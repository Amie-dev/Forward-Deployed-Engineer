import path from 'node:path';

import 'dotenv/config';
import { z } from 'zod';

/**
 * Boot-time configuration, validated once and then passed down as a plain value.
 *
 * Two rules from the notes show up here as code:
 *
 *  1. **`auto` keeps every script runnable with no account** (Chapter 05). If there
 *     is no `OPENAI_API_KEY`, the provider falls back to the offline simulator, so
 *     the failure modes the notes describe are reproducible on any machine.
 *  2. **Config is a value, not a global.** The evaluation harness re-runs the same
 *     pipeline under different settings in one process (Chapter 09), so providers
 *     must never read a module-level singleton at import time.
 */

export type LlmProvider = 'auto' | 'openai' | 'simulate';

export interface AppConfig {
  /** `auto` resolves to `openai` when a key exists, otherwise `simulate`. */
  provider: 'openai' | 'simulate';
  model: string;
  openaiApiKey?: string;

  /** Which rung of the enforcement ladder the extraction call uses. */
  enforcement: import('../types.js').EnforcementLevel;
  /** Sent to the model as a `const` so stored objects declare their contract. */
  schemaVersion: string;
  /** Close every object and require every field — the strict-mode subset (Ch. 04). */
  strictSchema: boolean;

  /** Bounded repair. Chapter 06 is explicit that 1–2 attempts is usually enough. */
  maxRepairs: number;
  temperature: number;
  repairTemperature: number;
  /** When repair is exhausted, fill unknowns with `null` instead of failing. */
  allowDegradedFallback: boolean;

  maxDurationMinutes: number;
  maxDurationReviewMinutes: number;
  requireFutureStart: boolean;

  /** Above this duration a human must confirm before the event is created. */
  autoApproveMaxDuration: number;
  actorId: string;
  directory: string[];

  evalMinFirstPass: number;
}

const optionalKey = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const schema = z
  .object({
    LLM_PROVIDER: z.enum(['auto', 'openai', 'simulate']).default('auto'),
    OPENAI_API_KEY: optionalKey,
    CHAT_MODEL: z.string().trim().default('gpt-4o-mini'),

    ENFORCEMENT: z.enum(['instruction', 'json_mode', 'schema', 'validate']).default('validate'),
    SCHEMA_VERSION: z.string().trim().default('meeting.v2'),
    STRICT_SCHEMA: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
    TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    REPAIR_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
    ALLOW_DEGRADED_FALLBACK: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    MAX_DURATION_MINUTES: z.coerce.number().int().min(1).max(1440).default(480),
    MAX_DURATION_REVIEW_MINUTES: z.coerce.number().int().min(1).max(1440).default(240),
    REQUIRE_FUTURE_START: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    AUTO_APPROVE_MAX_DURATION: z.coerce.number().int().min(0).max(1440).default(120),
    ACTOR_ID: z.string().trim().default('aditya@northwind.test'),
    DIRECTORY: z.string().default('aditya@northwind.test,ravi@northwind.test,priya@northwind.test'),

    EVAL_MIN_FIRST_PASS: z.coerce.number().min(0).max(1).default(0.8),

    PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  })
  .superRefine((value, context) => {
    // Cross-field rules belong in one place, next to the fields they relate to.
    if (value.MAX_DURATION_REVIEW_MINUTES > value.MAX_DURATION_MINUTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAX_DURATION_REVIEW_MINUTES'],
        message: 'MAX_DURATION_REVIEW_MINUTES cannot exceed MAX_DURATION_MINUTES.',
      });
    }
    if (value.LLM_PROVIDER === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai.',
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] Invalid configuration:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  throw new Error('Environment validation failed. Copy .env.example to .env and fill it in.');
}

const raw = parsed.data;

/** "auto" means: use the real provider when a key exists, otherwise stay offline. */
const provider: 'openai' | 'simulate' =
  raw.LLM_PROVIDER === 'auto' ? (raw.OPENAI_API_KEY ? 'openai' : 'simulate') : raw.LLM_PROVIDER;

export const config: AppConfig = {
  provider,
  model: raw.CHAT_MODEL,
  openaiApiKey: raw.OPENAI_API_KEY,

  enforcement: raw.ENFORCEMENT,
  schemaVersion: raw.SCHEMA_VERSION,
  strictSchema: raw.STRICT_SCHEMA,

  maxRepairs: raw.MAX_REPAIRS,
  temperature: raw.TEMPERATURE,
  repairTemperature: raw.REPAIR_TEMPERATURE,
  allowDegradedFallback: raw.ALLOW_DEGRADED_FALLBACK,

  maxDurationMinutes: raw.MAX_DURATION_MINUTES,
  maxDurationReviewMinutes: raw.MAX_DURATION_REVIEW_MINUTES,
  requireFutureStart: raw.REQUIRE_FUTURE_START,

  autoApproveMaxDuration: raw.AUTO_APPROVE_MAX_DURATION,
  actorId: raw.ACTOR_ID,
  directory: raw.DIRECTORY.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),

  evalMinFirstPass: raw.EVAL_MIN_FIRST_PASS,
};

/** The clock the whole demo reasons about. Pinned so runs are reproducible. */
export const paths = {
  root: path.resolve(import.meta.dirname, '../..'),
} as const;

export const serverConfig = { port: raw.PORT } as const;
