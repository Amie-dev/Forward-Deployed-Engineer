# Chapter 08 — The Four-Layer Pipeline

> **Where the pieces become a pipeline.** Chapters 03–07 built a dataset, an agent, checks and a
> judge. This chapter assembles them, and the framing matters more than the code: a pipeline
> *names the layer that failed*, where a single test class can only say "the test failed".
>
> Chapter 07 of the notes describes four steps and four layers. The steps run the real application;
> the layers grade what came back.

---

## File details

| | `src/services/pipeline.ts` |
|---|---|
| **Lines** | 83 |
| **Layer** | services |
| **Purpose** | one case through all four layers; the loop over the whole dataset |
| **Exports** | `evaluateCase()`, `runDataset()` |
| **Imports** | `domain/dataset`, `domain/types`, `deterministic`, `judge`, `model`, `supportAgent` |
| **Notes sections** | Ch07 §7.1–7.9, Ch02 §2.8 |

**This file imports nothing from Express, and nothing from the controllers.** That is what makes
`npm run eval` possible with no server running — Chapter 08 §8.5's claim that the offline
evaluation is the one that gates a release.

---

## Commands

```bash
# Chapter 07 §7.1 — the four layers, in order.
npm run eval 2>&1 | sed -n '4,30p'
```

```text
  app            agent-v1.0.0 | topK=1 | prompt=v1 | model=offline
  judge          offline-v1
  dataset        revision 1 · 9 cases

  --- Layer 1 · deterministic (code as the judge) ---
  deterministic  pass rate 1

  --- Layers 2 + 3 · quality scores against per-metric thresholds ---
  relevance         4.89   threshold 4
  correctness       5.00   threshold 4
  faithfulness      5.00   threshold 4
  helpfulness       5.00   threshold 4
  hallucinationFree 5.00   threshold 4

  --- per category (never one blended number) ---
  A   4 case(s) · pass 4
  B   3 case(s) · pass 3
  C   2 case(s) · pass 2
```

```bash
# Chapter 07 §7.3 — the case is the unit of attribution, so one case is inspectable alone.
npm start
curl -s http://127.0.0.1:8080/eval | python3 -c '
import json,sys
d=json.load(sys.stdin)
for c in d["cases"][:2]:
    print(c["id"], "->", c["passed"], "|", c["quality"]["scores"], "|", c["quality"]["reason"][:60])
'
```

---

## `src/services/pipeline.ts` — the full file

```ts
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
```

### Block-by-block

**Block 1 — `evaluateCase`: four statements, four layers.**

```ts
const response = await agent.chat(evalCase.question, evalCase.id);
const checks = runChecks(evalCase, response);            // LAYER 1
const quality = await judge.score(evalCase, response);   // LAYER 2
const failures = thresholdFailures(quality);             // LAYER 3
const passed = checks.every((r) => r.passed) && failures.length === 0;  // LAYER 4
```

The whole file is essentially these five lines, and their *shape* is the argument. Compare the two
ways to write the same test:

| One big assertion | The four layers |
| :--- | :--- |
| `assert(score >= 4 && toolCalled && sourceFound)` | four independent results, each with a name |
| a failure says "expected true, got false" | a failure says `No unexpected source: expected=return-policy actual=return-policy, refund-policy` |
| nobody owns the fix | the layer names the owner |

Note that Layer 1 and Layer 2 are **independent**: `runChecks` never looks at `quality`, and
`judge.score` never looks at `checks`. That independence is what lets the report say "the quality
scores did not move while the deterministic half broke" — the single most useful sentence this
project produces.

**Block 2 — the `caseId` that ties a trace to a dataset row.**

```ts
const response = await agent.chat(evalCase.question, evalCase.id);
```

The second argument is optional on `chat()`, and this is the one place it is supplied. Its effect:
the trace carries `caseId`, so a failure is traceable back to a readable question — and a
*production* trace (no `caseId`) stays distinguishable from an *eval* trace (with one).

Chapter 07 §7.4 asks for exactly this: `caseId` and a dataset identity recorded per run, for
attribution.

**Block 3 — Layer 4, and why it is a conjunction.**

```ts
const passed = checks.every((result) => result.passed) && failures.length === 0;
```

