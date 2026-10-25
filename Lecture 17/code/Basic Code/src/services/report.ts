import { config } from "../config/config.js";
import { coverageReport, dataset } from "../domain/dataset.js";
import type {
  Attribution,
  EvalCase,
  EvalReport,
  EvalResult,
  QualityOutcome,
  RetrievalScore,
} from "../domain/types.js";
import { runApp } from "./app.js";
import { runChecks } from "./deterministic.js";
import type { Judge } from "./judge.js";
import { classify, faithfulnessOf, pointwiseGate, scoreRetrieval } from "./retrieval.js";

/**
 * Chapter 02 §2.4 — **the eval loop**, and Chapter 09 §9.1 — the offline run.
 *
 * The loop is deliberately unglamorous:
 *
 * ```text
 * for each case:  run the app -> deterministic checks -> quality judging -> attribute
 * then:           aggregate per metric and per category -> compare to baseline -> gate
 * ```
 *
 * Two properties are load-bearing and easy to lose:
 *
 *  - **The trace is kept.** Chapter 08 §8.4 cannot attribute a failure without
 *    knowing what was retrieved and what was sent to the model.
 *  - **Deterministic and quality results stay separate.** When a score moves you
 *    want to know *which half* moved.
 */

/**
 * Chapter 06 §6.5 — bounded concurrency.
 *
 * 300 cases × a judge call each is slow and rate-limited. Fanning out
 * deliberately is the difference between a toy and a pipeline; fanning out
 * *unbounded* is how you get a 429 storm.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

/** One case, run once, judged. Chapter 08 §8.5 is the ordering: retrieve, then judge. */
export async function evaluateCase(
  testCase: EvalCase,
  options: { judge: Judge; topK: number },
): Promise<EvalResult> {
  const run = runApp(testCase.input, options.topK);

  const deterministic = runChecks(testCase, run);
  const retrieval = scoreRetrieval(testCase.expected.expectedDocs ?? [], run.retrieved);

  const judgeSpecs = testCase.evaluators.filter((evaluator) => evaluator.kind === "llmJudge");
  const hasQuality = judgeSpecs.length > 0;

  // Chapter 08 §8.5 — "response evaluation is only meaningful if the context was
  // available". Judging an answer against context that was never retrieved
  // measures the wrong thing, so it is skipped and attributed, not failed.
  const qualitySkipped = hasQuality && run.contextSent.length === 0;

  const quality: QualityOutcome[] = qualitySkipped
    ? []
    : await Promise.all(
        judgeSpecs.map((spec) =>
          options.judge.score({
            metric: spec.metric,
            question: testCase.input,
            answer: run.answer,
            context: run.contextSent,
            reference: testCase.goldenAnswer,
            scale: spec.scale,
          }),
        ),
      );

  const attribution = classify({
    retrieval,
    hasQuality,
    qualitySkipped,
    faithfulness: faithfulnessOf(quality),
    deterministic,
  });

  return {
    caseId: testCase.id,
    category: testCase.category,
    appVersion: run.version,
    response: run.answer,
    deterministic,
    quality,
    retrieval,
    attribution,
    usage: run.usage,
  };
}

export async function evaluateDataset(
  cases: EvalCase[],
  options: { judge: Judge; topK: number; concurrency?: number },
): Promise<EvalResult[]> {
  return mapWithConcurrency(cases, options.concurrency ?? 8, (testCase) =>
    evaluateCase(testCase, options),
  );
}

/** A case passes only if *every* check it declared passed. No partial credit. */
export function casePassed(result: EvalResult): boolean {
  return result.deterministic.every((check) => check.passed);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, places = 2): number {
  return Number(value.toFixed(places));
}

/** The set of cases a baseline run passed — the input to the regression check. */
export function passingIds(results: EvalResult[]): string[] {
  return results.filter(casePassed).map((result) => result.caseId);
}

/**
 * Chapter 02 §2.8 — the dataset-level report, and Chapter 04 §4.8 — the gate.
 *
 * Two deliberate choices:
 *
 *  - **Nothing is blended into one number.** Chapter 06 §6.5: aggregate *per
 *    metric* and *per category*. "Faithfulness dropped 0.6" is interesting;
 *    "faithfulness dropped 1.4 on adversarial cases" is a diagnosis.
 *  - **The gate names its reasons.** A blocked release that says *why* is
 *    reviewable; a red X is not.
 */
