# Chapter 07 — LLM-as-a-Judge — Five Metrics and a Rubric

> **Layer 2: what only meaning can decide.** Chapter 06 of the notes introduces the second
> half of the architecture — a second model that scores the answer against clearly defined
> criteria — and the five metrics for this application.
>
> The chapter's sharpest claim is this: **the judge prompt is the product.** Two judges given
> different rubrics will disagree about the same answer, and the disagreement will look like a
> model problem rather than a rubric problem. So the rubric lives in one exported constant, and
> every score carries the identity of the instrument that produced it.

---

## File details

| | `src/services/judge.ts` | `src/services/model.ts` |
|---|---|---|
| **Lines** | 71 | 289 |
| **Layer** | services | services |
| **Purpose** | the rubric, the five metrics, and the threshold comparison | the model: one interface, two implementations |
| **Exports** | `RUBRIC`, `Judge`, `thresholdFailures()` | `ModelClient`, `AgentRequest`, `ModelTurn`, `JudgeRequest`, `JudgeReply`, `SYSTEM_PROMPT`, `REFUSAL`, `OfflineModel`, `OpenAIModel`, `createModel()`, `orderIdIn()` |
| **Imports** | `config`, `types`, `model` (type only) | `openai`, `config`, `types`, `text`, `tools` |
| **Notes sections** | Ch06 §6.3, §6.5, §6.1.2, Ch07 §7.8 | Ch02 §2.1–2.2, Ch05 §5.2, Ch06 §6.4–6.5 |

**The judge does not call a model — it calls a `ModelClient`.** That indirection is the whole
reason this chapter is testable: `Judge` is a small class over an interface, and the interface
has two implementations that behave the same way from the outside.

---

## Commands

```bash
# Chapter 06 §6.3 — the five metrics, and their thresholds.
npm run eval 2>&1 | sed -n '/Layers 2/,/per category/p'
#   relevance         4.89   threshold 4
#   correctness       5.00   threshold 4
#   faithfulness      5.00   threshold 4
#   helpfulness       5.00   threshold 4
#   hallucinationFree 5.00   threshold 4
```

```bash
# Chapter 08 §8.4 — a per-metric threshold is a product decision, not a constant.
EVAL_MIN_RELEVANCE=5 npm run eval 2>&1 | sed -n '/failures/,$p'
#   policy-reworded-window   [quality threshold]
#       relevance 4 < 5
```

```bash
# Chapter 06 §6.4 — and the judge names itself on every score.
curl -s http://127.0.0.1:8080/eval | python3 -c 'import json,sys; print(json.load(sys.stdin)["judgeVersion"])'
#   offline-v1
```

---

## `src/services/judge.ts` — the full file

```ts
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
```

### Block-by-block

**Block 1 — `RUBRIC`, and why it is a constant.**

```ts
export const RUBRIC = `Score each metric from 1 to 5, where 5 is best.
relevance         5 = answers the question that was actually asked; 1 = answers a different question.
…
All five metrics point the same way: 5 is good. Explain the score in one sentence.`;
```

Three things are deliberate about this string.

**It is exported.** A rubric is a reviewable artefact, not a private detail of a function. If
the rubric cannot be read, quoted and argued about by someone who knows the business, it is
not a specification — and Chapter 04 §4.3's "the dataset defines what we consider correct
behaviour" applies just as much to the rubric.

**It defines both ends of every scale.** `5 = …; 1 = …` for each metric, not just a label. A
rubric that says only "score relevance from 1 to 5" invites the model to invent its own
scale — and an invented scale that shifts between runs is exactly the variance Chapter 06 §6.5
warns about.

**It states the direction explicitly.** *"All five metrics point the same way: 5 is good."*
That sentence is in the rubric because the naming choice (`hallucinationFree`) is only half
the defence. A judge that has been told the direction cannot invert one column by accident.

**Block 2 — the `Judge` class, and the interface seam.**

```ts
export class Judge {
  constructor(private readonly model: ModelClient) {}
  get version(): string { return this.model.version; }
}
```

The judge holds a `ModelClient`, not an OpenAI client. That one line is what makes the whole
chapter testable and reproducible:

