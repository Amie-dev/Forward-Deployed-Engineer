# Chapter 06 — LLM-as-a-Judge, Metrics and Rubrics

> **A second model can score meaning at scale — but it is a measuring instrument, not ground
> truth.** This chapter is the five metrics, the rubrics that make them reproducible, the
> structured output that makes them usable, and the seam that lets the same pipeline run with
> or without a model.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/judge.ts` (393 lines) |
| **Layer** | services |
| **Purpose** | score the metrics code cannot decide; compare two answers pairwise |
| **Exports** | `FAITHFULNESS_RUBRIC`, `RELEVANCE_RUBRIC`, `rubricFor()`, `JudgeInput`, `Judge`, `PreferenceVerdict`, `PreferenceInput`, `createJudge()` |
| **Imports** | `config`, `domain/types`, `services/app` (for `tokens`), `openai` **dynamically** |
| **Notes sections** | Ch05 §5.3 (the five metrics), Ch06 §6.3–6.5 (inputs, structured output, the loop), Ch07 §7.2/§7.5 (rubric, pairwise) |

**This is the largest file in the project, and it carries three chapters.** That is not an
accident of packaging: metrics, rubrics and the judge prompt are one subject — *how do you get a
reproducible number out of a thing that only understands meaning?* — and splitting them across
files would hide that.

---

## Commands

```bash
# the quality half of a run, with the judge's reason for every score
curl -s 'http://127.0.0.1:8080/eval?topk=3' | python3 -c '
import json,sys
for c in json.load(sys.stdin)["cases"]:
    for q in c["quality"]: print(f"{c[\"id\"]:22} {q[\"metric\"]:13} {q[\"score\"]}  {q[\"reason\"]}")'
```

```text
return-window          faithfulness  5  100% of answer claims are supported by the retrieved context
return-window          relevance     5  2 of 2 question terms appear in the answer
```

**Every score has a reason, and every reason is checkable.** That is the difference between a
judge you can debug and a number you have to trust.

---

## `src/services/judge.ts` — the full file

```ts
import { config } from "../config/config.js";
import type { MetricName, QualityOutcome, Scale } from "../domain/types.js";
import { tokens } from "./app.js";

/**
 * Chapter 06 — **LLM-as-a-Judge**: a second model scores meaning at scale.
 *
 * The lecture is careful about what a judge *is*, and this file keeps the same
 * posture. A judge is a **measuring instrument, not ground truth**: it is
 * reproducible only if its prompt, inputs and rubric are pinned, which is why
 * every score carries a `judgeVersion`.
 *
 * Two things are worth reading before the code:
 *
 *  1. **The rubric is the interface.** Chapter 07 §7.2's faithfulness rubric is
 *     reproduced verbatim below, because a score with no behaviour-anchored
 *     rubric is just a number someone liked.
 *  2. **The offline path is a stand-in, and it says so.** With no API key the
 *     judge scores against the same rubric using observable proxies. The
 *     *pipeline* — inputs, rubric, structured output, aggregation, gating — is
 *     identical either way; only the thing doing the scoring changes. That is
 *     what lets every number in this project be reproducible offline.
 */

/** Chapter 07 §7.2 — the lecture's rubric, verbatim. */
export const FAITHFULNESS_RUBRIC = [
  "Evaluate whether every factual claim in the answer is supported by the provided context.",
  "",
  "5 = Every factual claim is directly supported by the context.",
  "4 = Almost every claim is supported. There may be one minor unsupported detail that does not",
  "    materially affect the answer.",
  "3 = The main answer is supported, but meaningful unsupported claims exist.",
  "2 = Large portions of the response are unsupported.",
  "1 = The response substantially contradicts or ignores the provided context.",
].join("\n");

/** Chapter 05 §5.3.1 — the relevance scale, verbatim. */
export const RELEVANCE_RUBRIC = [
  "Did the answer actually address what the user asked?",
  "",
  "5 = Directly answers the question",
  "4 = Mostly answers the question",
  "3 = Partially answers the question",
  "2 = Barely related",
  "1 = Irrelevant",
].join("\n");

