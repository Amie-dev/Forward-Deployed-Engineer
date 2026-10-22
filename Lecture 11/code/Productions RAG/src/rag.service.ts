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

