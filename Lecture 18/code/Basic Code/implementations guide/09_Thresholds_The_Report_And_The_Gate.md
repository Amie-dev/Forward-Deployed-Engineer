# Chapter 09 — Thresholds, the Report and the Gate

> **Where a number becomes a decision.** Chapter 08 of the notes ends with the two things that
> make evaluation useful rather than decorative: **thresholds that come from the product** and a
> **gate that CI can act on**.
>
> This chapter also contains the file that decides whether a release ships. It is 24 lines long,
> and that is the point.

---

## File details

| | `src/services/report.ts` | `src/cli.ts` |
|---|---|---|
| **Lines** | 174 | 24 |
| **Layer** | services | entry |
| **Purpose** | aggregate the cases, name the failures, decide the gate, format the output | `npm run eval`, and the exit code CI reads |
| **Exports** | `gate()`, `buildReport()`, `formatReport()` | — (a script) |
| **Imports** | `config`, `domain/dataset`, `domain/types` | `pipeline`, `report` |
| **Notes sections** | Ch08 §8.4, §8.6, Ch06 §6.5, Ch02 §2.8 | Ch08 §8.5, §8.6 |

**`cli.ts` starts no server, opens no socket, and knows nothing about Express.** That is Chapter 08
§8.5's claim made structural: the offline evaluation is the one that gates a release, so it must be
runnable with no HTTP at all.

---

## Commands

```bash
# Chapter 08 §8.6 — the gate, and the exit code.
npm run eval > /dev/null 2>&1; echo "exit=$?"
#   exit=0

RETRIEVAL_TOPK=2 npm run eval > /dev/null 2>&1; echo "exit=$?"
#   exit=1
```

```bash
# Chapter 08 §8.4 — the thresholds, made explicit and reviewable.
npm run eval 2>&1 | sed -n '/Layers 2/,/per category/p'
#   relevance         4.89   threshold 4
#   ...
```

```bash
# Chapter 08 §8.6 — and the report names the layer that owns each failure.
RETRIEVAL_TOPK=2 npm run eval 2>&1 | sed -n '/failures/,$p'
```

```text
  --- failures, with the layer that owns them ---
  policy-return-window   [deterministic]
      No unexpected source: expected=return-policy actual=return-policy, refund-policy
  policy-shipping-speed   [deterministic]
      No unexpected source: expected=shipping-policy actual=shipping-policy, refund-policy
  policy-reworded-window   [deterministic]
      No unexpected source: expected=return-policy actual=return-policy, refund-policy

GATE BLOCKED
  - 3 of 9 case(s) failed
  - pass rate 0.67 < 1
```

---

## `src/services/report.ts` — the full file (part 1 of 2: aggregation and the gate)

```ts
import { appVersion, config } from "../config/config.js";
import { dataset } from "../domain/dataset.js";
import { METRICS, type CaseResult, type EvalReport, type JudgeScores } from "../domain/types.js";

/**
 * Chapter 08 §8.6 — the report, and the gate a release is judged by.
 *
 * Read the field list of `EvalReport` as a list of refusals to simplify:
 *
 *   no single blended score       -> `averages` is per metric, `byCategory` per category
 *   no "failed" without a cause   -> `failures` names the layer and the values
 *   no "blocked" without a reason -> `gate.reasons`
 *   no number without an identity -> `appVersion`, `judgeVersion`, `datasetRevision`
 *
 * Chapter 06 §6.5: *"aggregation must be per metric and per category — never a
 * single blended number."* This file is that sentence, with types.
 */

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Chapter 08 §8.6 — the gate.
 *
 * Two independent reasons to block, and both are named. A gate that reports only
 * "blocked" forces the next engineer to re-derive why — and a gate nobody can
 * explain is a gate that gets disabled "just this once".
 */
export function gate(report: EvalReport): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const failed = report.cases - report.passed;

  if (failed > 0) {
    reasons.push(`${failed} of ${report.cases} case(s) failed`);
  }

  if (report.passRate < config.minPassRate) {
    reasons.push(`pass rate ${report.passRate} < ${config.minPassRate}`);
  }

  return { blocked: reasons.length > 0, reasons };
}

/**
 * Chapter 08 §8.6 — one row per failed case, naming the layer that owns it.
 *
 * Deterministic failures win the attribution when both halves fail, and that is
 * not arbitrary: Chapter 07 §7.6's ordering means a wrong tool call makes the
 * quality scores meaningless, so reporting the judge first would send someone to
 * rewrite a prompt when the real bug was a bad argument.
 */
function failuresOf(result: CaseResult): EvalReport["failures"] {
  if (result.passed) {
    return [];
  }

  const failedChecks = result.checks.filter((check) => !check.passed);

  if (failedChecks.length > 0) {
    return [
      {
        caseId: result.caseId,
        layer: "deterministic",
        detail: failedChecks
          .map((check) => `${check.name}: expected=${check.expected} actual=${check.actual}`)
          .join("; "),
      },
    ];
  }

  return [
    {
      caseId: result.caseId,
      layer: "quality threshold",
      detail: result.thresholdFailures.join("; "),
    },
  ];
}
```

