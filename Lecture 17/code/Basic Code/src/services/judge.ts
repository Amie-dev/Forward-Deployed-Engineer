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