/** Chapter 05 §5.3 — the other three metrics, condensed to the same 1–5 shape. */
const CONDENSED_RUBRICS: Record<string, string> = {
  correctness:
    "Is the information actually true according to our reference?\n\n5 = Fully consistent with the reference.\n1 = Contradicts the reference.",
  helpfulness:
    "Did the answer actually help the user accomplish the task?\n\n5 = Complete and directly actionable.\n1 = Useless.",
  hallucination:
    "Did the answer invent information not supported by any source?\n\nNOTE: this scale is inverted — 1 is good.\n1 = No invented information.\n5 = Substantially invented.",
};

export function rubricFor(metric: MetricName): string {
  if (metric === "faithfulness") return FAITHFULNESS_RUBRIC;
  if (metric === "relevance") return RELEVANCE_RUBRIC;
  return CONDENSED_RUBRICS[metric] ?? `${metric}: score 1-5.`;
}

/** Chapter 06 §6.3 — the judge's input set *is* part of the metric's definition. */
export interface JudgeInput {
  metric: MetricName;
  question: string;
  answer: string;
  context: string[];
  reference?: string;
  scale: Scale;
}

export interface Judge {
  readonly version: string;
  score: (input: JudgeInput) => Promise<QualityOutcome>;
  /** Chapter 07 §7.5 — compare two answers instead of scoring one. */
  prefer: (input: PreferenceInput) => Promise<PreferenceVerdict>;
}

/**
 * Chapter 07 §7.5 — the pairwise verdict.
 *
 * A winner and a reason, not a number. §7.5's argument for pairwise is that
 * relative judgement is *easier and more reliable* than absolute scoring — at
 * the cost of having no threshold and costing two answers per comparison.
 */
export interface PreferenceVerdict {
  winner: "A" | "B" | "tie";
  reason: string;
}

export interface PreferenceInput {
  question: string;
  answerA: string;
  answerB: string;
  context: string[];
}

/** Map a 0..1 support ratio onto a 1..5 anchor. */
function anchor(ratio: number, thresholds: [number, number, number, number]): number {
  const [five, four, three, two] = thresholds;

  if (ratio >= five) return 5;
  if (ratio >= four) return 4;
  if (ratio >= three) return 3;
  if (ratio >= two) return 2;
  return 1;
}

/**
 * Chapter 07 §7.2 — the rubric anchors, made checkable.
 *
 * A sentence counts as "supported" when most of its content words appear in the
 * context: the observable proxy for "directly supported by the context". Level 5
 * is *every* claim supported, so the ratio must be ~1.
 */
function grounding(answer: string, context: string[]): number {
  const haystack = context.join(" ").toLowerCase();
  const sentences = answer.split(/(?<=\.)\s+/).filter((sentence) => sentence.trim() !== "");

  if (sentences.length === 0) return 0;

  const ratios = sentences.map((sentence) => {
    const content = tokens(sentence);

    if (content.length === 0) return 1;

    return content.filter((token) => haystack.includes(token)).length / content.length;
  });

  return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
}

function faithfulnessProxy(input: JudgeInput): { score: number; reason: string } {
  const ratio = grounding(input.answer, input.context);

  return {
    score: ratio === 0 ? 1 : anchor(ratio, [1, 0.9, 0.7, 0.4]),
    reason: `${Math.round(ratio * 100)}% of answer claims are supported by the retrieved context`,
  };
}

/** Chapter 05 §5.3.1 — "correct information ≠ relevant information", so measure overlap. */
function relevanceProxy(input: JudgeInput): { score: number; reason: string } {
  const question = tokens(input.question);
  const answer = input.answer.toLowerCase();

  if (question.length === 0) {
    return { score: 3, reason: "the question has no content words to match against" };
  }

  const matched = question.filter((token) => answer.includes(token)).length;
  const ratio = matched / question.length;

  return {
    score: anchor(ratio, [0.5, 0.3, 0.15, 0.01]),
    reason: `${matched} of ${question.length} question terms appear in the answer`,
  };
}

