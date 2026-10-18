# Chapter 02: Environment Configuration & Boot-Time Validation

> **Chapter Goal:** Turn ambient environment variables into a typed, validated configuration object. Fail immediately on impossible values, and detect whether a real OpenAI key is present so the service can fall back to deterministic mock mode.

> **Files covered:**

| File | Lines | Purpose |
| :--- | :--- | :--- |
| `src/config/env.ts` | 28 | Load `.env`, validate with Zod, export typed config and a live-key check |

---

## 1. Complete Source Code

### 📄 `src/config/env.ts` (28 lines)

```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3008),
  OPENAI_API_KEY: z.string().default('mock-key-for-development'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  DEFAULT_TOP_N: z.coerce.number().int().min(1).max(20).default(5),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export const isLiveOpenAIEnabled = (): boolean =>
  Boolean(
    env.OPENAI_API_KEY &&
    env.OPENAI_API_KEY !== 'your_openai_api_key_here' &&
    env.OPENAI_API_KEY !== 'mock-key-for-development'
  );
```

---

## 2. Block-by-Block Explanation

### Block 1: Loading `.env`

```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();
```

`dotenv.config()` reads `.env` from the current working directory and copies each key into `process.env`. If the file does not exist, it is a no-op — the defaults in the schema then apply.

This call must happen **before** the schema parses `process.env`. Because ES module imports are evaluated before the module body, keeping `dotenv.config()` in the same file as the schema guarantees the ordering.

### Block 2: Declaring the schema

```typescript
const EnvSchema = z.object({
  PORT: z.coerce.number().default(3008),
  OPENAI_API_KEY: z.string().default('mock-key-for-development'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  DEFAULT_TOP_N: z.coerce.number().int().min(1).max(20).default(5),
});
```

Every environment variable arrives as a **string or `undefined`**. The schema normalises them:

| Variable | Rule | Why |
| :--- | :--- | :--- |
| `PORT` | `z.coerce.number()` | Converts `"3008"` to `3008`; a non-numeric string becomes `NaN` and fails |
| `OPENAI_API_KEY` | `z.string()` with a sentinel default | The sentinel makes “no key” explicit and detectable |
| `EMBEDDING_MODEL` | `z.string()` | Kept open so the model can be changed without a code edit |
| `DEFAULT_TOP_N` | integer, 1–20 | Prevents `0`, negative, fractional, or absurd result counts |

> **Why `z.coerce.number()` instead of `parseInt`?** Zod performs the conversion *and* the validation in one step, and its error message tells you exactly which variable failed.

---

### Block 3: Parsing safely

```typescript
const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
```

`safeParse` returns a discriminated union rather than throwing:

- On success: `{ success: true, data: {...} }`
- On failure: `{ success: false, error: ZodError }`

If parsing fails, the process prints a structured error and exits with code `1`. This is **fail-fast**: a misconfigured server never starts and never serves a single request with a bad port or invalid default.

After the guard, TypeScript narrows `parsed` to the success branch, so `parsed.data` is fully typed. `env` is therefore a plain object with `PORT: number`, not `string | undefined`.

### Block 4: Detecting a usable key

```typescript
export const isLiveOpenAIEnabled = (): boolean =>
  Boolean(
    env.OPENAI_API_KEY &&
    env.OPENAI_API_KEY !== 'your_openai_api_key_here' &&
    env.OPENAI_API_KEY !== 'mock-key-for-development'
  );
```

The service is considered live only when the key is non-empty **and** is neither of the two placeholder values:

- `'your_openai_api_key_here'` comes from `.env.example`.
- `'mock-key-for-development'` is the schema default when no `.env` exists at all.

This function is a **function**, not a constant, so it always reads the current `env` object. That makes it easy to reason about in tests and avoids a stale boolean captured at import time.

The `Boolean(...)` wrapper converts the final expression to a strict `true`/`false` rather than returning the key string.

---

## 3. Why This Design Matters

| Without validation | With this module |
| :--- | :--- |
| `PORT="abc"` starts a server that cannot bind | Process exits immediately with a clear error |
| `DEFAULT_TOP_N=0` returns empty results forever | Validation rejects it at boot |
| A placeholder key causes a 401 on every request | The service switches to mock mode and still runs |
| Config shape is `string \| undefined` everywhere | Consumers see `number` / `string` with no casts |

The rest of the codebase imports `env` and never touches `process.env` directly. There is exactly **one** place where configuration is read and validated.

---

## 4. Verification

### Build-time check

```bash
npm run build
```

Expected: no errors. `env.ts` compiles under `strict`.

### Invalid configuration

```bash
PORT=not-a-number npx tsx src/server.ts
```

Expected:

```text
❌ Environment configuration validation failed:
{
  "PORT": { "_errors": ["Expected number, received nan"] }
}
```

The process exits before the catalog is built or the port is bound.

### Mock mode (no key)

```bash
npx tsx src/server.ts
```

Expected banner line:

```text
🔑 OpenAI Live:     MOCK MODE ⚠️  (set OPENAI_API_KEY for real embeddings)
```

### Live mode (real key)

```bash
OPENAI_API_KEY=sk-... npx tsx src/server.ts
```

Expected banner line:

```text
🔑 OpenAI Live:     ENABLED ✅
```

> **Security note:** never commit `.env`; only `.env.example` belongs in Git.

---

**Next:** [Chapter 03 — Domain Types & Movie Catalog](./03_Domain_Types_and_Movie_Catalog.md)
