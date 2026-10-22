# Chapter 12: The RAG Service

> **Chapter Goal:** Assemble the two pipelines into one class that returns an answer, its citations and a trace. This is the file where every earlier decision either composes or collides.

> **Lecture mapping:** Notes Chapter 02 (the two pipelines), Chapter 06 (grounding and refusal), Chapter 08 (traces), Chapter 09 (idempotent re-indexing).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/rag.service.ts` | 228 | `ingest()`, `ask()`, refusal path, trace assembly. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run ingest
npm run ask -- "What is the refund window for apparel?"
npm run eval
```

---

## 2. The Service — `src/rag.service.ts`

#### 📄 `src/rag.service.ts`

```ts
import { randomUUID } from 'node:crypto';

import type { EmbeddingProvider } from './embeddings/provider.js';
import { REFUSAL_MESSAGE, buildGroundedPrompt } from './generation/prompt.js';
import type { GenerationProvider } from './generation/provider.js';
import { countInvalid, linkCitations, stripInvalidMarkers } from './grounding/citations.js';
import { chunkDocument, toEmbeddingText } from './ingest/chunker.js';
import { loadDocuments } from './ingest/loader.js';
import type { Retriever } from './retrieval/retriever.js';
import type { QueryRewriter } from './session/rewrite.js';
import type { SessionStore } from './session/store.js';
import type { VectorStore } from './store/vector-store.js';
import type { IngestReport, Match, RagAnswer, RagTrace, Turn } from './types/rag.types.js';

export interface RagServiceConfig {
  knowledgeDir: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  maxContextTokens: number;
  historyTurns: number;
}

export interface RagServiceDeps {
  store: VectorStore;
  embeddings: EmbeddingProvider;
  generator: GenerationProvider;
  retriever: Retriever;
  sessions: SessionStore;
  rewriter: QueryRewriter;
  config: RagServiceConfig;
}

/**
 * The two pipelines, in one class.
 *
 * `ingest()` is offline and slow and runs when documents change.
 * `ask()` is online and must stay inside a latency budget.
 *
 * Keeping them together makes the contract visible: whatever `ingest()` puts in
 * the store is the only thing `ask()` can ever retrieve.
 */
export class RagService {
  constructor(private readonly deps: RagServiceDeps) {}

  async ingest(): Promise<IngestReport> {
    const started = performance.now();
    const documents = await loadDocuments(this.deps.config.knowledgeDir);

    const skipped: string[] = [];
    const chunks = documents.flatMap((document) => {
      if (!document.text.trim()) {
        skipped.push(document.source);
        return [];
      }

      return chunkDocument(document, {
        size: this.deps.config.chunkSize,
        overlap: this.deps.config.chunkOverlap,
      });
    });

    if (chunks.length === 0) {
      // An empty index answers every question with a refusal, which looks like a
      // working system and is the worst possible failure mode.
      throw new Error('Ingestion produced no chunks. Fix extraction before replacing the index.');
    }

    const vectors = await this.deps.embeddings.embed(chunks.map(toEmbeddingText), 'document');

    // Replace each source wholesale. Embedding first means a provider failure
    // leaves the old index intact; deleting first would leave the customer with
    // no index at all. Without this step, a shortened document keeps its old
    // chunks forever and every answer gets two contradictory versions of a rule.
    for (const source of new Set(documents.map((document) => document.source))) {
      await this.deps.store.deleteBySource(source);
    }

    await this.deps.store.upsert(chunks.map((chunk, index) => ({ ...chunk, vector: vectors[index] })));

    return {
      documents: documents.length - skipped.length,
      chunks: chunks.length,
      tokens: chunks.reduce((total, chunk) => total + chunk.tokens, 0),
      skipped,
      staleSourcesRemoved: await this.removeStaleSources(documents.map((document) => document.source)),
      durationMs: Math.round(performance.now() - started),
      store: this.deps.store.name,
    };
  }

  async ask(input: { question: string; sessionId?: string }): Promise<RagAnswer> {
    const started = performance.now();
    const question = input.question.trim();
    const sessionId = input.sessionId ?? randomUUID();
    const history = this.deps.sessions.get(sessionId);

    // 1. Resolve the question against the conversation before searching.
    const searchQuery = await this.deps.rewriter.rewrite(question, history);

    // 2. Retrieve evidence.
    const retrieval = await this.deps.retriever.retrieve(searchQuery);
    const trace = this.baseTrace(question, searchQuery, retrieval.matches, retrieval.candidates);

    // 3. No evidence means no model call: refuse in code, cheaply and visibly.
    if (retrieval.matches.length === 0) {
      return this.buildRefusal(sessionId, question, searchQuery, trace, retrieval, started);
    }

    // 4. Assemble the grounded prompt.
    const prompt = buildGroundedPrompt({
      question,
      matches: retrieval.matches,
      history: history.slice(-this.deps.config.historyTurns),
      maxContextTokens: this.deps.config.maxContextTokens,
    });

    // 5. Generate.
    const generateStarted = performance.now();
    const generated = await this.deps.generator.generate({
      instructions: prompt.instructions,
      messages: prompt.messages,
    });
    const generateMs = Math.round(performance.now() - generateStarted);

    // 6. Verify the output: flag invented citations, strip them, detect refusal.
    const allCitations = linkCitations(generated.text, prompt.labels);
    const answer = stripInvalidMarkers(generated.text, prompt.labels).trim();
    const refused = isRefusal(answer);

    this.remember(sessionId, question, answer, searchQuery);

    return {
      answer,
      citations: allCitations,
      refused,
      sessionId,
      trace: {
        ...trace,
        contextTokens: prompt.contextTokens,
        citations: allCitations.filter((citation) => citation.valid).length,
        invalidCitations: countInvalid(allCitations),
        refused,
        latencyMs: {
          embed: Math.round(retrieval.embedMs),
          search: Math.round(retrieval.searchMs),
          generate: generateMs,
          total: Math.round(performance.now() - started),
        },
      },
    };
  }

  /** Used by `DELETE /api/sessions/:id`. Deletion must be one call, not a cron job. */
  resetSession(sessionId: string): boolean {
    return this.deps.sessions.reset(sessionId);
  }

  private buildRefusal(
    sessionId: string,
    question: string,
    searchQuery: string,
    trace: RagTrace,
    retrieval: { embedMs: number; searchMs: number },
    started: number,
  ): RagAnswer {
    this.remember(sessionId, question, REFUSAL_MESSAGE, searchQuery);

    return {
      answer: REFUSAL_MESSAGE,
      citations: [],
      refused: true,
      sessionId,
      trace: {
        ...trace,
        refused: true,
        contextTokens: 0,
        citations: 0,
        invalidCitations: 0,
        latencyMs: {
          embed: Math.round(retrieval.embedMs),
          search: Math.round(retrieval.searchMs),
          generate: 0,
          total: Math.round(performance.now() - started),
        },
      },
    };
  }

  private baseTrace(
    question: string,
    searchQuery: string,
    matches: readonly Match[],
    candidates: number,
  ): RagTrace {
    return {
      question,
      searchQuery,
      topK: this.deps.config.topK,
      candidates,
      matches: matches.map((match) => ({
        id: match.id.slice(0, 12),
        score: Number(match.score.toFixed(4)),
        source: match.source,
        section: match.section,
      })),
      contextTokens: 0,
      citations: 0,
      invalidCitations: 0,
      refused: false,
      providers: {
        embedding: `${this.deps.embeddings.name}/${this.deps.embeddings.model}`,
        generation: `${this.deps.generator.name}/${this.deps.generator.model}`,
      },
      latencyMs: { embed: 0, search: 0, generate: 0, total: 0 },
    };
  }

  private remember(sessionId: string, question: string, answer: string, searchQuery: string): void {
    const turn: Turn = { question, answer, searchQuery, at: Date.now() };
    this.deps.sessions.append(sessionId, turn);
  }

  private async removeStaleSources(currentSources: readonly string[]): Promise<string[]> {
    if (!this.deps.store.listSources) return [];

    const current = new Set(currentSources);
    const stale = (await this.deps.store.listSources()).filter((source) => !current.has(source));

    for (const source of stale) await this.deps.store.deleteBySource(source);
    return stale;
  }
}

/** Exact-sentence match: the refusal is a contract, not a sentiment. */
function isRefusal(answer: string): boolean {
  return answer.toLowerCase().includes(REFUSAL_MESSAGE.toLowerCase());
}
```

