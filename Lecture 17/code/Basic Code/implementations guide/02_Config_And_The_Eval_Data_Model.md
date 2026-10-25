# Chapter 02 — Config and the Eval Data Model

> **Two files, and between them the vocabulary of the whole lecture.** `config.ts` says
> *what is being measured*; `types.ts` says *what a measurement is*. Everything else in the
> project is a function over the types, parameterised by the config.

---

## File details

| | `src/config/config.ts` | `src/domain/types.ts` |
|---|---|---|
| **Lines** | 60 | 186 |
| **Layer** | config | domain |
| **Purpose** | read the environment, own the thresholds, produce `appVersion` | the shapes: the three ingredients, the result, the report |
| **Exports** | `config`, `appVersion()` | 20 types and one constant (`CATEGORIES`) |
| **Imports** | `dotenv/config` | **nothing** |
| **Notes sections** | Ch02 §2.8, Ch04 §4.5/§4.8, Ch07 §7.4 | Ch02 §2.8, Ch03 §3.5, Ch04 §4.8, Ch05 §5.3.1, Ch06 §6.4, Ch08 §8.2/§8.4 |

**`types.ts` imports nothing at all.** That is not an accident — it is the constraint that
keeps the data model readable in isolation. A type that imports a service would drag the
whole project into a file whose job is to describe shapes.

---

## Commands

```bash
npm run typecheck                     # both files are pure types + a tiny config read

# the app version is the config, so you can see it change:
RETRIEVAL_TOPK=1 npm run eval --silent 2>&1 | grep 'app '
#   app           app-v1.0.0 | topK=1 | model=offline
```

---

## `src/config/config.ts` — the full file

```ts
import "dotenv/config";

/**
 * Chapter 02 — the evaluated system has a *version*, and the version **is** the
 * configuration. Change any value below and you have changed what is being
 * measured, which is why §2.8 records `appVersion` on every result: a score with
 * no version attached cannot be compared to anything.
 *
 * Every threshold here is read from the environment rather than hard-coded,
 * because Chapter 04 §4.8 asks for "explicit, reviewable thresholds" — a gate
 * whose limits are buried in a function body is not reviewable.
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

export const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: numberFromEnv("PORT", 8080),

  /** Chapter 08 §8.2 — the lever the lecture keeps returning to ("topK 5 -> 3"). */
  topK: numberFromEnv("RETRIEVAL_TOPK", 3),

  /** Chapter 04 §4.8 / Chapter 09 §9.1 — the release gate. */
  minPassRate: numberFromEnv("EVAL_MIN_PASS_RATE", 0.95),

  /** Chapter 07 §7.4 — the pointwise gate: "faithfulness >= 4.2 -> ship". */
  minFaithfulness: numberFromEnv("EVAL_MIN_FAITHFULNESS", 4.2),

  /**
   * Chapter 04 §4.5 — the operational budget. Note it is a *check*, not a metric:
   * latency and cost are deterministic, so no judge is involved.
   */
  budget: { maxMs: 5000, maxToolCalls: 2, maxUsd: 0.02 },

  /** Chapter 06 — the judge's model. Unused when the key is empty. */
  model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  hasModelKey: (process.env.OPENAI_API_KEY ?? "").trim() !== "",
};

/**
 * Chapter 02 §2.8 — a description of the configuration, so any score can be
 * attributed to the exact prompt/retrieval/model combination that produced it.
 */
export function appVersion(topK: number = config.topK): string {
  return `app-v1.0.0 | topK=${topK} | model=${config.hasModelKey ? config.model : "offline"}`;
}
```

### Block-by-block

**`import "dotenv/config";`** — a side-effecting import, and the only one in the project.
It loads `.env` into `process.env` before anything reads it. The order matters: an import
is hoisted, so this runs before `config` is constructed below it.

**`numberFromEnv(name, fallback)` — a throwing reader.** Two decisions are hidden in four
lines:

