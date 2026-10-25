# Chapter 02 — Config and the Trace Contract

> **Two files, and between them the vocabulary of the whole lecture.** `config.ts` says
> *what is being measured*; `types.ts` says *what a measurement is*. Everything else in
> the project is a function over the types, parameterised by the config.

---

## File details

| | `src/config/config.ts` | `src/domain/types.ts` |
|---|---|---|
| **Lines** | 92 | 168 |
| **Layer** | config | domain |
| **Purpose** | read the environment, own the thresholds, produce `appVersion` | the shapes: the trace, the response, the case, the result, the report |
| **Exports** | `config`, `appVersion()` | 14 types, 1 constant (`METRICS`) |
| **Imports** | `dotenv/config`, `domain/types.js` | **nothing** |
| **Notes sections** | Ch02 §2.8, Ch05 §5.2, Ch06 §6.4, Ch08 §8.4/§8.6 | Ch02 §2.2/§2.8, Ch03 §3.3–3.7, Ch04 §4.2, Ch05 §5.3, Ch06 §6.3/§6.5, Ch07 §7.3, Ch08 §8.6 |

**`types.ts` imports nothing at all.** That is not an accident — it is the constraint
that keeps the data model readable in isolation. A type that imported a service would
drag the whole project into a file whose job is to describe shapes.

---

## Commands

```bash
npm run typecheck     # both files are pure types plus a tiny config read

# the app version *is* the config, so you can watch it change:
RETRIEVAL_TOPK=2 npm run eval 2>&1 | grep 'app '
#   app            agent-v1.0.0 | topK=2 | prompt=v1 | model=offline

# and a per-metric threshold override:
EVAL_MIN_FAITHFULNESS=5 npm run eval 2>&1 | grep faithfulness
#   faithfulness      5.00   threshold 5
```

---

## `src/config/config.ts` — the full file

```ts
import "dotenv/config";
import { METRICS, type MetricName } from "../domain/types.js";

/**
 * Chapter 02 §2.8 / Chapter 08 §8.4 — the configuration **is** what is being
 * measured.
 *
 * Every threshold lives here, read from the environment rather than buried in a
 * function body, because Chapter 08 asks for "explicit, reviewable thresholds".
 * A gate whose limits are hard-coded somewhere in `services/` is not reviewable
 * and not negotiable — and thresholds are product decisions, so they must be
 * negotiable.
 */

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }

  return value;
}

/**
 * Chapter 08 §8.4 — one threshold per metric, not one global number.
 *
 * `EVAL_MIN_SCORE` is the default; `EVAL_MIN_FAITHFULNESS=5` tightens a single
 * metric without touching the others. That is the whole point of Chapter 08
 * §7.8.2's "per-metric thresholds": faithfulness is a hard correctness signal
 * while helpfulness is a soft one, and a single number hides the difference.
 */
const defaultThreshold = numberFromEnv("EVAL_MIN_SCORE", 4);

const metricThresholds = Object.fromEntries(
  METRICS.map((metric) => [
    metric,
    numberFromEnv(`EVAL_MIN_${metric.replace(/([A-Z])/g, "_$1").toUpperCase()}`, defaultThreshold),
  ]),
) as Record<MetricName, number>;

export const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: numberFromEnv("PORT", 8080),

  /** Chapter 02 §2.2 — how many policy documents retrieval returns. The topK lever. */
  topK: numberFromEnv("RETRIEVAL_TOPK", 1),

  /**
   * Chapter 05 §5.2 — the operational budget. Note this is a *check*, not a
   * metric: latency is deterministic, so no judge is involved.
   */
  budget: {
    maxLatencyMs: numberFromEnv("EVAL_MAX_LATENCY_MS", 5000),
    maxToolCalls: 3,
  },

  /** Chapter 07 §7.8 — Layer 3: the quality thresholds, per metric. */
  metricThresholds,

  /** Chapter 08 §8.6 — the release gate: what fraction of cases must pass. */
  minPassRate: numberFromEnv("EVAL_MIN_PASS_RATE", 1),

  /**
   * Chapter 03 §3.7 — the prompt is versioned, because "the answer got worse"
   * is not a bug report until you know which prompt produced it.
   */
  promptVersion: "v1",

  /** Chapter 06 §6.4 — which model judges, when a key is present. */
  model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  hasModelKey: (process.env.OPENAI_API_KEY ?? "").trim() !== "",
};

/**
 * Chapter 02 §2.8 — a description of the configuration.
 *
 * A score with no version attached cannot be compared to anything: change a
 * threshold or a topK and you have changed what is being measured.
 */
export function appVersion(): string {
  return (
    `agent-v1.0.0 | topK=${config.topK} | prompt=${config.promptVersion} | ` +
    `model=${config.hasModelKey ? config.model : "offline"}`
  );
}
```

