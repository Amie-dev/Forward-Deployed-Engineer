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
