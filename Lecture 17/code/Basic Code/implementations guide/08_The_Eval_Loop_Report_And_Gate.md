# Chapter 08 — The Eval Loop, the Report and the Gate

> **This is where the pieces meet.** One case becomes a result; nine results become a report; the
> report becomes a decision with a reason attached. And, because Chapter 07's pairwise comparison
> needs to run two candidates, it lives here too.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/report.ts` (353 lines) |
| **Layer** | services — the composition layer |
| **Purpose** | run the loop, aggregate, diff against a baseline, gate, and compare two configurations |
| **Exports** | `evaluateCase()`, `evaluateDataset()`, `casePassed()`, `passingIds()`, `buildReport()`, `compareConfigurations()`, `PairwiseComparison`, `PairwiseReport` |
| **Imports** | `config`, `domain/dataset`, `domain/types`, `app`, `deterministic`, `judge`, `retrieval` |
| **Notes sections** | Ch02 §2.4 (the loop) / §2.8 (the report), Ch04 §4.8 (the gate), Ch06 §6.5 (bounded concurrency), Ch07 §7.5 (pairwise), Ch08 §8.5 (the pipeline) |

**This file imports every other service, and nothing imports it except the controller and the CLI.**
That is the shape of a composition layer, and it is why the file is long: it is where the lecture's
architecture is *assembled* rather than where any one idea lives.

---

## Commands

```bash
npm run eval --silent                                              # the gate, pass
npm run eval --silent -- --topk=1 --baseline=3                     # the gate, blocked
npm run eval --silent -- --topk=1 --baseline=3 --pairwise          # + the win rate
```

```text
  pairwise      topK=1 vs topK=3 · win rate 0 (0W / 1L / 8T) · no position bias

GATE BLOCKED
  - 1 case(s) regressed: warranty-and-return
  - deterministic pass rate 0.89 < 0.95
```

---

## `src/services/report.ts` — the full file

```ts
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
```

### Block-by-block

**Block 1 — `mapWithConcurrency`, the bounded fan-out (Chapter 06 §6.5).**

```ts
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
```

Fifteen lines, and it is the difference between a toy and a pipeline. §6.5 names both failure modes:
**unbounded** fan-out is how you get a 429 storm, and **serial** fan-out is how a 300-case dataset
takes twenty minutes and stops being run.

Three details worth noticing:

- **`results[index] = …` preserves input order.** A worker pool that pushed results as they arrived
  would return them in completion order, and a report whose case order changes between runs is a
  report nobody can diff.
- **The shared `next` counter is safe** because JavaScript is single-threaded — a worker only yields
  at `await`, and the increment happens before it. This is the one place where a language-level
  guarantee is load-bearing, so it is worth being explicit that it *is* safe rather than lucky.
- **`limit` workers, not `items.length`.** `Math.min(limit, items.length)` avoids spawning 8 workers
  for a 3-case dataset.

**Block 2 — `evaluateCase`: the loop body (Chapter 08 §8.5, Chapter 06 §6.5).**

```ts
export async function evaluateCase(testCase: EvalCase, options: { judge: Judge; topK: number }): Promise<EvalResult> {
  const run = runApp(testCase.input, options.topK);

  const deterministic = runChecks(testCase, run);
  const retrieval = scoreRetrieval(testCase.expected.expectedDocs ?? [], run.retrieved);

  const judgeSpecs = testCase.evaluators.filter((evaluator) => evaluator.kind === "llmJudge");
  const hasQuality = judgeSpecs.length > 0;

  const qualitySkipped = hasQuality && run.contextSent.length === 0;

  const quality: QualityOutcome[] = qualitySkipped
    ? []
    : await Promise.all(judgeSpecs.map((spec) => options.judge.score({
        metric: spec.metric,
        question: testCase.input,
        answer: run.answer,
        context: run.contextSent,
        reference: testCase.goldenAnswer,
        scale: spec.scale,
      })));

  const attribution = classify({ retrieval, hasQuality, qualitySkipped,
                                 faithfulness: faithfulnessOf(quality), deterministic });

  return { caseId: testCase.id, category: testCase.category, appVersion: run.version,
           response: run.answer, deterministic, quality, retrieval, attribution, usage: run.usage };
}
```

The ordering is Chapter 08 §8.5's pipeline, and it is not arbitrary:

1. **Run the system once**, capturing the trace.
2. **Deterministic checks** — free, and they run first because a format failure makes the quality
   scores uninteresting.
3. **Retrieval** — set arithmetic, also free, and it decides whether step 4 is meaningful.
4. **Quality** — the only step that can cost money, and it is **skipped** when there was no context.

That skip is §8.5's sharpest detail: *"response evaluation is only meaningful if the context was
available."* Judging faithfulness against an empty context measures nothing, and marking it
`skipped` — which `classify` then attributes to retrieval — is the difference between a report that
says *"the model hallucinated"* and one that says *"there was nothing to answer from."*

`Promise.all` over the judge specs runs the metrics for one case concurrently. The *cross-case*
concurrency is the worker pool; the *cross-metric* concurrency is here. Both are bounded, and both
are deliberate.

**Block 3 — `evaluateDataset` and `casePassed`: the pass rule.**

```ts
export async function evaluateDataset(cases: EvalCase[], options: { judge: Judge; topK: number; concurrency?: number }): Promise<EvalResult[]> {
  return mapWithConcurrency(cases, options.concurrency ?? 8, (testCase) => evaluateCase(testCase, options));
}

