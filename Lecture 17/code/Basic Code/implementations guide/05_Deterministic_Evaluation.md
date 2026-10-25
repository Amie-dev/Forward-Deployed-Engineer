# Chapter 05 — Deterministic Evaluation: Code as the Judge

> **If code can decide it, code decides it.** This is the chapter where the lecture's most
> important rule becomes twelve functions — and where the report stops being an opinion.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/deterministic.ts` (225 lines) |
| **Layer** | services |
| **Purpose** | the check catalogue: pure functions from a run's artefacts to pass/fail + a detail |
| **Exports** | `Check` (type), `CHECKS`, `runChecks()` |
| **Imports** | `config`, `domain/types` |
| **Notes sections** | Ch04 §4.3 (the catalogue), §4.4 (structured output), §4.5 (operational), §4.8 (the harness) |

---

## Commands

```bash
# every check the dataset asks for, with the ones that failed named
curl -s 'http://127.0.0.1:8080/eval?topk=1&baseline=3' | python3 -c '
import json,sys
for c in json.load(sys.stdin)["cases"]:
    if not c["passed"]:
        print(c["id"], "->", c["attribution"])
        for f in c["failed"]: print("   ", f["name"], "|", f["detail"])'
```

```text
warranty-and-return -> retrieval
    must-mention | missing required fact(s): 12 month
    expected-docs | missing expected doc(s): warranty
```

**Two checks, two `detail` strings, one owner.** That is the shape every failure in this
project takes, and it is what makes a report actionable.

---

## `src/services/deterministic.ts` — the full file

```ts
import { config } from "../config/config.js";
import type { CheckOutcome, EvalCase, ExpectedBehaviour, RunContext } from "../domain/types.js";

/**
 * Chapter 04 — **when code can decide, code decides.**
 *
 * Every check below is a pure function over the run's artefacts (`raw`,
 * `answer`, `parsed`, `retrieved`, `calls`, `usage`). Two properties follow, and
 * both are the point:
 *
 *  - each check is trivially unit-testable on its own, because it takes a plain
 *    object and returns a plain object;
 *  - a failure can carry a `detail` naming *what* differed, which is the
 *    difference between a report you can act on and one you can only stare at.
 *
 * The catalogue is Chapter 04 §4.3's list, nothing more.
 */
export interface Check {
  name: string;
  run: (ctx: RunContext, expected: ExpectedBehaviour) => { passed: boolean; detail?: string };
}

