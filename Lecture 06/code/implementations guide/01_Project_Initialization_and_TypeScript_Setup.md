# Chapter 01: Project Initialization, Dependencies & TypeScript Setup

> **Chapter Goal:** Create the project, understand every dependency and why it is there, and configure a strict NodeNext TypeScript build consistent with the other lecture codebases.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `package.json` | 59 lines |
| `tsconfig.json` | 18 lines |
| `.gitignore` | 5 lines |
| `.env.example` | 56 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `package.json` (58 lines)

```json
{
  "name": "lecture-06-ai-streaming",
  "version": "1.0.0",
  "description": "Enterprise AI Streaming Microservice — token-level generation, progressive delivery over raw text / NDJSON / SSE, dual-write history buffering, backpressure, cancellation propagation, and streaming-specific observability",
  "main": "dist/server.js",
  "type": "module",
  "engines": {
    "node": ">=18.17.0"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "tsc && node dist/server.js",
    "stream:cli": "tsx src/scripts/cli-stream-consumer.ts",
    "test:utf8": "tsx src/scripts/test-utf8-fragmentation.ts",
    "test:cancel": "tsx src/scripts/test-cancellation.ts",
    "test:invariants": "tsx src/scripts/test-pipeline-invariants.ts",
    "bench:latency": "tsx src/scripts/benchmark-latency.ts",
    "verify": "npm run build && npm run test:utf8 && npm run test:invariants"
  },
  "keywords": [
    "fde",
    "genai",
    "ai-streaming",
    "ttft",
    "itl",
    "server-sent-events",
    "sse",
    "ndjson",
    "chunked-transfer-encoding",
    "readable-stream",
    "textdecoder",
    "backpressure",
    "abortcontroller",
    "dual-write",
    "observability",
    "typescript",
    "express",
    "openai"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "eventsource-parser": "^4.1.2",
    "express": "^4.21.2",
    "openai": "^4.85.4",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/node": "^22.13.8",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3"
  }
}
```


### 📄 `tsconfig.json` (17 lines)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "public"]
}
```


### 📄 `.gitignore` (4 lines)

```text
node_modules/
dist/
.env
*.log
```


### 📄 `.env.example` (55 lines)

```text
# ============================================================================
# Lecture 06 — AI Streaming Microservice configuration
# Copy to `.env` and adjust. Every value is validated at boot by src/config/env.ts
# ============================================================================

# --- Server -----------------------------------------------------------------
PORT=8090
NODE_ENV=development

# --- AI Provider ------------------------------------------------------------
# Leave as-is to run the deterministic streaming SIMULATOR (no cost, no network).
# Provide a real key to stream from OpenAI with `stream: true`.
OPENAI_API_KEY=your_openai_api_key_here
AI_MODEL=gpt-4o-mini
AI_TEMPERATURE=0.3
AI_MAX_OUTPUT_TOKENS=1024

# --- Streaming behaviour ----------------------------------------------------
# Provider deltas are coalesced before they are written to the socket.
# token | word | sentence | random   (random = hostile fragmentation, for tests)
STREAM_GRANULARITY=sentence
# Minimum time window (ms) before a partial application chunk is force-flushed.
STREAM_FLUSH_MS=40
# Largest application chunk (chars) before a force-flush (bound on chunk size).
STREAM_MAX_CHUNK_CHARS=180
# SSE keep-alive comment cadence. Must be < every intermediary idle timeout.
STREAM_HEARTBEAT_MS=10000
# How long a single SSE stream keeps frames available for Last-Event-ID resume.
STREAM_REPLAY_BUFFER_FRAMES=512

# --- Timeouts & budgets (the "streaming must not die at 60s" rules) ----------
# Max wait for the FIRST provider delta before the stream is failed in-band.
STREAM_TTFT_BUDGET_MS=20000
# Max silero gap between deltas (stall detector / idle watchdog).
STREAM_IDLE_TIMEOUT_MS=30000
# Hard ceiling for a whole generation.
STREAM_TOTAL_TIMEOUT_MS=180000

# --- Backpressure & limits --------------------------------------------------
# If the client socket backlog exceeds this, the stream is terminated safely.
STREAM_MAX_CLIENT_QUEUE_BYTES=1048576
# Concurrency guards.
MAX_CONCURRENT_STREAMS_PER_CONVERSATION=1
MAX_CONCURRENT_STREAMS_GLOBAL=64

# --- Conversation history (dual-write persistence) --------------------------
HISTORY_MAX_TURNS=24
HISTORY_TOKEN_BUDGET=6000
CONVERSATION_TTL_MS=3600000

