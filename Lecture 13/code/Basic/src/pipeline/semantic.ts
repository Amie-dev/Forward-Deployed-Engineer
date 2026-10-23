/**
 * The domain layer — Chapter 06 §6.6.
 *
 * Structural validation is the same in every project: types, required fields, enums,
 * bounds. This file is the part that is *not* the same, and it is where a Forward
 * Deployed Engineer earns their salary: the rules that make an object **true**, not
 * merely well-shaped.
 *
 * Two design decisions carry the whole file:
 *
 *  1. **Two severities, not one.** `block` means the object is unusable or unsafe.
 *     `review` means it is plausible and a human should look at it. Collapsing both
 *     into "invalid" either over-rejects good data or under-rejects bad data — the
 *     exact failure the notes describe.
 *
 *  2. **Every check is pure and injectable.** `now` and `directory` arrive as
 *     arguments, never read from a global. That is what makes the checks testable and
 *     what lets the evaluation harness replay a fixed date.
 */

import { config } from '../config/env.js';
import { matchesPerson } from '../lib/text.js';
import type { MeetingRequest, TaggedIssue } from '../types.js';

export interface SemanticContext {
  /** The instant to reason against. Injected so runs are reproducible. */
  now: Date;
  /** Known people. A name outside this set is a `review`, never a `block`. */
  directory: string[];
}

export function defaultSemanticContext(): SemanticContext {
  return { now: new Date(), directory: [...config.directory] };
}

function issue(
  path: string,
  code: TaggedIssue['code'],
  message: string,
  severity: TaggedIssue['severity'],
): TaggedIssue {
  return { path, code, message, severity, origin: 'semantic' };
}

/**
 * The checks, in the order a reviewer would ask about them.
 *
 * Note the deliberate asymmetry between `block` and `review`:
 *
 *   start in the past         → block. A meeting that already happened is not a plan.
 *   duration > 8 hours        → block. No policy allows it, and something is wrong.
 *   duration > 4 hours        → review. Legal, unusual, worth a human's glance.
 *   attendee not in directory → review, **not** block. The directory is incomplete and
 *                               the input may legitimately name a new person.
 *                               Rejecting here would be the over-rejection failure mode.
 *   empty title / attendee    → block. The model was told to use null, and a sentinel
 *                               empty string is exactly what the schema forbids.
 *   interview < 30 minutes    → block. A domain invariant, not a preference.
 */
export function semanticChecks(meeting: MeetingRequest, context: SemanticContext): TaggedIssue[] {
  const issues: TaggedIssue[] = [];

  // ── Presence, because a sentinel is not a value ──
  if (meeting.attendee.trim().length === 0) {
    issues.push(
      issue(
        'attendee',
        'missing_field',
        'The request does not name a person. Use null instead of an empty string, and do not guess.',
        'block',
      ),
    );
  }

  if (meeting.startIso.trim().length === 0) {
    issues.push(
      issue('startIso', 'missing_field', 'The request does not state a date and time.', 'block'),
    );
  }

  // ── Temporal sanity ──
  if (meeting.startIso.length > 0) {
    const start = parseLocalIso(meeting.startIso);
    if (start === null) {
      issues.push(
        issue(
          'startIso',
          'not_a_date',
          `"${meeting.startIso}" is not a valid YYYY-MM-DDTHH:mm instant.`,
          'block',
        ),
      );
    } else if (config.requireFutureStart && start.getTime() <= context.now.getTime()) {
      issues.push(
        issue(
          'startIso',
          'not_in_future',
          'The meeting starts in the past. Resolve relative dates against today.',
          'block',
        ),
      );
    }
  }

  // ── Numeric plausibility ──
  if (meeting.durationMinutes > config.maxDurationMinutes) {
    issues.push(
      issue(
        'durationMinutes',
        'out_of_range',
        `Duration exceeds the ${config.maxDurationMinutes}-minute limit.`,
        'block',
      ),
    );
  } else if (meeting.durationMinutes > config.maxDurationReviewMinutes) {
    issues.push(
      issue(
        'durationMinutes',
        'policy_violation',
        `Duration exceeds the ${config.maxDurationReviewMinutes}-minute review threshold.`,
        'review',
      ),
    );
  }

  // ── Cross-field consistency ──
  if (meeting.type === 'INTERVIEW' && meeting.durationMinutes < 30) {
    issues.push(
      issue('durationMinutes', 'policy_violation', 'Interviews must be at least 30 minutes.', 'block'),
    );
  }

  // ── Referential integrity (advisory only) ──
  if (meeting.attendee.trim().length > 0 && !isKnownPerson(meeting.attendee, context.directory)) {
    issues.push(
      issue(
        'attendee',
        'unknown_attendee',
        `"${meeting.attendee}" is not in the directory. Confirm the participant before the event is created.`,
        'review',
      ),
    );
  }

  return issues;
}

/**
 * Matches a name against the directory using the shared identity rule.
 *
 * A single implementation on purpose: the semantic layer, the authorisation layer and
 * the approval decision must all agree about who a person is.
 */
function isKnownPerson(attendee: string, directory: string[]): boolean {
  return directory.some((entry) => matchesPerson(attendee, entry));
}

/**
 * Parses `YYYY-MM-DDTHH:mm` as a **local** instant.
 *
 * `new Date("2026-10-02T16:00")` is parsed as local time in modern engines, but the
 * specification does not guarantee it — and a UTC-shifted instant silently moves a
 * meeting by hours. Splitting the string removes the ambiguity entirely.
 */
export function parseLocalIso(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);

  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);

  // Reject impossible dates that `Date` silently rolls over (31 February → 3 March).
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) {
    return null;
  }

  return date;
}

/** Splits issues by severity, because the two groups route differently. */
export function partition(issues: TaggedIssue[]): { blocking: TaggedIssue[]; review: TaggedIssue[] } {
  return {
    blocking: issues.filter((entry) => entry.severity === 'block'),
    review: issues.filter((entry) => entry.severity === 'review'),
  };
}
