/**
 * The reliability loop — Chapter 06, whole.
 *
 * One function, `extractMeeting`, and it is the production shape of a structured call:
 *
 *   generate → parse → validate (shape) → validate (meaning) → repair (bounded) → fall back
 *
 * Everything the notes insist on is enforced structurally here rather than by
 * convention:
 *
 *   • **One boundary.** `parseCandidate` is called in exactly one place, and nothing
 *     downstream ever sees a string.
 *   • **Typed outcomes.** The return value is an `Extraction`, not a throw. A refusal
 *     and a parse error are different values because they route differently.
 *   • **A bounded loop.** `maxRepairs` comes from config; there is no `while (true)`.
 *   • **The input changes on every attempt.** The repair prompt carries the issues and
 *     the previous output, so a retry is not a re-roll of the same dice.
 *   • **A trace per call.** Attempts, issues, outcome and latency are returned with
 *     the result, so the CLI can print them and the harness can count them.
 */

import { config } from '../config/env.js';
import { extractBraceSpan, parseJsonStrict, toTaggedIssues } from '../lib/json.js';
import { buildSystemPrompt } from '../llm/enforcement.js';
import type { Model } from '../llm/model.js';
import { parseCandidate } from '../schema/meeting.js';
import type {
  Attempt,
  EnforcementLevel,
  Extraction,
  ExtractionTrace,
  MeetingRequest,
  TaggedIssue,
  TraceStage,
} from '../types.js';
import { buildRepairPrompt } from './repair.js';
import { defaultSemanticContext, partition, semanticChecks, type SemanticContext } from './semantic.js';

export interface ExtractOptions {
  /** Overrides the configured level, so one process can compare all four. */
  enforcement?: EnforcementLevel;
  semantic?: SemanticContext;
  /** Used by the harness to label the trace. */
  task?: string;
}

export interface ExtractResult {
  extraction: Extraction;
  trace: ExtractionTrace;
}