- **A missing value falls back; a *malformed* value throws.** `RETRIEVAL_TOPK=` (empty) is
  "use the default"; `RETRIEVAL_TOPK=lots` is a configuration error, and it is better to
  refuse to start than to evaluate against `NaN`. This is the same posture Chapter 04 takes
  toward checks: fail loudly on something you can detect.
- **The error names the variable and the value** — `RETRIEVAL_TOPK must be a number, got
  "lots"`. A startup failure should tell you what to fix, which is Chapter 08 §8.4's
  "recovery sentence" idea applied to config.

**`config.topK`** is the retrieval lever, and the reason it is in `config` rather than in
the retriever is that it is a *configuration* of the system under test, not an
implementation detail of it. Chapter 08 §8.2 lists `topK` first among the things to vary —
and the regression demo varies nothing else.

**`config.minPassRate` and `config.minFaithfulness`** are the two thresholds, and they are
deliberately separate because they gate different things: the first is *"did any case
break?"*, the second is *"is the average good enough?"*. Chapter 04 §4.8 wants thresholds
"explicit, reviewable" — a gate whose limits are buried in a function body is not
reviewable, so they live here where a reviewer can see them.

**`config.budget`** is the Chapter 04 §4.5 operational budget. Note it is a *check*, not a
metric: latency, tool-call count and cost are all deterministic, so no judge is involved.

**`config.hasModelKey`** — a single boolean that switches the judge. It is computed once,
at startup, rather than checked per call, so the rest of the project never has to think
about which mode it is in.

**`appVersion(topK)`** — the function Chapter 02 §2.8 asks for in one line: *"a score
without a version is not comparable to anything."* Note that it is a **description of the
configuration**, not a git hash. That is the useful kind of version here: it says
`topK=3 | model=offline`, so two reports can be diffed by reading their headers instead of
by archaeology.

**Why `appVersion` takes `topK` as a parameter.** Because the CLI and the HTTP surface can
run a candidate at a different `topK` than the configured one — and the version string has
to describe the run that actually happened, not the one the environment file describes.

---

## `src/domain/types.ts` — the full file

```ts
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
```

### Block-by-block

**Block 1 — the taxonomy (Chapter 03 §3.5).**

```ts
export type Category =
  | "normal" | "reworded" | "edge"
  | "out_of_scope" | "missing_info" | "adversarial";

export const CATEGORIES: Category[] = [ … ];
```

Six categories, and the array exists so the *coverage report* can ask a question the type
cannot: **which of these has zero cases?** A union type says what is allowed; the array
says what was promised. Chapter 03 §3.5's argument is that a dataset's composition is a
claim about what you know — and a claim is only checkable if it is enumerated somewhere.

**Block 2 — the application's output contract.**

```ts
export type AppStatus = "OK" | "REFUSED" | "NEEDS_INFO";

export interface AppEnvelope {
  status: AppStatus;
  answer: string;
  recommendations?: string[];
}
```

This is Chapter 04 §4.3.4–4.3.5's point made structural: *"structured AI architectures are
easier to evaluate."* Because the system under test returns an **enum** rather than a
sentence, three checks become trivial:

| Check | Because |
| :--- | :--- |
| `schema-valid` | the enum has three members, and a fourth is a failure |
| `refusal-status` | `status === "REFUSED"` is a string comparison, not a judgement call |
| `output-constraints` | `recommendations.length <= 3` is array arithmetic |

The alternative — a refusal expressed as *"I'm sorry, but I can't help with that"* — is a
judge call. The shape of the output decides how testable the system is, which is why this
interface is the first thing in the file.

**Block 3 — the expected behaviour (Chapter 02 §2.8).**

```ts
export interface ExpectedBehaviour {
  mustMention?: string[];
  mustNotClaim?: string[];
  expectedTool?: string;
  expectedArgs?: Record<string, unknown>;
  expectedStatus?: AppStatus;
  expectedDocs?: string[];
  maxRecommendations?: number;
}
```

**Every field is optional, and that is the design.** A refusal case has no `mustMention`; a
retrieval case has no `expectedTool`. So a case declares exactly the assertions that apply
to it, and the runner (Chapter 05) obeys the declaration rather than running everything
against everything.

