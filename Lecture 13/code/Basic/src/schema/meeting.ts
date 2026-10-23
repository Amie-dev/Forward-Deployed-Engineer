/**
 * The contract, in the one place that owns it — Chapters 02 and 04.
 *
 * The notes make a claim that this file has to make true: *the schema is
 * application-owned; the model is a client of your contract, never its author.*
 *
 * So there is exactly **one** declaration here, and three things are derived from it:
 *
 *   Zod schema      → the runtime validator          (`parseCandidate`)
 *   JSON Schema     → the wire contract sent to the model (`meetingJsonSchema`)
 *   TypeScript type → the compile-time contract      (`MeetingRequest`)
 *
 * That is the "one source of truth" pattern from Chapter 02 §2.6, and it is the
 * reason a rename breaks the build instead of production.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { config } from '../config/env.js';
import { MEETING_TYPES, type MeetingRequest } from '../types.js';

/**
 * Every field carries a `description`, because Chapter 04 §4.2 calls it the
 * highest-value keyword in the whole vocabulary: the description is simultaneously
 * the API documentation and part of the prompt.
 */
export const meetingSchema = z
  .object({
    reasoning: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'One or two sentences explaining which words in the request produced these values. Under 40 words.',
      ),
    title: z
      .string()
      .min(1)
      .max(120)
      .describe('Short meeting title derived from the topic. Never a full sentence.'),
    attendee: z
      .string()
      .min(1)
      .describe('Full name or email of the other participant. Never invent a name.'),
    startIso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .describe(
        'Start as ISO 8601 local date-time, YYYY-MM-DDTHH:mm. Resolve "tomorrow" against today and convert "4 PM" to 16:00.',
      ),
    durationMinutes: z
      .number()
      .int()
      .min(1)
      .max(config.maxDurationMinutes)
      .describe('Duration in whole minutes. Convert "half an hour" to 30.'),
    type: z
      .enum(MEETING_TYPES)
      .describe('Meeting category. Use OTHER when nothing else fits; never invent a value.'),
    location: z
      .string()
      .min(1)
      .nullable()
      .describe('Room, link or address. Use null when the request does not mention a place.'),
    schemaVersion: z
      .literal(config.schemaVersion)
      .describe('Contract version. Must be exactly this value.'),
  })
  // `.strict()` is the code form of `additionalProperties: false`. Without it the
  // model may add "helpful" fields, which then travel into storage and break
  // equality checks downstream (Chapter 04 §4.5).
  .strict();

/**
 * The JSON Schema actually sent over the wire.
 *
 * Two transformations worth noticing, both from Chapter 04 §4.10:
 *  - `$refStrategy: 'none'` inlines every reference, because deeply nested `$defs`
 *    make the compiled grammar larger and slower to build;
 *  - the result is a *provider-neutral* schema. Provider-specific variants are
 *    generated from this one at call time, never hand-edited (Chapter 05 §5.3).
 */
export function meetingJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(meetingSchema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;

  return {
    ...schema,
    title: 'MeetingRequest',
    // Strict-mode subset: every property required, object closed. Optionality is
    // expressed as `nullable + required`, never as "the key may be absent".
    additionalProperties: false,
  };
}

/**
 * The strict-mode variant: same schema, but with the constraints that some decoders
 * cannot enforce stripped out.
 *
 * Chapter 04 §4.10 is blunt about this: a "strict" schema is not a semantically
 * strict schema. `pattern`, `format`, `minLength` and `minimum` may be accepted by
 * the API and then ignored by the grammar — so this function drops them and lets
 * the runtime validator remain the only guarantee for those predicates.
 */
export function meetingStrictJsonSchema(): Record<string, unknown> {
  const schema = meetingJsonSchema();
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const [name, definition] of Object.entries(properties)) {
    delete definition.pattern;
    delete definition.format;
    delete definition.minLength;
    delete definition.maxLength;
    delete definition.minimum;
    delete definition.maximum;
    // The one constraint we keep: a `const` is cheap for a grammar to enforce.
    if (name === 'schemaVersion') definition.enum = [config.schemaVersion];
  }

  return schema;
}

/** Validates a candidate against the contract. The single validation point. */
export function parseCandidate(
  candidate: unknown,
): { ok: true; value: MeetingRequest } | { ok: false; error: z.ZodError } {
  const result = meetingSchema.safeParse(candidate);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error };
}

/** Human-readable field list, used by the CLI to explain what the form contains. */
export const MEETING_FIELDS = [
  { name: 'reasoning', kind: 'string', required: true, note: 'rationale, generated first' },
  { name: 'title', kind: 'string', required: true, note: 'max 120 characters' },
  { name: 'attendee', kind: 'string', required: true, note: 'never invented' },
  { name: 'startIso', kind: 'string', required: true, note: 'ISO 8601 local, YYYY-MM-DDTHH:mm' },
  { name: 'durationMinutes', kind: 'integer', required: true, note: '1–480 minutes' },
  { name: 'type', kind: 'enum', required: true, note: MEETING_TYPES.join(' | ') },
  { name: 'location', kind: 'string | null', required: true, note: 'null when not mentioned' },
  { name: 'schemaVersion', kind: 'const', required: true, note: config.schemaVersion },
] as const;

/**
 * A known-good object, used by the CLI to *demonstrate* closure rather than assert it.
 *
 * The notes prefer a demonstration to a claim: instead of printing "the object is
 * closed", the CLI adds an extra key to this object and shows the validator rejecting it.
 */
export const SAMPLE_MEETING: MeetingRequest = {
  reasoning: 'Read attendee "Aditya" and start 2026-10-02T15:00 from the request.',
  title: 'Project Review',
  attendee: 'Aditya',
  startIso: '2026-10-02T15:00',
  durationMinutes: 45,
  type: 'TEAM',
  location: null,
  schemaVersion: config.schemaVersion,
};