**Block by block — the constructor and dependencies:**

- **`RagServiceDeps`** — seven collaborators, all interfaces: store, embeddings, generator, retriever, sessions, rewriter, config. No concrete class is imported here, which is why every later chapter can swap a provider without touching this file.
- **`config`** — chunk size, overlap, topK, context budget, history turns, knowledge directory. The service reads policy, it does not decide it.

**Block by block — `ingest()`:**

- **`performance.now()` at the top** — every stage reports its own duration; the report is part of the contract, not a debug print.
- **`loadDocuments(knowledgeDir)`** — chapter 03. Throws if the directory is missing or empty.
- **`documents.flatMap(...)`** — one pass that both skips and chunks:
  - `if (!document.text.trim())` → push the source into `skipped` and return `[]`. This is the coverage metric: a scanned PDF becomes a visible number, not a silent absence.
  - `chunkDocument(...)` → chapter 04.
- **`if (chunks.length === 0) throw`** — the second empty-index guard. Without it, the next step would delete every record and leave the system answering "I don't know" to everything, which looks like a working RAG.
- **`embed(chunks.map(toEmbeddingText), 'document')`** — one batched call with the section headers included (chapter 04). **Embedding happens before deletion**: if the provider fails, the old index is still intact and the customer still gets answers.
- **`for (const source of new Set(...)) await store.deleteBySource(source)`** — replace each source wholesale. This is the fix for the bug that appears the first time you edit a policy: the chunk ids are content-addressed, so a shortened document leaves its old chunks behind and every answer quotes two contradictory versions of the same rule.
- **`store.upsert(chunks.map((chunk, index) => ({ ...chunk, vector: vectors[index] })))`** — the join between text and vectors. `vectors[index]` is safe because the embedding provider preserves input order and the batch is one call for the whole corpus here.
- **`removeStaleSources(...)`** — sources that disappeared from disk. Optional, because it needs `listSources`, which the Pinecone adapter does not implement.
- **The report** — documents, chunks, tokens, skipped, stale, duration, store name. Four of those are alertable: a sudden drop in chunks or a non-empty `skipped` means extraction broke.

