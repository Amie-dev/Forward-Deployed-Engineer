/** Retrieval metrics — the only honest way to compare an ANN index to exact KNN. */

export function recallAtK(approximate: readonly string[], exact: readonly string[], k: number): number {
  if (k <= 0 || exact.length === 0) return 0;
  const truth = new Set(exact.slice(0, k));
  let hits = 0;
  for (const id of approximate.slice(0, k)) if (truth.has(id)) hits++;
  return hits / Math.min(k, exact.length);
}

export function precisionAtK(approximate: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (k <= 0) return 0;
  let hits = 0;
  for (const id of approximate.slice(0, k)) if (relevant.has(id)) hits++;
  return hits / k;
}

/** Mean reciprocal rank of the first relevant result. */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/** nDCG with graded relevance, the standard ranking-quality metric. */
export function ndcgAtK(
  ranked: readonly string[],
  relevance: ReadonlyMap<string, number>,
  k: number,
): number {
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, id, index) => sum + (relevance.get(id) ?? 0) / Math.log2(index + 2), 0);
  const ideal = [...relevance.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, value, index) => sum + value / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}