| If the judge held an SDK client | With a `ModelClient` |
| :--- | :--- |
| every score depends on a network call | the offline implementation is deterministic |
| a rubric change cannot be tested without spending tokens | the same pipeline runs with `npm run eval` on a fresh clone |
| the judge and the agent could drift to different clients | one factory (`createModel()`) decides, once |

`get version()` is a getter rather than a stored field so it always reflects the *current*
model. If a process somehow switched instruments, the recorded version would follow.

**Block 3 — `score()`, and the input matrix.**

```ts
const reply = await this.model.judge({
  question: evalCase.question,
  goldenAnswer: evalCase.goldenAnswer,
  context: response.context,
  toolEvidence: response.toolResults.join("\n"),
  answer: response.answer,
  rubric: RUBRIC,
});
```

Compare this payload with Chapter 06 §6.1.2's input matrix in the notes:

| Metric | Needs | Supplied by |
| :--- | :--- | :--- |
| relevance | question, answer | `question`, `answer` |
| correctness | golden answer, answer | `goldenAnswer`, `answer` |
| faithfulness | RAG context, tool results, answer | `context`, `toolEvidence` |
| helpfulness | answer | `answer` |
| hallucinationFree | context, tool results, answer | `context`, `toolEvidence` |

Every field is read from `response` — which is `AgentResponse`, recorded in Chapter 04.
**Nothing is re-derived here.** That is the practical consequence of the trace contract: if
`context` were absent from `AgentResponse`, two of the five metrics would be uncomputable, and
the failure would be a mysterious low score rather than an obvious missing field.

**Block 4 — the returned `JudgeResult`.**

```ts
return { scores: reply.scores, reason: reply.reason, judgeVersion: this.model.version };
```

`judgeVersion` is attached **here**, not by the model implementation. That is a small but
important placement: the model reports *scores and a reason*, and the judge is the thing that
knows it is acting as a judge. If a future second judge were added, each would stamp its own
version without the model implementations having to know about judging at all.

**Block 5 — `thresholdFailures()`, Layer 3 in four lines.**

```ts
export function thresholdFailures(quality: JudgeResult): string[] {
  return METRICS.filter((metric) => quality.scores[metric] < config.metricThresholds[metric]).map(
    (metric) => `${metric} ${quality.scores[metric]} < ${config.metricThresholds[metric]}`,
  );
}
```

Notice what it returns: **strings, not booleans.** `"relevance 4 < 5"` is a sentence a reader
can act on; `false` is not. This is the same principle as `CheckResult.expected/actual` in
Chapter 06 — a failure should carry its own explanation, so that nobody has to re-run the eval
with extra logging to find out what happened.

And notice it is *per metric*, in `METRICS` order. A single "quality failed" verdict would
hide the difference between a faithfulness problem (a grounding bug) and a helpfulness problem
(a style bug) — two failures with two entirely different owners.

---

## `src/services/model.ts` — the full file (part 1 of 3: the interface)

```ts
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
```

### Block-by-block (part 1)

**Block 1 — `ModelTurn`: the union that makes the tool budget free.**

```ts
export type ModelTurn =
  | { kind: "answer"; content: string }
  | { kind: "tool"; name: string; argument: string };
```

A discriminated union rather than `{ content?: string; toolCall?: … }`. The `kind` field lets
the agent's loop (Chapter 04) narrow with a single `if (turn.kind === "tool")`, and TypeScript
then guarantees `turn.name` exists inside the branch. There is no "content is undefined *and*
toolCall is undefined" state, because that state is not representable.

**Block 2 — `ModelClient`: two methods, one version.**

```ts
export interface ModelClient {
  readonly version: string;
  answer(request: AgentRequest): Promise<ModelTurn>;
  judge(request: JudgeRequest): Promise<JudgeReply>;
}
```

`answer` and `judge` are on the *same* interface, which is a deliberate simplification. In a
larger system the agent's model and the judge's model would be separate types, because Chapter
06 §6.4 treats the judge as a distinct instrument. Here they are one interface because one
factory picks both — and the `version` string is what records the difference at score time.