### Block-by-block

**Block 1 — `numberFromEnv(name, fallback)`.**

```ts
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}
```

Three decisions in five lines:

| Line | Why |
| :--- | :--- |
| `?.trim()` | an env var set to `"  "` is a typo, not a value. Treating it as "unset" is kinder than treating it as `0`. |
| `return fallback` | **unset is not an error.** A fresh clone with no `.env` must run. This is what makes the project reproducible on someone else's machine. |
| `throw` on non-finite | a *wrong* value is an error. `EVAL_MIN_SCORE=five` should stop the run loudly, not silently become `NaN` and make every threshold comparison `false` — which would fail every case and look like a model problem. |

That last distinction is the whole function: **absent → default, malformed → stop.**

**Block 2 — the per-metric thresholds.**

```ts
const defaultThreshold = numberFromEnv("EVAL_MIN_SCORE", 4);

const metricThresholds = Object.fromEntries(
  METRICS.map((metric) => [
    metric,
    numberFromEnv(`EVAL_MIN_${metric.replace(/([A-Z])/g, "_$1").toUpperCase()}`, defaultThreshold),
  ]),
) as Record<MetricName, number>;
```

The `replace` turns `hallucinationFree` into `HALLUCINATION_FREE`, so the env key is
`EVAL_MIN_HALLUCINATION_FREE`. That is a small piece of ergonomics with a real purpose:
Chapter 08 §8.4 says a threshold is a business decision, and a business decision that
requires a code change to adjust is not really a decision the business can make.

Note that the default is *computed once* and then reused as the fallback for all five
metrics. So `EVAL_MIN_SCORE=4` means "4 for everything", and
`EVAL_MIN_FAITHFULNESS=5` means "5 for faithfulness, 4 for the rest" — without either
setting knowing about the other.

**Block 3 — the `config` object.**

```ts
export const config = {
  host: ..., port: ...,
  topK: numberFromEnv("RETRIEVAL_TOPK", 1),
  budget: { maxLatencyMs: ..., maxToolCalls: 3 },
  metricThresholds,
  minPassRate: numberFromEnv("EVAL_MIN_PASS_RATE", 1),
  promptVersion: "v1",
  model: ..., hasModelKey: ...,
};
```

Read the members as a list of things that, if changed, change *what is being measured*:

| Member | Changed by | Which measurement it moves |
| :--- | :--- | :--- |
| `topK` | `RETRIEVAL_TOPK` | how much context the agent gets — the regression lever |
| `budget.maxLatencyMs` | `EVAL_MAX_LATENCY_MS` | the latency check |
| `metricThresholds` | `EVAL_MIN_*` | which quality scores count as passing |
| `minPassRate` | `EVAL_MIN_PASS_RATE` | how many cases must pass for the gate to open |
| `promptVersion` | (code) | the identity of the prompt the answer came from |
| `hasModelKey` | `OPENAI_API_KEY` | **whether the judge is a model or a stand-in** |

That last row is the one people forget. Turning on the API key changes the instrument,
which changes the numbers — and Chapter 06 §6.4's requirement that every score carry a
`judgeVersion` exists precisely so that this change is never invisible.

**Block 4 — `appVersion()`.**

```ts
export function appVersion(): string {
  return `agent-v1.0.0 | topK=${config.topK} | prompt=${config.promptVersion} | ` +
    `model=${config.hasModelKey ? config.model : "offline"}`;
}
```

