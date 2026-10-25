import { config } from "../config/config.js";
import type { AgentResponse, CheckResult, GoldenCase } from "../domain/types.js";

/**
 * Chapter 05 §5.3 — Layer 1: the deterministic check catalogue.
 *
 * Every check here answers a question whose value is *objectively knowable*.
 * That is Chapter 08 §8.1's one-line test:
 *
 *     Can I write this check without reading the meaning of the answer text?
 *       YES -> deterministic
 *       NO  -> judge
 *
 * All eight of these say yes, which is why they cost nothing and run on every
 * commit. The five that say no live in `judge.ts`.
 *
 * Two habits are worth noticing in the code below, because both prevent the
 * cheapest false failures in an eval suite (Chapter 05 §5.3.3–5.3.4):
 *
 *   - arguments are compared **normalised**, so `ord-101` and `ORD-101` agree;
 *   - when a case expects *nothing*, the check asserts **absence**, so
 *     over-retrieval and needless tool calls are failures rather than silence.
 */

/** Chapter 02 §2.2 — the shape of a refusal. Used only where a refusal is expected. */
const REFUSAL_PATTERN = /I can only help|I do not have information/i;

function check(name: string, passed: boolean, expected: string, actual: string): CheckResult {
  return { name, passed, expected, actual };
}

/** Keep a failure message readable: the report quotes these values verbatim. */
function show(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/**
 * Chapter 07 §7.6 — run the catalogue against one response.
 *
 * Note the shape of every predicate: `expectedX === null || ...`. A check that
 * has no expectation is **not skipped** — it still runs, still reports, and passes
 * trivially while naming what it expected. Chapter 07 §7.6 wants the full list
 * visible on every case, because "which checks ran" is itself information.
 */
export function runChecks(evalCase: GoldenCase, response: AgentResponse): CheckResult[] {
  const { expectedTool, expectedToolArgument, expectedSource, category } = evalCase;
  const { toolsUsed, toolArguments, retrievedDocuments } = response;

  return [
    // 1 · Response exists.
    // Chapter 05 §5.3.1 — must not be conflated with a refusal: a refusal is a
    // valid answer, an empty completion is a broken one.
    check(
      "Response exists",
      response.answer.trim() !== "",
      "a non-empty answer",
      response.answer.trim() === "" ? "(empty)" : `${response.answer.slice(0, 60)}…`,
    ),

    // 2 · Correct tool used (positive form).
    check(
      "Expected tool used",
      expectedTool === null || toolsUsed.includes(expectedTool),
      expectedTool ?? "no tool (policy question)",
      show(toolsUsed),
    ),

    // 3 · No unexpected tool (negative form).
    // Chapter 07 §7.6 calls this one out: on a policy question it asserts that the
    // agent did *not* reach for the order database — a correctness, cost and
    // privacy assertion in one line.
    check(
      "No unexpected tool",
      expectedTool === null ? toolsUsed.length === 0 : toolsUsed.every((name) => name === expectedTool),
      expectedTool ?? "no tool",
      show(toolsUsed),
    ),

    // 4 · Correct tool argument.
    // Chapter 05 §5.3.3 — this is what separates "wrong tool" from "right tool,
    // wrong argument". The two are different bugs with different owners.
    check(
      "Expected argument passed",
      expectedToolArgument === null ||
        toolArguments.some((argument) => argument.toUpperCase() === expectedToolArgument.toUpperCase()),
      expectedToolArgument ?? "no argument expected",
      show(toolArguments),
    ),

    // 5 · Expected source retrieved (positive form).
    check(
      "Expected source retrieved",
      expectedSource === null || retrievedDocuments.includes(expectedSource),
      expectedSource ?? "no document (order question)",
      show(retrievedDocuments),
    ),

    // 6 · No unexpected source (negative form).
    // This is the check that catches over-retrieval: the agent pulling irrelevant
    // policy text into the context and contaminating its own answer.
    check(
      "No unexpected source",
      expectedSource === null
        ? retrievedDocuments.length === 0
        : retrievedDocuments.every((id) => id === expectedSource),
      expectedSource ?? "no document",
      show(retrievedDocuments),
    ),

    // 7 · Refusal when out of scope.
    // Chapter 05 §5.3.5's caveat applies: this is deterministic *because the
    // refusal is a known shape*. With a real model the wording drifts, and a
    // brittle pattern turns a good refusal into a failure — which is why the
    // pattern is deliberately loose rather than an equality test.
    check(
      "Refusal when out of scope",
      category !== "C" || REFUSAL_PATTERN.test(response.answer),
      category === "C" ? "a refusal" : "not a refusal case",
      REFUSAL_PATTERN.test(response.answer) ? "a refusal" : "an answer",
    ),

    // 8 · Latency budget.
    // Chapter 05 §5.2 — an operational budget is a *check*, not a metric: latency
    // is measurable, so no judge is involved.
    check(
      "Latency within budget",
      response.trace.latencyMs <= config.budget.maxLatencyMs,
      `<= ${config.budget.maxLatencyMs} ms`,
      `${response.trace.latencyMs} ms`,
    ),
  ];
}