export async function extractMeeting(
  model: Model,
  input: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const enforcement = options.enforcement ?? config.enforcement;
  const semantic = options.semantic ?? defaultSemanticContext();
  const system = buildSystemPrompt(enforcement);

  const attempts: Attempt[] = [];
  const stages: TraceStage[] = [];
  const startedAt = Date.now();

  let prompt = input;
  /** The most recent blocking issue set, kept so the final outcome can report it. */
  let lastIssues: TaggedIssue[] = [];
  let lastRaw = '';

  for (let n = 1; n <= config.maxRepairs + 1; n += 1) {
    const callStarted = Date.now();

    const response = await model.complete({
      system,
      user: prompt,
      enforcement,
      jsonSchema: {},
      temperature: n === 1 ? config.temperature : config.repairTemperature,
    });

    const callMs = Date.now() - callStarted;
    lastRaw = response.raw;

    // ── Outcome 1: the model declined. Never retried (Chapter 06 §6.10). ──
    if (response.refused) {
      attempts.push({ n, enforcement, raw: response.raw, parsed: false, issues: [], ms: callMs });
      stages.push({
        name: `attempt ${n} · refused`,
        ms: callMs,
        detail: 'the model declined; a terminal outcome, not an error',
      });
      return finish('refused', attempts, stages, startedAt, model, enforcement, {
        kind: 'refused',
        attempts: n,
        raw: response.raw,
      });
    }

    // ── Outcome 2: the token budget cut the object in half. ──
    if (response.truncated) {
      attempts.push({ n, enforcement, raw: response.raw, parsed: false, issues: [], ms: callMs });
      stages.push({
        name: `attempt ${n} · truncated`,
        ms: callMs,
        detail: 'finish_reason=length; raise the budget or shrink the schema',
      });
      return finish('truncated', attempts, stages, startedAt, model, enforcement, {
        kind: 'truncated',
        attempts: n,
        raw: response.raw,
      });
    }

    // ── Step 2: parse. Strict, one JSON.parse, no guessing. ──
    const parsed = parseJsonStrict(response.raw);
    if (!parsed.ok) {
      lastIssues = [parsed.issue];
      attempts.push({
        n,
        enforcement,
        raw: response.raw,
        parsed: false,
        issues: [parsed.issue],
        ms: callMs,
      });
      stages.push({ name: `attempt ${n} · parse error`, ms: callMs, detail: parsed.detail });

      if (n > config.maxRepairs) break;
      prompt = buildRepairPrompt({ previous: response.raw, issues: [parsed.issue], attempt: n });
      continue;
    }

    // ── Step 3a: structural validation. ──
    const candidate = parseCandidate(parsed.value);
    if (!candidate.ok) {
      const issues = toTaggedIssues(candidate.error, 'structural');
      lastIssues = issues;
      attempts.push({ n, enforcement, raw: response.raw, parsed: true, issues, ms: callMs });
      stages.push({
        name: `attempt ${n} · shape error`,
        ms: callMs,
        detail: issues.map((entry) => entry.path).join(', '),
      });

      if (n > config.maxRepairs) break;
      prompt = buildRepairPrompt({ previous: response.raw, issues, attempt: n });
      continue;
    }

    // ── Step 3b: semantic validation. Shape is not truth. ──
    const semanticIssues = semanticChecks(candidate.value, semantic);
    const { blocking, review } = partition(semanticIssues);

    if (blocking.length > 0) {
      lastIssues = blocking;
      attempts.push({ n, enforcement, raw: response.raw, parsed: true, issues: blocking, ms: callMs });
      stages.push({
        name: `attempt ${n} · semantic error`,
        ms: callMs,
        detail: blocking.map((entry) => `${entry.path}(${entry.code})`).join(', '),
      });

      if (n > config.maxRepairs) break;
      prompt = buildRepairPrompt({ previous: response.raw, issues: blocking, attempt: n });
      continue;
    }

    // ── Step 5: accept. `review`-severity issues travel with the object. ──
    attempts.push({ n, enforcement, raw: response.raw, parsed: true, issues: review, ms: callMs });
    stages.push({
      name: `attempt ${n} · accepted`,
      ms: callMs,
      detail: review.length > 0 ? `flagged: ${review.map((entry) => entry.path).join(', ')}` : 'clean',
    });

    return finish('ok', attempts, stages, startedAt, model, enforcement, {
      kind: 'ok',
      value: candidate.value,
      attempts: n,
      flags: review,
    });
  }

  // ── Step 6: the fallback ladder. Repair is exhausted. ──
  //
  // Rung 3 of the ladder from Chapter 06 §6.9: a **degraded object**. Unknowns are
  // filled with `null` and the result is flagged so the caller can route it. This is
  // only correct when the downstream consumer can tolerate partial data — a product
  // decision, and therefore a config flag rather than a default.
  if (config.allowDegradedFallback && isDegradable(lastIssues)) {
    const degraded = degrade(lastRaw, lastIssues);
    if (degraded !== null) {
      stages.push({
        name: 'fallback · degraded object',
        ms: 0,
        detail: 'repair exhausted; unknowns set to null and the object flagged',
      });
      return finish('degraded', attempts, stages, startedAt, model, enforcement, {
        kind: 'degraded',
        value: degraded,
        attempts: attempts.length,
        flags: lastIssues,
        reason: 'repair exhausted; degraded to nulls',
      });
    }
  }

  stages.push({
    name: 'fallback · failed',
    ms: 0,
    detail: 'repair exhausted; no degraded object was safe to build',
  });

  return finish('invalid', attempts, stages, startedAt, model, enforcement, {
    kind: 'invalid',
    attempts: attempts.length,
    issues: lastIssues,
    reason: lastIssues.some((entry) => entry.origin === 'semantic') ? 'semantic_error' : 'shape_error',
  });
}

/* ─────────────────────────────────────────────────────────────
 * The fallback rung: what "degraded" may and may not do
 * ───────────────────────────────────────────────────────────── */

/**
 * The only (path, code) pairs degradation is allowed to invent a value for.
 *
 * This is the most important safety rule in the file, and it is keyed on the **code** as
 * well as the path — because "this value is missing" and "this value is against policy"
 * are not the same problem:
 *
 *   durationMinutes + out_of_range      → the value is untrustworthy (900 minutes, a
 *                                         string, a negative) → default it to 30 and flag.
 *   durationMinutes + policy_violation  → the value was *stated* and merely breaches a
 *                                         rule (a 15-minute interview). Silently turning
 *                                         15 into 30 changes what the user asked for.
 *                                         The correct rung is human review, not a default.
 *   location        + missing/wrong     → `null`, which the contract already allows.
 *   type            + enum_drift/missing→ `OTHER`, the enum's documented escape hatch.
 *
 * And the fields that are **never** invented, whatever the code:
 *
 *   title, attendee, startIso, schemaVersion
 *
 * Filling a missing attendee with a plausible name would be the worst bug in the
 * lecture: a schema-valid object that books a meeting with the wrong person.
 */
const DEGRADABLE: ReadonlySet<string> = new Set([
  'durationMinutes:out_of_range',
  'durationMinutes:wrong_type',
  'durationMinutes:missing_field',
  'location:missing_field',
  'location:wrong_type',
  'type:enum_drift',
  'type:missing_field',
  'type:wrong_type',
]);