A function rather than a constant, because the version describes *a run*, and a run
could in principle use a different `topK` than the configured default. The report
records this string on every run, so two reports with different strings are known to be
incomparable before anyone compares their numbers.

Notice what it prints when there is no key: `model=offline`. A report that said
`model=gpt-4o-mini` when no model was called would be a lie — and it is exactly the kind
of lie that makes a team trust an eval suite that is measuring nothing.

---

## `src/domain/types.ts` — the full file (part 1 of 2)

```ts
/**
 * Chapter 03 §3.4–3.5 — the vocabulary of the whole project.
 *
 * Chapter 01's argument is that an AI application is a **pipeline**, not an
 * input→output function, so the answer alone is not testable evidence. These
 * types are that argument made concrete: `Trace` is what the tester sees,
 * `AgentResponse` is what the caller sees, and every check in Chapters 05–08 is
 * a function over those two objects.
 *
 * This file imports nothing. That is deliberate — the data model should be
 * readable on its own, without a service dragged in behind it.
 */

/** Chapter 02 §2.2 — the three capabilities this agent has. */
export type Category = "A" | "B" | "C";

/** Chapter 03 §3.4.1 — one retrieved document, with the rank that matters later. */
export interface RetrievedDocument {
  /** A stable id. Compare on this, never on a file name (Chapter 05 §5.3.4). */
  id: string;
  /** 1-based position in the ranked list. */
  rank: number;
  score: number;
  /** The text that goes into the context, kept here so the trace is self-contained. */
  text: string;
}

/** Chapter 03 §3.4.4 — one tool call. The name and its argument stay together. */
export interface ToolCall {
  name: string;
  argument: string;
  result: string;
}

/**
 * Chapter 03 §3.6 — the trace: what the eval needs, and what the user must not see.
 *
 * The ids and the versions are not decoration. Chapter 03 §3.8 lists "no ids, no
 * versions" as a mistake precisely because a failure you cannot correlate with a
 * deploy is a failure you cannot fix.
 */
export interface Trace {
  traceId: string;
  /** Set only during an eval run, so a failure maps back to one dataset row. */
  caseId?: string;
  question: string;
  retrievedDocuments: RetrievedDocument[];
  /** The exact string the model was given. Never re-derived (Chapter 03 §3.7). */
  context: string;
  toolCalls: ToolCall[];
  latencyMs: number;
  model: string;
  promptVersion: string;
}

/**
 * Chapter 03 §3.3 — the second output of every request.
 *
 * The three parallel arrays are what make Chapter 05 possible: `toolsUsed` and
 * `toolArguments` are index-aligned so a failure can name *both* the tool and the
 * bad argument, and `toolResults` is the raw evidence that faithfulness is judged
 * against in Chapter 06.
 */
export interface AgentResponse {
  answer: string;
  /** Ids only, in rank order. An empty array is evidence, not missing data. */
  retrievedDocuments: string[];
  /** Tool names, in call order. */
  toolsUsed: string[];
  /** One entry per call, index-aligned with `toolsUsed`. */
  toolArguments: string[];
  /** One entry per call, index-aligned. The raw evidence. */
  toolResults: string[];
  context: string;
  trace: Trace;
}

/** Chapter 04 §4.2 — one row of the golden dataset. */
export interface GoldenCase {
  /** Stable across runs; a failure has to name the same case next time. */
  id: string;
  category: Category;
  question: string;
  /** Chapter 04 §4.2.2 — `null` is a real expectation: "must NOT retrieve". */
  expectedSource: string | null;
  /** `null` means "no tool may be called" — a Category A policy question. */
  expectedTool: string | null;
  expectedToolArgument: string | null;
  /** The reference answer. Only the judge reads it (Chapter 04 §4.2.1). */
  goldenAnswer: string;
}

/** Chapter 04 §4.3 — the dataset is a versioned artefact, not a generator. */
export interface GoldenDataset {
  revision: number;
  app: string;
  cases: GoldenCase[];
}
```

### Block-by-block (part 1)

