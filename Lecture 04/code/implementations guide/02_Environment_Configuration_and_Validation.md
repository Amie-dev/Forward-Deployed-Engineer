# Chapter 02: Environment Configuration & Runtime Zod Validation

> **Chapter Goal:** Implement a fail-fast runtime environment validation engine using Zod and dotenv, ensuring the microservice halts immediately upon startup if required configuration parameters or valid credentials are absent.

---

## 2.1 File Location & Directory Setup

```bash
mkdir -p "src/config"
touch "src/config/env.ts"
```

Target File: `src/config/env.ts`

---

## 2.2 Complete Source Code: `src/config/env.ts`

```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

/**
 * Zod validation schema for boot-time environment variables.
 * Enforces fail-fast principles if critical infrastructure configuration is missing.
 */
const envSchema = z.object({
  PORT: z
    .string()
    .default('8080')
    .transform((val) => parseInt(val, 10))
    .refine((port) => port > 0 && port < 65536, {
      message: 'PORT must be a valid port number (1-65535)',
    }),

  OPENAI_API_KEY: z
    .string()
    .min(1, 'OPENAI_API_KEY must not be empty')
    .default('your_openai_api_key_here'),

  AI_MODEL: z.string().default('gpt-4o-mini'),

  AI_TEMPERATURE: z
    .string()
    .default('0.3')
    .transform((val) => parseFloat(val))
    .refine((temp) => temp >= 0.0 && temp <= 2.0, {
      message: 'AI_TEMPERATURE must be between 0.0 (deterministic) and 2.0 (creative)',
    }),

  MAX_CONTEXT_TOKENS: z
    .string()
    .default('3000')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val >= 500, {
      message: 'MAX_CONTEXT_TOKENS must be at least 500',
    }),

  SUMMARIZATION_THRESHOLD_TURNS: z
    .string()
    .default('6')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val >= 2, {
      message: 'SUMMARIZATION_THRESHOLD_TURNS must be at least 2 turns',
    }),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Critical Error: Invalid environment configuration:');
  console.error(parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;
```

---

## 2.3 Block-by-Block Technical Explanation

### Block 1: Environment Ingestion & Dotenv Setup
```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();
```
- **What it does:** Imports the dotenv library and executes `dotenv.config()`.
- **How it works:** Reads the local `.env` file from the working directory and injects its key-value pairs into the global `process.env` object.

### Block 2: Defining the Strongly-Typed Zod Schema
```typescript
const envSchema = z.object({
  PORT: z
    .string()
    .default('8080')
    .transform((val) => parseInt(val, 10))
    .refine((port) => port > 0 && port < 65536, {
      message: 'PORT must be a valid port number (1-65535)',
    }),
  // ...
```
- **What it does:** Declares the validation and transformation pipeline for each environment variable.
- **How it works:**
  - `PORT`: Coerces raw string environment variables into valid 16-bit integer port numbers ($1 \le \text{port} \le 65535$).
  - `OPENAI_API_KEY`: Ensures a non-empty string is provided. Defaults to a placeholder so offline simulation mode can proceed safely without throwing unhandled exceptions.
  - `AI_MODEL`: Defaults to `'gpt-4o-mini'` for optimal balance of reasoning capability, latency, and token economics.
  - `AI_TEMPERATURE`: Transforms string input to float and enforces the mathematical bounds $[0.0, 2.0]$. Values near $0.0$ yield deterministic, repeatable responses for customer support.
  - `MAX_CONTEXT_TOKENS`: Establishes the upper bound for the sliding window token budget (minimum 500 tokens).
  - `SUMMARIZATION_THRESHOLD_TURNS`: Establishes the threshold (default: $6$ complete conversational turns) at which older dialogue is automatically compacted into a background summary.

### Block 3: Fail-Fast Boot Enforcement
```typescript
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Critical Error: Invalid environment configuration:');
  console.error(parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;
```
- **What it does:** Executes `safeParse()` against `process.env`. If any variable fails validation, it prints a formatted error report and immediately kills the process (`process.exit(1)`).
- **Why this matters for FDEs:** In distributed cloud environments (Kubernetes, AWS ECS), silent configuration bugs (like an invalid port or temperature of 25.0) can cause container restart loops or erratic AI behavior. Failing fast during container boot prevents broken pods from entering traffic load balancers.