# --- Observability ----------------------------------------------------------
METRICS_ENABLED=true
LOG_LEVEL=info
# p95(clientTTFT - serverTTFT) above this raises the streaming alert.
TTFT_GAP_ALERT_MS=500
```


---

## 3. Block-by-Block Explanation

### Part A: `package.json`

#### Block 1: Identity and module system

```json
"name": "lecture-06-ai-streaming",
"type": "module",
"engines": { "node": ">=18.17.0" },
```

- **What it does:** declares the project, forces native ESM (`import`/`export`, top-level `await`) and states the minimum runtime.
- **How it works:** `"type": "module"` makes Node treat every `.js` as an ES module. That is why every relative import in this codebase ends in `.js` — under `NodeNext` resolution TypeScript requires the *emitted* extension, not the source extension.

#### Block 2: Scripts — the operational surface

```json
"dev": "tsx watch src/server.ts",
"build": "tsc",
"start": "tsc && node dist/server.js",
"verify": "npm run build && npm run test:utf8 && npm run test:invariants"
```

- **What it does:** `dev` runs the TypeScript entrypoint directly with hot reload; `build` typechecks *and* emits; `start` is the production shape; `verify` is the CI gate.
- **How it works:** `tsx` executes TypeScript through esbuild with no build step. `verify` deliberately chains build → torture test → invariant suite, so a buffering regression or a decoding bug fails the pipeline before a container is published.

#### Block 3: The demonstration scripts

```json
"stream:cli": "tsx src/scripts/cli-stream-consumer.ts",
"test:utf8": "tsx src/scripts/test-utf8-fragmentation.ts",
"test:cancel": "tsx src/scripts/test-cancellation.ts",
"test:invariants": "tsx src/scripts/test-pipeline-invariants.ts",
"bench:latency": "tsx src/scripts/benchmark-latency.ts"
```

- **What it does:** exposes each verification script as a first-class command, so "how do I prove this works?" is answered by the same file that documents it.
- **How it works:** each script boots the Express app **in-process on an ephemeral port**, which is why none of them need a running server, a fixed port, or an API key.

#### Block 4: Dependencies

| Package | Why it is here |
| :--- | :--- |
| `express` | HTTP server; we use `res.write()`/`res.end()` directly for streaming |
| `openai` | Live provider; its stream is already an `AsyncIterable` |
| `zod` | Boot-time env validation + request/response contracts (single source of truth) |
| `dotenv` | `.env` loading |
| `cors` | The browser UI is served from the same origin but REST clients are not |
| `eventsource-parser` | A battle-tested incremental SSE parser for the **consumer** side, instead of a hand-rolled `split('\n\n')` |

> **Deliberate omission:** there is no compression middleware anywhere in this project. `gzip` on a progressive body re-buffers it and silently destroys streaming (hardening item #2) — the absence is a design decision, not an oversight.

#### Block 5: Dev dependencies

- **How it works:** `@types/node` is what makes `res.writableLength`, `process.hrtime` and `performance.now()` type-safe; `tsx` covers both watch mode and one-shot script execution.

---

### Part B: `tsconfig.json`

#### Block 6: Compilation target and module resolution

```json
"target": "ES2022",
"module": "NodeNext",
"moduleResolution": "NodeNext",
"lib": ["ES2022", "DOM"]
```

- **What it does:** emits modern JavaScript, uses Node's real ESM resolution rules, and gives the compiler both the ES2022 standard library and the DOM lib.
- **How it works:** `NodeNext` is what makes `import { x } from './y.js'` mandatory and correct. The `DOM` lib is included because `TextDecoder`/`AbortSignal` come from it and the browser client uses the same names — one vocabulary across both halves of the pipeline.

#### Block 7: Strictness

```json
"strict": true,
"forceConsistentCasingInFileNames": true
```

- **What it does:** turns on the full strict family and case-sensitivity checks.
- **How it works:** `strictNullChecks` does real work in the stream engine — `ttftMs: number | null` cannot be read without a check, which is exactly the discipline needed for "no first token yet". `forceConsistentCasingInFileNames` prevents the classic "works on macOS, breaks on Linux CI" import bug.

#### Block 8: Emit configuration

```json
"outDir": "./dist",
"rootDir": "./src",
"declaration": true,
"exclude": ["node_modules", "dist", "public"]
```

- **What it does:** emits `dist/` with `.d.ts` files and **excludes `public/`** from compilation.
- **How it works:** the browser client is plain ES modules served statically; it must never be compiled by the Node build (different globals, different module system). Keeping it out of `include` also keeps `tsc` fast.

---

### Part C: `.gitignore`

```text
node_modules/
dist/
.env
*.log
```

- **What it does:** keeps dependencies, build output, secrets and logs out of version control.
- **How it works:** `.env` is ignored while `.env.example` is committed, so the repository documents every knob without ever shipping a key.

---

### Part D: `.env.example`

#### Block 9: Grouped, documented configuration

```bash
PORT=8090
OPENAI_API_KEY=your_openai_api_key_here
STREAM_GRANULARITY=sentence
STREAM_FLUSH_MS=40
STREAM_TTFT_BUDGET_MS=20000
STREAM_IDLE_TIMEOUT_MS=30000
STREAM_TOTAL_TIMEOUT_MS=180000
STREAM_MAX_CLIENT_QUEUE_BYTES=1048576
```

- **What it does:** ships a working, zero-cost configuration out of the box (simulator mode) and documents every streaming knob in place.
- **How it works:** the sentinel key `your_openai_api_key_here` is recognised by `isLiveProviderConfigured()`; anything that is not `sk-…` selects the simulator. Grouping by concern (server · provider · granularity · liveness · backpressure · history · observability) mirrors how the values are read in `src/config/env.ts`.

> **Why three timeouts and not one:** they fail for different reasons and need different messages. TTFT budget = "the provider never started"; idle timeout = "the provider went silent mid-answer"; total ceiling = "this generation is simply too long". Collapsing them into one timeout makes production incidents unreadable.

---

### ✅ Chapter 01 verification

```bash
npm install          # installs the 6 runtime + 5 dev dependencies
npm run build        # tsc emits dist/ with no errors
npm run dev          # banner prints the active mode (SIMULATOR unless a key is set)
```



---

**Previous:** [Chapter 00 — Overview & File Structure](./00_Overview_and_File_Structure.md) · **Next:** 
