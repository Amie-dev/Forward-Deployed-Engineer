/**
 * The model boundary — Chapter 05's provider ladder, made concrete.
 *
 * There are two implementations behind one interface:
 *
 *   `SimulatedModel`  offline, deterministic, no API key. It is **not** a language
 *                     model: it reads the sentence with `llm/rules.ts` and then wraps
 *                     the result in the *envelope* the chosen enforcement level
 *                     promises. That is exactly what makes it useful — it reproduces
 *                     the documented failure modes of each rung on any machine.
 *
 *   `OpenAiModel`     the real thing. Same interface, same schema, different wire.
 *
 * The important property is that **the pipeline cannot tell them apart.** Every
 * chapter of the notes is testable offline, and switching to a real provider changes
 * one line of configuration.
 */

import { config } from '../config/env.js';
import { extractBraceSpan, looksTruncated } from '../lib/json.js';
import { toIsoLocal } from '../lib/text.js';
import { meetingStrictJsonSchema } from '../schema/meeting.js';
import type { EnforcementLevel, MeetingRequest } from '../types.js';
import { readDraft, type Draft } from './rules.js';

/* ─────────────────────────────────────────────────────────────
 * The interface
 * ───────────────────────────────────────────────────────────── */

export interface ModelCall {
  /** The task and its rules. The schema travels separately, as a wire parameter. */
  system: string;
  /** The user's text, or a repair instruction (Chapter 06 §6.8). */
  user: string;
  enforcement: EnforcementLevel;
  /** The JSON Schema. Only used by levels that can actually enforce it. */
  jsonSchema: Record<string, unknown>;
  temperature: number;
}

export interface ModelResponse {
  /** Exactly what came back as text. Never trusted, always logged on failure. */
  raw: string;
  /** The model declined. A first-class outcome, not an exception (Chapter 06 §6.10). */
  refused: boolean;
  /** The response was cut off by the token budget. */
  truncated: boolean;
  /** Provider-reported finish reason, when there is one. */
  finishReason: string;
  model: string;
  provider: string;
}

export interface Model {
  readonly provider: string;
  readonly model: string;
  complete(call: ModelCall): Promise<ModelResponse>;
}

/* ─────────────────────────────────────────────────────────────
 * The offline simulator
 * ───────────────────────────────────────────────────────────── */

/**
 * Wraps a deterministic reading of the sentence in the envelope the enforcement
 * level promises.
 *
 * Read the `switch` below as a table from the notes:
 *
 *   instruction → "Sure! Here's the JSON you requested:" + a fenced block
 *                 ⇒ `JSON.parse` throws, and the failure is the *preamble*.
 *   json_mode   → a valid JSON object with plausible drift: a numeric field as a
 *                 string, an enum value in the wrong casing, a missing nullable key,
 *                 an extra key the model found helpful.
 *                 ⇒ parses fine, fails validation. This is the whole point of §3.9.
 *   schema      → a schema-valid object, by construction. Nothing to fix.
 *   validate    → identical output; the *pipeline* is what changes, not the model.
 */
export class SimulatedModel implements Model {
  readonly provider = 'simulate';
  readonly model = 'simulated-extractor-v1';

  /** Latency is simulated so the CLI's p50/p95 columns are not all zeros. */
  constructor(private readonly latencyMs = 4) {}

  async complete(call: ModelCall): Promise<ModelResponse> {
    await sleep(this.latencyMs);

    // A repair call is a *different* instruction from an extraction call, and a model
    // behaves differently for it. Chapter 06 §6.8: the strong repair prompt asks for a
    // targeted edit and "the object only", so a model that follows it returns clean JSON
    // — which is exactly why repair can rescue a weak enforcement rung.
    if (isRepairPrompt(call.user)) {
      return this.repair(call);
    }

    const draft = readDraft(call.user);

    // A refusal is an answer, not a bug. Note it happens regardless of enforcement
    // level: no schema can make a model willing.
    if (draft.outOfScope || draft.injected) {
      return {
        raw: "I can't help with that. I only schedule meetings from a request that names a person and a time.",
        refused: true,
        truncated: false,
        finishReason: 'stop',
        model: this.model,
        provider: this.provider,
      };
    }

    const object = this.buildObject(draft);

    switch (call.enforcement) {
      case 'instruction': {
        // The canonical failure from the lecture, verbatim in shape.
        const body = JSON.stringify(this.driftObject(object, 'instruction'), null, 2);
        return this.respond(`Sure! Here's the JSON you requested:\n\n\`\`\`json\n${body}\n\`\`\``);
      }
      case 'json_mode':
        return this.respond(JSON.stringify(this.driftObject(object, 'json_mode')));
      case 'schema':
      case 'validate':
        return this.respond(JSON.stringify(this.exactObject(object)));
    }
  }

