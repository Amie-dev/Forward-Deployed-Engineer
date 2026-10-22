import { assemble } from './context/assemble.js';
import { createEmbeddings, type EmbeddingProvider } from './embeddings.js';
import { REFUSAL, createGenerator, verifyCitations, type Generator } from './generate.js';
import { buildIndex, type BuiltIndex } from './ingest/indexer.js';
import { loadDocuments } from './ingest/loader.js';
import { compileFilter, type Filter } from './store/filters.js';
import { Bm25Index } from './search/bm25.js';
import { denseSearch } from './search/dense.js';
import { agreement, rrf } from './search/hybrid.js';
import { createReranker, gateReranked, type Reranker } from './search/rerank.js';
import { config as envConfig, paths, type RagConfig } from './config/env.js';
import type {
  AccessContext,
  AssembledContext,
  RagAnswer,
  RagTrace,
  ScoredChunk,
  SourceDocument,
  TraceStage,
} from './types.js';

/**
 * The pipeline: one object that owns every stage, so a trace can name every stage.
 *
 * `retrieve()` and `ask()` are separate on purpose. Retrieval is what you measure
 * when something is wrong, and the only way to measure it independently is to be
 * able to call it without generating an answer. `ask()` is then a thin composition:
 * retrieve → assemble → generate → verify.
 */

export interface RetrievalRun {
  hits: ScoredChunk[];
  dense: ScoredChunk[];
  lexical: ScoredChunk[];
  fused: ScoredChunk[];
  reranked: ScoredChunk[];
  stages: TraceStage[];
  candidates: number;
  belowFloor: number;
  dropped: number;
}

export interface PipelineDeps {
  docs: readonly SourceDocument[];
  index: BuiltIndex;
  bm25: Bm25Index;
  embeddings: EmbeddingProvider;
  reranker: Reranker | null;
  generator: Generator;
  config: RagConfig;
}

export class RagPipeline {
  readonly config: RagConfig;
  private readonly deps: PipelineDeps;

