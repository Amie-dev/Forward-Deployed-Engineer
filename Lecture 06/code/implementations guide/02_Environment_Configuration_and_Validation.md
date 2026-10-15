# Chapter 02: Environment Configuration & Boot-Time Validation

> **Chapter Goal:** Fail fast on bad configuration, and turn every streaming behaviour (granularity, flush window, heartbeat, three timeouts, backpressure ceiling, concurrency caps) into a validated, documented knob.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/config/env.ts` | 77 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/config/env.ts` (76 lines)

```typescript
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
```


---

## 3. Block-by-Block Explanation

### Part A: Boot-time validation

#### Block 1: Loading and the boolean trap

```typescript
dotenv.config();

const BooleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  );
```

- **What it does:** loads `.env` and defines a *correct* boolean coercion for environment variables.
- **How it works:** environment variables are always strings, and `z.coerce.boolean()` would parse the string `"false"` as `true` (non-empty strings are truthy). The explicit allow-list is the standard fix; it is commented in the source because it is the kind of bug that ships silently and disables an entire feature flag.

#### Block 2: The schema — every streaming knob, validated

```typescript
NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
PORT: z.coerce.number().int().min(1).max(65535).default(8090),
STREAM_GRANULARITY: z.enum(['token', 'word', 'sentence', 'random']).default('sentence'),
STREAM_FLUSH_MS: z.coerce.number().int().min(0).default(40),
STREAM_MAX_CHUNK_CHARS: z.coerce.number().int().min(1).default(180),
```

- **What it does:** declares the complete configuration surface with types, bounds and defaults, grouped by concern.
- **How it works:** `z.coerce.number()` converts the string from `.env`; `.int().min().max()` rejects nonsense like a negative flush window; `.default()` means the service runs with an empty environment. `STREAM_GRANULARITY` is an enum because an unknown value must fail at boot, not at the first request.

#### Block 3: Liveness, limits and observability knobs

```typescript
STREAM_HEARTBEAT_MS: z.coerce.number().int().min(0).default(10_000),
STREAM_TTFT_BUDGET_MS: z.coerce.number().int().min(100).default(20_000),
STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
STREAM_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
STREAM_MAX_CLIENT_QUEUE_BYTES: z.coerce.number().int().min(1_024).default(1_048_576),
MAX_CONCURRENT_STREAMS_PER_CONVERSATION: z.coerce.number().int().min(1).default(1),
MAX_CONCURRENT_STREAMS_GLOBAL: z.coerce.number().int().min(1).default(64),
HISTORY_MAX_TURNS: z.coerce.number().int().min(1).default(24),
HISTORY_TOKEN_BUDGET: z.coerce.number().int().min(256).default(6_000),
CONVERSATION_TTL_MS: z.coerce.number().int().min(1_000).default(3_600_000),
METRICS_ENABLED: BooleanFromString.default(true),
LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
TTFT_GAP_ALERT_MS: z.coerce.number().int().min(1).default(500),
```

- **What it does:** encodes the operational policy of the service as data rather than constants scattered through the code.
- **How it works:** the three timeouts are independent because they detect different failures; `MAX_CONCURRENT_STREAMS_PER_CONVERSATION: 1` is what makes a conversation serial by default; `HISTORY_TOKEN_BUDGET` is enforced *before* dispatch so an oversized prompt fails fast with `413` instead of surfacing as a provider error; `TTFT_GAP_ALERT_MS` is read by the metrics registry's alert rule.

#### Block 4: Fail fast, then export

```typescript
const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type AppEnv = typeof env;
```

- **What it does:** validates once, at import time, and terminates the process on invalid configuration.
- **How it works:** every module that imports `env` gets a fully typed, already-validated object — no defensive `process.env.X ?? fallback` checks anywhere else in the codebase. `process.exit(1)` before the server binds a port is the correct fail-fast behaviour: a misconfigured streaming service that starts anyway will fail in a much more expensive place (mid-stream, in production).

#### Block 5: Live-provider detection

```typescript
export const isLiveProviderConfigured = (): boolean => {
  const key = env.OPENAI_API_KEY;
  return key.startsWith('sk-') && key.length > 20 && key !== 'your_openai_api_key_here';
};
```

- **What it does:** decides whether the service uses the real provider or the deterministic simulator.
- **How it works:** a *shape* check (prefix + length) rather than an API call, so it is free and safe to call at boot and on every health check. The sentinel from `.env.example` is rejected explicitly, which means `cp .env.example .env` always produces a runnable, offline, zero-cost service.

> **Design note:** this single predicate is what makes the whole test suite possible. Every script in `src/scripts/` runs against the simulator, so CI never depends on a paid provider — while the exact same pipeline code runs in production against OpenAI.

---

### ✅ Chapter 02 verification

```bash
npm run build
# Invalid values are rejected at boot:
STREAM_FLUSH_MS=-5 npx tsx src/server.ts   # exits 1 with a formatted Zod error
STREAM_GRANULARITY=words npx tsx src/server.ts  # exits 1: not a valid enum member
curl -s localhost:8090/health              # provider: "simulator" without a key
```


---

**Previous:**  · **Next:** 
