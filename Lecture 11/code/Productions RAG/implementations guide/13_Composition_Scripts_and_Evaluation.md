# Chapter 13: Composition, Scripts and Evaluation

> **Chapter Goal:** Wire the pipeline in exactly one place, expose it through scripts that prove each stage, and measure it against a golden set so quality is a number rather than an opinion.

> **Lecture mapping:** Notes Chapter 08 — golden sets, recall@K, citation validity, refusal correctness, and the debug tree.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/container.ts` | 87 | The composition root: provider and store selection in one place. |
| `src/scripts/ingest.ts` | 19 | Rebuild the index, report coverage. |
| `src/scripts/ask.ts` | 34 | One question with citations and trace. |
| `src/scripts/demo.ts` | 79 | Offline walkthrough of all seven stages. |
| `src/scripts/eval.ts` | 88 | Golden-set evaluation and pass/fail. |
| `eval/golden.json` | 74 | 12 cases: 10 answerable, 2 not. |

---

## 1. Commands

```bash
cd "Lecture 11/code"

npm run ingest                 # rebuild the index
npm run ask -- "…"             # one question
npm run demo                   # offline end-to-end walkthrough
npm run eval                   # golden set, exits 1 on regression
```

---

## 2. Composition Root — `src/container.ts`

#### 📄 `src/container.ts`

```ts
import { env } from './config/env.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embeddings/provider.js';
import { createGenerationProvider, type GenerationProvider } from './generation/provider.js';
import { RagService } from './rag.service.js';
import { Retriever } from './retrieval/retriever.js';
import { createQueryRewriter } from './session/rewrite.js';
import { SessionStore } from './session/store.js';
import { createVectorStore } from './store/factory.js';
import type { VectorStore } from './store/vector-store.js';

export interface Container {
  env: typeof env;
  store: VectorStore;
  embeddings: EmbeddingProvider;
  generator: GenerationProvider;
  retriever: Retriever;
  sessions: SessionStore;
  service: RagService;
}

/**
 * Composition root: the only place that knows which concrete provider is in use.
 *
 * Everything below this file depends on interfaces, which is what lets `demo` and
 * `eval` run offline with the same pipeline the server uses in production.
 */
export async function createContainer(): Promise<Container> {
  const embeddings = createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    apiKey: env.OPENAI_API_KEY,
  });

  const generator = createGenerationProvider({
    provider: env.LLM_PROVIDER,
    model: env.CHAT_MODEL,
    apiKey: env.OPENAI_API_KEY,
  });

  const store = await createVectorStore({
    kind: env.VECTOR_STORE,
    indexPath: env.INDEX_PATH,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    pinecone: {
      apiKey: env.PINECONE_API_KEY,
      indexName: env.PINECONE_INDEX_NAME,
      namespace: env.PINECONE_NAMESPACE,
    },
  });

  const retriever = new Retriever({
    store,
    embeddings,
    options: {
      topK: env.TOP_K,
      candidateMultiplier: env.CANDIDATE_MULTIPLIER,
      minScore: env.MIN_SCORE,
      lexicalWeight: env.HYBRID_LEXICAL_WEIGHT,
    },
  });

  const sessions = new SessionStore(env.SESSION_TTL_MINUTES * 60_000, env.HISTORY_TURNS);

  // Only a real model can rewrite a query; the extractive stub cannot paraphrase.
  const rewriter = createQueryRewriter(env.LLM_PROVIDER === 'openai' ? generator : undefined);

  const service = new RagService({
    store,
    embeddings,
    generator,
    retriever,
    sessions,
    rewriter,
    config: {
      knowledgeDir: env.KNOWLEDGE_DIR,
      chunkSize: env.CHUNK_SIZE,
      chunkOverlap: env.CHUNK_OVERLAP,
      topK: env.TOP_K,
      maxContextTokens: env.MAX_CONTEXT_TOKENS,
      historyTurns: env.HISTORY_TURNS,
    },
  });

  return { env, store, embeddings, generator, retriever, sessions, service };
}
```

**Block by block:**

- **`Container`** — every wired object, including `retriever` and `generator`. Scripts use the pieces (the demo prints the prompt built from a live retrieval); the server uses `service`.
- **One `env` read** — configuration is validated once, at import time, and the resolved values are passed down. No factory reaches into `process.env` on its own.
- **`createEmbeddingProvider` / `createGenerationProvider`** — chapter 05 and chapter 10. The API key is passed explicitly, so the providers have no global dependency.
- **`createVectorStore`** — chapter 06. This is the only `await` in the wiring: the memory store hydrates from disk, and Pinecone connects.
- **`new Retriever({...})`** — the four retrieval options are read here and nowhere else. A route cannot override `topK`.
- **`new SessionStore(ttlMs, maxTurns)`** — milliseconds derived from minutes in one place.
- **`createQueryRewriter(env.LLM_PROVIDER === 'openai' ? generator : undefined)`** — the policy in one line: only a real model can rewrite a query, because the extractive stub cannot paraphrase.
- **`new RagService({...})`** — seven dependencies and six config values, all explicit. No hidden singleton, no module-level state.

**Why this file is worth having**

Without it, `server.ts`, `demo.ts`, `eval.ts` and `ask.ts` would each build their own wiring, and they would drift: one would forget the lexical weight, another would use a different session TTL. Composition in one place is what makes "the demo behaves like production" true.

---

## 3. Ingest — `src/scripts/ingest.ts`

#### 📄 `src/scripts/ingest.ts`

```ts
import { createContainer } from '../container.js';