**Block 1 — `Category`.**

```ts
export type Category = "A" | "B" | "C";
```

A union of three literals rather than an enum or a string. Chapter 02 §2.2's three
categories are `A` (policy question → retrieval), `B` (order question → tools) and `C`
(unsupported → refusal). Making them a closed union means the compiler refuses a typo,
and the report can group by category without a lookup table.

**Block 2 — `RetrievedDocument`.**

```ts
export interface RetrievedDocument {
  id: string;
  rank: number;
  score: number;
  text: string;
}
```

Four fields, and the interesting one is `rank`. Chapter 03 §3.4.1's point is that
"retrieved" is not the same as "used": a document at position 9 is barely used, so the
position is part of the evidence. `score` is kept for the same reason — it is what makes
the `topK` regression visible in the trace rather than only in the result.

`text` is here so the trace is **self-contained**: a `Trace` you have to re-hydrate from
another system is a trace that can disagree with what the model actually saw.

**Block 3 — `ToolCall`.**

```ts
export interface ToolCall {
  name: string;
  argument: string;
  result: string;
}
```

One object holding the name, the argument and the result *together*. Chapter 05 §5.3.3
turns on this: `getOrderStatus("ORD-999")` must fail the *argument* check while passing
the *tool* check, and that is only expressible if the argument travels with the name.
A single `toolsUsed: string[]` would make "wrong tool" and "right tool, wrong argument"
the same failure.

**Block 4 — `Trace`.**

```ts
export interface Trace {
  traceId: string;
  caseId?: string;
  question: string;
  retrievedDocuments: RetrievedDocument[];
  context: string;
  toolCalls: ToolCall[];
  latencyMs: number;
  model: string;
  promptVersion: string;
}
```

This is Chapter 03 §3.6 in code, and every field has a consumer:

| Field | Who reads it | What it enables |
| :--- | :--- | :--- |
| `traceId` | logs, `x-trace-id` header | correlating a failure with a request |
| `caseId?` | the pipeline | mapping a failure back to one dataset row |
| `question` | the judge | relevance |
| `retrievedDocuments` | the checks | the retrieval half of RAG evaluation |
| `context` | the judge | faithfulness, hallucination-free |
| `toolCalls` | the checks | tool selection and argument correctness |
| `latencyMs` | the checks | the operational budget |
| `model`, `promptVersion` | the report | "which version produced this number" |

`caseId` is optional (`caseId?`) because production traffic has no case. That single
`?` is the difference between a trace format that works in an eval and one that works in
production — and Chapter 03 §3.8's warning about "no ids" is about exactly this field
being absent in real systems.

**Block 5 — `AgentResponse`.**

```ts
export interface AgentResponse {
  answer: string;
  retrievedDocuments: string[];
  toolsUsed: string[];
  toolArguments: string[];
  toolResults: string[];
  context: string;
  trace: Trace;
}
```

The four parallel arrays look redundant next to `trace.toolCalls` and
`trace.retrievedDocuments`, and the redundancy is deliberate. Chapter 05 §5.3.2–5.3.3
writes checks as `toolsUsed.includes(...)` and `toolArguments.includes(...)` — array
operations on flat lists. Deriving those lists inside every check would put the same
projection in eight places; storing them once puts it in one, and `trace` keeps the
richer structure for the judge and the report.

**Block 6 — `GoldenCase`.**

```ts
export interface GoldenCase {
  id: string;
  category: Category;
  question: string;
  expectedSource: string | null;
  expectedTool: string | null;
  expectedToolArgument: string | null;
  goldenAnswer: string;
}
```

Read the three `| null` annotations as the most important decision in this file.

| Field | `null` means | Which check it makes possible |
| :--- | :--- | :--- |
| `expectedSource` | *no document may be retrieved* | "No unexpected source" — catches over-retrieval |
| `expectedTool` | *no tool may be called* | "No unexpected tool" — catches a needless database hit |
| `expectedToolArgument` | no argument is expected | makes the argument check trivially true on policy cases |

