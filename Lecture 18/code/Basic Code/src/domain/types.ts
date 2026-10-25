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