`readonly version` is what makes `judgeVersion` possible without threading an extra argument
through every call.

**Block 3 — `toScore`, and five anchors.**

```ts
function toScore(fraction: number): number {
  if (fraction >= 0.8) return 5;
  if (fraction >= 0.6) return 4;
  if (fraction >= 0.4) return 3;
  if (fraction >= 0.2) return 2;
  return 1;
}
```

The stand-in measures fractions and the rubric is a 1–5 scale, so *some* mapping is needed. The
choice of five anchors rather than two is the interesting part:

| Anchors | Consequence for the threshold |
| :--- | :--- |
| only 1 and 5 | a threshold of 4 becomes "must be perfect", so the gate is binary |
| 1, 3, 5 | a threshold of 4 *still* means "must be perfect" — 3 is below it |
| **1, 2, 3, 4, 5** | a threshold of 4 means "good", and 3 means "partial" — which is what the notes' `Score >= 4` intends |

A judge that can only say "perfect" or "broken" makes every threshold in Chapter 07 §7.8 a coin
flip. The anchors are chosen so the *threshold* can express "good enough to ship" — which is
the only thing a threshold is for.

**Block 4 — `orderIdIn()`.**

```ts
export function orderIdIn(question: string): string | undefined {
  return question.match(/\bORD-\d+\b/i)?.[0];
}
```

Exported, because *two* places need it: the agent (to decide whether to retrieve) and the
offline model (to decide whether to call a tool). Both must agree, or routing becomes
inconsistent — and an inconsistency between "does retrieval happen" and "does a tool get
called" is exactly the kind of bug that produces an unexplainable failure.

`\b…\b` with the `i` flag matches `ord-101` and `ORD-101` alike; the caller decides the casing.
`?.[0]` returns `undefined` rather than throwing when there is no match, which is what makes the
`=== undefined` checks in the agent readable.

**Block 5 — `chooseTool()`, and the honest comment.**

```ts
function chooseTool(question: string): string {
  if (/arrive|deliver|when/i.test(question)) return "getDeliveryEstimate";
  if (/refund|money back/i.test(question)) return "getRefundAmount";
  return "getOrderStatus";
}
```

Three regexes stand in for a model's tool-selection reasoning, and the comment says so —
*"keyword routing stands in for the model's choice"*. That honesty matters: this function is
the *one* place where the stand-in does something a real model would do semantically, and a
reader needs to know that so they never mistake the offline numbers for evidence about
tool-selection quality.

Note the order: `arrive` is tested first. "When will ORD-102 arrive?" contains both "when" and
"arrive"; "How much refund will I get for ORD-103?" contains only "refund". The order only
matters when a question contains several keywords, and putting the more specific pattern first
is the habit that keeps it correct.

**Block 6 — `evidenceOf()`, and the bug it documents.**

```ts
function evidenceOf(context: string): string {
  return context
    .split("\n")
    .map((line) => line.replace(/^(SOURCE: \S+|TOOL RESULT \d+:)\s*/, "").trim())
    .filter((line) => line !== "")
    .join(" ");
}
```

The comment records a real bug from this project's development, and it is the most useful
comment in the file. The first version *filtered out* lines starting with `TOOL RESULT`, on the
theory that labels are not evidence. The effect: for an order case the context is
`"TOOL RESULT 1: Order ORD-101 has been shipped…"` — a single line, entirely a tool line — so
the evidence became the empty string, the answer became the refusal, and three Category B cases
failed on `correctness` with no indication of why.

The fix is the distinction the comment draws: **strip the address, keep the claim.** Labels are
addressing information; the text after them is the evidence. `filter` discards the line;
`map` + `replace` repairs it. That difference is the difference between an eval that works and
an eval that lies.

---

## `src/services/model.ts` — the full file (part 2 of 3: the offline stand-in)

```ts
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
```

### Block-by-block (part 2)

**Block 7 — `answer()`: two decisions, in the right order.**