const container = await createContainer();
const report = await container.service.ingest();

console.log(
  `[ingest] store=${report.store} documents=${report.documents} chunks=${report.chunks} ` +
    `tokens=${report.tokens} ${report.durationMs}ms`,
);

if (report.skipped.length > 0) {
  console.warn(`[ingest] skipped, no extractable text: ${report.skipped.join(', ')}`);
}

if (report.staleSourcesRemoved.length > 0) {
  console.log(`[ingest] removed deleted sources: ${report.staleSourcesRemoved.join(', ')}`);
}

console.log(`[ingest] index now holds ${await container.store.count()} chunks`);
```

**Block by block:**

- **`createContainer()` then `service.ingest()`** — no duplication of the pipeline; the script is a thin shell.
- **The report line** — store, documents, chunks, tokens, duration. Those five numbers are the smoke test: 3 documents, 19 chunks, ~870 tokens.
- **`skipped`** — files with no extractable text. Printed as a warning because a silent empty document is the classic broken-ingestion symptom.
- **`staleSourcesRemoved`** — files deleted from disk. Printed when non-empty.
- **The final count from the store** — the script does not trust the report; it asks the store how many records it actually holds. Two independent numbers that must agree.

---

## 4. Ask — `src/scripts/ask.ts`

#### 📄 `src/scripts/ask.ts`

```ts
import { createContainer } from '../container.js';

const question = process.argv.slice(2).join(' ').trim();

if (!question) {
  console.error('Usage: npm run ask -- "What is the refund window for apparel?"');
  process.exit(1);
}

const container = await createContainer();

if ((await container.store.count()) === 0) {
  const report = await container.service.ingest();
  console.log(`[ask] index was empty, ingested ${report.chunks} chunks first`);
}

const result = await container.service.ask({ question });

console.log(`\n${result.answer}\n`);

for (const citation of result.citations) {
  const status = citation.valid ? 'ok' : 'INVALID';
  console.log(
    `  [${citation.label}] ${status.padEnd(7)} ${citation.source} · ${citation.section} ` +
      `(score ${citation.score.toFixed(3)})`,
  );
}