/** Chapter 05 §5.3.5 — hallucination is faithfulness read the other way up. */
function inverted(result: { score: number; reason: string }): { score: number; reason: string } {
  return { score: 6 - result.score, reason: `inverted faithfulness: ${result.reason}` };
}

function overlapWithReference(input: JudgeInput): { score: number; reason: string } {
  if (input.reference === undefined) {
    // Chapter 07 §7.3 — the tie/uncertainty rule: say so rather than guess.
    return { score: 3, reason: "no reference answer supplied, so correctness is not judgeable" };
  }

  const reference = tokens(input.reference);
  const answer = input.answer.toLowerCase();
  const matched = reference.filter((token) => answer.includes(token)).length;
  const ratio = reference.length === 0 ? 1 : matched / reference.length;

  return {
    score: anchor(ratio, [1, 0.8, 0.5, 0.25]),
    reason: `${matched} of ${reference.length} reference terms appear in the answer`,
  };
}

function helpfulnessProxy(input: JudgeInput): { score: number; reason: string } {
  const relevance = relevanceProxy(input);
  const concrete = /\d/.test(input.answer) || input.answer.split(/\s+/).length >= 8;

  return {
    score: concrete ? Math.max(relevance.score, 4) : Math.min(relevance.score, 3),
    reason: concrete ? "on-topic and carries a concrete detail" : "on-topic but vague",
  };
}

/**
 * The stand-in judge.
 *
 * It applies the rubric anchors through the proxies above, so every score is
 * reproducible and every reason is inspectable. It is **not** a measurement of
 * meaning — that is what the model path is for — and the version string says so,
 * so a report can never be misread as having been judged by a model.
 */
function createStandInJudge(): Judge {
  return {
    version: "standin-v1",

    score: async (input) => {
      const result =
        input.metric === "faithfulness"
          ? faithfulnessProxy(input)
          : input.metric === "relevance"
            ? relevanceProxy(input)
            : input.metric === "hallucination"
              ? inverted(faithfulnessProxy(input))
              : input.metric === "correctness"
                ? overlapWithReference(input)
                : input.metric === "helpfulness"
                  ? helpfulnessProxy(input)
                  : { score: 3, reason: "no stand-in for this metric" };

      return {
        metric: input.metric,
        score: result.score,
        reason: result.reason,
        judgeVersion: "standin-v1",
      };
    },

    prefer: async (input) => {
      const groundedA = grounding(input.answerA, input.context);
      const groundedB = grounding(input.answerB, input.context);

      if (groundedA !== groundedB) {
        return groundedA > groundedB
          ? {
              winner: "A",
              reason: `A is better grounded in the context (${groundedA.toFixed(2)} vs ${groundedB.toFixed(2)})`,
            }
          : {
              winner: "B",
              reason: `B is better grounded in the context (${groundedB.toFixed(2)} vs ${groundedA.toFixed(2)})`,
            };
      }

      const relevance = (answer: string): number =>
        relevanceProxy({
          metric: "relevance",
          question: input.question,
          answer,
          context: input.context,
          scale: "1-5",
        }).score;

      const relevanceA = relevance(input.answerA);
      const relevanceB = relevance(input.answerB);

      if (relevanceA === relevanceB) {
        return { winner: "tie", reason: "equally grounded and equally relevant" };
      }

      return relevanceA > relevanceB
        ? { winner: "A", reason: `equal grounding; A answers more of the question (${relevanceA} vs ${relevanceB})` }
        : { winner: "B", reason: `equal grounding; B answers more of the question (${relevanceB} vs ${relevanceA})` };
    },
  };
}

/**
 * Chapter 06 §6.4 — **structured judge output**, with a reason field.
 *
 * The model is asked for `{ score, reason }` as JSON, because a free-text verdict
 * cannot be aggregated, thresholded, diffed or gated. `response_format` is what
 * makes that structural rather than hopeful.
 */
