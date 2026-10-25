import { dataset } from "../domain/dataset.js";
import type { CaseResult, GoldenCase } from "../domain/types.js";
import { runChecks } from "./deterministic.js";
import { Judge, thresholdFailures } from "./judge.js";
import { createModel } from "./model.js";
import { SupportAgent } from "./supportAgent.js";

/**
 * Chapter 07 §7.1 — the four-layer pipeline.
 *
 * The framing matters more than the code. A single test class that asserts
 * "the answer should be good" can only tell you that *something* is wrong. A
 * pipeline tells you **which layer** is wrong, and a layer has an owner:
 *
 *   LAYER 1  deterministic checks   -> retrieval team, tool/prompt team
 *   LAYER 2  quality scores         -> prompt / grounding / style owners
 *   LAYER 3  quality thresholds     -> the product owner who chose the number
 *   LAYER 4  overall pass / fail    -> the release gate
 */

/**
 * Chapter 07 §7.3 — one case, run once, through all four layers.
 *
 * Steps 1 and 2 (load the dataset, pick a case) are the caller's job; this is
 * steps 3 and 4 plus the grading. The **case is the unit of attribution**: every
 * number that comes out of here is scoped to one id, so a failure in the report
 * always points at one row of the dataset and one question a human can read.
 */
export async function evaluateCase(
  evalCase: GoldenCase,
  agent: SupportAgent,
  judge: Judge,
): Promise<CaseResult> {
  // STEP 3 — run the real application. Nothing is mocked: the LLM, the retrieval
  // and the tools *are* the components under test. The `caseId` is passed so the
  // trace can be tied back to the dataset row.
  const response = await agent.chat(evalCase.question, evalCase.id);

  // STEP 4 — inspect the execution. This is a routing decision, not a
  // computation: the trace splits into the payload code can judge and the payload
  // only meaning can judge. A missing trace field fails loudly here rather than
  // silently becoming a low score later.
  const checks = runChecks(evalCase, response); // LAYER 1
  const quality = await judge.score(evalCase, response); // LAYER 2
  const failures = thresholdFailures(quality); // LAYER 3
  const passed = checks.every((result) => result.passed) && failures.length === 0; // LAYER 4

  return {
    caseId: evalCase.id,
    category: evalCase.category,
    question: evalCase.question,
    response,
    checks,
    quality,
    thresholdFailures: failures,
    passed,
  };
}

/**
 * Chapter 07 §7.2–7.3 — the loop over the whole dataset.
 *
 * The cases run **sequentially**, and that is a choice rather than an oversight.
 * Chapter 06 §6.5's bounded concurrency is about cost and rate limits, which do
 * not exist offline; what does exist is the need for a stable, readable output
 * order when a failure has to be diffed against yesterday's run.
 */
export async function runDataset(cases: GoldenCase[] = dataset.cases): Promise<CaseResult[]> {
  // One model client, two roles. The judge is a *separate instrument* (Chapter 06
  // §6.4) even when it is the same object — which is why the judge version is
  // recorded on every score instead of being assumed from the app version.
  const model = createModel();
  const agent = new SupportAgent(model);
  const judge = new Judge(model);

  const results: CaseResult[] = [];

  for (const evalCase of cases) {
    results.push(await evaluateCase(evalCase, agent, judge));
  }

  return results;
}
