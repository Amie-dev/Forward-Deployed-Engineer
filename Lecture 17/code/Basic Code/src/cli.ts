#!/usr/bin/env node
import { config } from "./config/config.js";
import { dataset } from "./domain/dataset.js";
import { createJudge } from "./services/judge.js";
import { buildReport, compareConfigurations, evaluateDataset, passingIds } from "./services/report.js";

/**
 * Chapter 09 §9.1 — **offline evaluation, as a command.**
 *
 * This is the file the lecture's diagram is about: a change lands, the fixed
 * dataset is re-run, and the release is blocked if anything regressed. It exits
 * **non-zero**, because an evaluation nobody gates on is a dashboard rather than
 * a test.
 *
 * ```bash
 * npm run eval                          # gate the current configuration
 * npm run eval -- --topk=1 --baseline=3 # reproduce the topK regression, and watch it block
 * npm run eval -- --topk=1 --baseline=3 --pairwise
 * ```
 */

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;

  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const topK = Number(arg("topk") ?? config.topK);
const baselineTopK = arg("baseline");
const judge = createJudge();

const results = await evaluateDataset(dataset.cases, { judge, topK });

// Chapter 09 §9.1 — a candidate is only "blocked" relative to a baseline, so the
// baseline is a separate run rather than a number someone remembered.
const baselinePassIds =
  baselineTopK === undefined
    ? []
    : passingIds(await evaluateDataset(dataset.cases, { judge, topK: Number(baselineTopK) }));

const report = buildReport(results, { baselinePassIds });

const line = (label: string, value: string): void => console.log(`  ${label.padEnd(14)} ${value}`);

console.log(`\nLecture 17 — offline evaluation`);
console.log(`  dataset       revision ${report.datasetRevision} · ${report.cases} cases`);
console.log(`  app           ${report.appVersion}`);
console.log(`  judge         ${judge.version}`);

console.log(`\n  --- the two halves, kept apart (Chapter 02 §2.8) ---`);
line("deterministic", `pass rate ${report.deterministicPassRate}`);
line(
  "retrieval",
  `hit ${report.retrieval.hitRate} · recall ${report.retrieval.recall} · precision ${report.retrieval.precision} · mrr ${report.retrieval.mrr}`,
);

const metrics = Object.entries(report.averages)
  .map(([metric, score]) => `${metric} ${score}`)
  .join(" · ");
line("quality", metrics === "" ? "(no judge evaluators ran)" : metrics);

const attribution = Object.entries(report.attribution)
  .filter(([, count]) => count > 0)
  .map(([name, count]) => `${name} ${count}`)
  .join(" · ");
line("attribution", attribution);

console.log(`\n  --- where the failures cluster (never one blended number) ---`);
for (const [category, summary] of Object.entries(report.byCategory)) {
  line(category, `${summary.cases} case(s) · pass rate ${summary.passRate}`);
}

if (report.coverage.missingCategories.length > 0) {
  console.log(`\n  coverage gap: no cases for ${report.coverage.missingCategories.join(", ")}`);
}

if (report.regressions.length > 0) {
  console.log(`\n  --- regressions vs baseline (topK=${baselineTopK ?? "none"}) ---`);

  for (const id of report.regressions) {
    const result = results.find((candidate) => candidate.caseId === id);

    console.log(`  ${id}  ->  attributed to ${result?.attribution ?? "unknown"}`);

    for (const check of result?.deterministic.filter((c) => !c.passed) ?? []) {
      console.log(`      ${check.name}: ${check.detail ?? "failed"}`);
    }
  }
}

line("\n  cost", `${report.cost.tokens} tokens · $${report.cost.usd} · ${report.cost.avgMs} ms avg`);

if (process.argv.includes("--pairwise")) {
  const other = Number(baselineTopK ?? 1);
  const pairwise = await compareConfigurations(
    dataset.cases,
    { label: `topK=${topK}`, topK },
    { label: `topK=${other}`, topK: other },
    judge,
  );

  console.log(
    `\n  pairwise      ${pairwise.labelA} vs ${pairwise.labelB} · win rate ${pairwise.winRate}` +
      ` (${pairwise.wins}W / ${pairwise.losses}L / ${pairwise.ties}T)` +
      (pairwise.positionBiasCases.length === 0 ? " · no position bias" : ""),
  );
}

// Chapter 04 §4.8 — the gate. Non-zero exit, named reasons.
if (report.gate.blocked) {
  console.log(`\nGATE BLOCKED`);
  for (const reason of report.gate.reasons) {
    console.log(`  - ${reason}`);
  }
  console.log("");
  process.exit(1);
}

console.log(`\nGATE PASSED — ship with evidence.\n`);