export const CHECKS: Check[] = [
  {
    // §4.3.1 — the answer is objective: parseable or not.
    name: "json-valid",
    run: ({ raw }) => {
      try {
        JSON.parse(raw);
        return { passed: true };
      } catch {
        return { passed: false, detail: "output is not parseable JSON" };
      }
    },
  },
  {
    // §4.3.4 — "required fields present? correct data types?" — normal code.
    name: "schema-valid",
    run: ({ parsed }) => {
      if (parsed === null) {
        return { passed: false, detail: "no parsed output to validate" };
      }

      const statuses = ["OK", "REFUSED", "NEEDS_INFO"];

      if (!statuses.includes(parsed.status)) {
        return { passed: false, detail: `status "${parsed.status}" is not in the enum` };
      }

      if (typeof parsed.answer !== "string" || parsed.answer === "") {
        return { passed: false, detail: "answer is missing or empty" };
      }

      if (parsed.recommendations !== undefined && !Array.isArray(parsed.recommendations)) {
        return { passed: false, detail: "recommendations must be an array when present" };
      }

      return { passed: true };
    },
  },
  {
    // §4.3.2 — a string comparison on the name. No judge required.
    name: "expected-tool",
    run: ({ calls }, expected) => {
      if (expected.expectedTool === undefined) {
        return { passed: true };
      }

      const actual = calls[0]?.name ?? "none";

      return {
        passed: actual === expected.expectedTool,
        detail: `expected ${expected.expectedTool}, got ${actual}`,
      };
    },
  },
  {
    // §4.3.2 — right tool, wrong parameters is still a failure.
    name: "expected-args",
    run: ({ calls }, expected) => {
      if (expected.expectedArgs === undefined) {
        return { passed: true };
      }

      const actual = calls[0]?.args;

      if (actual === undefined) {
        return { passed: false, detail: "no tool call to compare arguments against" };
      }

      const mismatched = Object.entries(expected.expectedArgs).filter(
        ([key, value]) => actual[key] !== value,
      );

      return {
        passed: mismatched.length === 0,
        detail:
          mismatched.length === 0
            ? undefined
            : `expected ${JSON.stringify(expected.expectedArgs)}, got ${JSON.stringify(actual)}`,
      };
    },
  },
  {
    // §4.3.5 — a refusal expressed as an enum is testable.
    name: "refusal-status",
    run: ({ parsed }, expected) => {
      if (expected.expectedStatus === undefined) {
        return { passed: true };
      }

      return {
        passed: parsed?.status === expected.expectedStatus,
        detail: `expected ${expected.expectedStatus}, got ${parsed?.status ?? "none"}`,
      };
    },
  },
  {
    // §4.3.6 — the prompt says "max 3 recommendations"; the assertion says so too.
    name: "output-constraints",
    run: ({ parsed }, expected) => {
      if (expected.maxRecommendations === undefined) {
        return { passed: true };
      }

      const count = parsed?.recommendations?.length ?? 0;

      return {
        passed: count <= expected.maxRecommendations,
        detail: `prompt says: max ${expected.maxRecommendations} recommendations; got ${count}`,
      };
    },
  },
  {
    // §4.3.8 — `output.includes("30 days")` catches missing key information.
    name: "must-mention",
    run: ({ answer }, expected) => {
      const missing = (expected.mustMention ?? []).filter((fact) => !answer.includes(fact));

      return {
        passed: missing.length === 0,
        detail: missing.length === 0 ? undefined : `missing required fact(s): ${missing.join(", ")}`,
      };
    },
  },
  {
    // §4.3.8 — `!output.includes("restocking fee")` catches known fabrications.
    name: "no-forbidden-claim",
    run: ({ answer }, expected) => {
      const found = (expected.mustNotClaim ?? []).filter((claim) => answer.includes(claim));

      return {
        passed: found.length === 0,
        detail: found.length === 0 ? undefined : `forbidden claim(s) present: ${found.join(", ")}`,
      };
    },
  },
  {
    // §4.3.7 — assert that the retrieval stage returned at least one document.
    name: "retrieval-non-empty",
    run: ({ retrieved }) => ({
      passed: retrieved.length > 0,
      detail: retrieved.length > 0 ? undefined : "retrieval returned nothing",
    }),
  },
  {
    // §4.3.7 — the other half: an empty retrieval is *expected* here, and the
    // application must have said so rather than inventing an answer.
    name: "retrieval-empty",
    run: ({ retrieved }) => ({
      passed: retrieved.length === 0,
      detail: retrieved.length === 0 ? undefined : `expected no retrieval, got ${retrieved.length}`,
    }),
  },
  {
    // §8.2 — "did we retrieve the expected document?" Set arithmetic, no judge.
    name: "expected-docs",
    run: ({ retrieved }, expected) => {
      const wanted = expected.expectedDocs ?? [];

      if (wanted.length === 0) {
        return { passed: true };
      }

      const ids = retrieved.map((hit) => hit.id);
      const missing = wanted.filter((id) => !ids.includes(id));

      return {
        passed: missing.length === 0,
        detail: missing.length === 0 ? undefined : `missing expected doc(s): ${missing.join(", ")}`,
      };
    },
  },
  {
    // §4.5 — latency, tool calls and cost are deterministic too.
    name: "budget",
    run: ({ usage }) => ({
      passed:
        usage.ms < config.budget.maxMs &&
        usage.toolCalls <= config.budget.maxToolCalls &&
        usage.usd < config.budget.maxUsd,
      detail: `ms=${usage.ms} calls=${usage.toolCalls} usd=${usage.usd}`,
    }),
  },
];

/**
 * Chapter 04 §4.8 — one case becomes many pass/fail results.
 *
 * Note what the filter does: it runs *only* the checks the case asked for. A
 * refusal case declares no `must-mention`, so that check never runs for it — the
 * dataset says which assertions apply, and the runner obeys.
 */