const { trace } = result;
console.log(
  `\n[trace] searchQuery="${trace.searchQuery}" candidates=${trace.candidates} ` +
    `matches=${trace.matches.length} contextTokens=${trace.contextTokens} ` +
    `invalidCitations=${trace.invalidCitations} refused=${trace.refused}`,
);
console.log(
  `[trace] embed=${trace.latencyMs.embed}ms search=${trace.latencyMs.search}ms ` +
    `generate=${trace.latencyMs.generate}ms total=${trace.latencyMs.total}ms`,
);
console.log(`[trace] sessionId=${result.sessionId}`);
```

**Block by block:**

- **`process.argv.slice(2).join(' ')`** — `npm run ask -- "what is the refund window"` arrives as separate argv entries; joining them keeps quotes optional.
- **The usage guard** — a missing question exits `1` with the example command, instead of asking the model about an empty string.
- **`if (await store.count()) === 0 → ingest()`** — a convenience for first runs: the CLI heals an empty index. The server does the same at boot (chapter 14).
- **Citations printed one per line with `ok` / `INVALID`** — the console is a debugging tool, and the validity flag is the first thing you look at when an answer looks wrong.
- **The trace block** — `searchQuery`, `candidates`, `matches`, `contextTokens`, `invalidCitations`, `refused`, per-stage latency, `sessionId`. Everything from chapter 12, in two lines of terminal.

---

## 5. Demo — `src/scripts/demo.ts`

#### 📄 `src/scripts/demo.ts`

```ts
/**
 * Offline walkthrough of the whole pipeline.
 *
 * Forces the deterministic providers before anything reads configuration, so
 * `npm run demo` works with no API key and prints the same numbers every run.
 */
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'extractive';

import { buildGroundedPrompt } from '../generation/prompt.js';
import { chunkDocument } from '../ingest/chunker.js';
import { loadDocuments } from '../ingest/loader.js';

const { createContainer } = await import('../container.js');