  /** The values a model would have extracted, before any envelope is applied. */
  private buildObject(draft: Draft): MeetingRequest {
    return {
      reasoning: draft.reasoning,
      title: draft.title ?? 'Meeting',
      // A missing attendee becomes an empty string, not a null: this is the
      // "required field with a sentinel" mistake Chapter 04 §4.3 warns about, and it
      // is what the semantic layer has to catch.
      attendee: draft.attendee ?? '',
      startIso:
        draft.date && draft.time ? toIsoLocal(draft.date, draft.time.hours, draft.time.minutes) : '',
      durationMinutes: draft.durationMinutes ?? 30,
      type: draft.type,
      location: draft.location,
      schemaVersion: config.schemaVersion,
    };
  }

  /**
   * The drifts that survive syntax-only enforcement. Each one is a real class from
   * the notes' failure taxonomy (Chapter 01 §1.7).
   */
  private driftObject(
    object: MeetingRequest,
    level: 'instruction' | 'json_mode',
  ): Record<string, unknown> {
    const drifted: Record<string, unknown> = {
      // drift 1 — a number as a string ("30" instead of 30)
      durationMinutes: String(object.durationMinutes),
      // drift 2 — enum casing ("team" instead of TEAM)
      type: object.type.toLowerCase().replace(/_/g, '-'),
      // drift 3 — the model "improves" a field name and keeps both
      durationInMinutes: object.durationMinutes,
      title: object.title,
      attendee: object.attendee,
      startIso: object.startIso,
      reasoning: object.reasoning,
      schemaVersion: object.schemaVersion,
    };

    // drift 4 — a nullable key is simply omitted, because "null" felt redundant
    if (object.location !== null) drifted.location = object.location;

    if (level === 'instruction') {
      // drift 5 — an extra field nobody asked for
      drifted.confidence = 0.87;
    }

    return drifted;
  }

  /** Exactly the contract: every key present, every type right. */
  private exactObject(object: MeetingRequest): MeetingRequest {
    return { ...object };
  }

  private respond(raw: string): ModelResponse {
    return {
      raw,
      refused: false,
      truncated: looksTruncated(raw),
      finishReason: 'stop',
      model: this.model,
      provider: this.provider,
    };
  }

