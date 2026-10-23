/**
 * JSON handling at the boundary — Chapter 03 §3.8 and Chapter 06 §6.5.
 *
 * This file exists because of one paragraph in the notes: *every regex you add to
 * "fix" model output is a silent correctness risk that only triggers on rare inputs.*
 *
 * So it does two separate things, deliberately kept apart:
 *
 *   1. `stripFences` / `extractBraceSpan` — a **tolerant reader**, used only for
 *      diagnosis and for the weakest enforcement rungs. Documented as a liability.
 *   2. `parseJsonStrict` — the **strict path**. One `JSON.parse`, no guessing, and a
 *      typed result that says exactly which stage failed.
 *
 * The lesson is which one production code calls: the second one.
 */

import { z } from 'zod';

import type { Issue, TaggedIssue } from '../types.js';

/* ─────────────────────────────────────────────────────────────
 * The tolerant reader (use sparingly, and know why)
 * ───────────────────────────────────────────────────────────── */

/**
 * Removes a markdown fence if one is present.
 *
 * Chapter 03 §3.8 lists the counterexamples: the model may use `~~~`, may indent a
 * code block, or may emit a fence *inside* a string value. This function therefore
 * only handles the exact documented case — a fenced block that starts the response —
 * and leaves everything else for the repair loop.
 */
export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Returns the substring from the first `{` to the last `}`.
 *
 * This is the anti-pattern from the notes, kept because it is genuinely useful for
 * *diagnosis* — it lets the CLI show what a chatty preamble looked like — and
 * deliberately **not** used on the strict path.
 */
export function extractBraceSpan(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/* ─────────────────────────────────────────────────────────────
 * The strict path
 * ───────────────────────────────────────────────────────────── */

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; issue: TaggedIssue; detail: string };

/**
 * The single parse step every structured call goes through.
 *
 * It never guesses. If the text is not JSON, the caller learns that immediately and
 * receives an `Issue` it can paste straight into a repair prompt.
 */
export function parseJsonStrict(raw: string): ParseResult {
  const text = raw.trim();

  if (text.length === 0) {
    return {
      ok: false,
      issue: {
        path: '$',
        code: 'parse_error',
        message: 'The response was empty.',
        severity: 'block',
        origin: 'structural',
      },
      detail: 'empty response',
    };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issue: {
        path: '$',
        code: 'parse_error',
        message: `The response is not valid JSON: ${detail}`,
        severity: 'block',
        origin: 'structural',
      },
      detail,
    };
  }
}

/** True when the response looks like a refusal rather than an object. */
export function looksLikeRefusal(raw: string): boolean {
  const text = raw.toLowerCase();
  if (text.trim().length === 0) return true;
  return (
    text.includes("i can't help") ||
    text.includes('i cannot help') ||
    text.includes("i'm unable") ||
    text.includes('i am unable') ||
    text.includes('cannot assist') ||
    text.includes('not able to assist')
  );
}

/** True when the response was cut off mid-object rather than being wrong. */
export function looksTruncated(raw: string): boolean {
  const text = raw.trim();
  if (text.length === 0) return false;
  const opens = (text.match(/[{[]/g) ?? []).length;
  const closes = (text.match(/[}\]]/g) ?? []).length;
  return opens > closes;
}

/* ─────────────────────────────────────────────────────────────
 * Zod issues → the one issue shape the rest of the system uses
 * ───────────────────────────────────────────────────────────── */

/** Maps a Zod issue code onto the metric-friendly vocabulary in `types.ts`. */
function issueCodeOf(issue: z.ZodIssue): TaggedIssue['code'] {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === 'undefined' ? 'missing_field' : 'wrong_type';
    case z.ZodIssueCode.invalid_enum_value:
      return 'enum_drift';
    case z.ZodIssueCode.too_small:
    case z.ZodIssueCode.too_big:
      return 'out_of_range';
    case z.ZodIssueCode.unrecognized_keys:
      return 'unexpected_key';
    default:
      return 'wrong_type';
  }
}

/**
 * Converts Zod's issue list into `TaggedIssue[]`.
 *
 * Two details that matter downstream:
 *  - the path is flattened to a dotted string, because that is what the repair
 *    prompt prints and what the issue-distribution metric groups by;
 *  - `unrecognized_keys` produces one issue per offending key, not one per object,
 *    so "the model added `durationInMinutes`" becomes its own countable row.
 */
export function toTaggedIssues(error: z.ZodError, origin: TaggedIssue['origin']): TaggedIssue[] {
  const issues: TaggedIssue[] = [];

  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      for (const key of issue.keys) {
        issues.push({
          path: key,
          code: 'unexpected_key',
          message: `Unexpected field "${key}". Do not add fields that are not in the schema.`,
          severity: 'block',
          origin,
        });
      }
      continue;
    }

    issues.push({
      path: issue.path.join('.') || '$',
      code: issueCodeOf(issue),
      message: describe(issue),
      severity: 'block',
      origin,
    });
  }

  return issues;
}

/**
 * Turns a Zod message into something safe and useful to send back to a model.
 *
 * The message is deliberately explicit about expected-versus-received: Chapter 06 §6.8
 * shows that `Expected number, received string ("30")` is what makes a repair succeed
 * on the first attempt.
 */
function describe(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === 'undefined'
        ? `Required field is missing. Expected ${issue.expected}.`
        : `Expected ${issue.expected}, received ${issue.received}.`;
    case z.ZodIssueCode.invalid_enum_value:
      return `Invalid value "${String(issue.received)}". Expected one of: ${issue.options.join(', ')}.`;
    case z.ZodIssueCode.too_small:
      return `Value is too small. Expected ${issue.minimum} or more.`;
    case z.ZodIssueCode.too_big:
      return `Value is too large. Expected ${issue.maximum} or less.`;
    case z.ZodIssueCode.invalid_string:
      return `String format is invalid (${issue.validation}).`;
    default:
      return issue.message;
  }
}

/** Convenience: build a single blocking structural issue. */
export function structuralIssue(path: string, code: Issue['code'], message: string): TaggedIssue {
  return { path, code, message, severity: 'block', origin: 'structural' };
}
