import type { EmbeddingProvider } from '../embeddings.js';
import { cosine } from '../lib/vectors.js';
import { compileFilter, type Filter } from '../store/filters.js';
import type { MemoryVectorStore } from '../store/vector-store.js';
import type { AccessContext, DenseCandidate } from '../types.js';

/**
 * Dense retrieval: embed, search, floor, diversify.
 *
 * The four knobs here are the four ways this stage goes wrong:
 *
 *  - `kRetrieve` sets the *recall ceiling*. Whatever is not in this list can never
 *    be reranked into the answer, so this is a width, not a quality setting.
 *  - `minScore` decides when the system has found nothing. It is calibrated on a
 *    golden set (see `calibrate.ts`), never guessed.
 *  - `mmrLambda` trades relevance for diversity. It is the fix for five near
 *    duplicates crowding out the one chunk that contradicts them.
 *  - The query prefix. Asymmetric models are trained with `search_query:` and
 *    `search_document:` prefixes; omitting them costs several points of recall and
 *    produces no error at all.
 */

export interface DenseOptions {
  kRetrieve: number;
  minScore: number;
  /** 0 = off, 1 = pure relevance, 0.5 = balanced. */
  mmrLambda: number;
  /** e.g. `search_query: ` for E5/BGE-style models. Empty for OpenAI models. */
  queryPrefix?: string;
}

export interface DenseResult {
  hits: DenseCandidate[];
  /** Everything the index scored before the floor was applied. */
  candidates: number;
  /** Documents that passed the metadata/ACL predicate. */
  eligible: number;
  belowFloor: number;
  embedMs: number;
  searchMs: number;
}

export async function denseSearch(
  store: MemoryVectorStore,
  embeddings: EmbeddingProvider,
  question: string,
  access: AccessContext,
  filter: Filter | undefined,
  options: DenseOptions,
): Promise<DenseResult> {
  const embedStarted = performance.now();
  const [vector] = await embeddings.embed([`${options.queryPrefix ?? ''}${question}`]);
  const embedMs = performance.now() - embedStarted;

  if (!vector) throw new Error('The embedding provider returned no vector for the query.');

  const searchStarted = performance.now();
  const result = store.query({
    vector,
    topK: options.kRetrieve,
    predicate: compileFilter(filter, access),
  });
  const searchMs = performance.now() - searchStarted;

  const aboveFloor = result.hits.filter((hit) => hit.score >= options.minScore);
  const diversified =
    options.mmrLambda > 0 && options.mmrLambda < 1
      ? mmr(aboveFloor, options.mmrLambda, options.kRetrieve)
      : aboveFloor;

  return {
    hits: diversified,
    candidates: result.hits.length,
    eligible: result.eligible,
    belowFloor: result.hits.length - aboveFloor.length,
    embedMs,
    searchMs,
  };
}

/**
 * Maximal Marginal Relevance.
 *
 * Greedy selection: at each step take the candidate that maximises
 * `λ · relevance − (1 − λ) · max similarity to anything already selected`.
 *
 * Relevance is divided by the best score so that the two terms live on the same
 * 0–1 scale. Without that, a cosine of 0.7 and a diversity penalty of 0.9 are
 * being compared as if they meant the same thing, and λ stops being interpretable.
 */
export function mmr(hits: readonly DenseCandidate[], lambda: number, k: number): DenseCandidate[] {
  if (hits.length <= 1) return [...hits];

  const best = hits[0].score || 1;
  const remaining = [...hits];
  const selected: DenseCandidate[] = [];

  while (remaining.length > 0 && selected.length < k) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;

    remaining.forEach((candidate, index) => {
      const relevance = candidate.score / best;
      const redundancy = selected.length === 0
        ? 0
        : Math.max(...selected.map((chosen) => cosine(candidate.vector, chosen.vector)));
      const value = lambda * relevance - (1 - lambda) * redundancy;

      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });

    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
  }

  return selected;
}

/** Kept as a named export because calibration sweeps exactly this operation. */
export function applyFloor<T extends { score: number }>(hits: readonly T[], floor: number): T[] {
  return hits.filter((hit) => hit.score >= floor);
}
