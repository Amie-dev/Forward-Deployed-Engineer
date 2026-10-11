# Chapter 01: Project Initialization, Toolchain & TypeScript Setup

> **Chapter Goal:** Initialize the project repository, configure the modern Node.js and TypeScript toolchain using ECMAScript Modules (`NodeNext`), install required runtime and development dependencies, and configure security ignore rules and environment templates.

---

## 1.1 Directory Setup & Terminal Commands

Run the following commands from your terminal to create the project directory tree and install all required dependencies:

```bash
# 1. Navigate to target workspace directory
mkdir -p "Lecture 04/code/src"
cd "Lecture 04/code"

# 2. Install production runtime dependencies
npm install express openai zod dotenv cors

# 3. Install development toolchain & TypeScript type declarations
npm install -D typescript tsx @types/node @types/express @types/cors
```

---

## 1.2 File 1: `package.json`

Create `package.json` in the root of `Lecture 04/code/`:

```json
{
  "name": "lecture-04-production-chatbot",
  "version": "1.0.0",
  "description": "Enterprise Conversational AI microservice demonstrating Context Management, Memory Hydration, Server-Sent Events (SSE) Streaming, and Anti-Hallucination Guardrails",
  "main": "dist/server.js",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "tsc && node dist/server.js",
    "chat:cli": "tsx src/scripts/cli-chat.ts",
    "test:hallucination": "tsx src/scripts/test-hallucination.ts",
    "test:context": "tsx src/scripts/test-context-bloat.ts"
  },
  "keywords": [
    "fde",
    "genai",
    "llm",
    "chatbot",
    "streaming",
    "sse",
    "context-management",
    "hallucination-mitigation",
    "openai",
    "typescript",
    "express"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
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

### Block-by-Block Explanation: `package.json`

- `"type": "module"`: Enforces native ECMAScript Modules (ESM) across the entire project. This enables top-level `import`/`export` syntax and avoids legacy CommonJS (`require()`) pitfalls.
- `"scripts"`:
  - `"dev": "tsx watch src/server.ts"`: Uses `tsx` (TypeScript Execute) to run TypeScript files directly in memory with live hot-reloading on file changes, bypassing slow build steps during development.
  - `"build": "tsc"`: Uses the official TypeScript compiler to perform strict static type checking and compile source files into production-ready JavaScript in `dist/`.
  - `"start": "tsc && node dist/server.js"`: Production startup script that first verifies type compilation and boots the compiled output directly using the Node.js runtime.
  - `"chat:cli": "tsx src/scripts/cli-chat.ts"`: Launches an interactive terminal chatbot with real-time SSE streaming for rapid developer verification.
  - `"test:hallucination": "tsx src/scripts/test-hallucination.ts"`: Executes the automated adversarial test suite verifying refusal against false premises.
  - `"test:context": "tsx src/scripts/test-context-bloat.ts"`: Runs the 20-turn token bloat simulation benchmarking naive accumulation against sliding window compaction.
- `"dependencies"`:
  - `express`: Minimalist, high-performance HTTP web server for REST and Server-Sent Events (SSE).
  - `openai`: Official OpenAI Node.js SDK providing typed client bindings, automated retries, and async streaming iterables.
  - `zod`: TypeScript-first schema declaration and data validation library for environment variables and structured outputs.
  - `dotenv`: Loads configuration from local `.env` files into `process.env`.
  - `cors`: Enables Cross-Origin Resource Sharing for browser web clients.

---

## 1.3 File 2: `tsconfig.json`

Create `tsconfig.json` in the root of `Lecture 04/code/`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Block-by-Block Explanation: `tsconfig.json`

- `"target": "ES2022"`: Compiles modern JavaScript features supported natively by Node.js 18+ (such as class fields, top-level await, and `AbortController`).
- `"module": "NodeNext"` & `"moduleResolution": "NodeNext"`: Aligns the compiler directly with Node.js's native ESM resolution rules. Requires explicit `.js` extensions on local imports (e.g., `import { config } from './config/env.js'`).
- `"outDir": "./dist"` & `"rootDir": "./src"`: Directs compiled output into the `dist/` directory while restricting compilation to files located inside `src/`.
- `"strict": true`: Enables all strict type-checking options, preventing `null` pointer exceptions and untyped implicit `any` variables.
- `"skipLibCheck": true`: Accelerates build times by skipping type checks on external third-party `.d.ts` declaration files.

---

## 1.4 File 3: `.gitignore`

Create `.gitignore` in the root of `Lecture 04/code/`:

```gitignore
node_modules/
dist/
.env
*.log
.DS_Store
```

### Block-by-Block Explanation: `.gitignore`

- `node_modules/`: Excludes bulky third-party dependencies from version control.
- `dist/`: Excludes compiled JavaScript binaries, ensuring only pristine TypeScript source code is tracked in git.
- `.env`: **Critical Security Boundary**. Prevents private API keys (`OPENAI_API_KEY`) from ever being committed to git repositories.
- `*.log`: Ignores local debug and server execution logs.

---

## 1.5 File 4: `.env.example`

Create `.env.example` in the root of `Lecture 04/code/`:

```bash
# Server Port
PORT=8080

# OpenAI API Key (Required for live generation)
OPENAI_API_KEY=your_openai_api_key_here

# Target LLM Model (e.g., gpt-4o-mini, gpt-4o)
AI_MODEL=gpt-4o-mini

# Sampling Temperature (0.0 = Deterministic/Factual, 0.7 = Creative)
AI_TEMPERATURE=0.3

# Context Management Configuration
MAX_CONTEXT_TOKENS=3000
SUMMARIZATION_THRESHOLD_TURNS=6
```

### Block-by-Block Explanation: `.env.example`

- Serves as the **declarative configuration template** for new developers and deployment environments.
- Documents all supported operational parameters, acceptable model defaults (`gpt-4o-mini`), default sampling temperatures ($0.3$), and context compaction thresholds ($6$ turns).
