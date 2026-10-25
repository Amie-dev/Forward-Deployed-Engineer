/**
 * Chapter 02 §2.8 — the shapes an eval is made of.
 *
 * Three ingredients, three types, and one result. Everything else in this
 * project is a function over these:
 *
 *   1. `EvalCase.input`      — the test input
 *   2. `EvalCase.expected`   — the expected **behaviour** (never the expected text)
 *   3. `EvalCase.evaluators` — how to judge it: code, a judge, or a human
 *
 * The reason `expected` is a bag of *properties* rather than one golden string is
 * Chapter 01's whole argument: `expected === actual` cannot be written for an
 * answer that has three acceptable phrasings, so we assert behaviour instead.
 */

/** Chapter 03 §3.5 — the taxonomy a dataset promises to cover. */
export type Category =
  | "normal"
  | "reworded"
  | "edge"
  | "out_of_scope"
  | "missing_info"
  | "adversarial";

export const CATEGORIES: Category[] = [
  "normal",
  "reworded",
  "edge",
  "out_of_scope",
  "missing_info",
  "adversarial",
];

/** The structured envelope the application under test returns (Chapter 04 §4.3.4–4.3.5). */
export type AppStatus = "OK" | "REFUSED" | "NEEDS_INFO";

export interface AppEnvelope {
  status: AppStatus;
  answer: string;
  /** Only present when the question asked for a structured payload (Chapter 04 §4.3.6). */
  recommendations?: string[];
}

/**
 * Ingredient 2 — the expected behaviour.
 *
 * Every field is optional because a case uses only the ones it needs: a refusal
 * case has no `mustMention`, a retrieval case has no `expectedTool`.
 */
export interface ExpectedBehaviour {
  mustMention?: string[];
  mustNotClaim?: string[];
  expectedTool?: string;
  expectedArgs?: Record<string, unknown>;
  expectedStatus?: AppStatus;
  expectedDocs?: string[];
  maxRecommendations?: number;
}

/** Ingredient 3 — how this case is judged. */
export type EvaluatorSpec =
  | { kind: "code"; checks: string[] }
  | { kind: "llmJudge"; metric: MetricName; scale: Scale }
  | { kind: "human"; metric: MetricName };

export type MetricName =
  | "relevance"
  | "correctness"
  | "faithfulness"
  | "helpfulness"
  | "hallucination";

/** Chapter 05 §5.3.1 — the scales the lecture uses. */
export type Scale = "1-5" | "1-10" | "1-100";

/** Ingredient 1, plus everything else a case carries. */
export interface EvalCase {
  /** Stable across runs — regression tracking is impossible without it (Chapter 02 §2.8). */
  id: string;
  category: Category;
  input: string;
  goldenAnswer?: string;
  expected: ExpectedBehaviour;
  evaluators: EvaluatorSpec[];
}

/** Chapter 03 §3.8 — a dataset is a file with a header that versions it. */
export interface EvalDatasetFile {
  revision: number;
  app: string;
  createdAt: string;
  categories: Category[];
  cases: EvalCase[];
}

/** Chapter 08 §8.2 — one retrieved document, with the rank that matters for MRR. */
export interface Retrieved {
  id: string;
  rank: number;
  score: number;
}

/** Chapter 04 §4.8 — the artefacts a check is a pure function over. */
export interface RunContext {
  raw: string;
  answer: string;
  parsed: AppEnvelope | null;
  retrieved: Retrieved[];
  contextSent: string[];
  calls: { name: string; args: Record<string, unknown> }[];
  usage: { ms: number; tokens: number; usd: number; toolCalls: number; modelCalls: number };
}

/** One case, run once, plus the identity of the version that produced it. */
export interface AppRun extends RunContext {
  /** Chapter 02 §2.8 — a score without a version is not comparable to anything. */
  version: string;
}

export interface CheckOutcome {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface QualityOutcome {
  metric: MetricName;
  score: number;
  reason: string;
  /** Chapter 06 §6.4 — "scores must be attributable to a judge prompt version". */
  judgeVersion: string;
}

/** One case's full result. Deterministic and quality are kept apart on purpose (Chapter 02 §2.8). */
export interface EvalResult {
  caseId: string;
  category: Category;
  appVersion: string;
  response: string;
  deterministic: CheckOutcome[];
  quality: QualityOutcome[];
  retrieval: RetrievalScore;
  attribution: Attribution;
  usage: AppRun["usage"];
}

/**
 * Chapter 08 §8.2 — retrieval is set arithmetic, so it needs no judge.
 *
 * `applicable` exists because not every case *has* a retrieval expectation: a
 * tool-calling case and a refusal case declare no `expectedDocs`, and scoring
 * them as retrieval failures would be a category error. Averages are taken over
 * applicable cases only.
 */
export interface RetrievalScore {
  applicable: boolean;
  hit: boolean;
  recall: number;
  precision: number;
  firstRelevantRank: number | null;
}

/** Chapter 08 §8.4 — the classifier that gives every failure an owner. */
export type Attribution = "retrieval" | "generation" | "spec" | "pass";

/** Chapter 02 §2.8 — the dataset-level report. Never a single blended number. */
export interface EvalReport {
  appVersion: string;
  datasetRevision: number;
  cases: number;
  deterministicPassRate: number;
  averages: Record<string, number>;
  byCategory: Record<string, { cases: number; passRate: number }>;
  attribution: Record<Attribution, number>;
  retrieval: { hitRate: number; recall: number; precision: number; mrr: number };
  regressions: string[];
  gate: { blocked: boolean; reasons: string[] };
  coverage: CoverageReport;
  cost: { tokens: number; usd: number; avgMs: number };
}

/** Chapter 03 §3.8 — the report teams skip, and then regret skipping. */
export interface CoverageReport {
  byCategory: Record<string, number>;
  missingCategories: Category[];
}