Notice what is **absent**: there is no `expectedAnswer: string`. That is Chapter 01's entire
argument. `assertEquals(expected, actual)` cannot be written for an answer with three
acceptable phrasings, so the field that would tempt you into writing it does not exist.

**Block 4 — the evaluator ladder (Chapter 02 §2.5).**

```ts
export type EvaluatorSpec =
  | { kind: "code"; checks: string[] }
  | { kind: "llmJudge"; metric: MetricName; scale: Scale }
  | { kind: "human"; metric: MetricName };
```

Three variants, in the order the lecture ranks them: **code → LLM → human.** The union is
discriminated by `kind`, so `runChecks` can filter for `kind === "code"` and the type
narrowing gives it `checks: string[]` with no cast.

`{ kind: "human" }` has no implementation in this project, and it is in the type on
purpose: Chapter 07 §7.7's point is that humans decide the cases code and judges cannot, and
a dataset format that cannot *express* a human evaluator quietly asserts that they never
will.

**Block 5 — the case, and the three ingredients (Chapter 02 §2.3).**

```ts
export interface EvalCase {
  id: string;
  category: Category;
  input: string;
  goldenAnswer?: string;
  expected: ExpectedBehaviour;
  evaluators: EvaluatorSpec[];
}
```

Read it against §2.3's list and you can see the three ingredients in the field names:

| Ingredient | Field |
| :--- | :--- |
| a test input | `input` |
| an expected **behaviour** | `expected` |
| an evaluation mechanism | `evaluators` |

Two more fields are doing quiet work. **`id` must be stable** — §2.8 says regression
tracking is impossible if ids are regenerated each run, and `buildReport` compares ids to
find regressions. **`category`** is what lets the report say *"pass rate 0.5 on edge
cases"* instead of *"pass rate 0.89"*, which is the difference between a number and a
diagnosis.

**Block 6 — the dataset file (Chapter 03 §3.8).**

```ts
export interface EvalDatasetFile {
  revision: number;
  app: string;
  createdAt: string;
  categories: Category[];
  cases: EvalCase[];
}
```

`revision` is the whole point. §3.8: *bump it on every change, so scores stay comparable.*
A score of 4.4 on revision 1 and a score of 4.4 on revision 3 are not the same claim, and
without the number you would compare them anyway.

**Block 7 — the artefacts, and the trace (Chapter 04 §4.8, Chapter 08 §8.5).**

```ts
export interface RunContext {
  raw: string;          answer: string;
  parsed: AppEnvelope | null;
  retrieved: Retrieved[];
  contextSent: string[];
  calls: { name: string; args: Record<string, unknown> }[];
  usage: { ms: number; tokens: number; usd: number; toolCalls: number; modelCalls: number };
}
```

These are precisely the inputs the deterministic checks are pure functions over, which is
§4.8's "checks are pure functions over artefacts" made explicit in a type. Two of them are
worth naming:

- **`raw` and `parsed` are both kept.** `raw` is what the model emitted; `parsed` is the
  result of `JSON.parse`. The `json-valid` check needs `raw` (because *failing* to parse is
  what is being checked) and `schema-valid` needs `parsed`. Keeping only one would make one
  of the two checks impossible to write.
- **`retrieved` and `contextSent` are separate.** `retrieved` is what the retriever found;
  `contextSent` is what actually went into the prompt. Here they are the same documents, but
  a real system truncates — and Chapter 08's attribution needs to know whether the answer
  failed because the document was never *found* or because it was found and then dropped.

**Block 8 — the two halves of a result, kept apart (Chapter 02 §2.8).**

```ts
export interface CheckOutcome { name: string; passed: boolean; detail?: string }
export interface QualityOutcome {
  metric: MetricName; score: number; reason: string; judgeVersion: string;
}
```

They are two types rather than one, and `EvalResult` has two fields rather than one. §2.8
gives the reason: *"you want to see which half moved when a score changes."* The `--topk=1`
demo is exactly that scenario — quality unchanged, deterministic half broken — and if the
two were merged into a single score the distinction would be invisible.