### Block-by-block (part 1)

**Block 1 — `round()` and `average()`.**

```ts
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}
```

`round()` to two decimals, applied at every boundary where a number leaves this file. A pass rate
of `0.6666666666666666` in a report is noise, and noise in a report is what makes people stop
reading reports.

`average()` guards the empty array and returns `0`. That guard is not decoration: `runDataset([])`
is a legal call (Chapter 08's "run one candidate case"), and `0/0` would make every metric `NaN`.
An empty dataset reporting `0` is wrong in an obvious, loud way; `NaN` is wrong in a quiet way that
survives into a dashboard.

**Block 2 — `gate()`, and two reasons to block.**

```ts
const reasons: string[] = [];
const failed = report.cases - report.passed;

if (failed > 0) reasons.push(`${failed} of ${report.cases} case(s) failed`);
if (report.passRate < config.minPassRate) reasons.push(`pass rate ${report.passRate} < ${config.minPassRate}`);

return { blocked: reasons.length > 0, reasons };
```

The two conditions are **independent**, and both are reported rather than short-circuited:

| Condition | Why it is separate |
| :--- | :--- |
| any case failed | the strongest signal: a specific, named, reproducible failure |
| pass rate below the threshold | the aggregate signal — the thing that matters once the dataset is large enough for one failure to be tolerable |

On a nine-case dataset the two always agree (`1/9 = 0.89 < 1`). They diverge at scale: with 500
cases and `minPassRate: 0.95`, up to 25 failures are tolerated — and then the *case* count is what
tells you how bad it is, while the *rate* is what the gate acts on. Writing both now means the gate
does not need rewriting later.

Note that the reasons are **strings with the numbers in them**: `"pass rate 0.67 < 1"`. A gate that
says only "blocked" forces the next engineer to re-derive why — and a gate nobody can explain is a
gate that gets disabled "just this once".

**Block 3 — `failuresOf()`, and the attribution order.**

```ts
const failedChecks = result.checks.filter((check) => !check.passed);

if (failedChecks.length > 0) {
  return [{ caseId, layer: "deterministic", detail: failedChecks.map(…).join("; ") }];
}

return [{ caseId, layer: "quality threshold", detail: result.thresholdFailures.join("; ") }];
```

**Deterministic failures win the attribution**, and the comment explains why: if the agent called
the wrong tool, the quality scores that follow are meaningless. Reporting "faithfulness 3" for a
case whose real bug was a bad order id would send someone to rewrite a prompt — the most expensive
possible wrong fix.

This is a *policy* decision, and it belongs in code where it can be reviewed. The alternative — 
reporting both layers and letting the reader decide — is how a report becomes a wall of text that
nobody reads past the first line of.

The detail string is the same `expected=X actual=Y` shape as Chapter 06's checks, and for the same
reason: a failure should carry its own explanation, so nobody has to re-run the eval with extra
logging to find out what happened.

---

## `src/services/report.ts` — the full file (part 2 of 2: the report and the output)

```ts
/** Chapter 08 §8.6 — aggregate the cases into the report the gate reads. */
export function buildReport(results: CaseResult[]): EvalReport {
  const passed = results.filter((result) => result.passed).length;
  const checks = results.flatMap((result) => result.checks);

  const averages = Object.fromEntries(
    METRICS.map((metric) => [metric, round(average(results.map((result) => result.quality.scores[metric])))]),
  ) as JudgeScores;

  const byCategory: EvalReport["byCategory"] = {};

  for (const result of results) {
    byCategory[result.category] ??= { cases: 0, passed: 0 };
    byCategory[result.category].cases += 1;

    if (result.passed) {
      byCategory[result.category].passed += 1;
    }
  }

  const report: EvalReport = {
    appVersion: appVersion(),
    judgeVersion: results[0]?.quality.judgeVersion ?? "none",
    datasetRevision: dataset.revision,
    cases: results.length,
    passed,
    passRate: results.length === 0 ? 0 : round(passed / results.length),
    deterministicPassRate: round(checks.filter((check) => check.passed).length / checks.length),
    averages,
    byCategory,
    failures: results.flatMap(failuresOf),
    gate: { blocked: false, reasons: [] },
  };

  return { ...report, gate: gate(report) };
}

/**
 * Chapter 08 §8.6 — the human-readable report.
 *
 * `cli.ts` prints this and CI reads the exit code. Note that the sections are in
 * layer order and that failures are *last*, because the failures are the only part
 * anyone reads twice.
 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    "Lecture 18 — offline evaluation: the four-layer pipeline",
    "",
    `  app            ${report.appVersion}`,
    `  judge          ${report.judgeVersion}`,
    `  dataset        revision ${report.datasetRevision} · ${report.cases} cases`,
    "",
    "  --- Layer 1 · deterministic (code as the judge) ---",
    `  deterministic  pass rate ${report.deterministicPassRate}`,
    "",
    "  --- Layers 2 + 3 · quality scores against per-metric thresholds ---",
    ...METRICS.map(
      (metric) =>
        `  ${metric.padEnd(18)}${report.averages[metric].toFixed(2)}   threshold ${config.metricThresholds[metric]}`,
    ),
    "",
    "  --- per category (never one blended number) ---",
    ...Object.entries(report.byCategory).map(
      ([category, entry]) => `  ${category}   ${entry.cases} case(s) · pass ${entry.passed}`,
    ),
  ];

  if (report.failures.length > 0) {
    lines.push("", "  --- failures, with the layer that owns them ---");

    for (const failure of report.failures) {
      lines.push(`  ${failure.caseId}   [${failure.layer}]`);
      lines.push(`      ${failure.detail}`);
    }
  }

  lines.push("");

  if (report.gate.blocked) {
    lines.push("GATE BLOCKED");

    for (const reason of report.gate.reasons) {
      lines.push(`  - ${reason}`);
    }
  } else {
    lines.push(`GATE PASSED — ${report.passed}/${report.cases} cases, pass rate ${report.passRate}.`);
  }

  return lines.join("\n");
}
```

### Block-by-block (part 2)

**Block 4 — the averages, computed per metric.**

```ts
const averages = Object.fromEntries(
  METRICS.map((metric) => [metric, round(average(results.map((result) => result.quality.scores[metric])))]),
) as JudgeScores;
```

Five numbers, not one. This is Chapter 06 §6.5's *"never a single blended number"* in three lines,
and it is the difference between a report that tells you **faithfulness is 2.0 while relevance is
5.0** and a report that says "quality 4.2".

The blended number is worse than useless: it hides which engineering team owns the fix. A
faithfulness problem belongs to the grounding instructions; a relevance problem belongs to intent
handling. Averaging them produces a number nobody can act on.

**Block 5 — `byCategory`, the second refusal to blend.**

```ts
byCategory[result.category] ??= { cases: 0, passed: 0 };
byCategory[result.category].cases += 1;
if (result.passed) byCategory[result.category].passed += 1;
```

The `??=` initialiser is the whole loop: a category is created on first sight, then incremented.
The output is `A: 4 cases · pass 4`, `B: 3 · 3`, `C: 2 · 2` — and the value is that a *capability*
can fail while the overall pass rate looks healthy.

That is the failure mode this block exists for: 90% pass rate overall, 0% on tool calls. Without
per-category numbers, that reads as "mostly fine".

**Block 6 — the report's identity fields.**

```ts
appVersion: appVersion(),
judgeVersion: results[0]?.quality.judgeVersion ?? "none",
datasetRevision: dataset.revision,
```

Three identities, and all three are needed:

| Field | Answers |
| :--- | :--- |
| `appVersion` | which configuration was measured (`topK`, prompt, model) |
| `judgeVersion` | which *instrument* produced the scores |
| `datasetRevision` | which expectations were used |

Chapter 02 §2.8: *a score with no version attached cannot be compared to anything.* The `?? "none"`
on `judgeVersion` covers the empty-dataset case, where there are no scores to attribute.

**Block 7 — the two pass rates, kept apart.**

```ts
passRate: results.length === 0 ? 0 : round(passed / results.length),
deterministicPassRate: round(checks.filter((check) => check.passed).length / checks.length),
```

Two different denominators, on purpose:

| Field | Denominator | What it measures |
| :--- | :--- | :--- |
| `passRate` | **cases** | how many cases fully passed |
| `deterministicPassRate` | **checks** | how many individual checks passed, across all cases |

The second is finer-grained, and it is what makes the `topK` regression legible: `passRate` drops to
`0.67` while `deterministicPassRate` is `0.96` — because only one check failed per affected case.
Both numbers tell you something the other cannot: the rate says "three cases broke", the check rate
says "the breakage is narrow and localised", which is precisely the information that decides whether
to fix or revert.

**Block 8 — the empty gate, then the real one.**

```ts
const report: EvalReport = { …, gate: { blocked: false, reasons: [] } };
return { ...report, gate: gate(report) };
```

The gate object is built *empty*, then the report is built, then the gate is computed from it and
the result is spread over. Two statements instead of one, and the ordering is the point: **the gate
reads the report**, so it cannot exist before the report does.

This also makes the type honest. `EvalReport.gate` is not optional and never `undefined`, so a
consumer cannot forget to check whether a gate was computed — the only way to get an `EvalReport` is
from `buildReport()`, which always computes one.

**Block 9 — `formatReport`, and the layout as argument.**

```ts
"  --- Layer 1 · deterministic (code as the judge) ---",
"  --- Layers 2 + 3 · quality scores against per-metric thresholds ---",
"  --- per category (never one blended number) ---",
"  --- failures, with the layer that owns them ---",
```

The section headers carry the reasoning, not just the label. A reader who has never seen the lecture
still learns from this output that deterministic and quality results are *different things* and that
aggregation is per category.

The order is deliberate too: identity → Layer 1 → Layers 2+3 → per category → **failures** → verdict.
Failures go last because they are the only part anyone reads twice, and putting them at the bottom
means the eye lands on them after the context is established.

**Block 10 — the alignment, and `padEnd`.**

```ts
`  ${metric.padEnd(18)}${report.averages[metric].toFixed(2)}   threshold ${config.metricThresholds[metric]}`
```

`padEnd(18)` aligns the numbers into a column, which is what makes a diff of two runs readable: a
changed score appears as a changed number, not as a reflowed line. `toFixed(2)` fixes the precision
so `5` and `5.00` never look like different values.

`hallucinationFree` is 17 characters — the longest metric name — which is why the padding is 18.
The width was chosen from the data rather than picked arbitrarily, and that is why the columns line
up exactly.

**Block 11 — the verdict block.**

```ts
if (report.gate.blocked) {
  lines.push("GATE BLOCKED");
  for (const reason of report.gate.reasons) lines.push(`  - ${reason}`);
} else {
  lines.push(`GATE PASSED — ${report.passed}/${report.cases} cases, pass rate ${report.passRate}.`);
}
```

`GATE BLOCKED` is in capitals and followed by an indented list of reasons, so it is greppable and
readable in a CI log. `GATE PASSED` carries the numbers, so a green run still tells you *what* passed
— which matters because a green run that says only "passed" gives you nothing to compare against
tomorrow.

Note the asymmetry: the blocked branch is loud and itemised, the passed branch is one line. That is
correct prioritisation. Nobody reads a passing report carefully; everybody reads a failing one.

---

## `src/cli.ts` — the full file

```ts
#!/usr/bin/env node
import { runDataset } from "./services/pipeline.js";
import { buildReport, formatReport } from "./services/report.js";

/**
 * Chapter 08 §8.6 — `npm run eval`, and the exit code CI reads.
 *
 * The report goes to stdout; the exit code is the verdict. Nothing else in this
 * project is allowed to decide whether a release ships: a gate you can argue with
 * is not a gate.
 *
 * Note what this file does *not* do. It starts no server, opens no socket, and
 * knows nothing about Express. Chapter 08 §8.5's claim is that the offline
 * evaluation is the one that gates a release — so it must be runnable with no HTTP
 * at all, which is only true if the evaluation never lived in a controller.
 */
const results = await runDataset();
const report = buildReport(results);

console.log(formatReport(report));

if (report.gate.blocked) {
  process.exitCode = 1;
}
```

### Block-by-block

**Block 1 — the shebang, and what it buys.**

```ts
#!/usr/bin/env node
```

Two lines at the top of `index.ts` and `cli.ts`. It means `./src/cli.ts` is executable directly, and
it is the convention for a file whose job is to be *run* rather than imported. (With `tsx` the
interpreter is supplied by the loader, so the shebang is documentation as much as mechanism — but
it is the right documentation.)

**Block 2 — top-level `await`, and the ESM requirement.**

```ts
const results = await runDataset();
```

Top-level `await` in a script, with no wrapper function and no `.then()` chain. This works because
`package.json` sets `"type": "module"` — the same setting that forces the `.js` import suffixes
described in Chapter 01. A CommonJS script would need an async IIFE for the same three lines.

It is a small thing, and it matters for readability: the file reads as a sequence of statements
rather than as a promise chain, and the sequence *is* the logic — run, report, exit.

**Block 3 — the two calls, and where the logic is not.**

```ts
const results = await runDataset();
const report = buildReport(results);
```

Two function calls. Everything interesting — the four layers, the aggregation, the gate — is
elsewhere, and that is the whole design. A CLI that contains logic is a CLI that has to be
re-tested when the logic changes; a CLI that calls two functions is a CLI you never need to test.

**Block 4 — the report goes to stdout.**

```ts
console.log(formatReport(report));
```

`console.log`, not `console.error`, and the distinction is deliberate. The report is the program's
**output** — something a human or a pipeline may want to capture — so it goes to stdout.
Diagnostics (the Express access log in `middleware/requestContext.ts`) go to stderr. That way
`npm run eval > report.txt` captures exactly the report and nothing else.

**Block 5 — the exit code, and why it is not `process.exit(1)`.**

```ts
if (report.gate.blocked) {
  process.exitCode = 1;
}
```

`process.exitCode = 1` rather than `process.exit(1)`. The difference is not cosmetic:

| Call | Effect |
| :--- | :--- |
| `process.exit(1)` | terminates **immediately**, possibly truncating buffered stdout |
| `process.exitCode = 1` | lets the event loop drain, then exits with code 1 |

With `process.exit()` a large report can be cut off mid-write — which is exactly the run you most
need to read. Setting the code and returning is the safe form, and it costs nothing.

**Block 6 — what the file does not do, and why that is the point.**

The comment lists three omissions — no server, no socket, no Express — and they are all the same
omission. If the evaluation lived in a controller, CI would have to boot a web server to test a
commit. Chapter 08 §8.5's claim is that the offline evaluation is the one that gates a release; this
file is that claim, executable.

That is also why the file is 24 lines. It is not short because it is doing little; it is short
because the layering did the work.

---

## Checkpoint

1. **Why are there two pass rates?**
   Different denominators, different questions. `passRate` counts *cases* that fully passed;
   `deterministicPassRate` counts *checks* that passed across all cases. In the `topK` regression
   `0.67` vs `0.96` is what tells you the breakage is narrow — which is what decides fix-versus-revert.

2. **Why is the gate computed after the report rather than inside it?**
   Because the gate *reads* the report. Building it empty and replacing it makes that dependency
   explicit and keeps `EvalReport.gate` non-optional, so no consumer can forget to check it.

3. **Why do deterministic failures win the attribution when both layers fail?**
   Because a wrong tool call makes the quality scores meaningless. Reporting the judge first would
   send someone to rewrite a prompt when the real bug was a bad argument.

4. **Why `process.exitCode = 1` rather than `process.exit(1)`?**
   `process.exit()` can truncate buffered stdout — losing part of the report from the run you most
   need to read. Setting the code lets the stream flush first.

5. **What makes the exit code trustworthy?**
   That nothing else decides it. The report goes to stdout; the gate is the only thing that sets the
   code. A gate you can argue with is not a gate.

---

**[Chapter 10: The Surfaces — Controllers, Routes and Entry →](./10_The_Surfaces_Controller_Routes_And_Entry.md)**