---

**Block by block — `ask()`:**

- **`sessionId = input.sessionId ?? randomUUID()`** — the server issues the id when the client does not have one. The client never supplies history, only a key.
- **`history = sessions.get(sessionId)`** — a copy, TTL-checked.
- **Step 1 — `rewriter.rewrite(question, history)`** — resolves "And for shoes?" into a searchable query *before* embedding. Skipped entirely when the question stands alone.
- **Step 2 — `retriever.retrieve(searchQuery)`** — embed, over-fetch, blend, floor, trim (chapter 07).
- **`baseTrace(...)`** — built immediately, so the refusal path and the success path share the same structure. A trace that only exists on success is a trace you cannot debug.
- **Step 3 — the refusal branch** — `if (retrieval.matches.length === 0)`. No evidence means **no model call**: `buildRefusal` records the turn, sets `refused: true`, `contextTokens: 0`, `generate: 0ms`. This is the cheapest and most honest path in the system.
- **Step 4 — `buildGroundedPrompt(...)`** — evidence inside `<documents>`, question last, label map returned (chapter 09). `history.slice(-historyTurns)` is the second cap on history: the store may hold six turns, this call sends at most six and the config decides.
- **Step 5 — `generator.generate(...)`** — only `instructions` and `messages` cross the boundary. The provider never sees the store, the retriever or the corpus.
- **Step 6 — verification** — three separate concerns, three lines:
  - `linkCitations(generated.text, prompt.labels)` → every marker resolved or flagged.
  - `stripInvalidMarkers(...)` → the customer never sees a fabricated source.
  - `isRefusal(answer)` → an exact-sentence check, not a sentiment.