function heading(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

const container = await createContainer();
const { env, service, store, retriever, generator } = container;

heading('1. Configuration');
console.log(`embeddings  ${env.EMBEDDING_PROVIDER}/${env.EMBEDDING_MODEL} (${env.EMBEDDING_DIMENSIONS} dims)`);
console.log(`generation  ${generator.name}/${generator.model}`);
console.log(`store       ${env.VECTOR_STORE}`);
console.log(`chunking    size=${env.CHUNK_SIZE} overlap=${env.CHUNK_OVERLAP} topK=${env.TOP_K} floor=${env.MIN_SCORE}`);

heading('2. Ingestion — documents become chunks');
const documents = await loadDocuments(env.KNOWLEDGE_DIR);
for (const document of documents) {
  const chunks = chunkDocument(document, { size: env.CHUNK_SIZE, overlap: env.CHUNK_OVERLAP });
  const first = chunks[0];
  console.log(`${document.source.padEnd(22)} ${String(chunks.length).padStart(2)} chunks  first: "${first?.section}"`);
}
const report = await service.ingest();
console.log(`\nindexed ${report.chunks} chunks / ${report.tokens} tokens in ${report.durationMs}ms (${await store.count()} in store)`);

heading('3. The assembled prompt (chapter 06)');
const question = 'What is the refund window for apparel?';
const retrieval = await retriever.retrieve(question);
const prompt = buildGroundedPrompt({ question, matches: retrieval.matches, maxContextTokens: env.MAX_CONTEXT_TOKENS });
console.log(prompt.instructions);
console.log('\n--- user message ------------------------------------------');
console.log(prompt.messages.at(-1)?.content.slice(0, 700));
console.log('\n--- end ---------------------------------------------------');

heading('4. Answer with citations');
const result = await service.ask({ question, sessionId: 'demo-session' });
console.log(`Q: ${question}`);
for (const match of result.trace.matches) {
  console.log(`   ${match.score.toFixed(4)}  ${match.source} · ${match.section}`);
}
console.log(`\nA: ${result.answer}`);
console.log(
  `\ncontext=${result.trace.contextTokens} tokens  citations=${result.trace.citations}  ` +
    `invalid=${result.trace.invalidCitations}  ${result.trace.latencyMs.total}ms`,
);

heading('5. Refusal — no evidence, no model call');
const unanswered = await service.ask({ question: 'Can I pay with Bitcoin?', sessionId: 'demo-session' });
console.log(`A: ${unanswered.answer}`);
console.log(
  `refused=${unanswered.refused}  matches=${unanswered.trace.matches.length}  ` +
    `generate=${unanswered.trace.latencyMs.generate}ms`,
);

heading('6. Follow-up — the conversation resolves the reference');
const followUpSession = 'demo-followup';
await service.ask({ question: 'What is the refund window for apparel?', sessionId: followUpSession });
const followUp = await service.ask({ question: 'And for shoes?', sessionId: followUpSession });
console.log('Q: And for shoes?');
console.log(`rewritten searchQuery: ${followUp.trace.searchQuery}`);
console.log(`\nA: ${followUp.answer}`);

heading('7. The trace you would ship to your logs');
console.log(JSON.stringify(followUp.trace, null, 2));
```

**Block by block:**

- **`process.env.EMBEDDING_PROVIDER = 'mock'` at the very top** — this is the subtlest line in the guide. ES module imports are hoisted and evaluated **before** any statement in the file body runs, so a static `import { env } from '../config/env.js'` would read configuration *before* these assignments. `env.ts` would then decide the providers from a `.env` that may say `openai`.
- **`await import('../container.js')`** — a dynamic import, executed *after* the env assignment. That ordering is what makes `npm run demo` deterministic on a machine that also has an API key.
- **Static imports of `prompt`, `chunker`, `loader`** — safe, because none of them read configuration.
- **Step 1** prints providers, dimensions, chunking and retrieval knobs. If a demo behaves oddly, this block explains why.
- **Step 2** loads and chunks independently of the service, so the chunk counts are visible before indexing.
- **Step 3** builds a prompt from a live retrieval and prints the instructions plus the first 700 characters of the evidence block — the best way to see what the model actually receives.
- **Step 4** asks the real question through `service.ask`, prints scored matches, the answer, and the budget/citation counters.
- **Step 5** asks something the corpus cannot answer and prints `refused=true matches=0 generate=0ms`. That zero is the refusal-before-generation rule made visible.
- **Step 6** runs a two-turn conversation in a fresh session, so the rewrite is attributable to the follow-up and nothing else.
- **Step 7** prints the whole trace as JSON — the artefact you would ship to a log store.

---

## 6. Evaluation — `src/scripts/eval.ts` and `eval/golden.json`

#### 📄 `eval/golden.json`

```json
[
  {
    "id": "refund-apparel",
    "question": "What is the refund window for apparel?",
    "expectedSources": ["refund-policy.md"],
    "answerable": true,
    "mustContain": ["3 days"]
  },
  {
    "id": "refund-footwear",
    "question": "How many days do I have to return shoes?",
    "expectedSources": ["refund-policy.md"],
    "answerable": true,
    "mustContain": ["7 days"]
  },
  {
    "id": "refund-electronics",
    "question": "What is the refund period for electronics?",
    "expectedSources": ["refund-policy.md"],
    "answerable": true,
    "mustContain": ["14 days"]
  },
  {
    "id": "refund-timing",
    "question": "How long does a refund take to reach my account?",
    "expectedSources": ["refund-policy.md"],
    "answerable": true,
    "mustContain": ["5 to 7 business days"]
  },
  {
    "id": "refund-gift-cards",
    "question": "Are gift cards refundable?",
    "expectedSources": ["refund-policy.md"],
    "answerable": true,
    "mustContain": ["gift cards"]
  },
  {
    "id": "shipping-express",
    "question": "How much does express delivery cost?",
    "expectedSources": ["shipping-policy.md"],
    "answerable": true,
    "mustContain": ["12.99"]
  },
  {
    "id": "shipping-free",
    "question": "When is standard shipping free?",
    "expectedSources": ["shipping-policy.md"],
    "answerable": true,
    "mustContain": ["75"]
  },
  {
    "id": "shipping-lost",
    "question": "When is a parcel considered lost?",
    "expectedSources": ["shipping-policy.md"],
    "answerable": true,
    "mustContain": ["7 business days"]
  },
  {
    "id": "warranty-electronics",
    "question": "How long is the warranty on electronics?",
    "expectedSources": ["warranty-policy.md"],
    "answerable": true,
    "mustContain": ["12 months"]
  },
  {
    "id": "warranty-assessment",
    "question": "How long does a warranty assessment take?",
    "expectedSources": ["warranty-policy.md"],
    "answerable": true,
    "mustContain": ["10 business days"]
  },
  {
    "id": "unanswerable-student-discount",
    "question": "Do you offer a student discount?",
    "expectedSources": [],
    "answerable": false
  },
  {
    "id": "unanswerable-bitcoin",
    "question": "Can I pay with Bitcoin?",
    "expectedSources": [],
    "answerable": false
  }
]
```

#### 📄 `src/scripts/eval.ts`

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContainer } from '../container.js';

interface GoldenCase {
  id: string;
  question: string;
  /** Source files that must appear in the retrieved context. Empty = unanswerable. */
  expectedSources: string[];
  answerable: boolean;
  /** Substrings the answer must contain. Case-insensitive. */
  mustContain?: string[];
}

const GOLDEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval/golden.json');

const cases = JSON.parse(await readFile(GOLDEN_PATH, 'utf8')) as GoldenCase[];
const container = await createContainer();

const report = await container.service.ingest();
console.log(`[eval] indexed ${report.chunks} chunks into ${report.store}\n`);

let recallSum = 0;
let citationsValid = 0;
let refusalsCorrect = 0;
let factsPresent = 0;

const rows = [];

for (const testCase of cases) {
  const result = await container.service.ask({ question: testCase.question });

  const retrieved = new Set(result.trace.matches.map((match) => match.source));
  const hits = testCase.expectedSources.filter((source) => retrieved.has(source)).length;
  const recall = testCase.expectedSources.length === 0 ? 1 : hits / testCase.expectedSources.length;

  const citationsOk = result.citations.every((citation) => citation.valid);
  const refusalOk = result.refused === !testCase.answerable;
  const factsOk = (testCase.mustContain ?? []).every((term) =>
    result.answer.toLowerCase().includes(term.toLowerCase()),
  );

  recallSum += recall;
  if (citationsOk) citationsValid++;
  if (refusalOk) refusalsCorrect++;
  if (factsOk) factsPresent++;

  rows.push({
    case: testCase.id,
    recall: `${hits}/${testCase.expectedSources.length}`,
    citations: citationsOk ? 'ok' : 'INVALID',
    refused: result.refused ? 'yes' : 'no',
    refusal: refusalOk ? 'ok' : 'WRONG',
    facts: factsOk ? 'ok' : 'MISSING',
    ms: result.trace.latencyMs.total,
  });
}

console.table(rows);

const total = cases.length;
console.log(`[eval] recall@${container.env.TOP_K}    ${(recallSum / total).toFixed(2)}`);
console.log(`[eval] citations      ${citationsValid}/${total}`);
console.log(`[eval] refusals       ${refusalsCorrect}/${total}`);
console.log(`[eval] expected facts ${factsPresent}/${total}`);

const failures = rows.filter((row) => row.refusal === 'WRONG' || row.facts === 'MISSING' || row.citations === 'INVALID');
if (failures.length > 0) {
  console.error(`\n[eval] ${failures.length} failing case(s): ${failures.map((row) => row.case).join(', ')}`);
  process.exitCode = 1;
}
```

**Block by block:**

- **`GoldenCase`** — `id`, `question`, `expectedSources`, `answerable`, optional `mustContain`. Source-level expectations, not chunk ids: chunk ids change whenever the chunker changes, and a golden set that breaks on a legitimate refactor is a golden set nobody runs.
- **`await readFile(GOLDEN_PATH)`** — the dataset lives next to the code, versioned in git. A golden set in a database is one nobody can review.
- **`await service.ingest()` before the loop** — evaluation must run against a known index. A stale index makes yesterday's failures today's mystery.
- **`retrieved = new Set(trace.matches.map(m => m.source))`** — recall is computed on **what the prompt saw**, not on what the store holds. That is the only retrieval number that affects answers.
- **`recall = expectedSources.length === 0 ? 1 : hits / expectedSources.length`** — unanswerable cases have no gold source, and are scored on refusal instead.
- **`citationsOk`** — every returned citation must be `valid`. One fabricated source fails the case.
- **`refusalOk = result.refused === !testCase.answerable`** — the 2×2 in one line: answerable questions must be answered, unanswerable ones must be refused. Both directions are failures.
- **`factsOk`** — `mustContain` terms are the cheap faithfulness check: `3 days`, `12.99`, `75`, `10 business days`. A paraphrase that keeps the number passes; one that changes it fails.
- **`console.table(rows)`** — twelve rows you can scan in five seconds.
- **`process.exitCode = 1` on any failure** — this is what makes `npm run eval` usable in CI. A metric that only prints is a metric that regresses silently.

### Measured results

```text
[eval] recall@4    1.00
[eval] citations      12/12
[eval] refusals       12/12
[eval] expected facts 12/12
```

| Metric | Definition in this harness |
| :--- | :--- |
| recall@K | retrieved expected sources ÷ expected sources, over the top-K that reached the prompt |
| citation validity | share of cases where every returned citation resolved to a prompt chunk |
| refusal accuracy | share of cases where `refused` matched `!answerable` |
| expected facts | share of cases whose `mustContain` terms appear in the answer |

### What this harness does not measure

- **Faithfulness per sentence** — no entailment check. `mustContain` is a proxy.
- **Answer quality** — a correct fact in a confusing sentence still passes.
- **Latency percentiles** — the table prints per-case `ms`, not p95.
- **Cost** — token usage is captured in the trace but not asserted.

Those four are the natural next additions, in that order.

### The golden set, case by case

| Case | Question (abridged) | Expected source | Answerable |
| :--- | :--- | :--- | :--- |
| refund-apparel | refund window for apparel | refund-policy | yes |
| refund-footwear | how many days to return shoes | refund-policy | yes |
| refund-electronics | refund period for electronics | refund-policy | yes |
| refund-timing | how long a refund takes | refund-policy | yes |
| refund-gift-cards | are gift cards refundable | refund-policy | yes |
| shipping-express | express delivery cost | shipping-policy | yes |
| shipping-free | when is shipping free | shipping-policy | yes |
| shipping-lost | when is a parcel lost | shipping-policy | yes |
| warranty-electronics | warranty on electronics | warranty-policy | yes |
| warranty-assessment | warranty assessment time | warranty-policy | yes |
| unanswerable-student-discount | student discount | — | **no** |
| unanswerable-bitcoin | pay with Bitcoin | — | **no** |

Ten answerable, two not, across three documents, with five numeric facts. That is the smallest set that can catch a regression in chunking, retrieval, prompting and refusal at once.

---

## 7. Verify the Chapter

```bash
npm run eval
echo "exit=$?"
```

Expected:

```text
[eval] recall@4    1.00
[eval] citations      12/12
[eval] refusals       12/12
[eval] expected facts 12/12
exit=0
```

Then break something on purpose and watch it fail. Set the floor absurdly high:

```bash
MIN_SCORE=0.9 npm run eval
# [eval] refusals       2/12      ← answerable questions now refused
# [eval] 10 failing case(s): refund-apparel, refund-footwear, …
```

That is the harness doing its job: the failure names the cases, and the row shows `refused: yes` where it should be `no`.

**Next:** [Chapter 14 — HTTP API, Server and Operations](./14_HTTP_API_Server_and_Operations.md)
