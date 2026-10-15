import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from the local .env file (no-op if absent).
dotenv.config();

/**
 * IMPORTANT: `z.coerce.boolean()` would parse the *string* `"false"` as `true`,
 * because JavaScript strings are truthy. Streaming toggles are therefore coerced
 * explicitly from a known set of truthy literals.
 */
const BooleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  );

const EnvSchema = z.object({
  // --- Server ---------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),

  // --- AI provider ----------------------------------------------------------
  OPENAI_API_KEY: z.string().default('your_openai_api_key_here'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(32_000).default(1024),

  // --- Granularity / coalescing (token ≠ provider delta ≠ network chunk) ----
  STREAM_GRANULARITY: z.enum(['token', 'word', 'sentence', 'random']).default('sentence'),
  STREAM_FLUSH_MS: z.coerce.number().int().min(0).default(40),
  STREAM_MAX_CHUNK_CHARS: z.coerce.number().int().min(1).default(180),

  // --- Liveness (the "a stream must not die at 60 s" rules) -----------------
  STREAM_HEARTBEAT_MS: z.coerce.number().int().min(0).default(10_000),
  STREAM_REPLAY_BUFFER_FRAMES: z.coerce.number().int().min(0).default(512),
  STREAM_TTFT_BUDGET_MS: z.coerce.number().int().min(100).default(20_000),
  STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
  STREAM_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),

  // --- Backpressure & concurrency limits ------------------------------------
  STREAM_MAX_CLIENT_QUEUE_BYTES: z.coerce.number().int().min(1_024).default(1_048_576),
  MAX_CONCURRENT_STREAMS_PER_CONVERSATION: z.coerce.number().int().min(1).default(1),
  MAX_CONCURRENT_STREAMS_GLOBAL: z.coerce.number().int().min(1).default(64),

  // --- Conversation history (dual-write persistence) ------------------------
  HISTORY_MAX_TURNS: z.coerce.number().int().min(1).default(24),
  HISTORY_TOKEN_BUDGET: z.coerce.number().int().min(256).default(6_000),
  CONVERSATION_TTL_MS: z.coerce.number().int().min(1_000).default(3_600_000),

  // --- Observability --------------------------------------------------------
  METRICS_ENABLED: BooleanFromString.default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TTFT_GAP_ALERT_MS: z.coerce.number().int().min(1).default(500),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type AppEnv = typeof env;

/**
 * A live provider is only used when a plausible key is supplied.
 * Otherwise the deterministic streaming simulator drives the whole pipeline,
 * so every script, test and UI demo runs offline at zero cost.
 */
export const isLiveProviderConfigured = (): boolean => {
  const key = env.OPENAI_API_KEY;
  return key.startsWith('sk-') && key.length > 20 && key !== 'your_openai_api_key_here';
};