`&&`, not `||`, and not a weighted score. Both halves must pass, because they test different things:

| Half | Question | A failure here means |
| :--- | :--- | :--- |
| `checks.every(…)` | did the system do the right *thing*? | the retrieval, the tool call or the argument is wrong |
| `failures.length === 0` | is the *answer* good enough? | the answer is not relevant/correct/grounded/helpful enough |

A weighted combination would let a high helpfulness score excuse a missing tool call — exactly the
trade a release gate must not make. Chapter 07 §7.9's "overall pass/fail" is a conjunction, and
both halves stay visible in `CaseResult` so a report can show which one broke.

**Block 4 — the returned `CaseResult`, and carrying the response.**

```ts
return { caseId, category, question, response, checks, quality, thresholdFailures: failures, passed };
```

`response` travels with the verdict, not just the numbers. That is a deliberate cost — the result
objects are large — and it buys the thing Chapter 02 §2.8 insists on: a failure you can *open*.

Concretely, this is what makes investigating the `RETRIEVAL_TOPK=2` regression a two-minute job
instead of a re-run-with-logging job: the answer, the context and the tool calls are all sitting
next to the failed check, so there is nothing to reproduce.

**Block 5 — one model, two roles.**

```ts
const model = createModel();
const agent = new SupportAgent(model);
const judge = new Judge(model);
```

One client instance, passed to two constructors. The comment states the tension honestly: the judge
is a *separate instrument* (Chapter 06 §6.4) even when it happens to be the same object. That is why
`judgeVersion` is recorded per score rather than inferred from the app version — the identity of an
instrument must be *declared*, not deduced.

**Block 6 — sequential, on purpose.**

```ts
for (const evalCase of cases) {
  results.push(await evaluateCase(evalCase, agent, judge));
}
```

A `for…of` with `await`, not `Promise.all`. Chapter 06 §6.5's bounded concurrency is a *cost and
rate-limit* measure, and neither exists offline — nine deterministic cases finish instantly.

What does exist is the need for a **stable output order**. A failure diffed against yesterday's run
has to appear in the same place; parallel evaluation would make the report's order depend on
completion timing, and a diff of two reports would be noise. Sequential is slower and better, and
the comment says which trade was made.

**Block 7 — the default parameter, and why it is not a constant read.**

```ts
export async function runDataset(cases: GoldenCase[] = dataset.cases): Promise<CaseResult[]> {
```

`dataset.cases` is a default, not a hard reference, so the function is usable three ways with no
change:

| Call | Use |
| :--- | :--- |
| `runDataset()` | the whole suite — what `cli.ts` and `GET /eval` do |
| `runDataset(dataset.cases.filter((c) => c.category === "B"))` | one capability at a time, while debugging |
| `runDataset([candidateCase])` | a single candidate case, before it joins the dataset |

That last row is Chapter 04 §4.4's dataset hygiene in mechanical form: a new case is worth running
*alone* first, to confirm it fails on the current system for the right reason. **A case that passes
immediately is a case that is not testing anything new.**

---

## Checkpoint

1. **Why does `evaluateCase` compute the checks and the quality scores independently?**
   So the report can show which half moved. In the `topK` regression the quality scores are
   unchanged while the deterministic half breaks — and a single merged verdict would hide that.

2. **Why is Layer 4 a conjunction rather than a weighted score?**
   Because a weighted score lets a high helpfulness number excuse a missing tool call. A release
   gate must not make that trade, so both halves must pass.

3. **Why does `CaseResult` carry the whole `AgentResponse`?**
   So a failure can be opened and diagnosed without re-running anything. Chapter 02 §2.8: a result
   you cannot open is a result you cannot act on.

4. **Why do the cases run sequentially?**
   Because bounded concurrency solves a cost problem that does not exist offline, while a stable
   output order solves a diff problem that does. A report whose order changes run to run cannot be
   compared with yesterday's.

5. **Why does `runDataset` take `cases` as a parameter at all?**
   So one capability — or one candidate case — can be run alone. A new case should be run by itself
   first: a case that passes immediately is not testing anything new.

---

**[Chapter 09: Thresholds, the Report and the Gate →](./09_Thresholds_The_Report_And_The_Gate.md)**