export function runChecks(testCase: EvalCase, ctx: RunContext): CheckOutcome[] {
  const wanted = new Set(
    testCase.evaluators.flatMap((evaluator) =>
      evaluator.kind === "code" ? evaluator.checks : [],
    ),
  );

  return CHECKS.filter((check) => wanted.has(check.name)).map((check) => ({
    name: check.name,
    ...check.run(ctx, testCase.expected),
  }));
}
```

### Block-by-block

**Block 1 — the `Check` interface, and the three properties it guarantees.**

```ts
export interface Check {
  name: string;
  run: (ctx: RunContext, expected: ExpectedBehaviour) => { passed: boolean; detail?: string };
}
```

Three things follow from this signature, and Chapter 04 §4.8 names all three:

| Property | Because of |
| :--- | :--- |
| **checks are pure functions over artefacts** | `run` takes a plain object and returns a plain object. No I/O, no clock, no globals — so each check is trivially unit-testable on its own |
| **failures carry a `detail`** | `detail?: string` is in the return type, so a check *can* say what differed. `"missing expected doc(s): warranty"` is a work item; `passed: false` is not |
| **the expected behaviour is an argument** | a check never reads the dataset directly. It receives `expected`, so the same check works for every case that declares it |

**Block 2 — `json-valid`: the simplest possible check (Chapter 04 §4.3.1).**

```ts
{ name: "json-valid",
  run: ({ raw }) => {
    try { JSON.parse(raw); return { passed: true }; }
    catch { return { passed: false, detail: "output is not parseable JSON" }; }
  } }
```

Six lines, and it demonstrates the pattern every other check follows: destructure what you
need from the context, decide, return. Note it uses `raw` and not `parsed` — **failing to
parse is the thing being checked**, so the check has to see the unparsed text.

**Block 3 — `schema-valid`: the shape, not the meaning (Chapter 04 §4.3.4).**

```ts
{ name: "schema-valid",
  run: ({ parsed }) => {
    if (parsed === null) return { passed: false, detail: "no parsed output to validate" };
    const statuses = ["OK", "REFUSED", "NEEDS_INFO"];
    if (!statuses.includes(parsed.status))
      return { passed: false, detail: `status "${parsed.status}" is not in the enum` };
    if (typeof parsed.answer !== "string" || parsed.answer === "")
      return { passed: false, detail: "answer is missing or empty" };
    if (parsed.recommendations !== undefined && !Array.isArray(parsed.recommendations))
      return { passed: false, detail: "recommendations must be an array when present" };
    return { passed: true };
  } }
```

This is §4.3.4's board example — *"1. Is JSON valid? ← deterministic. 2. Is semantics
correct? ← NOT deterministic"* — with only the first question answered. The check asserts that
`status` is one of three strings and that `answer` is a non-empty string; it says nothing about
whether the answer is *right*, and that boundary is the chapter's honesty.

Each early return carries its own `detail`, so a schema failure names the **field** rather
than the fact. That is a small habit with a large payoff the day a prompt change starts
emitting `"status": "REFUSED "` with a trailing space.

**Block 4 — the two tool checks (Chapter 04 §4.3.2).**

```ts
{ name: "expected-tool",
  run: ({ calls }, expected) => {
    if (expected.expectedTool === undefined) return { passed: true };   // ← vacuous pass
    const actual = calls[0]?.name ?? "none";
    return { passed: actual === expected.expectedTool, detail: `expected ${expected.expectedTool}, got ${actual}` };
  } }

{ name: "expected-args",
  run: ({ calls }, expected) => {
    if (expected.expectedArgs === undefined) return { passed: true };
    const actual = calls[0]?.args;
    if (actual === undefined) return { passed: false, detail: "no tool call to compare arguments against" };
    const mismatched = Object.entries(expected.expectedArgs).filter(([key, value]) => actual[key] !== value);
    return { passed: mismatched.length === 0,
             detail: mismatched.length === 0 ? undefined : `expected ${JSON.stringify(expected.expectedArgs)}, got ${JSON.stringify(actual)}` };
  } }