```ts
const orderId = orderIdIn(question);

if (orderId !== undefined && toolNames.length > 0) {
  return { kind: "tool", name: chooseTool(question), argument: orderId };
}

const evidence = evidenceOf(context);
return { kind: "answer", content: evidence === "" ? REFUSAL : evidence };
```

The condition has **two** parts, and both are necessary:

| Condition | What it enforces |
| :--- | :--- |
| `orderId !== undefined` | an order question is answered from the tools |
| `toolNames.length > 0` | …but only when tools were offered — the second turn withholds them, so the model must answer instead of looping |

Drop the second condition and the agent loops forever on the first tool call. Drop the first and
every order question becomes a refusal. This is the only place the tool budget is actually
enforced, and it is enforced by a *condition*, not a counter.

Then the answer is the evidence, or the refusal if there is none. That ternary is Category C in
one line: **no evidence → refuse.** The refusal is a constant rather than a generated sentence,
so the deterministic refusal check (Chapter 06) has a stable shape to match.

**Block 8 — `judge()`: three signals, five metrics.**

```ts
const questionOverlap = overlap(question, answer);
const goldenOverlap = overlap(goldenAnswer, answer);
const groundingOverlap = overlap(answer, evidence);
```

The stand-in can compute exactly three things, and they are computed *once each* — not inline in
the score object — for a reason that shows up in the `reason` string: they are reported back to
the human. A judge whose reasoning is not visible is a judge nobody can argue with.

Note the direction of each call, because it is the easiest thing in this file to get backwards:

| Signal | Call | Reads as |
| :--- | :--- | :--- |
| relevance | `overlap(question, answer)` | of the question's terms, how many appear in the answer |
| correctness | `overlap(goldenAnswer, answer)` | of the golden answer's terms, how many appear in the answer |
| grounding | `overlap(answer, evidence)` | **of the answer's claims, how many appear in the evidence** |

That last row is the one that matters. `overlap(answer, evidence)` asks "is every claim in the
answer supported?" — which is what faithfulness means. The reverse
(`overlap(evidence, answer)`) would ask "is every sentence of the policy quoted?", which would
score a *correct, concise* answer badly and a *verbatim dump* perfectly. Getting this backwards
inverts the metric's incentive — and the metric still looks plausible in a report.

**Block 9 — the five scores, and the refusal special case.**

```ts
const scores: JudgeScores = {
  relevance: refusal ? 5 : toScore(questionOverlap),
  correctness: toScore(goldenOverlap),
  faithfulness: refusal ? 5 : toScore(groundingOverlap),
  hallucinationFree: refusal ? 5 : toScore(groundingOverlap),
  helpfulness: complete ? 5 : 3,
};
```

Three of the five metrics have a refusal branch, and the reasoning is in the comment: **a refusal
asserts nothing, so there is nothing for it to be unfaithful to.** A refusal is grounded by
definition — it makes no factual claim at all.

This is not the stand-in being lenient; it is the stand-in being *correct*. Chapter 06 §6.2.1 is
explicit that a refusal is a valid behaviour, and a judge that scores refusals as ungrounded or
unhelpful pushes the agent towards confident guessing — the exact failure the Category C cases
exist to prevent.

`correctness` has **no** refusal branch, and that is deliberate: a refusal is correct only when
the dataset says a refusal is expected. For `out-of-scope-weather` the `goldenAnswer` *is* a
refusal, so `goldenOverlap` scores it correctly; on a policy question a refusal would score near
zero. One metric, no special case, correct in both directions.

**Block 10 — `helpfulness`, and naming the stand-in's blind spot.**

```ts
const complete = /[.!?]\s*$/.test(answer.trim()) && answer.trim().length >= 20;
…
helpfulness: complete ? 5 : 3,
```

Helpfulness is the metric a stand-in is *least* able to judge: it needs tone, clarity, structure
and next-step advice. So the stand-in scores the only thing it can actually see — whether a
complete sentence was produced — and the comment says so.

That is the honest shape for a stand-in. The alternative, inventing a plausible-looking
helpfulness score from a length heuristic, would produce numbers that *look* like quality
measurements and are not. **A proxy that announces itself is better than a fake metric that does
not.**

**Block 11 — the `reason` string.**