export function casePassed(result: EvalResult): boolean {
  return result.deterministic.every((check) => check.passed);
}
```

`casePassed` is one line and it is a **policy**, so it is worth stating plainly: **no partial
credit.** A case passes only if every check it declared passed. Five checks green and one red is a
failure.

That is the right default for a regression gate — §4.8's *"fail the build on regressions, not on
noise"* — because a case with a failing check is a case where something specific is wrong, and the
`detail` on that check says what. An 83%-passing case would be a case nobody fixes.

**Block 4 — `passingIds`, `mean`, `round`: the small helpers.**

```ts
export function passingIds(results: EvalResult[]): string[] {
  return results.filter(casePassed).map((result) => result.caseId);
}
```

This is how a **baseline** is represented: not as a score, but as *the set of case ids that passed*.
That representation is what makes the regression check possible at all — `buildReport` compares two
sets of ids, which is §4.8's *"a regression list is actionable; a floating average is not."*

`mean` and `round` exist to keep every number in the report to two decimal places. That is not
cosmetic: a report that prints `4.600000000000001` invites a reader to treat noise as signal.

**Block 5 — `buildReport`, part 1: the aggregations (Chapter 02 §2.8, Chapter 06 §6.5).**

```ts
const byMetric = new Map<string, number[]>();
for (const result of results) {
  for (const outcome of result.quality) {
    byMetric.set(outcome.metric, [...(byMetric.get(outcome.metric) ?? []), outcome.score]);
  }
}
const averages = Object.fromEntries([...byMetric.entries()].map(([metric, scores]) => [metric, round(mean(scores))]));
```

This is §6.5's rule in code — *"aggregate per metric and per category — never a single blended
number"* — and the shape of the loop is the whole argument. Scores are collected **keyed by metric**,
so the output is `{ faithfulness: 5, relevance: 5 }` rather than `4.9`. A blended score would hide
the case where faithfulness is 3 and relevance is 5, which is a completely different system from one
where both are 4.

```ts
const byCategory: Record<string, { cases: number; passRate: number }> = {};
for (const category of dataset.categories) {
  const inCategory = results.filter((result) => result.category === category);
  byCategory[category] = { cases: inCategory.length,
                           passRate: round(inCategory.length === 0 ? 0 : passingIds(inCategory).length / inCategory.length) };
}
```

Note it iterates `dataset.categories`, not the results — the same "start from the promise" trick as
the coverage report. A category with no cases still appears, with `passRate: 0`, rather than silently
vanishing from the report.

**The retrieval averages are computed over *applicable* results only:**

```ts
const applicable = results.map((result) => result.retrieval).filter((score) => score.applicable);

const retrieval = {
  hitRate:   round(mean(applicable.map((score) => (score.hit ? 1 : 0)))),
  recall:    round(mean(applicable.map((score) => score.recall))),
  precision: round(mean(applicable.map((score) => score.precision))),
  mrr:       round(mean(applicable.filter((s) => s.firstRelevantRank !== null)
                                    .map((s) => 1 / (s.firstRelevantRank ?? 1)))),
};
```

The MRR line is worth reading twice. `mean reciprocal rank` is the average of `1/rank` **for cases
where a relevant document was found at all** — so the filter is not an optimisation, it is the
definition. Including cases with `firstRelevantRank: null` would require inventing a value for
"never found", and any choice you made would be wrong in a way that is hard to notice.

This is also where the `topK=1` run's counter-intuitive MRR comes from: with one document retrieved,
the first relevant document is always at rank 1, so `1/1 = 1`. The metric is correct; it is simply
measuring ranking quality, which improves when you retrieve less.

**Block 6 — the gate: regressions first, then thresholds (Chapter 04 §4.8).**

```ts
const regressions = results
  .filter((result) => baselinePassIds.includes(result.caseId) && !casePassed(result))
  .map((result) => result.caseId);

const quality = pointwiseGate(averages, minFaithfulness);
const reasons: string[] = [];