Chapter 04 §4.2.2 is blunt about why this matters: **a dataset that only states positive
expectations can never detect over-retrieval.** If "no source expected" were expressed as
an omitted field, the check would have nothing to compare against and would pass
silently — and the `RETRIEVAL_TOPK=2` regression would be invisible.

Note there is no `expectedAnswer` field, and `goldenAnswer` is *not* it: `goldenAnswer` is
a reference for the judge to compare *meaning* against, never a string for code to
compare equality against. That is Chapter 01's entire argument, enforced by the type.

---

## `src/domain/types.ts` — the full file (part 2 of 2)

```ts
/** Chapter 05 §5.3 — one deterministic check, and what it actually compared. */
export interface CheckResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

/**
 * Chapter 06 §6.3 — five metrics, one direction.
 *
 * `hallucinationFree` is named this way on purpose: 5 means *good* for every
 * metric, so no aggregation ever has to remember which way a number points.
 */
export type MetricName =
  | "relevance"
  | "correctness"
  | "faithfulness"
  | "helpfulness"
  | "hallucinationFree";

export const METRICS: MetricName[] = [
  "relevance",
  "correctness",
  "faithfulness",
  "helpfulness",
  "hallucinationFree",
];

export type JudgeScores = Record<MetricName, number>;

/** Chapter 06 §6.5 — the judge's structured output: a score per metric, plus a reason. */
export interface JudgeResult {
  scores: JudgeScores;
  reason: string;
  /** Chapter 06 §6.4 — a score must name the instrument that produced it. */
  judgeVersion: string;
}

/** Chapter 07 §7.3 — one case, run once, through all four layers. */
export interface CaseResult {
  caseId: string;
  category: Category;
  question: string;
  response: AgentResponse;
  /** Layer 1 — deterministic. */
  checks: CheckResult[];
  /** Layer 2 — the judge. */
  quality: JudgeResult;
  /** Layer 3 — the thresholds this case missed. */
  thresholdFailures: string[];
  /** Layer 4 — the verdict. */
  passed: boolean;
}

/** Chapter 08 §8.6 — the report, and the gate a release is judged by. */
export interface EvalReport {
  appVersion: string;
  judgeVersion: string;
  datasetRevision: number;
  cases: number;
  passed: number;
  passRate: number;
  deterministicPassRate: number;
  averages: JudgeScores;
  byCategory: Record<string, { cases: number; passed: number }>;
  failures: { caseId: string; layer: string; detail: string }[];
  gate: { blocked: boolean; reasons: string[] };
}
```

### Block-by-block (part 2)

**Block 7 — `CheckResult`.**

```ts
export interface CheckResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}
```

Four fields, and the last two are why this type exists. A boolean alone gives you a red
dot; `expected` and `actual` give you a sentence someone can act on:

```text
No unexpected source: expected=return-policy actual=return-policy, refund-policy
```

Chapter 07 §7.6 says a deterministic failure should print `expected=X actual=Y`, and that
requirement is satisfied *by the shape of this type* rather than by remembering to format
it at every call site. Both fields are `string`, not `unknown`: they are for humans, and
the conversion happens once, in `deterministic.ts`.

**Block 8 — `MetricName`, `METRICS`, `JudgeScores`.**

```ts
export type MetricName = "relevance" | "correctness" | "faithfulness" | "helpfulness" | "hallucinationFree";
export const METRICS: MetricName[] = ["relevance", "correctness", "faithfulness", "helpfulness", "hallucinationFree"];
export type JudgeScores = Record<MetricName, number>;
```

A type and a runtime array of the same five names. The type makes a typo impossible
anywhere in the project; the array makes it possible to *iterate* — which is what
`config.ts` uses to build per-metric thresholds, what `report.ts` uses to compute
averages, and what `judge.ts` uses to find threshold failures.

**The naming choice is the lecture's.** `hallucinationFree`, not `hallucination`. With a
metric called `hallucination`, 5 would mean *bad* and 1 would mean *good* — and every
aggregation, threshold and report column would have to remember the inversion. One
slightly awkward name buys a uniform direction: **5 is good, everywhere.**

**Block 9 — `JudgeResult`.**

