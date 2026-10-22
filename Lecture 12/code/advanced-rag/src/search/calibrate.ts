import type { ScoredChunk } from '../types.js';

/**
 * Threshold calibration — turning "0.75 sounds safe" into a number with evidence.
 *
 * The only honest way to choose a similarity floor is to measure both things it
 * controls at once:
 *
 *  - raise it, and unanswerable questions are correctly refused, but answerable
 *    ones lose their evidence;
 *  - lower it, and recall rises while the system starts answering from noise.
 *
 * So we sweep the floor, score each candidate floor on *balanced accuracy*
 * (mean of answerable recall and unanswerable refusal), and pick the best. Ties go
 * to the higher floor, because a higher floor sends fewer tokens to the model for
 * the same measured quality.
 */

export interface CalibrationCase {
  id: string;
  question: string;
  asOf: string;
  answerable: boolean;
  expectedSources: string[];
}

export interface CaseCandidates {
  testCase: CalibrationCase;
  /** Every candidate the retriever produced, already sorted, *before* any floor. */
  hits: ScoredChunk[];
}

export interface CalibrationRow {
  floor: number;
  /** Mean number of chunks that survive at this floor. */
  kept: number;
  /** Recall over the answerable cases. */
  recall: number;
  /** Share of unanswerable cases that end up with no evidence at all. */
  refusal: number;
  balanced: number;
}

export type FloorMode = 'absolute' | 'best';

export interface SweepOptions {
  floors?: readonly number[];
  /** How many chunks an answer may use. */
  k?: number;
  /**
   * `absolute` sweeps a per-chunk floor (used for the dense cosine scale).
   * `best` sweeps the threshold the *best* candidate must clear before any
   * evidence is used at all, with the relative cut applied on top. That is the
   * right shape for a reranker, whose scores are compressed per query: a fixed
   * per-chunk floor refuses legitimate questions whose terms happen to be common.
   */
  mode?: FloorMode;
  /** The relative cut used in `best` mode. */
  maxDrop?: number;
}

export interface CalibrationResult {
  rows: CalibrationRow[];
  recommended: number;
  note: string;
}

/** Floors to try. Dense cosine on real embeddings lives roughly in 0.1–0.6. */
export function defaultFloors(): number[] {
  return [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
}

export function sweepFloors(batches: readonly CaseCandidates[], options: SweepOptions = {}): CalibrationResult {
  const floors = options.floors ?? defaultFloors();
  const k = options.k ?? 5;
  const mode = options.mode ?? 'absolute';
  const maxDrop = options.maxDrop ?? 0.25;

  const rows = floors.map((floor) => {
    let kept = 0;
    let recallSum = 0;
    let answerable = 0;
    let refused = 0;
    let unanswerable = 0;

    for (const batch of batches) {
      const best = batch.hits[0]?.score ?? 0;
      const survivors =
        mode === 'best'
          ? best >= floor
            ? batch.hits.filter((hit) => hit.score >= best - maxDrop).slice(0, k)
            : []
          : batch.hits.filter((hit) => hit.score >= floor).slice(0, k);

      kept += survivors.length;

      if (batch.testCase.answerable) {
        answerable++;
        const sources = new Set(survivors.map((hit) => hit.chunk.source));
        const found = batch.testCase.expectedSources.filter((source) => sources.has(source)).length;
        recallSum += batch.testCase.expectedSources.length === 0
          ? 0
          : found / batch.testCase.expectedSources.length;
      } else {
        unanswerable++;
        if (survivors.length === 0) refused++;
      }
    }

    const recall = answerable === 0 ? 0 : recallSum / answerable;
    const refusal = unanswerable === 0 ? 1 : refused / unanswerable;

    return {
      floor,
      kept: Number((kept / Math.max(1, batches.length)).toFixed(2)),
      recall: Number(recall.toFixed(3)),
      refusal: Number(refusal.toFixed(3)),
      balanced: Number(((recall + refusal) / 2).toFixed(3)),
    };
  });

  const best = rows.reduce((winner, row) => {
    if (row.balanced > winner.balanced) return row;
    // Tie-break upward: same quality, fewer tokens, fewer chances to mislead.
    if (row.balanced === winner.balanced && row.floor > winner.floor) return row;
    return winner;
  }, rows[0]);

  return {
    rows,
    recommended: best.floor,
    note: `floor ${best.floor.toFixed(2)} → recall ${best.recall.toFixed(2)}, refusal ${best.refusal.toFixed(2)}, ~${best.kept} chunks per answer`,
  };
}
