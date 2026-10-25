import { config } from "../config/config.js";
import { METRICS, type AgentResponse, type GoldenCase, type JudgeResult } from "../domain/types.js";
import type { ModelClient } from "./model.js";

/**
 * Chapter 06 §6.5 — the judge, and the rubric that *is* the product.
 *
 * The prompt is not a wrapper around a model. It is the measurement instrument:
 * two judges given different rubrics will disagree about the same answer, and the
 * disagreement will look like a model problem rather than a rubric problem.
 */

/**
 * Chapter 06 §6.3 — the five metrics, one direction.
 *
 * Note that every metric points the same way: 5 is good. That is the deliberate
 * `hallucinationFree` naming choice — with a metric called `hallucination`, the
 * direction of one column in the report would be inverted, and every aggregation
 * would have to remember it.
 */
export const RUBRIC = `Score each metric from 1 to 5, where 5 is best.
relevance         5 = answers the question that was actually asked; 1 = answers a different question.
correctness       5 = agrees with the expected answer; 1 = contradicts it.
faithfulness      5 = every factual claim appears in the evidence; 1 = claims the evidence does not support.
helpfulness       5 = clear, complete and usable; 1 = vague or unusable.
hallucinationFree 5 = invents nothing; 1 = invents facts, policies, dates or amounts.
All five metrics point the same way: 5 is good. Explain the score in one sentence.`;

/**
 * Chapter 06 §6.1.2 — the input matrix, as code.
 *
 * `context` and `toolResults` are not optional extras: faithfulness and
 * hallucination-free cannot be computed without them. That is why Chapter 03's
 * trace is a hard prerequisite for this file and not a nice-to-have.
 */
export class Judge {
  constructor(private readonly model: ModelClient) {}

  /** Chapter 06 §6.4 — the instrument's identity, so a score can never be misread. */
  get version(): string {
    return this.model.version;
  }

  async score(evalCase: GoldenCase, response: AgentResponse): Promise<JudgeResult> {
    const reply = await this.model.judge({
      question: evalCase.question,
      goldenAnswer: evalCase.goldenAnswer,
      // The evidence the model actually had — recorded in Chapter 03, not re-derived here.
      context: response.context,
      toolEvidence: response.toolResults.join("\n"),
      answer: response.answer,
      rubric: RUBRIC,
    });

    return { scores: reply.scores, reason: reply.reason, judgeVersion: this.model.version };
  }
}

/**
 * Chapter 07 §7.8 — Layer 3: the thresholds this case missed.
 *
 * The comparison is per metric, against a threshold that came from `config`, which
 * came from the environment. Chapter 08 §8.4 is emphatic that these numbers are
 * product decisions: there is nothing universal about 4, and a threshold chosen to
 * make the current build green is not a threshold but a description.
 */
export function thresholdFailures(quality: JudgeResult): string[] {
  return METRICS.filter((metric) => quality.scores[metric] < config.metricThresholds[metric]).map(
    (metric) => `${metric} ${quality.scores[metric]} < ${config.metricThresholds[metric]}`,
  );
}