```ts
export interface JudgeResult {
  scores: JudgeScores;
  reason: string;
  judgeVersion: string;
}
```

Three fields, each with a job:

| Field | Why it is not optional |
| :--- | :--- |
| `scores` | a `Record`, so a metric can never be silently missing |
| `reason` | Chapter 06 §6.5 — a score without a reason is unarguable, and an unarguable score gets ignored |
| `judgeVersion` | Chapter 06 §6.4 — "scores must be attributable to a judge prompt version" |

`judgeVersion` is the one that saves you. When the numbers move after someone edits the
rubric, the report says so — and the conversation becomes about the rubric instead of
about the model having a bad day.

**Block 10 — `CaseResult`.**

```ts
export interface CaseResult {
  caseId: string; category: Category; question: string;
  response: AgentResponse;
  checks: CheckResult[];
  quality: JudgeResult;
  thresholdFailures: string[];
  passed: boolean;
}
```

The four layers, in one object, **kept apart**:

| Field | Layer | Who owns a failure here |
| :--- | :--- | :--- |
| `checks` | 1 — deterministic | retrieval, tools, prompt |
| `quality` | 2 — the judge | prompt, grounding, response style |
| `thresholdFailures` | 3 — thresholds | the product owner who chose the number |
| `passed` | 4 — the verdict | the gate |

`response` is carried in full rather than reduced to a score, because Chapter 02 §2.8's
rule applies at this level too: a result you cannot open is a result you cannot act on.
Everything needed to debug the case — the answer, the context, the tool calls — is
reachable from here.

**Block 11 — `EvalReport`.**

```ts
export interface EvalReport {
  appVersion: string; judgeVersion: string; datasetRevision: number;
  cases: number; passed: number; passRate: number; deterministicPassRate: number;
  averages: JudgeScores;
  byCategory: Record<string, { cases: number; passed: number }>;
  failures: { caseId: string; layer: string; detail: string }[];
  gate: { blocked: boolean; reasons: string[] };
}
```

Read the field list as a list of *refusals to simplify*:

| Refusal | Field that embodies it |
| :--- | :--- |
| no single blended score | `averages` is per metric, `byCategory` is per category |
| no "failed" without a cause | `failures[].layer` and `failures[].detail` |
| no "blocked" without a reason | `gate.reasons` |
| no number without an identity | `appVersion`, `judgeVersion`, `datasetRevision` |
| no two halves merged | `passRate` and `deterministicPassRate` are separate |

Chapter 06 §6.5: *"aggregation must be per metric and per category — never a single
blended number."* This interface is that sentence, with types.

The `gate` object is created empty (`{ blocked: false, reasons: [] }`) and then
*replaced* by `gate(report)` in `report.ts`. That ordering is deliberate: the gate reads
the report, so it cannot be computed until the report exists — and making that explicit
prevents the classic bug of deciding a verdict from a half-built summary.

---

## Checkpoint

1. **Why is there no `expectedAnswer` field on `GoldenCase`?**
   Because Chapter 01's premise is that `expected === actual` cannot be written for an
   answer with several acceptable phrasings. The type asserts *behaviour* instead, and
   omitting the tempting field is what stops the premise leaking back in.

2. **Why are `checks` and `quality` separate fields on `CaseResult`?**
   So a report can show which half moved. In the `RETRIEVAL_TOPK=2` regression the quality
   scores are unchanged while the deterministic half breaks; one merged score would hide
   that — and the half is what names the owner of the fix.

3. **What is `expectedSource: null` for?**
   It is an assertion that *no document may be retrieved*. Without it, over-retrieval is
   silent, and the `topK` regression would pass the suite.

4. **Why is `appVersion()` a function rather than a constant?**
   Because the version describes *the run*. Keeping it a function means the string is
   always derived from the config actually in force at report time, never from a value
   captured at import time.

5. **Why is `MetricName` a union and not `string`?**
   So a typo is a compile error rather than a metric that silently never gets a threshold,
   never gets averaged, and never appears in a report.

---

**[Chapter 03: The Application Under Test →](./03_The_Application_Under_Test.md)**