async function scoreWithModel(input: JudgeInput): Promise<QualityOutcome> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI();

  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are an evaluation judge. Score ONE metric and return JSON.",
          "Do not judge anything outside the rubric's scope.",
          "",
          `METRIC: ${input.metric} (scale ${input.scale})`,
          "",
          rubricFor(input.metric),
          "",
          'Return exactly: {"score": <number>, "reason": "<one sentence>"}',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `QUESTION:\n${input.question}`,
          input.context.length > 0 ? `CONTEXT:\n${input.context.join("\n---\n")}` : "",
          input.reference === undefined ? "" : `REFERENCE ANSWER:\n${input.reference}`,
          `ANSWER TO SCORE:\n${input.answer}`,
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
      },
    ],
  });

  const content = response.choices[0]?.message.content ?? "{}";
  const parsed = JSON.parse(content) as { score?: number; reason?: string };

  return {
    metric: input.metric,
    score: typeof parsed.score === "number" ? parsed.score : 3,
    reason: parsed.reason ?? "the judge returned no reason",
    judgeVersion: `model:${config.model}`,
  };
}

/**
 * Chapter 06 §6.2 — the seam.
 *
 * With a key the model scores against the rubric; without one the stand-in does.
 * A model failure **falls back** rather than aborting the run: an evaluation that
 * dies on the first flaky call is an evaluation nobody runs.
 */
/** §7.5 — the preference prompt. Note it asks for a winner *and* a reason, never a score. */
async function preferWithModel(input: PreferenceInput): Promise<PreferenceVerdict> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI();

  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are a pairwise evaluation judge. Two answers to the same question follow.",
          "Judge only which answer better satisfies the question, using the context provided.",
          'Return exactly: {"winner": "A" | "B" | "tie", "reason": "<one sentence>"}',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `QUESTION:\n${input.question}`,
          input.context.length > 0 ? `CONTEXT:\n${input.context.join("\n---\n")}` : "",
          `ANSWER A:\n${input.answerA}`,
          `ANSWER B:\n${input.answerB}`,
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0]?.message.content ?? "{}") as {
    winner?: string;
    reason?: string;
  };

  return {
    winner: parsed.winner === "A" || parsed.winner === "B" ? parsed.winner : "tie",
    reason: parsed.reason ?? "the judge returned no reason",
  };
}

export function createJudge(): Judge {
  if (!config.hasModelKey) {
    return createStandInJudge();
  }

  return {
    version: `model:${config.model}`,

    score: async (input) => {
      try {
        return await scoreWithModel(input);
      } catch {
        return createStandInJudge().score(input);
      }
    },

    prefer: async (input) => {
      try {
        return await preferWithModel(input);
      } catch {
        return createStandInJudge().prefer(input);
      }
    },
  };
}
```

### Block-by-block

**Block 1 — the faithfulness rubric, verbatim (Chapter 07 §7.2).**

```ts
export const FAITHFULNESS_RUBRIC = [
  "Evaluate whether every factual claim in the answer is supported by the provided context.",
  "",
  "5 = Every factual claim is directly supported by the context.",
  "4 = Almost every claim is supported. There may be one minor unsupported detail that does not",
  "    materially affect the answer.",
  "3 = The main answer is supported, but meaningful unsupported claims exist.",
  "2 = Large portions of the response are unsupported.",
  "1 = The response substantially contradicts or ignores the provided context.",
].join("\n");
```

This is the lecture's rubric copied character for character, and it is worth reading as a
**specification** rather than as prose. Four engineering choices are visible in five lines:

| Choice | Why it matters |
| :--- | :--- |
| each level names **observable behaviour**, not adjectives | two raters can check the same thing |
| the levels are **monotone** (claim coverage decreases) | a score difference is interpretable |
| level 4 handles the grey case explicitly (*"does not materially affect the answer"*) | the genuinely ambiguous case gets a rule instead of a coin flip |
| level 1 names **contradiction *and* ignoring** | two distinct failure modes, one score |

The metric's definition is stated **above** the levels, which is what makes the rubric
self-contained — it can be pasted into a judge prompt with no surrounding explanation, which is
exactly what `scoreWithModel` does.

**Block 2 — the relevance scale, and the condensed three (Chapter 05 §5.3).**

```ts
export const RELEVANCE_RUBRIC = [ "Did the answer actually address what the user asked?", "", "5 = Directly answers…", … ];
const CONDENSED_RUBRICS: Record<string, string> = { correctness: …, helpfulness: …, hallucination: … };

