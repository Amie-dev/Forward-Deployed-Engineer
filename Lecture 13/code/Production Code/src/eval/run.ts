/**
 * The evaluation harness — Chapter 09 §9.4.
 *
 * The harness has one non-negotiable property: **it replays the production code path.**
 * A harness with a simplified prompt measures nothing real, so this file calls
 * `extractMeeting` — the same function the CLI, the HTTP server and the action pipeline
 * call — and scores what comes back.
 *
 * What it measures, and why each number is in the table:
 *
 *   first-pass validity   the fraction of calls whose *first* response was usable.
 *                         This is the number that decides your repair budget.
 *   repair rate           the fraction that needed a second call. High means the
 *                         schema or the prompt is wrong, not that the loop is broken.
 *   final failure rate    what a user actually experiences.
 *   kind accuracy         whether the outcome was even the right *shape* of outcome
 *                         (a refusal where a refusal was required counts as a pass).
 *   per-field accuracy    object-level accuracy hides which field is broken.
 *   issue distribution    the single most useful chart. It turns "the model is
 *                         unreliable" into "durationMinutes is a string 4% of the time".
 */

import { config } from '../config/env.js';
import type { Model } from '../llm/model.js';
import { extractMeeting } from '../pipeline/extract.js';
import { defaultSemanticContext } from '../pipeline/semantic.js';
import type { EnforcementLevel, Extraction, MeetingRequest } from '../types.js';
import { GOLDEN_CASES, type GoldenCase } from './golden.js';

export interface CaseScore {
  id: string;
  tags: string[];
  outcome: Extraction['kind'];
  /** True when the outcome was one this case permits. */
  kindOk: boolean;
  attempts: number;
  /** Fields that matched, and fields that were scored. */
  fieldsMatched: number;
  fieldsScored: number;
  violations: string[];
  latencyMs: number;
  issues: string[];
  /** `review`-severity flags that travelled with an accepted object. */
  flags: string[];
}

export interface SuiteReport {
  enforcement: EnforcementLevel;
  cases: number;
  /**
   * The fraction of **clean** cases that were right on the first call.
   *
   * Measured on the clean subset on purpose: a case that *should* be rejected, or that
   * is expected to need the fallback rung, cannot be a first-pass success by design.
   * Averaging them in would hide the number that decides your repair budget.
   */
  firstPassValidity: number;
  /** Clean cases that needed a second call. High means fix the schema or the prompt. */
  repairRate: number;
  /** Clean cases that ended in a failure. What a user actually experiences. */
  finalFailureRate: number;
  /** Every case: did the outcome have the right *shape* (including a correct refusal)? */
  kindAccuracy: number;
  /** Every scored field, across accepted objects. */
  fieldAccuracy: number;
  /** Cases that must be rejected: how many actually were. */
  negativeAccuracy: number;
  p50Ms: number;
  p95Ms: number;
  issueDistribution: Record<string, number>;
  outcomeCounts: Record<string, number>;
  scores: CaseScore[];
  /** Non-empty when the release gate failed. */
  gateFailures: string[];
}

/** Runs one case and scores it. Pure: no console output, no shared state. */
export async function scoreCase(
  model: Model,
  goldenCase: GoldenCase,
  enforcement: EnforcementLevel,
): Promise<CaseScore> {
  const { extraction, trace } = await extractMeeting(model, goldenCase.input, {
    enforcement,
    semantic: defaultSemanticContext(),
    task: goldenCase.id,
  });

  const violations: string[] = [];
  const value: MeetingRequest | null =
    extraction.kind === 'ok' || extraction.kind === 'degraded' ? extraction.value : null;

  /** True when this case is supposed to yield an object. */
  const expectsObject = goldenCase.allowedKinds.some(
    (kind) => kind === 'ok' || kind === 'degraded',
  );

  let fieldsMatched = 0;
  let fieldsScored = 0;

  for (const [field, expected] of Object.entries(goldenCase.expected) as Array<
    [keyof MeetingRequest, unknown]
  >) {
    if (value === null) break;
    fieldsScored += 1;
    if (value[field] === expected) fieldsMatched += 1;
  }

  if (value !== null) {
    for (const field of goldenCase.mustBeNull ?? []) {
      fieldsScored += 1;
      if (value[field] === null) fieldsMatched += 1;
      else violations.push(`${field} must be null but was ${JSON.stringify(value[field])}`);
    }
    for (const field of goldenCase.mustBePresent ?? []) {
      fieldsScored += 1;
      const entry = value[field];
      if (typeof entry === 'string' && entry.trim().length > 0) fieldsMatched += 1;
      else violations.push(`${field} must be a non-empty string`);
    }
    for (const code of goldenCase.mustFlag ?? []) {
      fieldsScored += 1;
      const flagged = flagsOf(extraction).includes(code);
      if (flagged) fieldsMatched += 1;
      else violations.push(`expected a "${code}" flag on the accepted object`);
    }
  }

  // A case that should have produced an object must have produced one. The reverse is
  // checked by `allowedKinds`: a case that must be rejected has no object to score.
  if (value === null && expectsObject) {
    violations.push(
      `no object was produced, but the case expects ${Object.keys(goldenCase.expected).join(', ') || 'one'}`,
    );
  }

  const kindOk = goldenCase.allowedKinds.includes(extraction.kind);
  if (!kindOk) {
    violations.push(`outcome ${extraction.kind} is not in [${goldenCase.allowedKinds.join(', ')}]`);
  }

  return {
    id: goldenCase.id,
    tags: goldenCase.tags,
    outcome: extraction.kind,
    kindOk,
    attempts: trace.attempts.length,
    fieldsMatched,
    fieldsScored,
    violations,
    latencyMs: trace.latencyMs,
    issues: Object.keys(trace.issueDistribution),
    flags: flagsOf(extraction),
  };
}

