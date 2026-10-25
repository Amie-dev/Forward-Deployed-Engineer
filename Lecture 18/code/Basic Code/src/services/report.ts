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
