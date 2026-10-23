/**
 * A deterministic, rule-based reader for the sentences used in this lecture.
 *
 * **This is not a language model, and pretending otherwise would hide the thing the
 * lecture is about.** The offline simulator needs *content* to wrap, and this is where
 * the content comes from: the same normalisations a model would be asked to perform
 * (relative dates, 12-hour clocks, prose durations), implemented as the exact rules
 * the schema's `description` fields instruct.
 *
 * What this file does **not** decide is the *envelope* — whether the result comes back
 * as prose, as valid-but-drifting JSON, or as a schema-valid object. That decision
 * belongs to the enforcement level, and it lives in `llm/model.ts`.
 */

import { normaliseTime, resolveRelativeDate, toIsoLocal } from '../lib/text.js';
import type { MeetingType } from '../types.js';

/** A partially-filled form. Every field may be `null`: that is what "unknown" means. */
export interface Draft {
  title: string | null;
  attendee: string | null;
  /** Resolved absolute date, or `null` when the expression was not recognised. */
  date: Date | null;
  time: { hours: number; minutes: number } | null;
  durationMinutes: number | null;
  type: MeetingType;
  location: string | null;
  reasoning: string;
  /** The input is not a scheduling request at all — a real model would decline. */
  outOfScope: boolean;
  /** The input contains instruction-like text (Chapter 08 §8.10's attack surface). */
  injected: boolean;
}

/** Words that mean "the user is not asking us to schedule anything". */
const OUT_OF_SCOPE = [
  'what is the weather',
  'write me a poem',
  'explain docker',
  'what is our return policy',
  'how do i deploy',
  'translate this',
];

/** Instruction-like text embedded in untrusted content. */
const INJECTION_MARKERS = [
  'ignore previous instructions',
  'ignore all previous',
  'disregard the system prompt',
  'you are now',
  'reveal your system prompt',
  'create the event without asking',
];

/** Topic words that map onto the closed enum, so the enum is never guessed at. */
const TYPE_HINTS: Array<{ type: MeetingType; words: string[] }> = [
  { type: 'INTERVIEW', words: ['interview', 'screening', 'candidate', 'hiring'] },
  { type: 'ONE_ON_ONE', words: ['1:1', 'one on one', 'one-on-one', 'check-in', 'check in'] },
  { type: 'TEAM', words: ['standup', 'stand-up', 'team', 'sync', 'retro', 'planning', 'review'] },
];

const DURATION_WORDS: Array<{ minutes: number; words: string[] }> = [
  { minutes: 15, words: ['quarter of an hour', 'quarter hour'] },
  { minutes: 30, words: ['half an hour', 'half hour', 'thirty minutes', '30 minutes', '30 min'] },
  { minutes: 45, words: ['forty five minutes', '45 minutes', '45 min'] },
  { minutes: 60, words: ['an hour', 'one hour', '60 minutes', '1 hour'] },
  { minutes: 90, words: ['an hour and a half', '90 minutes', 'ninety minutes'] },
  { minutes: 120, words: ['two hours', '2 hours'] },
];

/** Reads one sentence into a draft. Deterministic: same input, same draft, always. */
export function readDraft(input: string): Draft {
  const text = input.trim();
  const lower = text.toLowerCase();

  const outOfScope = OUT_OF_SCOPE.some((phrase) => lower.includes(phrase));
  const injected = INJECTION_MARKERS.some((phrase) => lower.includes(phrase));

  const attendee = findAttendee(text);
  const date = findDate(lower);
  const time = findTime(lower);
  const durationMinutes = findDuration(lower);
  const location = findLocation(text);
  const type = findType(lower);
  const title = findTitle(text, type);

  return {
    title,
    attendee,
    date,
    time,
    durationMinutes,
    type,
    location,
    reasoning: buildReasoning({ date, time, durationMinutes, attendee, location }),
    outOfScope,
    injected,
  };
}

/** `with Ravi`, `with Aditya Sharma`, `with ravi@northwind.test` — first match wins. */
function findAttendee(text: string): string | null {
  const email = /([\w.+-]+@[\w-]+\.[\w.-]+)/.exec(text);
  if (email) return email[1];

  const named = /\bwith\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/.exec(text);
  if (named) return named[1].trim();

  const lowercaseNamed = /\bwith\s+([a-z]{3,})\b/i.exec(text);
  return lowercaseNamed ? capitalise(lowercaseNamed[1]) : null;
}