- **`this.remember(...)`** — the turn is stored **after** the answer exists, so a failed generation cannot leave a half-turn in history.
- **The returned trace** — `candidates`, `matches[]` (id prefix, score, source, section), `contextTokens`, `citations`, `invalidCitations`, `refused`, `providers`, `latencyMs` per stage.

**Block by block — the helpers:**

- **`buildRefusal`** — a full `RagAnswer` with an empty citation list and a trace whose `generate` is exactly `0`. If that number is ever non-zero on a refusal, something called the model without evidence.
- **`baseTrace`** — `id.slice(0, 12)`: a readable prefix in logs, while the full hash stays available in the store. Full 64-character ids in every log line are unreadable and invite copy-paste mistakes.
- **`remember`** — one place that shapes a `Turn`, including the `searchQuery` that future rewriting will build on.
- **`removeStaleSources`** — `if (!store.listSources) return []`, then delete everything not in the current set. Optional capability, explicit fallback.
- **`isRefusal`** — `answer.toLowerCase().includes(REFUSAL_MESSAGE.toLowerCase())`. Deliberately forgiving about case, deliberately strict about wording.

---

## 3. The Trace, In Full

A real response from the compiled server, trimmed to the interesting fields:

```json
{
  "answer": "- Standard delivery: 3 to 5 business days, 4.99 USD, free for orders over 75 USD. … [1]",
  "citations": [
    { "label": 1, "source": "shipping-policy.md", "section": "Delivery options",
      "score": 0.3141, "valid": true }
  ],
  "refused": false,
  "sessionId": "380056e1-…",
  "trace": {
    "question": "How much does express delivery cost?",
    "searchQuery": "How much does express delivery cost?",
    "topK": 4,
    "candidates": 12,
    "matches": [
      { "id": "27ea3f80475c", "score": 0.3141, "source": "shipping-policy.md", "section": "Delivery options" }
    ],
    "contextTokens": 118,
    "citations": 1,
    "invalidCitations": 0,
    "refused": false,
    "providers": { "embedding": "mock/mock-hash-v1", "generation": "extractive/extractive-v1" },
    "latencyMs": { "embed": 0, "search": 1, "generate": 0, "total": 5 }
  }
}
```

Each field answers a question someone will actually ask:

| Field | Question it answers |
| :--- | :--- |
| `searchQuery` | Did the rewrite help or hurt? |
| `candidates` / `matches` | Did the floor drop the right things? |
| `matches[].score` | Was the top hit strong or marginal? |
| `contextTokens` | Did the budget cut evidence? |
| `invalidCitations` | Did the model invent a source? |
| `providers` | Which model actually answered? |
| `latencyMs` | Which stage is slow? |

---

## 4. Ordering Rules That Matter

| Rule | Why |
| :--- | :--- |
| Embed before deleting old chunks | A provider failure must not destroy a working index |
| Refuse before generating | Saves the most expensive call and prevents invention |
| Strip before returning | A fake `[9]` must never reach the customer |
| Remember after answering | No half-turns in history |
| Trace built before branching | Refusals are as observable as answers |

**Next:** [Chapter 13 — Composition, Scripts and Evaluation](./13_Composition_Scripts_and_Evaluation.md)