/** Narrows `Extraction` down to the variants that carry `review` flags. */
function flagsOf(extraction: Extraction): string[] {
  if (extraction.kind === 'ok' || extraction.kind === 'degraded') {
    return extraction.flags.map((flag) => flag.code);
  }
  return [];
}

/** Runs the whole suite and computes the metric card. */
export async function runSuite(
  model: Model,
  enforcement: EnforcementLevel,
  cases: GoldenCase[] = GOLDEN_CASES,
): Promise<SuiteReport> {
  const scores: CaseScore[] = [];
  for (const goldenCase of cases) {
    scores.push(await scoreCase(model, goldenCase, enforcement));
  }

  const byId = new Map(cases.map((entry) => [entry.id, entry]));

  // The clean subset: the cases that must work. Everything else is a rejection or a
  // deliberate fallback, and mixing them into "first-pass validity" would make the
  // number meaningless.
  const clean = scores.filter((score) => byId.get(score.id)?.tags.includes('clean'));
  const negative = scores.filter((score) => {
    const entry = byId.get(score.id);
    if (!entry) return false;
    return !entry.allowedKinds.some((kind) => kind === 'ok' || kind === 'degraded');
  });

  const firstPass = clean.filter(
    (score) => score.attempts === 1 && score.kindOk && score.violations.length === 0,
  ).length;
  const repaired = clean.filter((score) => score.attempts > 1).length;
  const failed = clean.filter(
    (score) =>
      score.outcome === 'invalid' || score.outcome === 'failed' || score.outcome === 'truncated',
  ).length;

  const total = scores.length;
  const kindOk = scores.filter((score) => score.kindOk).length;
  const negativeOk = negative.filter((score) => score.kindOk).length;

  const fieldsScored = scores.reduce((sum, score) => sum + score.fieldsScored, 0);
  const fieldsMatched = scores.reduce((sum, score) => sum + score.fieldsMatched, 0);

  const latencies = scores.map((score) => score.latencyMs).sort((left, right) => left - right);

  const outcomeCounts: Record<string, number> = {};
  const issueDistribution: Record<string, number> = {};
  for (const score of scores) {
    outcomeCounts[score.outcome] = (outcomeCounts[score.outcome] ?? 0) + 1;
    for (const issue of score.issues) {
      issueDistribution[issue] = (issueDistribution[issue] ?? 0) + 1;
    }
  }

  const firstPassValidity = clean.length === 0 ? 0 : firstPass / clean.length;

  // The release gate, Chapter 09 §9.9. A gate that never fails is not a gate — and the
  // weakest enforcement rung is supposed to fail it. That is the measurement.
  const gateFailures: string[] = [];
  if (firstPassValidity < config.evalMinFirstPass) {
    gateFailures.push(
      `first-pass validity on clean cases ${(firstPassValidity * 100).toFixed(0)}% is below the ${(
        config.evalMinFirstPass * 100
      ).toFixed(0)}% gate`,
    );
  }
  if (kindOk < total) {
    gateFailures.push(`${total - kindOk} case(s) produced the wrong kind of outcome`);
  }
  if (negative.length > 0 && negativeOk < negative.length) {
    gateFailures.push(`${negative.length - negativeOk} case(s) that must be rejected were not`);
  }
  const wrongFields = scores.filter((score) => score.violations.length > 0).length;
  if (wrongFields > 0) {
    gateFailures.push(`${wrongFields} case(s) violated a field-level expectation`);
  }

  return {
    enforcement,
    cases: total,
    firstPassValidity,
    repairRate: clean.length === 0 ? 0 : repaired / clean.length,
    finalFailureRate: clean.length === 0 ? 0 : failed / clean.length,
    kindAccuracy: total === 0 ? 0 : kindOk / total,
    fieldAccuracy: fieldsScored === 0 ? 0 : fieldsMatched / fieldsScored,
    negativeAccuracy: negative.length === 0 ? 1 : negativeOk / negative.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    issueDistribution,
    outcomeCounts,
    scores,
    gateFailures,
  };
}

/** Nearest-rank percentile. Good enough for a suite this size, and it never interpolates. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/**
 * Runs the same suite at every enforcement level.
 *
 * This is the single most convincing function in the project: one table, four rungs, the
 * same ten cases. Chapter 03 §3.5 claims each rung removes a specific failure class, and
 * this is where that claim becomes a measurement.
 */
export async function compareEnforcements(
  model: Model,
  levels: EnforcementLevel[],
): Promise<SuiteReport[]> {
  const reports: SuiteReport[] = [];
  for (const level of levels) {
    reports.push(await runSuite(model, level));
  }
  return reports;
}