```ts
reason:
  `overlap with the question ${questionOverlap.toFixed(2)}, ` +
  `with the golden answer ${goldenOverlap.toFixed(2)}, ` +
  `with the evidence ${groundingOverlap.toFixed(2)}` +
  (refusal ? "; the answer is a refusal, which claims nothing" : ""),
```

Chapter 06 §6.5 requires a reason on every score, and here it is built from the exact numbers
that produced the scores. When `policy-reworded-window` scored 4 on relevance during development,
this string said `overlap with the question 0.75` — which was enough to work out that `after` was
being counted as a content term, and that the stop list needed a temporal section.

That is the whole value of the reason field: **it converts "a metric is low" into "here is the
arithmetic".** Two decimal places, because the difference between `0.75` and `0.67` is the
difference between passing and failing a threshold of 4.

**The limitation the class comment names.** Faithfulness and hallucination-free are both derived
from `groundingOverlap`, so the stand-in *cannot* distinguish two failures a real judge separates
cleanly:

| Failure | What happened | `groundingOverlap` |
| :--- | :--- | :--- |
| unfaithful | the answer **omits** a required fact | low |
| hallucination | the answer **invents** a fact | low |

Both look like "some of the answer's terms are not in the evidence". A real judge distinguishes
them because it reads meaning: a missing fact is a *completeness* problem (fix retrieval or the
prompt), an invented fact is a *safety* problem (fix the grounding instructions). Naming this in
the code is what stops the two metrics from being mistaken for independent measurements when the
stand-in is in use.

---

## `src/services/model.ts` — the full file (part 3 of 3: the real model)

```ts
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
```

### Block-by-block (part 3)

**Block 12 — the tool schema, built from `toolDefinitions`.**

```ts
const tools = toolDefinitions
  .filter((tool) => allowed.includes(tool.name))
  .map((tool) => ({ type: "function" as const, function: { name, description, parameters } }));
…
...(tools.length > 0 ? { tools } : {}),
```

The `.filter()` implements the tool budget on the real path. `allowed` is `toolNames` on the first
turn and `[]` on the second — so the second request is sent with **no tools at all**, and the model
cannot call one. Same mechanism as the offline stand-in's `toolNames.length > 0` check, expressed
in the provider's own vocabulary.

The conditional spread matters for the API, not for TypeScript: OpenAI rejects an empty `tools: []`
array, so the key has to be *absent* rather than empty. `as const` on `type: "function"` is what
lets the literal survive into the SDK's discriminated union.

**Block 13 — `temperature: 0`, and what it does not fix.**

```ts
temperature: 0,
```

Chapter 05 §5.2 asks for a frozen run, and `temperature: 0` is the closest a hosted model gets. It
is worth being precise about the limit: it reduces sampling variance but does not eliminate it.
Provider-side model updates, non-deterministic kernels and prompt-cache effects all still move the
output. That is exactly why the judge's identity is recorded on every score — the version string is
the honest acknowledgement that reproducibility here is *approximate*, and a report has to say so.

**Block 14 — reading the tool call.**

```ts
const call = message?.tool_calls?.[0];
if (call?.type === "function") {
  const args = JSON.parse(call.function.arguments) as { orderId?: string };
  return { kind: "tool", name: call.function.name, argument: args.orderId ?? "" };
}
return { kind: "answer", content: message?.content?.trim() || REFUSAL };
```

The optional chaining is not defensive style — it is the actual API shape. A completion may have no
choices; a message may have no tool calls; and a message *does* have no content when the model calls
a tool. Every `?.` here corresponds to a real state.

The `?? ""` on `args.orderId` means a malformed tool call produces an empty argument rather than
`undefined`. An empty argument flows into `runTool`, which returns `"Order not found: ."`, and the
deterministic argument check then fails with a clear message. **A malformed model call becomes a
test failure rather than a crash** — the same principle as Chapter 03's "a tool failure is a
result".

**Block 15 — the judge prompt, assembled from the parts.**