function findDate(lower: string): Date | null {
  const reference = new Date();
  reference.setHours(0, 0, 0, 0);

  // Longest expressions first, so "day after tomorrow" is not read as "tomorrow".
  const candidates = [
    'day after tomorrow',
    'next week',
    'tomorrow',
    'today',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ];

  for (const candidate of candidates) {
    if (lower.includes(candidate)) return resolveRelativeDate(candidate, reference);
  }

  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(lower);
  return iso ? resolveRelativeDate(iso[1], reference) : null;
}

function findTime(lower: string): { hours: number; minutes: number } | null {
  const meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(lower);
  if (meridiem) return normaliseTime(meridiem[0]);

  const clock = /\b(\d{1,2}):(\d{2})\b/.exec(lower);
  return clock ? normaliseTime(clock[0]) : null;
}

function findDuration(lower: string): number | null {
  for (const entry of DURATION_WORDS) {
    if (entry.words.some((word) => lower.includes(word))) return entry.minutes;
  }

  const numeric = /\bfor\s+(\d{1,3})\s*(minutes|min|mins|hours|hour|h)\b/.exec(lower);
  if (numeric) {
    const amount = Number(numeric[1]);
    return numeric[2].startsWith('h') ? amount * 60 : amount;
  }

  return null;
}

/** `in Room 4`, `in the Blue Room`, `at https://...`. */
function findLocation(text: string): string | null {
  const url = /(https?:\/\/[^\s,]+)/.exec(text);
  if (url) return url[1];

  const room = /\b(?:in|at)\s+((?:the\s+)?[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*\s+(?:Room|Hall|Office|Zoom|Meet))\b/.exec(
    text,
  );
  if (room) return room[1].trim();

  const bare = /\b(?:in|at)\s+(Room\s+\w+)\b/i.exec(text);
  return bare ? capitalise(bare[1].trim()) : null;
}

function findType(lower: string): MeetingType {
  for (const hint of TYPE_HINTS) {
    if (hint.words.some((word) => lower.includes(word))) return hint.type;
  }
  return 'OTHER';
}

/** Pulls the topic out of "Schedule a <topic> with <person> ...". */
function findTitle(text: string, type: MeetingType): string | null {
  const explicit = /\b(?:titled|called|about|regarding)\s+["']?([^"',.]+)["']?/i.exec(text);
  if (explicit) return titleCase(explicit[1].trim());

  const scheduled = /\bschedule\s+(?:a|an|the)?\s*([^,.]+?)\s+with\b/i.exec(text);
  if (scheduled) return titleCase(scheduled[1].trim());

  const discuss = /\b(?:to\s+)?discuss\s+([^,.]+)/i.exec(text);
  if (discuss) return titleCase(discuss[1].trim());

  // No topic in the text. The prompt says a title is required, so we synthesise one —
  // which is exactly the instruction-following the schema asked for.
  const fallback: Record<MeetingType, string> = {
    ONE_ON_ONE: 'One-on-one',
    INTERVIEW: 'Interview',
    TEAM: 'Team meeting',
    OTHER: 'Meeting',
  };
  return fallback[type];
}

function buildReasoning(parts: {
  date: Date | null;
  time: { hours: number; minutes: number } | null;
  durationMinutes: number | null;
  attendee: string | null;
  location: string | null;
}): string {
  const found: string[] = [];
  const missing: string[] = [];

  if (parts.attendee) found.push(`attendee "${parts.attendee}"`);
  else missing.push('attendee');

  if (parts.date && parts.time) {
    found.push(`start ${toIsoLocal(parts.date, parts.time.hours, parts.time.minutes)}`);
  } else if (parts.date) {
    missing.push('time');
  } else {
    missing.push('date');
  }

  if (parts.durationMinutes) found.push(`duration ${parts.durationMinutes} min`);
  else missing.push('duration');

  if (parts.location) found.push(`location "${parts.location}"`);

  const foundText = found.length > 0 ? `Read ${found.join(', ')} from the request.` : 'Read nothing usable.';
  const missingText = missing.length > 0 ? ` Not stated: ${missing.join(', ')}.` : '';
  return foundText + missingText;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
