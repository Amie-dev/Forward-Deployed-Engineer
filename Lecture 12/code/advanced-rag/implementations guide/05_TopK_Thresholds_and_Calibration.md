# Chapter 05: Top-K, Thresholds and Calibration

> **Chapter Goal:** Decide how much evidence to ask for and how good it has to be — and make
> both decisions *measured*. This chapter produces the two numbers that the rest of the
> pipeline depends on, and shows what happens when they are guessed instead.

> **Lecture mapping:** Notes Chapter 04 — the anatomy of a retrieval request, K_retrieve
> versus K_context, the score floor, MMR, and the fact that a similarity score is not a
> confidence.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/search/dense.ts` | 125 | embed → search → floor → MMR, with the two-K split |
| `src/search/calibrate.ts` | 134 | floor sweeps, two modes, balanced accuracy |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- calibrate                     # both floors, swept against the golden set
MIN_SCORE=0.05 npm run cli -- eval           # watch recall rise and refusal collapse
K_RETRIEVE=4 npm run cli -- ablation         # the recall ceiling, measured
```

---

## 2. Measured Output

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts calibrate

Calibration over 14 golden cases (27 chunks)

Dense floor — hash-1024-v1
floor  chunks/answer  recall  refusal  balanced
─────  ─────────────  ──────  ───────  ────────  ──────
0.05   4.5            0.875   0.000    0.438
0.10   3.8            0.833   0.500    0.667
0.15   2.9            0.750   1.000    0.875     ← pick
0.20   1.0            0.333   1.000    0.667
0.25   0.4            0.250   1.000    0.625
0.30   0.1            0.083   1.000    0.542
0.35   0.0            0.000   1.000    0.500
0.40   0.0            0.000   1.000    0.500
0.45   0.0            0.000   1.000    0.500
0.50   0.0            0.000   1.000    0.500
0.55   0.0            0.000   1.000    0.500
0.60   0.0            0.000   1.000    0.500
floor 0.15 → recall 0.75, refusal 1.00, ~2.93 chunks per answer

Rerank floor — heuristic scorer
floor  chunks/answer  recall  refusal  balanced
─────  ─────────────  ──────  ───────  ────────  ──────
0.10   4.5            0.958   0.500    0.729
0.15   4.5            0.958   0.500    0.729
0.20   4.1            0.958   1.000    0.979
0.25   4.1            0.958   1.000    0.979     ← pick
0.30   3.8            0.875   1.000    0.938
0.35   3.8            0.875   1.000    0.938
0.40   3.4            0.833   1.000    0.917
0.45   3.1            0.750   1.000    0.875
0.50   2.4            0.583   1.000    0.792
0.60   2.0            0.500   1.000    0.750
floor 0.25 → recall 0.96, refusal 1.00, ~4.14 chunks per answer