if (regressions.length > 0) reasons.push(`${regressions.length} case(s) regressed: ${regressions.join(", ")}`);
if (deterministicPassRate < minPassRate) reasons.push(`deterministic pass rate ${round(deterministicPassRate)} < ${minPassRate}`);
reasons.push(...quality.reasons.filter((reason) => reason.includes("<")));

return { … gate: { blocked: reasons.length > 0, reasons }, … };
```

Three things about this block:

**The regression check is a *diff*, not a threshold.** It asks "was this case passing in the baseline
and failing now?" — §4.8's distinction between *"a case regressed"* and *"the average dipped"*. Both
are checked, but only the first is a regression; the second is a quality bar.

**The reasons accumulate rather than short-circuiting.** A run can be blocked for two independent
reasons, and reporting only the first would mean fixing it and re-running to discover the second.

**`quality.reasons.filter((reason) => reason.includes("<"))`** is a small, slightly awkward line worth
explaining: `pointwiseGate` returns a reason whether it passes or fails, because a passing gate should
still say what it was measured against. So the gate filters to the failing ones here, and the CLI
prints the passing ones as information. Having `pointwiseGate` return only failures would make the
successful case silent — and a silent success is what makes people stop trusting a gate.

**Block 7 — `compareConfigurations`: pairwise, in both orders (Chapter 07 §7.5).**

```ts
const first = await judge.prefer({ question, answerA: runA.answer, answerB: runB.answer, context });
const swapped = await judge.prefer({ question, answerA: runB.answer, answerB: runA.answer, context });

const swappedAsA = swapped.winner === "tie" ? "tie" : swapped.winner === "A" ? "B" : "A";
const positionBias = first.winner !== swappedAsA;

comparisons.push({ caseId: testCase.id, firstOrder: first.winner, swappedOrder: swapped.winner,
                   winner: positionBias ? "tie" : first.winner, positionBias, reason: first.reason });
```

**Every case is judged twice, with the answers exchanged.** §7.5 is unambiguous about why: *"if a
candidate wins in both orders, that is a real improvement. If it only wins when it appears first, you
measured position bias."* One call per case would produce a number that looks like a benchmark and is
partly a measurement of where the answers were placed.

The `swappedAsA` translation is the fiddly part, worth tracing once. The second call passes
`answerA: runB.answer`, so its `"A"` means *B won*. To compare the verdicts they must be in the same
space, so the swapped verdict is mapped back: `swapped.winner === "A"` → `"B"`, and vice versa.

**A contradictory pair is scored as a tie, not a win.** `winner: positionBias ? "tie" : first.winner`
is the conservative reading — a case that produced two different verdicts has not established
anything, and counting it for the first answer would inflate the win rate with noise.

**The context is the union of both runs:**

```ts
const context = [...new Set([...runA.contextSent, ...runB.contextSent])];
```

Neither candidate is judged against context that only the other one managed to retrieve. Without this,
`topK=1` would be penalised twice — once for retrieving less, and again for being judged without the
documents `topK=3` had. The comparison would then measure the *harness* rather than the candidates.

**The win rate, and the caveat:**

```ts
winRate: wins + losses === 0 ? 0 : round(wins / (wins + losses))
```

Ties are excluded from the denominator, per §7.5's formula. `0W / 1L / 8T` is the honest outcome of
comparing `topK=1` against `topK=3`: one case where the answers differ, eight where they are identical.

> **The caveat the endpoint states out loud.** A deterministic stand-in judge **cannot** exhibit
> position bias — the same two answers always produce the same verdict, in either order. So
> `positionBiasCases: []` here is not evidence that the judge is unbiased; it is evidence that the
> check has not been exercised. The `/pairwise` response says exactly this in its `note` field,
> because a green result that means nothing is worse than a red one.

---

## Checkpoint

1. **Why does `evaluateCase` skip the judge when `contextSent` is empty?**
   Because §8.5 says response evaluation is only meaningful when the context was available. Judging
   faithfulness against nothing measures nothing, and marking it `skipped` is what lets `classify`
   attribute the case to retrieval instead of blaming the model.

2. **Why is a baseline a set of case ids rather than a score?**
   Because a regression is a *diff*: "this case passed before and fails now". A score cannot express
   that, which is why §4.8 says a regression list is actionable and a floating average is not.

3. **Why does the gate collect reasons instead of returning on the first failure?**
   So a run blocked for two independent reasons says so in one report, rather than making you fix one
   and re-run to discover the next.

4. **Why is every pairwise case judged twice, and why does the context union both runs?**
   Twice, because §7.5's position-bias check requires it. The union, so neither candidate is judged
   against documents only the other one retrieved — otherwise the comparison measures the harness.

---

**[Chapter 09: Online Evaluation and the Loop →](./09_Online_Evaluation_And_The_Loop.md)**