export function rubricFor(metric: MetricName): string {
  if (metric === "faithfulness") return FAITHFULNESS_RUBRIC;
  if (metric === "relevance")    return RELEVANCE_RUBRIC;
  return CONDENSED_RUBRICS[metric] ?? `${metric}: score 1-5.`;
}
```

Five metrics, and the honest split is visible here: **two rubrics are the lecture's own words,
three are condensed.** That distinction is kept in the code rather than smoothed over, because a
reader comparing this file to the notes should be able to see exactly which anchors came from the
lecture and which were written to fill the same 1–5 shape.

`rubricFor` exists so that the model path and the stand-in path are handed the *same* rubric. If
the stand-in used different anchors, switching from offline to model mode would change what is
being measured — which is precisely the failure Chapter 06 §6.3 warns about: *"the judge's input
set is part of the metric's definition."*

**Block 3 — `JudgeInput`: the input set, made explicit (§6.3).**

```ts
export interface JudgeInput {
  metric: MetricName;
  question: string;
  answer: string;
  context: string[];
  reference?: string;
  scale: Scale;
}
```

§6.3's table lists what each metric *needs*: relevance needs question + answer; faithfulness
needs question + context + answer; correctness needs a reference. This interface can express all
of them, and `reference` is optional precisely because only correctness needs it.

The input set is a *type* rather than a convention for §6.3's engineering reason: **if two runs
use different input sets, their scores are not comparable, and the difference will look like a
regression.** Naming the fields is what makes that checkable.

**Block 4 — `Judge`, and why there are two operations (§7.5).**

```ts
export interface Judge {
  readonly version: string;
  score:  (input: JudgeInput)      => Promise<QualityOutcome>;
  prefer: (input: PreferenceInput) => Promise<PreferenceVerdict>;
}

export interface PreferenceVerdict { winner: "A" | "B" | "tie"; reason: string }
```

`score` asks *"how good is this?"* — an absolute judgement against a rubric, which supports a
**threshold**. `prefer` asks *"which of these two is better?"* — a relative judgement, which
supports a **choice**.

§7.5's table is the reason both exist: pointwise gates a release (`faithfulness ≥ 4.2 → ship`),
pairwise chooses between candidates (*"adopt v2"*), and neither can do the other's job. A pairwise
verdict has no absolute scale; a pointwise score cannot say which of two prompts is better.

`readonly version` is §6.4's reproducibility rule given a name: every score must be attributable
to the judge prompt that produced it.

**Block 5 — the proxies, and the honesty that goes with them.**

```ts
function anchor(ratio: number, thresholds: [number, number, number, number]): number { … }