Balanced = mean(answerable recall, unanswerable refusal). Ties go to the higher
floor: same measured quality for fewer tokens. Set MIN_SCORE and
RERANK_MIN_BEST from this output, and re-run it whenever the embedder, the
corpus or the reranker changes.
```

Two sweeps, and they disagree — which is the lesson.

**The dense floor** peaks at **0.15**: recall 0.75 with refusal 1.00 and ~2.9 chunks per
answer. Push it to 0.20 and recall collapses to 0.33, because cosine scores from the offline
embedder live in a narrow band; push it down to 0.05 and refusal drops to 0.00, because with
no floor *something* always looks relevant.

**The rerank floor** peaks at **0.25**: recall 0.958 with refusal 1.00. The same number on
the same corpus, but a completely different scale, because a reranker's scores are not a
cosine. Applying the dense floor to the reranker (or vice versa) is a mistake that looks like
a model problem.

The `chunks/answer` column is the cost side: at floor 0.40 the rerank sweep still gets 3.4
chunks per answer, but recall has fallen to 0.833. Floors trade recall for tokens, and the
sweep is how you see the exchange rate.


---

## 3. Dense Retrieval — `src/search/dense.ts`

```ts
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
```

**Block by block:**

- **`DenseOptions` has four knobs and each maps to a documented failure mode**:
  `kRetrieve` is the recall ceiling, `minScore` decides when nothing was found, `mmrLambda`
  trades relevance for diversity, and `queryPrefix` is the asymmetric-model trap.
- **`kRetrieve` is a width, not a quality setting.** Whatever is not in this list can never be
  reranked into the answer, so a reranker cannot fix a `kRetrieve` that is too small. The
  ablation shows the whole curve: `naive` uses 4, everything else uses 25.
- **The floor is applied before MMR and before fusion**, so a chunk that is not evidence of
  anything never occupies a slot. `belowFloor` is reported because "we retrieved 25 and threw
  15 away" is a calibration signal, not a footnote.
- **`queryPrefix`** exists because E5/BGE-style models are trained with `search_query:` and
  `search_document:` prefixes. Omitting them costs several points of recall and produces no
  error at all — the worst kind of bug. OpenAI's models want no prefix, which is why the
  default is empty.
- **`mmr` divides relevance by the best score before combining it with the diversity term.**
  Without that, a cosine of 0.7 and a redundancy penalty of 0.9 are being compared as if they
  meant the same thing, and λ stops being interpretable. It is `0` by default here because
  the corpus has few near-duplicates — but the mechanism is what stops five paraphrases of
  the same rule from filling the window.
- **`applyFloor` is exported** because calibration sweeps exactly this operation. The metric
  function and the production path share one implementation.

---

## 4. Calibration — `src/search/calibrate.ts`

```ts
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
```

**Block by block:**

- **`sweepFloors` measures two things at once**: recall over the answerable cases and refusal
  over the unanswerable ones. Optimising either alone is trivial and useless — floor 0 gives
  perfect recall and never refuses; floor 1 refuses everything.
- **`balanced` is the mean of the two**, and that is the objective. It is deliberately simple:
  a weighted F-score needs weights nobody can justify, and the honest answer is "both matter
  equally, and the sweep shows the trade-off curve".
- **Ties break upward.** At equal balanced accuracy the higher floor wins, because it uses
  fewer tokens per answer and gives the model less to be misled by. This is the only
  tie-break that is defensible in a review.
- **`mode: 'absolute'`** sweeps a per-chunk floor — correct for a cosine scale.
- **`mode: 'best'`** sweeps the threshold the *best* candidate must clear, with the relative
  cut applied on top — correct for a reranker, whose scores are compressed per query. A fixed
  per-chunk floor on a reranker refuses legitimate questions whose terms happen to be common;
  the guide's Chapter 08 shows the case where that happened (`q05`, an exchange question).
- **`CaseCandidates` takes candidates *before* the floor**, so one embedding pass serves the
  whole sweep. Twelve floors × 14 cases would otherwise be 168 retrievals instead of 14.

---

## 5. Reading the Floor

| floor | recall | refusal | balanced | chunks/answer | what it means in production |
| ---: | ---: | ---: | ---: | ---: | :--- |
| 0.05 | 0.875 | 0.000 | 0.438 | 4.5 | answers everything, including questions it cannot answer |
| 0.10 | 0.833 | 0.500 | 0.667 | 3.8 | half the unanswerable questions get an answer |
| **0.15** | **0.750** | **1.000** | **0.875** | **2.9** | the calibrated default for the offline embedder |
| 0.20 | 0.333 | 1.000 | 0.667 | 1.0 | too strict: three quarters of the corpus is unreachable |
| 0.35+ | 0.000 | 1.000 | 0.500 | 0.0 | the system refuses every question, and looks "safe" |

The last row is the trap. A floor high enough to make every refusal correct is a system that
has stopped working, and it will pass any test suite that only checks for hallucination.

**Re-calibrate when the embedder, the corpus or the chunking changes.** The floor is a
property of a *distribution*, and every one of those changes the distribution.

---

## 6. What to Take Away

- **Two Ks, not one.** `K_RETRIEVE` sets the recall ceiling; `K_CONTEXT` sets the token bill.
- **A floor is calibrated, never guessed.** `npm run cli -- calibrate` is the procedure, and it
  takes a second.
- **Measure recall and refusal together.** A single number hides the trade-off that decides
  whether your system is useful or merely quiet.
- **Ties break upward.** Fewer tokens for the same measured quality.
- **MMR is for redundancy, and it needs vectors.** It is the fix for five paraphrases of one
  rule crowding out the exception.
- **Check the prefix convention of your embedding model.** It is free recall with no error
  message when you get it wrong.

> **Where This Goes Next:** [Chapter 06](./06_Metadata_Filters_ACL_and_Time.md) adds the
> control that runs *before* any scoring: which documents are eligible at all.

