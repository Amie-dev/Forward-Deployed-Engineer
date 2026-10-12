# Chapter 02: Environment Configuration & Boot-Time Validation

> **Chapter Goal:** Establish a fail-fast environment configuration layer, enforce strongly-typed runtime validation using Zod, and provide automated detection between Live OpenAI Mode and Deterministic Offline Simulator Mode.

---

## 2.1 File Details & Purpose

| File | Target Path | Operational Purpose |
| :--- | :--- | :--- |
| **`.env.example`** | `Lecture 05/code/.env.example` | Template documenting all environment variables, default values, and operational ceilings. |
| **`src/config/env.ts`** | `Lecture 05/code/src/config/env.ts` | Loads `.env` via `dotenv`, validates types and boundaries using Zod, crashes immediately on invalid config (fail-fast), and exports the typed `env` singleton. |

### Terminal Commands
```bash
# Copy example environment template to local active configuration
cp .env.example .env
```

---

## 2.2 Full Code File: `.env.example`

```bash
# Server Port
PORT=8080

# OpenAI API Key (Required for live agent loops)
OPENAI_API_KEY=your_openai_api_key_here

# Target LLM Model (e.g., gpt-4o, gpt-4o-mini)
AI_MODEL=gpt-4o

# Sampling Temperature (0.1 - 0.3 recommended for reliable tool calling)
AI_TEMPERATURE=0.2

# Autonomous Agent Engine Bounds
AGENT_MAX_STEPS=12
AGENT_TIMEOUT_MS=60000

# Sandboxed Workspace Directory
WORKSPACE_DIR=generated-sites

# Financial Threshold for Human-in-the-Loop Approval (in Currency units, e.g. INR or USD)
HITL_FINANCIAL_THRESHOLD=5000
```

---

## 2.3 Full Code File: `src/config/env.ts`

```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  OPENAI_API_KEY: z.string().default('mock-key-for-development'),
  AI_MODEL: z.string().default('gpt-4o'),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(30).default(12),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60000),
  WORKSPACE_DIR: z.string().default('generated-sites'),
  HITL_FINANCIAL_THRESHOLD: z.coerce.number().default(5000)
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export const isLiveOpenAIEnabled = (): boolean => {
  return Boolean(
    env.OPENAI_API_KEY &&
    env.OPENAI_API_KEY !== 'your_openai_api_key_here' &&
    env.OPENAI_API_KEY !== 'mock-key-for-development'
  );
};
```

---

## 2.4 Block-by-Block Explanation: `src/config/env.ts`

### Block 1: Imports and Dotenv Hydration
```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();
```
- **What this does:** Reads the `.env` file from the current working directory and loads key-value pairs into the global `process.env` dictionary.
- **How it works:** Executes synchronously before any module attempts to access environment properties.

### Block 2: Zod Schema Declaration & Type Coercion
```typescript
const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  OPENAI_API_KEY: z.string().default('mock-key-for-development'),
  AI_MODEL: z.string().default('gpt-4o'),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(30).default(12),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60000),
  WORKSPACE_DIR: z.string().default('generated-sites'),
  HITL_FINANCIAL_THRESHOLD: z.coerce.number().default(5000)
});
```
- **What this does:** Defines runtime contracts, boundaries, and default fallbacks.
- **How it works:**
  - `z.coerce.number()`: Automatically converts incoming environment strings (e.g., `"8080"`) into real JavaScript numbers.
  - `AGENT_MAX_STEPS`: Constrained between 1 and 30 turns. Prevents developers from accidentally configuring unbounded loops.
  - `AGENT_TIMEOUT_MS`: Minimum 5,000ms. Enforces deterministic request timeouts.
  - `HITL_FINANCIAL_THRESHOLD`: Sets the monetary threshold above which actions are blocked by approval gates.

### Block 3: Fail-Fast Process Validation
```typescript
const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
```
- **What this does:** Enforces a **Fail-Fast** startup invariant.
- **How it works:** If any environment variable is malformed (e.g. `AI_TEMPERATURE=99`), the server prints a formatted error report and halts execution (`process.exit(1)`). This prevents silent runtime bugs during high-throughput operation.

### Block 4: Live Mode vs. Offline Simulation Detection
```typescript
export const isLiveOpenAIEnabled = (): boolean => {
  return Boolean(
    env.OPENAI_API_KEY &&
    env.OPENAI_API_KEY !== 'your_openai_api_key_here' &&
    env.OPENAI_API_KEY !== 'mock-key-for-development'
  );
};
```
- **What this does:** Detects whether a legitimate OpenAI API key is active.
- **How it works:** If the API key is missing or set to placeholder values, the engine automatically switches to the deterministic offline simulator. This ensures that CI/CD pipelines, unit tests, and local demonstrations run flawlessly without network dependencies or paid API quotas.
