import type { ScoredChunk } from '../types.js';

/**
 * Reciprocal Rank Fusion — and the mistake it exists to prevent.
 *
 * RRF ignores the scores entirely and fuses *ranks*:
 *
 *     score(doc) = Σ over lists  1 / (k + rank_in_list(doc)),   k = 60
 *
 * The constant `k` damps the top of each list. With k = 60, rank 1 contributes
 * 1/61 = 0.01639 and rank 10 contributes 1/70 = 0.01429 — a 13% difference
 * instead of a 10× difference. That is deliberate: a bi-encoder's 0.83 versus
 * 0.81 says almost nothing, while BM25's 12.4 versus 9.1 says a lot, and there is
 * no principled way to put those two numbers on one scale.
 *
 * `scoreFusion` below is the anti-pattern, kept in the file on purpose. It looks
 * reasonable, it runs, and it silently deletes one of the two signals.
 */

export interface HybridOptions {
  /** RRF constant. 60 is the value from the original paper and a safe default. */
  rrfK: number;
  /** How deep to read each list. Fusing 100 ranks is not better than fusing 25. */
  depth: number;
}

export interface HybridResult {
  hits: ScoredChunk[];
  /** Documents that appeared in both lists — the ones hybrid search rescued. */
  agreement: number;
  denseMs: number;
  lexicalMs: number;
}

/**
 * Fuse ranked lists. Rank starts at 1, not 0: `1/(60+0)` would make the top hit
 * contribute more than the entire rest of the list combined.
 */
export function rrf(lists: ReadonlyArray<readonly ScoredChunk[]>, k: number, depth = 100): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk['chunk']; score: number; bestRank: number }>();

  for (const list of lists) {
    list.slice(0, depth).forEach((hit, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const existing = fused.get(hit.chunk.id);

      if (existing) {
        existing.score += contribution;
        existing.bestRank = Math.min(existing.bestRank, rank);
      } else {
        fused.set(hit.chunk.id, { chunk: hit.chunk, score: contribution, bestRank: rank });
      }
    });
  }

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank || left.chunk.id.localeCompare(right.chunk.id))
    .map((entry) => ({ chunk: entry.chunk, score: entry.score, origin: 'fused' as const }));
}

/**
 * The anti-pattern: normalise each list by its own maximum, then add the numbers.
 *
 * It fails because normalisation preserves *shape*, not *meaning*. BM25 scores are
 * unbounded and often spread over 0–15; cosine scores live in a narrow band around
 * 0.2–0.9. Dividing each by its max makes both top out at 1.0, so a document that
 * BM25 loved twice as much as the next one looks identical to a document that the
 * bi-encoder merely liked. Worse, a single outlier flattens every other score in
 * the list toward zero, and the other signal takes over.
 */
export function scoreFusion(
  lists: ReadonlyArray<readonly ScoredChunk[]>,
  weights: readonly number[],
): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk['chunk']; score: number }>();

  lists.forEach((list, listIndex) => {
    const max = Math.max(...list.map((hit) => hit.score), Number.EPSILON);
    const weight = weights[listIndex] ?? 1;

    for (const hit of list) {
      const contribution = (hit.score / max) * weight;
      const existing = fused.get(hit.chunk.id);
      if (existing) existing.score += contribution;
      else fused.set(hit.chunk.id, { chunk: hit.chunk, score: contribution });
    }
  });

  return [...fused.values()]
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({ chunk: entry.chunk, score: entry.score, origin: 'fused' as const }));
}

/** How many documents the two lists agree on — the number that predicts the gain. */
export function agreement(dense: readonly ScoredChunk[], lexical: readonly ScoredChunk[]): number {
  const denseIds = new Set(dense.map((hit) => hit.chunk.id));
  return lexical.filter((hit) => denseIds.has(hit.chunk.id)).length;
}
