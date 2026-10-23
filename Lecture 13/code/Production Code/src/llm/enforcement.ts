/**
 * The enforcement ladder — Chapters 03 and 05.
 *
 * This file answers one question: *for this call, what is actually guaranteed?*
 *
 * The answer is a four-row table, and the table is the most useful thing in the
 * lecture. Everything else in this codebase either raises a rung or compensates for
 * the rung it is on.
 *
 * There is a second, quieter job here too: the **prompt changes with the level.** A
 * call at `instruction` has to describe the shape in prose, because prose is all it
 * has. A call at `schema` describes only the *task*, because the shape travels as a
 * wire parameter and duplicating it in prose wastes tokens and invites conflict.
 */

import { config } from '../config/env.js';
import { meetingJsonSchema } from '../schema/meeting.js';
import type { EnforcementGuarantee, EnforcementLevel } from '../types.js';
import { OpenAiModel, SimulatedModel, type ChatCompletionsClient, type Model } from './model.js';

/* ─────────────────────────────────────────────────────────────
 * What each rung actually promises
 * ───────────────────────────────────────────────────────────── */

/**
 * The table from Chapter 03 §3.5, as data.
 *
 * `shape` is deliberately three-valued rather than two-valued. `json_mode` is not
 * "no shape guarantee" — a model asked for JSON and given the schema in prose usually
 * gets the shape right. "Usually" is the problem, and that is what `likely` means.
 */
export const ENFORCEMENT_TABLE: readonly EnforcementGuarantee[] = [
  {
    level: 'instruction',
    syntax: 'none',
    shape: 'none',
    values: 'none',
    wire: 'no response_format — the prompt asks for JSON',
    removes: 'nothing; it only shifts the probability of the next token',
  },
  {
    level: 'json_mode',
    syntax: 'guaranteed',
    shape: 'likely',
    values: 'none',
    wire: 'response_format: { type: "json_object" }',
    removes: 'chatty preambles, markdown fences, trailing commas, unbalanced braces',
  },
  {
    level: 'schema',
    syntax: 'guaranteed',
    shape: 'guaranteed',
    values: 'none',
    wire: 'response_format: { type: "json_schema", strict: true }',
    removes: 'missing fields, wrong types, enum drift, unexpected keys',
  },
  {
    level: 'validate',
    syntax: 'guaranteed',
    shape: 'guaranteed',
    values: 'validated',
    wire: 'schema + runtime validation and a bounded repair loop',
    removes: 'everything above, plus "a well-shaped object that is still wrong"',
  },
] as const;

export function guaranteeFor(level: EnforcementLevel): EnforcementGuarantee {
  const found = ENFORCEMENT_TABLE.find((entry) => entry.level === level);
  if (!found) throw new Error(`Unknown enforcement level: ${level}`);
  return found;
}

/** True when the level's provider call can carry the schema over the wire. */
export function enforcesShapeOnTheWire(level: EnforcementLevel): boolean {
  return level === 'schema' || level === 'validate';
}

/* ─────────────────────────────────────────────────────────────
 * The prompt, which depends on the rung
 * ───────────────────────────────────────────────────────────── */

/** The task, the normalisation rules and the output contract. */
export function buildSystemPrompt(level: EnforcementLevel): string {
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`;

  const rules = [
    `Today's date is ${todayIso}.`,
    'Convert relative dates ("tomorrow", "next Tuesday") into YYYY-MM-DD and resolve them against today.',
    'Convert times ("4 PM") into a 24-hour HH:mm clock.',
    'Convert prose durations ("half an hour") into whole minutes.',
    'Never invent an attendee, a date or a time. If the request does not state a value, use null.',
    'Use null for location when no place is mentioned. Do not use an empty string.',
    'Return the rationale in `reasoning` before the other fields.',
  ];

  if (enforcesShapeOnTheWire(level)) {
    // The schema is a wire parameter, so the prompt carries the task only. Repeating
    // the shape here would duplicate tokens and, worse, create two sources of truth.
    return [
      'You extract a meeting request from one sentence.',
      '',
      'The response must satisfy the JSON schema supplied with this request.',
      '',
      'Rules:',
      ...rules.map((rule) => `- ${rule}`),
      '',
      'Do not add fields that are not in the schema. Do not explain your answer outside the object.',
    ].join('\n');
  }

  // Instruction-level: prose is all this rung has, so the shape has to be spelled out.
  // This is exactly the pattern the notes call "a preference over a token distribution",
  // and it is here so the CLI can show what it produces.
  return [
    'You extract a meeting request from one sentence.',
    '',
    'Rules:',
    ...rules.map((rule) => `- ${rule}`),
    '',
    'Return your answer as JSON in exactly this format:',
    '',
    JSON.stringify(
      {
        reasoning: '',
        title: '',
        attendee: '',
        startIso: '',
        durationMinutes: 0,
        type: 'ONE_ON_ONE | INTERVIEW | TEAM | OTHER',
        location: null,
        schemaVersion: config.schemaVersion,
      },
      null,
      2,
    ),
  ].join('\n');
}

/* ─────────────────────────────────────────────────────────────
 * The provider factory
 * ───────────────────────────────────────────────────────────── */

/**
 * Builds the model the pipeline will use.
 *
 * `simulate` is the default when no key is present, so every script in this project
 * runs on any machine. That is not a test double bolted on afterwards — it is the
 * reason the failure modes in the notes can be *demonstrated* rather than described.
 */
export async function createModel(override?: 'openai' | 'simulate'): Promise<Model> {
  const provider = override ?? config.provider;

  if (provider === 'openai') {
    if (!config.openaiApiKey) {
      throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.');
    }
    // Imported lazily so the offline path never pays for the SDK.
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: config.openaiApiKey }) as unknown as ChatCompletionsClient;
    return new OpenAiModel(client, config.model);
  }

  return new SimulatedModel();
}

/** The JSON Schema this project sends over the wire. */
export function wireSchema(): Record<string, unknown> {
  return meetingJsonSchema();
}
