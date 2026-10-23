/**
 * The calendar adapter — Chapter 08 §8.4.
 *
 * This is the answer to the lecture's closing question: *how does our application
 * communicate with Google Calendar?*
 *
 * It is an **adapter**, and its whole job is to absorb the difference between two
 * contracts:
 *
 *   the model's domain object   `MeetingRequest` — `startIso`, `durationMinutes`
 *   the vendor's payload        `start.dateTime` + `end.dateTime`, RFC-3339, timezone
 *
 * Three rules from the notes are enforced here, in code rather than in a comment:
 *
 *  1. **Vendor errors become typed domain errors.** `conflict`, `unauthorised`,
 *     `rate_limited`, `unavailable`. An HTTP status leaking upward turns precise retry
 *     logic into guesswork.
 *  2. **Writes are idempotent.** The key is derived from the object's *semantics*, so
 *     a retry after a timeout returns the same event instead of creating a second one.
 *  3. **The model never calls this.** The model proposes; the runtime executes. This
 *     file knows nothing about prompts, schemas or tokens.
 *
 * The implementation is an in-memory store, because the interesting part is the
 * contract, not the HTTP call.
 */

import { config } from '../config/env.js';
import { matchesPerson, shortHash } from '../lib/text.js';
import type { ActionErrorCode, MeetingRequest } from '../types.js';

/** A calendar event as the *vendor* sees it — a different shape from our domain type. */
export interface CalendarEvent {
  id: string;
  summary: string;
  /** RFC-3339 with the account timezone, as most calendar APIs require. */
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: Array<{ email: string }>;
  location?: string;
}

export type CreateEventResult =
  | { ok: true; event: CalendarEvent; duplicate: boolean }
  | { ok: false; code: ActionErrorCode; message: string; retryAfterMs?: number };

/**
 * The port. Everything above this interface talks about meetings; everything below
 * talks about a specific vendor. Swapping providers changes one implementation.
 */
export interface CalendarPort {
  createEvent(meeting: MeetingRequest, idempotencyKey: string, actor: string): Promise<CreateEventResult>;
  listEvents(): CalendarEvent[];
  findConflicts(meeting: MeetingRequest): CalendarEvent[];
}

/**
 * An in-memory calendar that behaves like a real one in the two ways that matter:
 * it rejects overlapping events, and it honours idempotency keys.
 */
export class InMemoryCalendar implements CalendarPort {
  private readonly events = new Map<string, CalendarEvent>();
  /** idempotency key → event id. This is what makes a retry safe. */
  private readonly byKey = new Map<string, string>();

  /** Set to `false` in a demo to simulate a vendor outage. */
  constructor(private available = true) {}

  setAvailable(available: boolean): void {
    this.available = available;
  }

  async createEvent(
    meeting: MeetingRequest,
    idempotencyKey: string,
    actor: string,
  ): Promise<CreateEventResult> {
    // Rule 2: the idempotency check comes FIRST, before any other validation of the
    // request. A retry must be a no-op even if the calendar's state has changed since.
    const existingId = this.byKey.get(idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.events.get(existingId);
      if (existing) return { ok: true, event: existing, duplicate: true };
    }

    if (!this.available) {
      return {
        ok: false,
        code: 'unavailable',
        message: 'Calendar service is unavailable.',
        retryAfterMs: 500,
      };
    }

    // Rule 1: an overlapping event is a domain-level `conflict`, not a 409 leaking up.
    const conflicts = this.findConflicts(meeting);
    if (conflicts.length > 0) {
      return {
        ok: false,
        code: 'conflict',
        message: `The slot overlaps "${conflicts[0].summary}". Propose another time.`,
      };
    }

    if (!this.canWrite(actor, meeting)) {
      return { ok: false, code: 'forbidden', message: 'This actor may not book for that attendee.' };
    }

    const event: CalendarEvent = {
      id: `evt_${shortHash(`${idempotencyKey}:${this.events.size}`)}`,
      summary: meeting.title,
      start: { dateTime: meeting.startIso, timeZone: 'UTC' },
      end: { dateTime: addMinutes(meeting.startIso, meeting.durationMinutes), timeZone: 'UTC' },
      attendees: [{ email: toEmail(meeting.attendee) }],
      ...(meeting.location !== null ? { location: meeting.location } : {}),
    };

    this.events.set(event.id, event);
    this.byKey.set(idempotencyKey, event.id);

    return { ok: true, event, duplicate: false };
  }

  listEvents(): CalendarEvent[] {
    return [...this.events.values()];
  }

  findConflicts(meeting: MeetingRequest): CalendarEvent[] {
    const start = new Date(meeting.startIso).getTime();
    const end = start + meeting.durationMinutes * 60_000;

    return this.listEvents().filter((event) => {
      const otherStart = new Date(event.start.dateTime).getTime();
      const otherEnd = new Date(event.end.dateTime).getTime();
      return start < otherEnd && otherStart < end;
    });
  }

  /** A tiny policy: an actor may book for themselves, or for anyone in the directory. */
  private canWrite(actor: string, meeting: MeetingRequest): boolean {
    if (matchesPerson(actor, meeting.attendee)) return true;
    return config.directory.some((entry) => matchesPerson(meeting.attendee, entry));
  }
}

/**
 * The idempotency key — Chapter 06 §6.11 and Chapter 08 §8.5.
 *
 * Note what goes into it: **semantics**, not a random UUID and not the raw sentence.
 * Two different phrasings of the same request produce the same key (so the second is a
 * no-op), while a genuinely different meeting produces a different one.
 *
 * A random key would make every retry a duplicate event. That is the single most common
 * bug in this area of the lecture.
 */
export function idempotencyKeyFor(meeting: MeetingRequest, actor: string): string {
  return shortHash(
    [
      actor.toLowerCase(),
      meeting.attendee.trim().toLowerCase(),
      meeting.startIso,
      String(meeting.durationMinutes),
      meeting.title.trim().toLowerCase(),
    ].join('|'),
  );
}

/** `Aditya` → `aditya@northwind.test`. The vendor wants an email; we have a name. */
function toEmail(attendee: string): string {
  if (attendee.includes('@')) return attendee.toLowerCase();
  const local = attendee.trim().toLowerCase().replace(/[^a-z]+/g, '.');
  return `${local}@northwind.test`;
}

/** `2026-10-02T16:00` + 45 minutes → `2026-10-02T16:45`, without a timezone shift. */
function addMinutes(isoLocal: string, minutes: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(isoLocal);
  if (!match) return isoLocal;

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]) + minutes,
  );

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