function grounding(answer: string, context: string[]): number {
  const haystack = context.join(" ").toLowerCase();
  const sentences = answer.split(/(?<=\.)\s+/).filter((s) => s.trim() !== "");
  if (sentences.length === 0) return 0;
  const ratios = sentences.map((sentence) => {
    const content = tokens(sentence);
    if (content.length === 0) return 1;
    return content.filter((token) => haystack.includes(token)).length / content.length;
  });
  return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
}
```

`grounding` is the faithfulness proxy, and it is a **direct reading of the rubric's level 5**:
*"every factual claim is directly supported by the context."* A sentence counts as supported when
its content words appear in the context, so a ratio of 1.0 *is* "every claim supported" — and
`anchor(ratio, [1, 0.9, 0.7, 0.4])` maps that onto the five levels.

The thresholds are not arbitrary: 5 requires **exactly** full support, which is what the rubric
says. 4 allows a minor gap (0.9), 3 allows meaningful gaps (0.7), 2 means large portions are
unsupported (0.4), and below that is level 1.

The remaining proxies follow the same pattern — `relevanceProxy` measures question-term coverage,
`inverted` flips faithfulness for hallucination (whose scale runs the other way), and
`overlapWithReference` compares against `goldenAnswer`. Each is labelled in its doc comment with
the rubric line it is approximating.

**What these proxies are not.** They are not measurements of meaning, and the file says so twice —
once in the header and once on `createStandInJudge`. A stand-in exists so the *pipeline* is
complete and reproducible offline; the thing that actually reads meaning is the model path below.
Presenting a proxy as a measurement is the one way this file could mislead, so it is guarded in
prose rather than hidden.

**Block 6 — the stand-in, and its `prefer`.**

```ts
function createStandInJudge(): Judge {
  return {
    version: "standin-v1",
    score: async (input) => {
      const result = input.metric === "faithfulness" ? faithfulnessProxy(input)
        : input.metric === "relevance" ? relevanceProxy(input)
        : input.metric === "hallucination" ? inverted(faithfulnessProxy(input))
        : input.metric === "correctness" ? overlapWithReference(input)
        : input.metric === "helpfulness" ? helpfulnessProxy(input)
        : { score: 3, reason: "no stand-in for this metric" };
      return { metric: input.metric, score: result.score, reason: result.reason, judgeVersion: "standin-v1" };
    },

    prefer: async (input) => {
      const groundedA = grounding(input.answerA, input.context);
      const groundedB = grounding(input.answerB, input.context);
      if (groundedA !== groundedB) { … higher grounding wins … }
      const relevanceA = relevance(input.answerA);  const relevanceB = relevance(input.answerB);
      if (relevanceA === relevanceB) return { winner: "tie", reason: "equally grounded and equally relevant" };
      … higher relevance wins …
    },
  };
}
```

`prefer` is a **cascade** rather than a single number: compare grounding first (the more serious
property), then relevance, then declare a tie. That ordering is a design decision worth naming —
it means a *less grounded but more relevant* answer loses, which is the right priority for a RAG
system where an ungrounded answer is the expensive failure.

Every returned verdict carries a `reason` that names **both** scores (`"A is better grounded in
the context (1.00 vs 0.00)"`), because §7.5's risk is that a pairwise judge becomes a black box
that always picks the second answer. A reason that shows the numbers is spot-checkable.

**Block 7 — structured judge output (Chapter 06 §6.4).**

```ts
async function scoreWithModel(input: JudgeInput): Promise<QualityOutcome> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI();

  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: [
          "You are an evaluation judge. Score ONE metric and return JSON.",
          "Do not judge anything outside the rubric's scope.",
          "",
          `METRIC: ${input.metric} (scale ${input.scale})`,
          "",
          rubricFor(input.metric),
          "",
          'Return exactly: {"score": <number>, "reason": "<one sentence>"}',
        ].join("\n") },
      { role: "user", content: [
          `QUESTION:\n${input.question}`,
          input.context.length > 0 ? `CONTEXT:\n${input.context.join("\n---\n")}` : "",
          input.reference === undefined ? "" : `REFERENCE ANSWER:\n${input.reference}`,
          `ANSWER TO SCORE:\n${input.answer}`,
        ].filter((part) => part !== "").join("\n\n") },
    ],
  });

  const parsed = JSON.parse(response.choices[0]?.message.content ?? "{}");
  return { metric: input.metric, score: typeof parsed.score === "number" ? parsed.score : 3,
           reason: parsed.reason ?? "the judge returned no reason", judgeVersion: `model:${config.model}` };
}
```

Five things in this block are the chapter's actual content, and each maps to a line of §6.4's
table:

| Detail | §6.4's rule |
| :--- | :--- |
| `response_format: { type: "json_object" }` | *prefer structured results* — the format is enforced, not requested |
| the `METRIC:` line | one metric per judge call, so the scale is unambiguous (§6.9) |
| `rubricFor(...)` pasted in full | the rubric is the interface — the judge gets the anchors, not a summary |
| `"Do not judge anything outside the rubric's scope."` | §7.3's **scope statement** — one metric must not leak into another |
| `reason` required in the shape | §6.4: *"a score with no reason cannot be debugged, cannot be spot-checked by a human, and cannot be used to improve the prompt"* |

Note the input block is assembled from a **filtered array**, so an absent `reference` simply does
not appear rather than appearing as an empty section. A judge prompt with an empty `CONTEXT:`
heading invites the model to comment on the emptiness — exactly the kind of prompt artefact that
turns into score noise.