  /**
   * A repair: the targeted edit the strong repair prompt asks for.
   *
   * The asymmetry here is the whole lesson of Chapter 06 §6.13, expressed as code:
   *
   *   **Fixed** — mechanical errors. A string that should be a number, an enum value in
   *   the wrong casing, an extra key, a missing nullable key. All of these are edits the
   *   model can make without knowing anything new about the world.
   *
   *   **Not fixed** — anything requiring a fact. A missing attendee, a missing date, or
   *   an out-of-range duration. Inventing a value would produce a schema-valid object
   *   that schedules a meeting with the wrong person at the wrong time. Leaving it broken
   *   is the correct behaviour, and it is why the `degraded` rung exists separately.
   */
  private repair(call: ModelCall): ModelResponse {
    const previous = extractBraceSpan(call.user);
    if (previous === null) {
      // Nothing to edit. Return the same empty shape so the loop terminates.
      return this.respond('');
    }

    let loose: Record<string, unknown>;
    try {
      loose = JSON.parse(previous) as Record<string, unknown>;
    } catch {
      return this.respond(previous);
    }

    const fixed: Record<string, unknown> = {};

    // 1 · Drop keys that are not in the schema. Safe: the instruction said not to add any.
    for (const key of Object.keys(loose)) {
      if (SCHEMA_KEYS.has(key)) fixed[key] = loose[key];
    }

    // 2 · Coerce a numeric field that arrived as a string. Safe: it is a pure re-typing.
    if (typeof fixed.durationMinutes === 'string') {
      const parsed = Number(fixed.durationMinutes);
      if (Number.isFinite(parsed)) fixed.durationMinutes = Math.trunc(parsed);
    }

    // 3 · Normalise the enum casing. Safe: the schema lists the allowed values, so
    //     `"team"` → `TEAM` is a lookup, not a guess. Anything unmatched falls back to
    //     the documented escape hatch rather than an invented member.
    if (typeof fixed.type === 'string') {
      const normalised = fixed.type.trim().toUpperCase().replace(/[\s-]+/g, '_');
      fixed.type = isMeetingType(normalised) ? normalised : 'OTHER';
    }

    // 4 · A missing nullable key becomes `null`. Safe: `null` is a stated valid value.
    if (!('location' in fixed)) fixed.location = null;

    // 5 · Everything else is carried over untouched — including anything still wrong.
    if (typeof fixed.schemaVersion !== 'string') fixed.schemaVersion = config.schemaVersion;
    if (typeof fixed.reasoning !== 'string' || fixed.reasoning.length === 0) {
      fixed.reasoning = 'Repaired: mechanical field errors corrected; values preserved.';
    }

    // The repair instruction said "return the corrected object only", so there is no
    // preamble and no fence — regardless of which rung the original call was on.
    return this.respond(JSON.stringify(fixed));
  }
}

/** The exact key set the schema declares. Used to strip extras on repair. */
const SCHEMA_KEYS = new Set([
  'reasoning',
  'title',
  'attendee',
  'startIso',
  'durationMinutes',
  'type',
  'location',
  'schemaVersion',
]);

/** A repair prompt is recognisable by its first line, which is a contract of its own. */
function isRepairPrompt(user: string): boolean {
  return user.includes('Your previous answer') && user.includes('Validation errors:');
}

function isMeetingType(value: string): value is MeetingRequest['type'] {
  return value === 'ONE_ON_ONE' || value === 'INTERVIEW' || value === 'TEAM' || value === 'OTHER';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ─────────────────────────────────────────────────────────────
 * The real provider
 * ───────────────────────────────────────────────────────────── */

/**
 * OpenAI, via the official SDK — the production-ready package, as the notes'
 * provider table describes it.
 *
 * The three rungs map onto three request bodies, and the difference between them is
 * the entire point of Chapter 05:
 *
 *   instruction  no `response_format` at all
 *   json_mode    `{ type: 'json_object' }`                  → syntax only
 *   schema       `{ type: 'json_schema', strict: true }`    → shape, by construction
 *
 * The client is injected rather than constructed here, so the pipeline never reaches
 * for a global and a test can pass a stub.
 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(body: Record<string, unknown>): Promise<{
        choices?: Array<{
          message?: { content?: string | null; refusal?: string | null };
          finish_reason?: string;
        }>;
        model?: string;
      }>;
    };
  };
}

export class OpenAiModel implements Model {
  readonly provider = 'openai';

  constructor(
    private readonly client: ChatCompletionsClient,
    readonly model: string,
  ) {}

  async complete(call: ModelCall): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: call.temperature,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
    };

    if (call.enforcement === 'json_mode') {
      body.response_format = { type: 'json_object' };
    }

    if (call.enforcement === 'schema' || call.enforcement === 'validate') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'meeting_request',
          // The strict subset: every property required, object closed, and the
          // constraints a grammar cannot enforce stripped out (Chapter 04 §4.10).
          schema: meetingStrictJsonSchema(),
          strict: true,
        },
      };
    }

    const response = await this.client.chat.completions.create(body);
    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? '';
    const refusal = choice?.message?.refusal ?? null;

    return {
      raw: content,
      refused: Boolean(refusal),
      truncated: choice?.finish_reason === 'length',
      finishReason: choice?.finish_reason ?? 'unknown',
      model: response.model ?? this.model,
      provider: this.provider,
    };
  }
}