  private constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.config = deps.config;
  }

  /** Build everything from a config. Each ablation preset calls this once. */
  static async create(overrides: Partial<RagConfig> = {}): Promise<RagPipeline> {
    const config: RagConfig = { ...envConfig, ...overrides };
    const docs = await loadDocuments(paths.policies);
    const embeddings = createEmbeddings({ ...config.embedding, openaiApiKey: config.openaiApiKey });

    const index = await buildIndex(docs, {
      strategy: config.chunkStrategy,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      chunkUnit: config.chunkUnit,
      parentMaxTokens: config.parentMaxTokens,
      minChunkTokens: config.minChunkTokens,
      contextualize: config.contextualize,
      lateChunkAlpha: config.lateChunkAlpha,
      semanticThreshold: 0.35,
      embeddings,
      openaiApiKey: config.openaiApiKey,
      chatModel: config.generation.model,
    });

    return new RagPipeline({
      docs,
      index,
      bm25: new Bm25Index(index.records, { k1: config.bm25K1, b: config.bm25B }),
      embeddings,
      reranker: createReranker(config.rerank, { apiKey: config.cohereApiKey, model: config.rerankModel }),
      generator: createGenerator({
        provider: config.generation.provider,
        model: config.generation.model,
        apiKey: config.openaiApiKey,
      }),
      config,
    });
  }

  get stats() {
    return this.deps.index.stats;
  }

  /** Retrieval only — the half of the system that Chapter 10 measures on its own. */
  async retrieve(question: string, options: { access: AccessContext; filter?: Filter }): Promise<RetrievalRun> {
    const stages: TraceStage[] = [];

    const dense = await denseSearch(
      this.deps.index.store,
      this.deps.embeddings,
      question,
      options.access,
      options.filter,
      {
        kRetrieve: this.config.kRetrieve,
        minScore: this.config.minScore,
        mmrLambda: this.config.mmrLambda,
      },
    );

    stages.push({
      name: 'dense',
      ms: Math.round(dense.embedMs + dense.searchMs),
      detail: `${dense.candidates} candidates · ${dense.eligible} eligible · ${dense.belowFloor} below ${this.config.minScore}`,
    });

    let lexical: ScoredChunk[] = [];
    let fused: ScoredChunk[] = dense.hits;

    if (this.config.hybrid === 'rrf') {
      const lexicalStarted = performance.now();
      lexical = this.deps.bm25.search(question, this.config.kRetrieve, compileFilter(options.filter, options.access));
      const lexicalMs = performance.now() - lexicalStarted;

      const shared = agreement(dense.hits, lexical);
      fused = rrf([dense.hits, lexical], this.config.rrfK, this.config.kRetrieve);

      stages.push({
        name: 'bm25',
        ms: Math.round(lexicalMs),
        detail: `${lexical.length} hits · ${shared} also in dense`,
      });
      stages.push({
        name: 'rrf',
        ms: 0,
        detail: `k=${this.config.rrfK} · ${fused.length} fused from ${dense.hits.length}+${lexical.length}`,
      });
    }

    let reranked: ScoredChunk[] = [];
    let hits = fused.slice(0, this.config.kContext);
    let dropped = Math.max(0, fused.length - hits.length);

    if (this.deps.reranker) {
      const started = performance.now();
      reranked = await this.deps.reranker.rerank(question, fused, fused.length);
      const ms = performance.now() - started;

      const gated = gateReranked(reranked, {
        minBest: this.config.rerankMinBest,
        maxDrop: this.config.rerankMaxDrop,
        maxK: this.config.kContext,
      });

      hits = gated.kept;
      dropped = fused.length - hits.length;

      stages.push({
        name: 'rerank',
        ms: Math.round(ms),
        detail: `${this.deps.reranker.name} · ${reranked.length} scored · best ${(reranked[0]?.score ?? 0).toFixed(3)} · ${gated.refused ? 'nothing cleared the gate' : `${gated.kept.length} kept`}`,
      });
    }

    return {
      hits,
      dense: dense.hits,
      lexical,
      fused,
      reranked,
      stages,
      candidates: dense.candidates,
      belowFloor: dense.belowFloor,
      dropped,
    };
  }

  /** Exposed so the CLI and the API can show what the index actually contains. */
  get store() {
    return this.deps.index.store;
  }

  get records() {
    return this.deps.index.records;
  }

  /** Retrieve, assemble, generate, verify — and record all of it. */
  async ask(
    question: string,
    options: { access: AccessContext; filter?: Filter },
  ): Promise<RagAnswer & { context: AssembledContext }> {
    const startedAt = performance.now();
    const run = await this.retrieve(question, options);

    const assembleStarted = performance.now();
    const context = assemble(run.hits, {
      maxTokens: this.config.maxContextTokens,
      expandParents: this.config.expandParents,
      bookendOrder: this.config.bookendOrder,
    });
    const assembleMs = performance.now() - assembleStarted;

    const generateStarted = performance.now();
    const generated = context.blocks.length === 0
      ? { text: REFUSAL, refused: true }
      : await this.deps.generator.generate({ question, context });
    const generateMs = performance.now() - generateStarted;

    const citations = verifyCitations(generated.text, context.blocks);

    const stages: TraceStage[] = [
      ...run.stages,
      {
        name: 'assemble',
        ms: Math.round(assembleMs),
        detail: `${context.blocks.length} blocks · ${context.tokens} tokens · ${context.dropped} dropped`,
      },
      {
        name: 'generate',
        ms: Math.round(generateMs),
        detail: `${this.deps.generator.name} · ${generated.refused ? 'refused' : `${citations.length} citations`}`,
      },
    ];

    const trace: RagTrace = {
      question,
      asOf: options.access.asOf,
      tenantId: options.access.tenantId,
      stages,
      retrieved: describeRetrieval(run),
      candidates: run.candidates,
      reranked: run.reranked.length,
      contextTokens: context.tokens,
      dropped: context.dropped,
      refused: generated.refused,
      invalidCitations: citations.filter((citation) => !citation.valid).length,
      latencyMs: Math.round(performance.now() - startedAt),
      providers: {
        embeddings: this.deps.embeddings.model,
        rerank: this.deps.reranker?.name ?? 'none',
        generation: this.deps.generator.name,
      },
    };

    return {
      answer: generated.text,
      citations,
      refused: generated.refused,
      trace,
      context,
    };
  }
}

/** One row per candidate, carrying every score it collected along the way. */
function describeRetrieval(run: RetrievalRun): RagTrace['retrieved'] {
  const rows = new Map<string, RagTrace['retrieved'][number]>();

  const upsert = (hit: ScoredChunk) => {
    const existing = rows.get(hit.chunk.id) ?? {
      id: hit.chunk.id,
      source: hit.chunk.source,
      heading: hit.chunk.heading || hit.chunk.title,
      dense: 0,
      used: false,
    };
    rows.set(hit.chunk.id, existing);
    return existing;
  };

  for (const hit of run.dense) upsert(hit).dense = round(hit.score);
  for (const hit of run.lexical) upsert(hit).bm25 = round(hit.score);
  for (const hit of run.fused) upsert(hit).fused = round(hit.score);
  for (const hit of run.reranked) upsert(hit).rerank = round(hit.score);
  run.hits.forEach((hit, index) => {
    const row = upsert(hit);
    row.used = true;
    row.rank = index + 1;
  });

  return [...rows.values()].sort(
    (left, right) => Number(right.used) - Number(left.used) || right.dense - left.dense,
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
