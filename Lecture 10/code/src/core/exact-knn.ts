import { prepare, scoreWithNorms, distanceFromScore } from './metrics.js';
import { TopK } from '../lib/topk.js';
import type {
  IndexSearchOptions,
  IndexSearchResult,
  Metric,
  PreparedRecord,
  Vector,
} from '../types/vector.types.js';

export interface ExactKnnOptions<T = Record<string, unknown>> extends IndexSearchOptions<T> {
  metric: Metric;
  /** Reuse the store's id map instead of rebuilding one per query. */
  recordsById?: ReadonlyMap<string, PreparedRecord<T>>;
}

/**
 * Exact KNN — the ground truth.
 *
 * Scans every record, keeps only K candidates in a bounded heap, and therefore
 * returns 100% recall by construction. Cost is O(N × D) comparisons and O(K)
 * extra memory. Every ANN claim in this codebase is measured against this.
 */
export function exactKnn<T>(
  records: readonly PreparedRecord<T>[],
  query: Vector,
  options: ExactKnnOptions<T>,
): IndexSearchResult<T>[] {
  const { k, metric, filter } = options;
  if (k <= 0) return [];

  const preparedQuery = prepare(query);
  const top = new TopK(k);
  const byId = options.recordsById ?? new Map(records.map((record) => [record.id, record]));

  for (const record of records) {
    if (filter && !filter(record)) continue;
    const score = scoreWithNorms(
      metric,
      preparedQuery.data,
      preparedQuery.norm,
      record.vector,
      record.norm,
    );
    top.push(record.id, score);
  }

  return top.results().map((ranked) => {
    const record = byId.get(ranked.id);
    if (!record) throw new Error(`Internal error: missing record ${ranked.id}.`);
    return {
      id: record.id,
      score: ranked.score,
      distance: distanceFromScore(metric, ranked.score),
      record,
    };
  });
}