```

Two details worth copying:

- **The `undefined` guard is a *vacuous pass*, and that is correct.** A case that does not
  declare `expectedTool` has nothing to assert here, so the check passes. The alternative —
  failing when there is no expectation — would make every retrieval case fail.
- **`expected-args` compares only the keys the expectation names**, so a case can assert
  `{ orderId: "4471" }` without predicting every field the tool might receive. Partial matching
  is the right default: the interesting failure is *"right tool, wrong parameter"*, not
  *"extra field"*.

**Block 5 — `refusal-status`: the enum comparison (Chapter 04 §4.3.5).**

```ts
{ name: "refusal-status",
  run: ({ parsed }, expected) => {
    if (expected.expectedStatus === undefined) return { passed: true };
    return { passed: parsed?.status === expected.expectedStatus,
             detail: `expected ${expected.expectedStatus}, got ${parsed?.status ?? "none"}` };
  } }
```

The whole check is one `===`, which is exactly §4.3.5's point: *"a refusal expressed as an enum
is testable."* Note it is used by **three** cases with three different expectations — `"OK"`,
`"NEEDS_INFO"`, `"REFUSED"` — which is what a good check looks like: parameterised by the
expectation, not hard-coded to one case.

**Block 6 — `output-constraints`: a constraint in the prompt, asserted in code (§4.3.6).**

```ts
{ name: "output-constraints",
  run: ({ parsed }, expected) => {
    if (expected.maxRecommendations === undefined) return { passed: true };
    const count = parsed?.recommendations?.length ?? 0;
    return { passed: count <= expected.maxRecommendations,
             detail: `prompt says: max ${expected.maxRecommendations} recommendations; got ${count}` };
  } }
```

The `detail` is written from the **prompt's** point of view on purpose — *"prompt says: max 3
recommendations"* — because that is where the contract came from. §4.3.6's design habit is that
every constraint you write in a system prompt gets its assertion in the same commit, and naming
the prompt in the failure message is what makes that connection visible.

**Block 7 — the required-facts pair (§4.3.8).**

```ts
{ name: "must-mention",
  run: ({ answer }, expected) => {
    const missing = (expected.mustMention ?? []).filter((fact) => !answer.includes(fact));
    return { passed: missing.length === 0,
             detail: missing.length === 0 ? undefined : `missing required fact(s): ${missing.join(", ")}` };
  } }

{ name: "no-forbidden-claim",
  run: ({ answer }, expected) => {
    const found = (expected.mustNotClaim ?? []).filter((claim) => answer.includes(claim));
    return { passed: found.length === 0,
             detail: found.length === 0 ? undefined : `forbidden claim(s) present: ${found.join(", ")}` };
  } }
```

Two checks, and the pair is deliberate. `must-mention` catches **omission**;
`no-forbidden-claim` catches **fabrication**. A system can fail either independently, and the
failing run in this guide is the omission case: *"missing required fact(s): 12 month"*.

Both read `answer` (the prose) rather than `raw` (the envelope), because the assertion is about
what the user reads. That choice is what makes `mustMention: ["30 days"]` a claim about the
response rather than about a JSON field.

**Block 8 — the retrieval-shape pair (§4.3.7).**

```ts
{ name: "retrieval-non-empty", run: ({ retrieved }) => ({ passed: retrieved.length > 0, … }) }
{ name: "retrieval-empty",     run: ({ retrieved }) => ({ passed: retrieved.length === 0, … }) }
```

Two checks that are exact opposites, and both are needed. `retrieval-non-empty` asserts that a
question *with* an answer got context; `retrieval-empty` asserts that a question *without* one
did not — §4.3.7's board example, where the assertion is both that retrieval came back empty
**and** that the application said so rather than inventing an answer.

Having the opposite check is what makes the fallback testable. Without it, a system that
hallucinated an answer for `gift-wrapping` could still pass `must-mention` if it happened to use
the right words; `retrieval-empty` is what catches the invented context.

**Block 9 — `expected-docs`: deterministic retrieval evaluation (Chapter 08 §8.2).**

```ts
{ name: "expected-docs",
  run: ({ retrieved }, expected) => {
    const wanted = expected.expectedDocs ?? [];
    if (wanted.length === 0) return { passed: true };
    const ids = retrieved.map((hit) => hit.id);
    const missing = wanted.filter((id) => !ids.includes(id));
    return { passed: missing.length === 0,
             detail: missing.length === 0 ? undefined : `missing expected doc(s): ${missing.join(", ")}` };
  } }
