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
