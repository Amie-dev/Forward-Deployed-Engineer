import { countTokens } from '../lib/text.js';
import { blend, normalise } from '../lib/vectors.js';
import type { EmbeddingProvider } from '../embeddings.js';
import { contextualize, embedText, type ContextMode } from './context.js';
import { chunkFixed, findOrphans } from './fixed-chunker.js';
import { chunkSemantic } from './semantic-chunker.js';
import { chunkStructural } from './structural-chunker.js';
import { MemoryVectorStore } from '../store/vector-store.js';
import type { Chunk, IndexRecord, SourceDocument } from '../types.js';

/**
 * Ingestion: documents in, a queryable index out.
 *
 * The order is fixed and every step is observable, because "the index is bad" is
 * never actionable on its own:
 *
 *   chunk → add context → build the embedding text → embed → (optional) blend in
 *   document context → store with metadata
 *
 * The one non-obvious step is the optional blend (`lateChunkAlpha`). Late chunking
 * in the literature embeds the whole document with a long-context model and then
 * pools token vectors per chunk, so a chunk's vector literally contains its
 * neighbours. We cannot do that through an embeddings API, which only returns one
 * vector per input. The approximation here — a weighted blend of the child vector
 * with the document mean — buys most of the effect on a small corpus and is honest
 * about what it is.
 */

export interface IndexOptions {
  strategy: 'fixed' | 'structural' | 'semantic';
  chunkSize: number;
  chunkOverlap: number;
  chunkUnit: 'tokens' | 'chars';
  parentMaxTokens: number;
  minChunkTokens: number;
  contextualize: ContextMode;
  lateChunkAlpha: number;
  semanticThreshold: number;
  embeddings: EmbeddingProvider;
  openaiApiKey?: string;
  chatModel: string;
}

export interface IndexStats {
  documents: number;
  chunks: number;
  tokens: number;
  averageTokens: number;
  orphans: number;
  storageMultiplier: number;
  dimensions: number;
  embedMs: number;
  strategy: IndexOptions['strategy'];
  contextualized: number;
}

export interface BuiltIndex {
  store: MemoryVectorStore;
  records: IndexRecord[];
  stats: IndexStats;
}

export async function buildIndex(docs: readonly SourceDocument[], options: IndexOptions): Promise<BuiltIndex> {
  const startedAt = performance.now();

  // 1. Chunk. Every strategy produces the same `Chunk` shape, so everything
  //    downstream is strategy-agnostic — that is what makes the ablation possible.
  const rawChunks: Chunk[] = [];
  for (const doc of docs) {
    if (options.strategy === 'fixed') {
      rawChunks.push(
        ...chunkFixed(doc, { size: options.chunkSize, overlap: options.chunkOverlap, unit: options.chunkUnit }),
      );
    } else if (options.strategy === 'semantic') {
      rawChunks.push(
        ...(await chunkSemantic(doc, options.embeddings, {
          maxTokens: options.chunkSize,
          threshold: options.semanticThreshold,
          minTokens: 60,
        })),
      );
    } else {
      rawChunks.push(
        ...chunkStructural(doc, {
          size: options.chunkSize,
          overlap: options.chunkOverlap,
          parentMaxTokens: options.parentMaxTokens,
          minTokens: options.minChunkTokens,
        }),
      );
    }
  }

  // 2. Situate each chunk in its document (Chapter 03).
  const docsBySource = new Map(docs.map((doc) => [doc.source, doc]));
  const chunks = await contextualize(rawChunks, docsBySource, {
    mode: options.contextualize,
    apiKey: options.openaiApiKey,
    model: options.chatModel,
  });

  // 3. Embed one string per chunk — the same string the retriever will search.
  const texts = chunks.map((chunk) => embedText(chunk));
  const vectors = await options.embeddings.embed(texts);

  // 4. Optional document-context blend.
  const documentVectors = options.lateChunkAlpha > 0 ? meanBySource(chunks, vectors) : new Map<string, number[]>();

  const records: IndexRecord[] = chunks.map((chunk, index) => {
    const own = vectors[index] ?? [];
    const documentVector = documentVectors.get(chunk.source);
    const vector = documentVector ? blend(own, documentVector, options.lateChunkAlpha) : normalise(own);

    return { ...chunk, embedText: texts[index] ?? '', vector };
  });

  const tokens = records.reduce((sum, record) => sum + record.tokens, 0);
  const documentTokens = docs.reduce((sum, doc) => sum + countTokens(doc.text), 0);

  return {
    store: new MemoryVectorStore(records, {
      model: options.embeddings.model,
      dimensions: options.embeddings.dimensions,
    }),
    records,
    stats: {
      documents: docs.length,
      chunks: records.length,
      tokens,
      averageTokens: records.length === 0 ? 0 : Math.round(tokens / records.length),
      orphans: findOrphans(records).length,
      storageMultiplier: documentTokens === 0 ? 0 : Number((tokens / documentTokens).toFixed(2)),
      dimensions: options.embeddings.dimensions,
      embedMs: Math.round(performance.now() - startedAt),
      strategy: options.strategy,
      contextualized: records.filter((record) => Boolean(record.contextPrefix)).length,
    },
  };
}

/** One vector per document: the mean of its chunk vectors, re-normalised. */
function meanBySource(chunks: readonly Chunk[], vectors: readonly number[][]): Map<string, number[]> {
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();

  chunks.forEach((chunk, index) => {
    const vector = vectors[index];
    if (!vector) return;

    const current = sums.get(chunk.source);
    if (!current) {
      sums.set(chunk.source, [...vector]);
      counts.set(chunk.source, 1);
      return;
    }

    for (let position = 0; position < current.length; position++) current[position] += vector[position];
    counts.set(chunk.source, (counts.get(chunk.source) ?? 0) + 1);
  });

  const means = new Map<string, number[]>();
  for (const [source, sum] of sums) {
    const count = counts.get(source) ?? 1;
    means.set(source, normalise(sum.map((value) => value / count)));
  }
  return means;
}