export function buildReport(
  results: EvalResult[],
  options: {
    baselinePassIds?: string[];
    minPassRate?: number;
    minFaithfulness?: number;
  } = {},
): EvalReport {
  const minPassRate = options.minPassRate ?? config.minPassRate;
  const minFaithfulness = options.minFaithfulness ?? config.minFaithfulness;
  const baselinePassIds = options.baselinePassIds ?? [];

  const deterministicPassRate = results.length === 0 ? 1 : passingIds(results).length / results.length;

  const byMetric = new Map<string, number[]>();

  for (const result of results) {
    for (const outcome of result.quality) {
      byMetric.set(outcome.metric, [...(byMetric.get(outcome.metric) ?? []), outcome.score]);
    }
  }

  const averages = Object.fromEntries(
    [...byMetric.entries()].map(([metric, scores]) => [metric, round(mean(scores))]),
  );

  const byCategory: Record<string, { cases: number; passRate: number }> = {};

  for (const category of dataset.categories) {
    const inCategory = results.filter((result) => result.category === category);
    byCategory[category] = {
      cases: inCategory.length,
      passRate: round(inCategory.length === 0 ? 0 : passingIds(inCategory).length / inCategory.length),
    };
  }

  const attribution: Record<Attribution, number> = { retrieval: 0, generation: 0, spec: 0, pass: 0 };

  for (const result of results) {
    attribution[result.attribution] += 1;
  }

  // Retrieval averages cover *applicable* cases only — see `scoreRetrieval`.
  const applicable = results.map((result) => result.retrieval).filter((score) => score.applicable);

  const retrieval = {
    hitRate: round(mean(applicable.map((score) => (score.hit ? 1 : 0)))),
    recall: round(mean(applicable.map((score) => score.recall))),
    precision: round(mean(applicable.map((score) => score.precision))),
    mrr: round(
      mean(
        applicable
          .filter((score) => score.firstRelevantRank !== null)
          .map((score) => 1 / (score.firstRelevantRank ?? 1)),
      ),
    ),
  };

  // §4.8 — "fail the build on regressions, not on noise": a regression list is
  // actionable; a floating average is not.
  const regressions = results
    .filter((result) => baselinePassIds.includes(result.caseId) && !casePassed(result))
    .map((result) => result.caseId);

  const quality = pointwiseGate(averages, minFaithfulness);
  const reasons: string[] = [];

  if (regressions.length > 0) {
    reasons.push(`${regressions.length} case(s) regressed: ${regressions.join(", ")}`);
  }

  if (deterministicPassRate < minPassRate) {
    reasons.push(`deterministic pass rate ${round(deterministicPassRate)} < ${minPassRate}`);
  }

  reasons.push(...quality.reasons.filter((reason) => reason.includes("<")));

  return {
    appVersion: results[0]?.appVersion ?? "unknown",
    datasetRevision: dataset.revision,
    cases: results.length,
    deterministicPassRate: round(deterministicPassRate),
    averages,
    byCategory,
    attribution,
    retrieval,
    regressions,
    gate: { blocked: reasons.length > 0, reasons },
    coverage: coverageReport(),
    cost: {
      tokens: results.reduce((sum, result) => sum + result.usage.tokens, 0),
      usd: round(
        results.reduce((sum, result) => sum + result.usage.usd, 0),
        6,
      ),
      avgMs: round(mean(results.map((result) => result.usage.ms))),
    },
  };
}

/**
 * Chapter 07 §7.5 — **pairwise evaluation**: compare two candidates instead of
 * scoring one.
 *
 * Two things the lecture insists on, both implemented here:
 *
 *  - **Run both orders.** If a candidate wins in *both* orders it is a real
 *    improvement; if it only wins when it appears first, you measured position
 *    bias rather than quality.
 *  - **Report a win rate, not a score.** `wins / (wins + losses)`, ties excluded,
 *    which is the only number pairwise can honestly produce.
 *
 * The comparison is between two `topK` settings, because that is exactly §7.5's
 * "RAG configurations" case — and it is the lever Chapter 01's regression story
 * turns on.
 */
export interface PairwiseComparison {
  caseId: string;
  firstOrder: "A" | "B" | "tie";
  swappedOrder: "A" | "B" | "tie";
  winner: "A" | "B" | "tie";
  positionBias: boolean;
  reason: string;
}

export interface PairwiseReport {
  labelA: string;
  labelB: string;
  cases: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  positionBiasCases: string[];
  comparisons: PairwiseComparison[];
}

export async function compareConfigurations(
  cases: EvalCase[],
  a: { label: string; topK: number },
  b: { label: string; topK: number },
  judge: Judge,
): Promise<PairwiseReport> {
  const comparisons: PairwiseComparison[] = [];

  for (const testCase of cases) {
    const runA = runApp(testCase.input, a.topK);
    const runB = runApp(testCase.input, b.topK);

    // The context is the union of both runs, so neither candidate is judged
    // against context that only the other one managed to retrieve.
    const context = [...new Set([...runA.contextSent, ...runB.contextSent])];
    const question = testCase.input;

    const first = await judge.prefer({
      question,
      answerA: runA.answer,
      answerB: runB.answer,
      context,
    });

    // The swapped order: the same two answers, positions exchanged.
    const swapped = await judge.prefer({
      question,
      answerA: runB.answer,
      answerB: runA.answer,
      context,
    });

    // Translate the swapped verdict back into A/B space.
    const swappedAsA = swapped.winner === "tie" ? "tie" : swapped.winner === "A" ? "B" : "A";
    const positionBias = first.winner !== swappedAsA;

    comparisons.push({
      caseId: testCase.id,
      firstOrder: first.winner,
      swappedOrder: swapped.winner,
      // A contradictory pair is not a win for anybody.
      winner: positionBias ? "tie" : first.winner,
      positionBias,
      reason: first.reason,
    });
  }

  const wins = comparisons.filter((comparison) => comparison.winner === "A").length;
  const losses = comparisons.filter((comparison) => comparison.winner === "B").length;
  const ties = comparisons.filter((comparison) => comparison.winner === "tie").length;

  return {
    labelA: a.label,
    labelB: b.label,
    cases: comparisons.length,
    wins,
    losses,
    ties,
    winRate: wins + losses === 0 ? 0 : round(wins / (wins + losses)),
    positionBiasCases: comparisons.filter((comparison) => comparison.positionBias).map((c) => c.caseId),
    comparisons,
  };
}