`detail` and `reason` exist for the same purpose: §4.8 says *"failures carry a `detail` —
the report should say what differed, not just that something did."*

`judgeVersion` on every quality outcome is Chapter 06 §6.4's reproducibility rule: a score
must be attributable to the judge prompt that produced it.

**Block 9 — the result (Chapter 08 §8.5).**

```ts
export interface EvalResult {
  caseId: string;  category: Category;  appVersion: string;
  response: string;
  deterministic: CheckOutcome[];
  quality: QualityOutcome[];
  retrieval: RetrievalScore;
  attribution: Attribution;
  usage: RunContext["usage"];
}
```

The `attribution` field is what this project adds on top of a plain test result, and it is
Chapter 08's payoff: **every failure has an owner.** A result that says "failed" is a bug
report; one that says `attribution: "retrieval"` is a work item.

**Block 10 — retrieval, with `applicable` (Chapter 08 §8.2).**

```ts
export interface RetrievalScore {
  applicable: boolean;
  hit: boolean;  recall: number;  precision: number;  firstRelevantRank: number | null;
}
```

`applicable` is the subtle one, and it exists to avoid a category error. The tool-calling
case (`order-status`) and the two refusal cases declare **no `expectedDocs`** — they are not
retrieval tests. Scoring them as retrieval failures would drag the hit rate down for no
reason, so they are marked not-applicable and excluded from the retrieval averages. You can
see the consequence in the baseline report: `hit 1` over five applicable cases out of nine.

**Block 11 — the attribution vocabulary (Chapter 08 §8.4).**

```ts
export type Attribution = "retrieval" | "generation" | "spec" | "pass";
```

Four outcomes, and the fourth is not a failure. `"spec"` is the one teams forget: a
**grounded, relevant answer that misses a required fact** is not a model failure — the
contract was wrong, or the prompt never asked for it. Having a name for it means the report
can say so instead of blaming the model by default.

**Block 12 — the report (Chapter 02 §2.8, Chapter 06 §6.5).**

```ts
export interface EvalReport {
  appVersion: string;  datasetRevision: number;  cases: number;
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
```

Read the field list as a list of *refusals* to simplify:

| Refusal | Field that embodies it |
| :--- | :--- |
| no single blended score | `averages` is per metric, `byCategory` is per category |
| no "failed" without a cause | `attribution` |
| no "blocked" without a reason | `gate.reasons` |
| no number without an identity | `appVersion` + `datasetRevision` |
| no report without its blind spots | `coverage` |

Chapter 06 §6.5: *"aggregation must be per metric and per category — never a single blended
number."* This interface is that sentence, with types.

**Block 13 — coverage (Chapter 03 §3.8).**

```ts
export interface CoverageReport {
  byCategory: Record<string, number>;
  missingCategories: Category[];
}
```

`missingCategories` is the field the chapter says teams skip and then regret skipping. It is
computed against `CATEGORIES` — the *promise* — rather than against the cases that happen to
exist, which is the only way it can report a gap.

---

## Checkpoint

1. **Why is there no `expectedAnswer` field on `EvalCase`?**
   Because Chapter 01's premise is that `expected === actual` cannot be written for an answer
   with several acceptable phrasings. The type asserts *behaviour* instead, and omitting the
   tempting field is what stops the premise leaking back in.

2. **Why are `CheckOutcome` and `QualityOutcome` separate types?**
   So a report can show which half moved. In the `--topk=1` regression the quality scores are
   unchanged and the deterministic half breaks; one merged score would hide that.

3. **What is `retrieval.applicable` for?**
   The tool case and the refusal cases have no retrieval expectation. Marking them
   not-applicable keeps them out of the retrieval averages instead of counting them as
   retrieval failures.

4. **Why does `appVersion` take `topK` as an argument?**
   Because a candidate run can use a different `topK` than the configured default, and the
   version must describe the run that actually happened — otherwise two incomparable reports
   would look identical.

---

**[Chapter 03: The Dataset and the Corpus →](./03_The_Dataset.md)**