```ts
content: [
  `USER QUESTION:\n${question}`,
  `EXPECTED ANSWER:\n${goldenAnswer}`,
  `RAG EVIDENCE:\n${context}`,
  `TOOL EVIDENCE:\n${toolEvidence}`,
  `ACTUAL ANSWER:\n${answer}`,
  rubric,
  `Return a JSON object with integer fields ${METRICS.join(", ")} and a string reason.`,
].join("\n\n"),
```

Read this as Chapter 06 §6.5's input list, in the notes' own order: question, golden answer, RAG
evidence, tool evidence, generated answer, rubric, output format. The judge receives exactly the
payload the notes describe, because `Judge.score()` supplies exactly those fields.

Two details are load-bearing:

- **The labels** (`USER QUESTION:`, `EXPECTED ANSWER:`, …). A judge given six unlabelled paragraphs
  has to guess which is which; labelled, it cannot. Same principle as `buildContext`'s `SOURCE:`
  lines.
- **`METRICS.join(", ")`** in the final instruction. The metric list is interpolated from the same
  constant the aggregation uses, so a metric cannot be added to the report without being requested
  from the judge.

**Block 16 — parsing the judge's reply, defensively.**

```ts
const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as
  Partial<Record<string, number>> & { reason?: string };

return {
  scores: Object.fromEntries(METRICS.map((metric) => [metric, Number(parsed[metric] ?? 1)])) as JudgeScores,
  reason: String(parsed.reason ?? ""),
};
```

Three defences, each answering a real failure mode:

| Defence | Failure it survives |
| :--- | :--- |
| `?? "{}"` | the model returned nothing, or returned prose that is not JSON |
| `Partial<Record<…>>` | the model omitted a metric — a `Partial`, not a `Record`, so the type tells the truth |
| `?? 1` per metric | a missing metric scores **1**, not `undefined` — which would produce `NaN` averages and poison the whole report |

That last one is the important one. `undefined` propagating into an average is the most common way
an eval dashboard quietly becomes wrong: one bad judge response, one `NaN`, and every number
downstream is meaningless. Defaulting to the *worst* score is the fail-safe direction — a malformed
judge response can only make the run look worse, never better.

`String(parsed.reason ?? "")` guarantees `reason` is a string even if the model returned a number
or an object. The report prints it; the report must not throw.

**Block 17 — `createModel()`, the only place the choice is made.**

```ts
export function createModel(): ModelClient {
  return config.hasModelKey ? new OpenAIModel() : new OfflineModel();
}
```

One factory, one condition, and the rest of the project never asks again. Note that
`new OpenAIModel()` is only *constructed* when a key exists — which matters, because
`new OpenAI()` throws without one. A fresh clone with an empty `.env` never touches the SDK.

This is also why `npm run typecheck` passes offline: the `openai` import is static, but
instantiation is conditional, so none of the code paths this guide exercises needs credentials.

---

## Checkpoint

1. **Why does `Judge` hold a `ModelClient` rather than an OpenAI client?**
   So the pipeline is reproducible with no key. The judge's logic — the rubric, the five metrics,
   the threshold comparison — is then testable independently of any provider.

2. **Why is `judgeVersion` attached by the judge rather than by the model?**
   Because *being a judge* is the judge's business. The model reports scores and a reason; the judge
   is what knows it is acting as an instrument, and it stamps its identity accordingly.

3. **Why are faithfulness and hallucination-free computed from the same signal in the stand-in?**
   Because a set-overlap test cannot tell a *missing* fact from an *invented* one. The limitation is
   named in the code so the two metrics are not mistaken for independent measurements when the
   stand-in is in use.

4. **Why does a refusal score 5 on faithfulness?**
   Because a refusal asserts nothing, so there is nothing for it to be unfaithful to. Chapter 06
   §6.2.1: scoring refusals as ungrounded pushes the agent towards confident guessing.

5. **Why does a missing metric default to 1 rather than 0 or `undefined`?**
   `undefined` poisons every average with `NaN`; `0` is off-scale. `1` is on-scale, is the fail-safe
   direction, and stops a malformed judge response from making a run look better than it is.

---

**[Chapter 08: The Four-Layer Pipeline →](./08_The_Four_Layer_Pipeline.md)**
