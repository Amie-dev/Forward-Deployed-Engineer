import OpenAI from "openai";
import { config } from "../config/config.js";
import { METRICS, type JudgeScores } from "../domain/types.js";
import { overlap } from "./text.js";
import { toolDefinitions } from "./tools.js";

/**
 * Chapter 02 §2.1 — the model, behind an interface.
 *
 * There are two implementations and they are interchangeable, which is the whole
 * point: the evaluation pipeline must not know or care which one is in place.
 * The offline one is not a test stub — it is what makes every number in this
 * project reproducible with no API key, which Chapter 05 §5.2 asks for
 * ("freeze what you can before running the dataset").
 */

export interface AgentRequest {
  question: string;
  /** The exact context string assembled from retrieval and tool results. */
  context: string;
  /** Which tools the model may call. Empty means "answer, do not call". */
  toolNames: string[];
}

/** Chapter 02 §2.1 — a turn is either an answer, or a request to use a tool. */
export type ModelTurn =
  | { kind: "answer"; content: string }
  | { kind: "tool"; name: string; argument: string };

export interface JudgeRequest {
  question: string;
  goldenAnswer: string;
  context: string;
  toolEvidence: string;
  answer: string;
  rubric: string;
}

export interface JudgeReply {
  scores: JudgeScores;
  reason: string;
}

export interface ModelClient {
  /** Chapter 06 §6.4 — the identity of the instrument, recorded on every score. */
  readonly version: string;
  answer(request: AgentRequest): Promise<ModelTurn>;
  judge(request: JudgeRequest): Promise<JudgeReply>;
}

/** Chapter 02 §2.2 — the system prompt. Versioned by `config.promptVersion`. */
export const SYSTEM_PROMPT = `You are the support agent for an online store.
Answer only from the CONTEXT you are given. If the context does not contain the
answer, say that you cannot help with that request.
Never invent order data, policies, dates or amounts.`;

/**
 * Chapter 02 §2.2 — Category C behaviour.
 *
 * A refusal is a **valid answer**, not a failure. Chapter 06 §6.2.1 is explicit
 * about this: a judge that scores every refusal as unhelpful pushes the agent
 * towards confident guessing.
 */
export const REFUSAL =
  "I can only help with returns, refunds and shipping for orders in this store. " +
  "I do not have information about anything else.";

const REFUSAL_PATTERN = /I can only help|I do not have information/i;

function isRefusal(answer: string): boolean {
  return REFUSAL_PATTERN.test(answer);
}

/**
 * Chapter 06 §6.3 — map a fraction onto the 1–5 scale.
 *
 * Five anchors rather than two, because a judge that can only say "perfect" or
 * "broken" makes every threshold in Chapter 07 §7.8 a binary — and a binary
 * threshold cannot express "good enough to ship".
 */
function toScore(fraction: number): number {
  if (fraction >= 0.8) return 5;
  if (fraction >= 0.6) return 4;
  if (fraction >= 0.4) return 3;
  if (fraction >= 0.2) return 2;
  return 1;
}

/** The order id in a question, if there is one. Used for routing (Chapter 02 §2.2). */
export function orderIdIn(question: string): string | undefined {
  return question.match(/\bORD-\d+\b/i)?.[0];
}

/** Which tool an order question needs. Keyword routing stands in for the model's choice. */
function chooseTool(question: string): string {
  if (/arrive|deliver|when/i.test(question)) return "getDeliveryEstimate";
  if (/refund|money back/i.test(question)) return "getRefundAmount";
  return "getOrderStatus";
}

/**
 * The evidence lines of a context, with the labels removed.
 *
 * The labels (`SOURCE:`, `TOOL RESULT 1:`) are addressing information, not
 * evidence: they tell the model where a fact came from. Leaving them in would
 * inflate every faithfulness score, and — as a first version of this file did —
 * *dropping* the tool lines would leave a tool answer with no evidence at all.
 * The rule is: strip the address, keep the claim.
 */
function evidenceOf(context: string): string {
  return context
    .split("\n")
    .map((line) => line.replace(/^(SOURCE: \S+|TOOL RESULT \d+:)\s*/, "").trim())
    .filter((line) => line !== "")
    .join(" ");
}

/**
 * Chapter 05 §5.2 — the deterministic stand-in.
 *
 * It is deliberately dull. Every judgement it makes is one you can re-run and get
 * the same answer from, which is what makes the *pipeline* visible: when this
 * project reports a failure, the failure is in the pipeline or the agent, never
 * in the model's mood.
 */
export class OfflineModel implements ModelClient {
  readonly version = "offline-v1";

  /**
   * Chapter 02 §2.2 — decide: call a tool, or answer from the context.
   *
   * The routing here is the interesting part, and the dataset asserts it. An order
   * question goes to the tools and **skips retrieval**; a policy question goes to
   * the knowledge base and skips the tools. That is why `expectedSource: null` on
   * an order case is a real assertion: it says "do not drag policy text into an
   * order answer".
   */
  async answer({ question, context, toolNames }: AgentRequest): Promise<ModelTurn> {
    const orderId = orderIdIn(question);

    if (orderId !== undefined && toolNames.length > 0) {
      return { kind: "tool", name: chooseTool(question), argument: orderId };
    }

    const evidence = evidenceOf(context);

    return { kind: "answer", content: evidence === "" ? REFUSAL : evidence };
  }

