#!/usr/bin/env node
import { appVersion } from "./config/config.js";
import { Agent } from "./services/agent.js";
import { summarise } from "./services/audit.js";
import { createModel } from "./services/model.js";
import { createScenarios } from "./services/scenarios.js";

/**
 * Chapter 09 §9.13 — `npm run demo`.
 *
 * Eight attacks, one agent, one loop. The report prints a trace for each and then
 * makes a single claim: **no forbidden effect was executed.** Chapter 09 §9.13 is
 * the reason the claim is phrased that way and not "the assistant refused
 * politely" — the only thing worth asserting about a security test is what
 * actually happened, because a model that says all the right words while the
 * refund goes through passes the wrong test.
 *
 * Exit code 1 when any scenario's forbidden effect executed, so CI can act on it
 * for the same reason Chapter 18's gate exits 1.
 */
async function main(): Promise<void> {
  const scenarios = createScenarios({ agent: new Agent(createModel()) });
  const outcomes = await scenarios.runAll();

  const lines: string[] = [];
  lines.push("Lecture 19 — the security demo: eight attacks through one safe loop", "");
  lines.push(`  app  ${appVersion()}`, "");

  let violated = 0;
  let executed = 0;

  for (const outcome of outcomes) {
    lines.push(`  --- ${outcome.scenario.id} · ${outcome.scenario.teaches}`);
    lines.push(`      asset    ${outcome.scenario.asset}`);

    if (outcome.note !== undefined) {
      lines.push(`      note     ${outcome.note}`);
    }

    lines.push(summarise(outcome.result.trace));
    lines.push(`      effects  ${outcome.effects.join(", ") || "none"}`);
    lines.push(
      `      verdict  ${
        outcome.violated.length === 0
          ? "contained"
          : `VIOLATED — ${outcome.violated.join(", ")}`
      }`,
    );
    lines.push("");

    violated += outcome.violated.length;
    executed += outcome.effects.length;
  }

  if (violated === 0) {
    lines.push(
      `SAFETY GATE PASSED — ${outcomes.length}/${outcomes.length} scenarios contained, ` +
        `0 forbidden effects executed (${executed} legitimate effects).`,
    );
  } else {
    lines.push("SAFETY GATE BLOCKED");

    for (const outcome of outcomes) {
      for (const effect of outcome.violated) {
        lines.push(`  - ${outcome.scenario.id} executed ${effect}`);
      }
    }
  }

  console.log(lines.join("\n"));
  process.exitCode = violated === 0 ? 0 : 1;
}

await main();
