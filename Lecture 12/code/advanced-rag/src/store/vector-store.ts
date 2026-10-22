import { cosine } from '../lib/vectors.js';
import type { DenseCandidate, DocMeta, IndexRecord } from '../types.js';

/**
 * An in-memory vector store, small enough to read in one sitting.
 *
 * It has exactly the two behaviours this lecture needs to demonstrate:
 *
 *  - **Pre-filtering.** The predicate runs during the scan, so the K results are
 *    the best K *eligible* results. This is what a real database does when it can
 *    push the filter into the index.
 *  - **Post-filtering.** The predicate runs after the top-K, which is what happens
 *    when a system retrieves first and filters second. `mode: 'post'` exists so the
 *    guide can show the failure instead of describing it: with a restrictive filter
 *    the result set collapses to zero even though matching documents exist.
 */

export interface VectorQuery {
  vector: readonly number[];
  topK: number;
  predicate?: (meta: DocMeta) => boolean;
  mode?: 'pre' | 'post';
}

export interface VectorQueryResult {
  hits: DenseCandidate[];
  /** Records examined by the scan — the number that decides your latency. */
  scanned: number;
  /** Records that passed the predicate before ranking. */
  eligible: number;
}

export class MemoryVectorStore {
  readonly model: string;
  readonly dimensions: number;
  private readonly records: IndexRecord[];

  constructor(records: readonly IndexRecord[], meta: { model: string; dimensions: number }) {
    this.records = [...records];
    this.model = meta.model;
    this.dimensions = meta.dimensions;
  }

  get size(): number {
    return this.records.length;
  }

  all(): readonly IndexRecord[] {
    return this.records;
  }

  query({ vector, topK, predicate, mode = 'pre' }: VectorQuery): VectorQueryResult {
    const accept = predicate ?? (() => true);

    if (mode === 'post') {
      const ranked = this.records
        .map((record) => this.score(record, vector))
        .sort((left, right) => right.score - left.score)
        .slice(0, topK);

      return {
        hits: ranked.filter((hit) => accept(hit.chunk.meta)),
        scanned: this.records.length,
        eligible: this.records.filter((record) => accept(record.meta)).length,
      };
    }

    const hits: DenseCandidate[] = [];

    for (const record of this.records) {
      if (!accept(record.meta)) continue;
      hits.push(this.score(record, vector));
    }

    hits.sort((left, right) => right.score - left.score);

    return {
      hits: hits.slice(0, topK),
      scanned: this.records.length,
      eligible: hits.length,
    };
  }

  private score(record: IndexRecord, query: readonly number[]): DenseCandidate {
    const { vector, embedText: _embedText, ...chunk } = record;
    return { chunk, score: cosine(query, vector), origin: 'dense', vector };
  }
}
