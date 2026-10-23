/**
 * Small, boring helpers. No dependencies, no cleverness.
 *
 * Two of these are the exact normalisations Chapter 04 §4.7 says the *schema* is
 * responsible for: relative dates ("tomorrow") and 12-hour times ("4 PM"). They live
 * in code here because the offline simulator needs them; in a real deployment they
 * are the `description` fields on the schema plus a semantic check on the way out.
 */

import { createHash } from 'node:crypto';

/** Short, stable, deterministic. Used for chunk ids, proposal ids and idempotency keys. */
export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/* ─────────────────────────────────────────────────────────────
 * Dates and times — the normalisation the schema must force
 * ───────────────────────────────────────────────────────────── */

/** `2026-10-02` for a `Date`, in local time (never UTC-shifted, unlike `toISOString`). */
export function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `2026-10-02T16:00` — no seconds, no zone suffix: a local wall-clock instant. */
export function toIsoLocal(date: Date, hours: number, minutes: number): string {
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${toIsoDate(date)}T${hh}:${mm}`;
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

/**
 * Resolves a relative date expression against a reference date.
 *
 * Chapter 02 §2.9 calls this out explicitly: `tomorrow` is unusable to a calendar
 * API, and the schema's job is to force the model to normalise it. This is the
 * reference implementation of that rule, so the offline path behaves like a model
 * that followed the instruction.
 *
 * Returns `null` when the expression is not one we are willing to guess at. Guessing
 * is how a meeting lands on the wrong day.
 */
export function resolveRelativeDate(expression: string, reference: Date): Date | null {
  const text = expression.toLowerCase().trim();

  if (text.includes('today')) return new Date(reference.getTime());
  if (text.includes('tomorrow')) return addDays(reference, 1);
  if (text.includes('day after tomorrow')) return addDays(reference, 2);
  if (text.includes('next week')) return addDays(reference, 7);

  // Explicit ISO date, e.g. 2026-10-02.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  // Weekday name: the *next* occurrence, never today.
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let index = 0; index < weekdays.length; index += 1) {
    if (text.includes(weekdays[index])) {
      let delta = (index - reference.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      return addDays(reference, delta);
    }
  }

  return null;
}

/**
 * Normalises `"4 PM"`, `"4pm"`, `"16:00"` into `{ hours, minutes }` on a 24-hour clock.
 *
 * Returns `null` rather than defaulting, for the same reason as above: a wrong time is
 * worse than an admitted gap.
 */
export function normaliseTime(expression: string): { hours: number; minutes: number } | null {
  const text = expression.toLowerCase().replace(/\s+/g, '');

  const twelve = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(text);
  if (twelve) {
    let hours = Number(twelve[1]);
    const minutes = Number(twelve[2] ?? '0');
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    if (twelve[3] === 'pm' && hours !== 12) hours += 12;
    if (twelve[3] === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  const twentyFour = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (twentyFour) {
    const hours = Number(twentyFour[1]);
    const minutes = Number(twentyFour[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }

  return null;
}

/** `90` → `"1 h 30 min"`. Display only; the object always carries minutes. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/* ─────────────────────────────────────────────────────────────
 * Identity
 * ───────────────────────────────────────────────────────────── */

/**
 * Does a human-readable person reference match an identity?
 *
 * This exists because the same person arrives in three shapes and they must all
 * compare equal:
 *
 *   the model extracts a *name*      `"Aditya"`
 *   the directory stores an *email*  `"aditya@northwind.test"`
 *   the request carries an *actor*   `"aditya@northwind.test"`
 *
 * Getting this wrong is not cosmetic. It is the difference between "you may book for
 * yourself" and "forbidden", and between an auto-approved event and a human approval
 * gate — so there is exactly **one** implementation, shared by the semantic layer and
 * the authorisation layer.
 */
export function matchesPerson(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;

  // Compare the addressable parts, so "Aditya" matches "aditya@northwind.test".
  const localOf = (value: string): string => value.split('@')[0];
  const displayOf = (value: string): string => localOf(value).replace(/[._-]+/g, ' ');

  const aLocal = localOf(a);
  const bLocal = localOf(b);
  return (
    aLocal === bLocal ||
    displayOf(a) === displayOf(b) ||
    displayOf(a) === bLocal ||
    aLocal === displayOf(b)
  );
}

/* ─────────────────────────────────────────────────────────────
 * Console helpers — the CLI prints tables, so it needs a little geometry
 * ───────────────────────────────────────────────────────────── */

/** Pads to a column width, counting characters rather than bytes. */
export function pad(value: string, width: number): string {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Truncates with an ellipsis so a table row never wraps. */
export function clamp(value: string, width: number): string {
  const text = String(value).replace(/\s+/g, ' ');
  return text.length <= width ? pad(text, width) : `${text.slice(0, width - 1)}…`;
}

export function heading(title: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(Math.max(title.length, 40)));
}

export function rule(): void {
  console.log('─'.repeat(96));
}

/** Milliseconds, rounded — every number the CLI prints should be stable across runs. */
export function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}