**Block 8 — the seam, and the fallback (Chapter 06 §6.2).**

```ts
export function createJudge(): Judge {
  if (!config.hasModelKey) {
    return createStandInJudge();
  }

  return {
    version: `model:${config.model}`,
    score:  async (input) => { try { return await scoreWithModel(input); }  catch { return createStandInJudge().score(input); } },
    prefer: async (input) => { try { return await preferWithModel(input); } catch { return createStandInJudge().prefer(input); } },
  };
}
```

Two decisions:

**The switch is on the key, and it is made once.** Everything downstream — the loop, the report,
the CLI — receives a `Judge` and never asks which kind it is. That is why the pipeline is identical
in both modes, and why `npm run eval` produces the same *shape* of output with or without
credentials.

**A model failure falls back rather than throwing.** This is a deliberate trade, and it has a real
cost: a run could be judged by the stand-in without anyone noticing. It is paid down by
`judgeVersion` — the stand-in stamps `standin-v1` on every score, so a report always says which
judge actually ran, even when the model failed mid-run. The alternative (abort the run) is worse
for the lecture's purpose: an evaluation that dies on the first flaky call is an evaluation nobody
runs in CI.

**Block 9 — `preferWithModel`, the preference prompt.**

```ts
const response = await client.chat.completions.create({
  model: config.model,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: [
        "You are a pairwise evaluation judge. Two answers to the same question follow.",
        "Judge only which answer better satisfies the question, using the context provided.",
        'Return exactly: {"winner": "A" | "B" | "tie", "reason": "<one sentence>"}',
      ].join("\n") },
    { role: "user", content: [ `QUESTION:…`, `CONTEXT:…`, `ANSWER A:…`, `ANSWER B:…` ].join("\n\n") },
  ],
});

const parsed = JSON.parse(response.choices[0]?.message.content ?? "{}");
return { winner: parsed.winner === "A" || parsed.winner === "B" ? parsed.winner : "tie",
         reason: parsed.reason ?? "the judge returned no reason" };
```

Compare this with `scoreWithModel` and the difference between the two operations is visible
structurally: **no rubric, no scale, no number.** A preference prompt supplies the preference
rubric implicitly by asking which answer "better satisfies the question", and the output is a label
rather than a score.

The winner is validated against the two legal values and anything else becomes `"tie"` — because a
judge that returns `"A is slightly better"` must not be silently coerced into a win. §7.5's "tie
inflation" risk is real, but an unparseable verdict is the bigger problem, and defaulting to a tie
is the conservative failure.

---

## Checkpoint

1. **Why are there two judge operations rather than one?**
   Because §7.5's two questions are genuinely different: `score` gives an absolute value that
   supports a threshold (a release gate), `prefer` gives a relative verdict that supports a choice
   (which prompt to adopt). Neither can answer the other's question.

2. **What makes a score reproducible?**
   A pinned rubric, a pinned input set (`JudgeInput`), and a `judgeVersion` on every score. §6.3:
   if two runs use different inputs, the difference looks like a regression.

3. **Why does the stand-in exist, and what stops it being mistaken for a measurement?**
   It makes the whole pipeline runnable and reproducible offline. It is labelled twice in prose and
   stamps `standin-v1` on every score, so a report can never be read as model-judged.

4. **Why is the rubric pasted into the judge prompt in full rather than summarised?**
   Because the rubric *is* the metric's definition. A summarised rubric is a different metric, and
   scores would silently stop being comparable with earlier runs.

5. **Why does `prefer` compare grounding before relevance?**
   Because an ungrounded answer is the expensive failure in a RAG system. Ordering the cascade that
   way means a fluent, relevant, invented answer loses to a plainer grounded one.

6. **Why does a model failure fall back instead of throwing?**
   Because an evaluation that dies on the first flaky call will not be run in CI. The cost — a run
   quietly judged by the stand-in — is paid down by `judgeVersion`, which records which judge ran.

---

**[Chapter 07: Retrieval Metrics and Attribution →](./07_Retrieval_Metrics_And_Attribution.md)**