/** True only when every blocking issue targets a field degradation may default. */
function isDegradable(issues: TaggedIssue[]): boolean {
  if (issues.length === 0) return false;
  return issues.every((issue) => DEGRADABLE.has(`${issue.path}:${issue.code}`));
}

/**
 * Builds a degraded object, or returns `null` when that would require inventing a
 * non-defaultable field.
 *
 * The flagged paths are defaulted explicitly, so the degraded object is consistent with
 * the issue it was degraded for — a degraded duration of 15 minutes that still breaches
 * the interview rule would be worse than no object at all.
 *
 * This is the one place the *tolerant* reader is legitimate: by the time we are here,
 * enforcement and validation have both failed, and the alternative is nothing at all.
 * The result is still put back through the validator, so a degraded object is never
 * less *valid* than a normal one — it is only less complete.
 */
function degrade(raw: string, issues: TaggedIssue[]): MeetingRequest | null {
  const tolerant = extractBraceSpan(raw);
  if (tolerant === null) return null;

  let loose: Record<string, unknown>;
  try {
    loose = JSON.parse(tolerant) as Record<string, unknown>;
  } catch {
    return null;
  }

  // The non-nullable spine. No guessing: a value must already be there and be a string.
  const title = typeof loose.title === 'string' ? loose.title.trim() : '';
  const attendee = typeof loose.attendee === 'string' ? loose.attendee.trim() : '';
  const startIso = typeof loose.startIso === 'string' ? loose.startIso.trim() : '';
  if (title.length === 0 || attendee.length === 0 || startIso.length === 0) return null;

  const flagged = new Set(issues.map((issue) => issue.path));

  // Default exactly what was flagged; keep everything else the model produced.
  const duration = typeof loose.durationMinutes === 'number' ? loose.durationMinutes : Number.NaN;
  const durationIsUsable =
    !flagged.has('durationMinutes') &&
    Number.isInteger(duration) &&
    duration >= 1 &&
    duration <= config.maxDurationMinutes;

  const candidate = {
    reasoning:
      typeof loose.reasoning === 'string' && loose.reasoning.trim().length > 0
        ? loose.reasoning
        : 'Degraded extraction: the model output failed validation after repair.',
    title,
    attendee,
    startIso,
    // Defaulted, not guessed — and the flag travels with the object.
    durationMinutes: durationIsUsable ? duration : 30,
    type: !flagged.has('type') && typeof loose.type === 'string' && isMeetingType(loose.type)
      ? loose.type
      : 'OTHER',
    location:
      !flagged.has('location') && typeof loose.location === 'string' && loose.location.length > 0
        ? loose.location
        : null,
    schemaVersion: config.schemaVersion,
  };

  const validated = parseCandidate(candidate);
  return validated.ok ? validated.value : null;
}

function isMeetingType(value: string): value is MeetingRequest['type'] {
  return value === 'ONE_ON_ONE' || value === 'INTERVIEW' || value === 'TEAM' || value === 'OTHER';
}

/* ─────────────────────────────────────────────────────────────
 * Closing the loop: the trace
 * ───────────────────────────────────────────────────────────── */

/**
 * Assembles the result and its trace.
 *
 * The issue distribution is computed here rather than by the caller, because it is
 * the single most useful production metric in Chapter 09: it turns "the model is
 * unreliable" into "`durationMinutes` is a string 4% of the time".
 *
 * Note what the trace does **not** carry on the success path: the raw output. Raw
 * output frequently contains personal data, and general logs are the wrong place for
 * it. Failures keep it, because a failure you cannot reproduce is not fixable.
 */
function finish(
  outcome: Extraction['kind'],
  attempts: Attempt[],
  stages: TraceStage[],
  startedAt: number,
  model: Model,
  enforcement: EnforcementLevel,
  extraction: Extraction,
): ExtractResult {
  const issueDistribution: Record<string, number> = {};
  for (const attempt of attempts) {
    for (const issue of attempt.issues) {
      const key = `${issue.path}:${issue.code}`;
      issueDistribution[key] = (issueDistribution[key] ?? 0) + 1;
    }
  }

  const trace: ExtractionTrace = {
    task: 'meeting_extraction',
    schemaVersion: config.schemaVersion,
    provider: model.provider,
    model: model.model,
    enforcement,
    stages,
    attempts,
    outcome,
    issueDistribution,
    latencyMs: Date.now() - startedAt,
  };

  return { extraction, trace };
}

/** Convenience for callers that only want the object, and want it loudly. */
export function requireValue(extraction: Extraction): MeetingRequest | null {
  return extraction.kind === 'ok' || extraction.kind === 'degraded' ? extraction.value : null;
}