```

This is the check the regression demo trips, and it is four lines of array work. Chapter 08
§8.2's argument is exactly that: a retrieval eval with expected document ids **needs no judge**
— it is set arithmetic. Compare it with what the alternative costs: asking a model *"did this
answer come from the right document?"* and then wondering whether the judge is reliable.

**Block 10 — `budget`: the operational check (Chapter 04 §4.5).**

```ts
{ name: "budget",
  run: ({ usage }) => ({
    passed: usage.ms < config.budget.maxMs &&
            usage.toolCalls <= config.budget.maxToolCalls &&
            usage.usd < config.budget.maxUsd,
    detail: `ms=${usage.ms} calls=${usage.toolCalls} usd=${usage.usd}`,
  }) }
```

Latency, tool-call count and cost are deterministic, so they are a *check* rather than a
metric — no judge is involved. The `detail` prints all three values rather than only the one
that failed, because a budget breach is usually a story about the relationship between them
(slow **and** many calls means a loop).

**Block 11 — `runChecks`: the runner, and the filter that matters.**

```ts
export function runChecks(testCase: EvalCase, ctx: RunContext): CheckOutcome[] {
  const wanted = new Set(
    testCase.evaluators.flatMap((evaluator) => evaluator.kind === "code" ? evaluator.checks : []),
  );
  return CHECKS.filter((check) => wanted.has(check.name)).map((check) => ({
    name: check.name,
    ...check.run(ctx, testCase.expected),
  }));
}
```

The `flatMap` does two jobs at once: it **selects** the checks the case asked for, and by
filtering on `kind === "code"` it *excludes* the `llmJudge` evaluators — which are not checks
at all. The type narrowing from the discriminated union makes `evaluator.checks` available with
no cast.

The filter is the design: **the dataset declares which assertions apply to each case, and the
runner obeys.** A refusal case never runs `must-mention`; a tool case never runs `expected-docs`.
That is what lets nine cases share twelve checks without any of them being irrelevant.

**Block 12 — the catalogue at a glance.**

| Check | Notes § | Decides |
| :--- | :--- | :--- |
| `json-valid` | 4.3.1 | is the output parseable at all |
| `schema-valid` | 4.3.4 | enum membership, required fields, types |
| `expected-tool` | 4.3.2 | tool selection |
| `expected-args` | 4.3.2 | right tool, right parameters |
| `refusal-status` | 4.3.5 | `OK` / `REFUSED` / `NEEDS_INFO` |
| `output-constraints` | 4.3.6 | "max 3 recommendations" |
| `must-mention` | 4.3.8 | omission |
| `no-forbidden-claim` | 4.3.8 | fabrication |
| `retrieval-non-empty` | 4.3.7 | context was available |
| `retrieval-empty` | 4.3.7 | the fallback was honest |
| `expected-docs` | 8.2 | retrieval correctness, as set arithmetic |
| `budget` | 4.5 | latency, tool calls, cost |

**Eleven of the twelve decide something a judge could only guess at.** That ratio is the
lecture's posture in one number: *deterministic checks everywhere they fit, judge calls only
where meaning is genuinely required.*

---

## Checkpoint

1. **Why do checks take `expected` as an argument instead of reading the dataset?**
   So the same check serves every case that declares it — `refusal-status` is used with three
   different statuses. A check that read the dataset could only ever test one case.

2. **Why do `expected-tool` and `expected-args` pass when the expectation is `undefined`?**
   Because a case that declares no expectation has nothing to assert. Failing instead would make
   every retrieval case fail on a tool check it never asked for.

3. **Why are there two opposite retrieval checks?**
   `retrieval-non-empty` catches a question that got no context; `retrieval-empty` catches a
   question that got context it should not have. The second is what makes the honest-fallback
   behaviour testable.

4. **What makes the `detail` field worth its complexity?**
   It is the difference between `passed: false` and *"missing required fact(s): 12 month"*. The
   second is a work item, and §4.8 asks for exactly that: say what differed.

5. **Why is `budget` a check and not a metric?**
   Because latency, tool-call count and cost are deterministic. Putting them through a judge
   would add a cost and a source of noise to something a comparison already decides.

---

**[Chapter 06: LLM-as-a-Judge and Rubrics →](./06_LLM_As_A_Judge_And_Rubrics.md)**