  /**
   * Chapter 06 §6.5 — score the answer, and say why.
   *
   * The three signals it can actually see are three text overlaps. Two metrics
   * share one signal here — faithfulness and hallucination-free are both derived
   * from `groundingOverlap` — and that is a limitation worth naming: a *missing*
   * fact (unfaithful) and an *invented* fact (a hallucination) look identical to a
   * set-overlap test. Separating them is precisely the work a real judge does.
   */
  async judge({ question, goldenAnswer, context, toolEvidence, answer }: JudgeRequest): Promise<JudgeReply> {
    const evidence = `${context}\n${toolEvidence}`;
    const refusal = isRefusal(answer);

    const questionOverlap = overlap(question, answer);
    const goldenOverlap = overlap(goldenAnswer, answer);
    const groundingOverlap = overlap(answer, evidence);

    // A crude proxy for "usable", and the only one a stand-in can see: was a
    // complete sentence produced at all? Tone, clarity and next-step advice are
    // exactly what the stand-in cannot read — and exactly what a real judge is for.
    const complete = /[.!?]\s*$/.test(answer.trim()) && answer.trim().length >= 20;

    const scores: JudgeScores = {
      relevance: refusal ? 5 : toScore(questionOverlap),
      correctness: toScore(goldenOverlap),
      // A refusal asserts nothing, so there is nothing for it to be unfaithful to.
      faithfulness: refusal ? 5 : toScore(groundingOverlap),
      hallucinationFree: refusal ? 5 : toScore(groundingOverlap),
      helpfulness: complete ? 5 : 3,
    };

    return {
      scores,
      reason:
        `overlap with the question ${questionOverlap.toFixed(2)}, ` +
        `with the golden answer ${goldenOverlap.toFixed(2)}, ` +
        `with the evidence ${groundingOverlap.toFixed(2)}` +
        (refusal ? "; the answer is a refusal, which claims nothing" : ""),
    };
  }
}

/**
 * Chapter 06 §6.4 — the same interface, backed by a real model.
 *
 * Nothing about the pipeline changes when this is used: the judge still receives
 * question, golden answer, evidence, actual answer and rubric, and still returns
 * one score per metric plus a reason. Only the instrument is different — which is
 * why every score carries the judge's version.
 */
export class OpenAIModel implements ModelClient {
  readonly version = `model:${config.model}`;
  private readonly client = new OpenAI();

  async answer({ question, context, toolNames: allowed }: AgentRequest): Promise<ModelTurn> {
    const tools = toolDefinitions
      .filter((tool) => allowed.includes(tool.name))
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            properties: { orderId: { type: "string", description: "Order id such as ORD-101." } },
            required: ["orderId"],
            additionalProperties: false,
          },
        },
      }));

    const completion = await this.client.chat.completions.create({
      model: config.model,
      // Chapter 05 §5.2 — temperature 0 minimises sampling variance. It does not
      // remove it: an LLM eval is never perfectly reproducible, which is exactly
      // why the judge's identity is recorded on every score.
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` },
      ],
      ...(tools.length > 0 ? { tools } : {}),
    });

    const message = completion.choices[0]?.message;
    const call = message?.tool_calls?.[0];

    if (call?.type === "function") {
      const args = JSON.parse(call.function.arguments) as { orderId?: string };
      return { kind: "tool", name: call.function.name, argument: args.orderId ?? "" };
    }

    return { kind: "answer", content: message?.content?.trim() || REFUSAL };
  }

  async judge({ question, goldenAnswer, context, toolEvidence, answer, rubric }: JudgeRequest): Promise<JudgeReply> {
    const completion = await this.client.chat.completions.create({
      model: config.model,
      temperature: 0,
      // Chapter 06 §6.5 — a judge that returns prose cannot be aggregated. The
      // structured output is part of the contract, not a convenience.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a strict evaluator of AI application responses. Return JSON." },
        {
          role: "user",
          content: [
            `USER QUESTION:\n${question}`,
            `EXPECTED ANSWER:\n${goldenAnswer}`,
            `RAG EVIDENCE:\n${context}`,
            `TOOL EVIDENCE:\n${toolEvidence}`,
            `ACTUAL ANSWER:\n${answer}`,
            rubric,
            `Return a JSON object with integer fields ${METRICS.join(", ")} and a string reason.`,
          ].join("\n\n"),
        },
      ],
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as
      Partial<Record<string, number>> & { reason?: string };

    return {
      scores: Object.fromEntries(METRICS.map((metric) => [metric, Number(parsed[metric] ?? 1)])) as JudgeScores,
      reason: String(parsed.reason ?? ""),
    };
  }
}

/**
 * Chapter 06 §6.4 — which instrument to use.
 *
 * The choice is made in exactly one place, and the rest of the project never asks
 * again. With no key the offline stand-in is used, so `npm run eval` and
 * `npm run typecheck` both work on a fresh clone with no network and no secrets.
 */
export function createModel(): ModelClient {
  return config.hasModelKey ? new OpenAIModel() : new OfflineModel();
}

