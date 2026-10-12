# Chapter 01: Project Initialization & TypeScript Configuration

> **Chapter Goal:** Establish the project foundation, configure the Node.js package manifest (`package.json`), initialize the modern TypeScript compiler settings (`tsconfig.json`), and configure Git exclusions (`.gitignore`).

---

## 1.1 File Details & Purpose

| File | Target Path | Operational Purpose |
| :--- | :--- | :--- |
| **`package.json`** | `Lecture 05/code/package.json` | Declares project metadata, npm scripts, production dependencies (`express`, `openai`, `zod`, `dotenv`, `cors`), and development tooling (`typescript`, `tsx`, `@types/*`). |
| **`tsconfig.json`** | `Lecture 05/code/tsconfig.json` | Configures TypeScript compiler for modern NodeNext ECMAScript module resolution, strict typechecking, and output build directories. |
| **`.gitignore`** | `Lecture 05/code/.gitignore` | Prevents generated build artifacts (`dist/`), dependencies (`node_modules/`), secrets (`.env`), and runtime output (`generated-sites/`) from leaking into source control. |

### Terminal Commands
```bash
# Initialize npm project and install dependencies
cd "Lecture 05/code"
npm install

# Test TypeScript compilation
npm run build
```

---

## 1.2 Full Code File: `package.json`

```json
{
  "name": "lecture-05-autonomous-ai-agents",
  "version": "1.0.0",
  "description": "Enterprise Autonomous AI Agent Framework demonstrating Native Tool Calling Protocols, Multi-Step ReAct Execution Loops, Sandboxed Workspace File Operations, and Human-in-the-Loop (HITL) Governance",
  "main": "dist/server.js",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "tsc && node dist/server.js",
    "agent:multitool": "tsx src/scripts/cli-multitool-agent.ts",
    "agent:website": "tsx src/scripts/cli-website-agent.ts",
    "test:hitl": "tsx src/scripts/test-hitl-flow.ts"
  },
  "keywords": [
    "fde",
    "genai",
    "ai-agents",
    "tool-calling",
    "react-loop",
    "function-calling",
    "workspace-sandbox",
    "hitl",
    "human-in-the-loop",
    "typescript",
    "express",
    "openai"
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

---

## 1.3 Block-by-Block Explanation: `package.json`

### Block 1: Module System & Metadata
```json
  "main": "dist/server.js",
  "type": "module",
```
- **What this does:** Configures the project as an ECMAScript Module (`"type": "module"`).
- **How it works:** In Node.js, setting `"type": "module"` allows the entire codebase to use modern `import` and `export` statements rather than legacy CommonJS `require()` and `module.exports`. The entrypoint points to the compiled JavaScript file in `dist/server.js`.

### Block 2: Lifecycle & Execution Scripts
```json
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "tsc && node dist/server.js",
    "agent:multitool": "tsx src/scripts/cli-multitool-agent.ts",
    "agent:website": "tsx src/scripts/cli-website-agent.ts",
    "test:hitl": "tsx src/scripts/test-hitl-flow.ts"
  },
```
- **What this does:** Provides shortcuts for development, compilation, and autonomous demonstration scripts.
- **How it works:**
  - `npm run dev`: Uses `tsx watch` to execute TypeScript files directly in memory with instant hot-reloading upon file save.
  - `npm run build`: Invokes `tsc` to perform complete static type analysis and emit production JavaScript into `dist/`.
  - `npm run agent:multitool`: Runs the CLI test for sequential and parallel multi-tool chaining.
  - `npm run agent:website`: Runs the autonomous closed-loop website generator.
  - `npm run test:hitl`: Runs the automated pause/resume Human-in-the-Loop approval gate test.

### Block 3: Production Dependencies
```json
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "openai": "^4.85.4",
    "zod": "^3.24.2"
  },
```
- **`express` & `cors`:** High-performance HTTP server runtime and Cross-Origin Resource Sharing middleware.
- **`dotenv`:** Ingests local `.env` configuration into `process.env`.
- **`openai`:** Official client library providing wire-level TypeScript definitions for Chat Completion APIs, tool calling payloads, and streaming iterables.
- **`zod`:** TypeScript-first schema declaration and runtime data validation library. Used to define strict tool parameter contracts and validate environment variables.

---

## 1.4 Full Code File: `tsconfig.json`

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
  "exclude": ["node_modules", "dist", "generated-sites"]
}
```

---

## 1.5 Block-by-Block Explanation: `tsconfig.json`

### Block 1: Target & Module Resolution
```json
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
```
- **What this does:** Targets modern JavaScript standards and enables native Node.js ESM resolution.
- **How it works:** `NodeNext` matches modern Node.js module resolution semantics, requiring explicit file extensions (`.js`) in relative import paths (e.g., `import { env } from './config/env.js'`). This eliminates transpilation impedance between dev and production.

### Block 2: Strictness & Emission
```json
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true
```
- **`rootDir` / `outDir`:** Maps TypeScript source files in `src/` directly to output JavaScript in `dist/`.
- **`strict: true`:** Enables all strict typechecking options (`noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`), preventing runtime null-pointer crashes.
- **`declaration: true`:** Emits `.d.ts` type declaration files alongside JavaScript.

### Block 3: Directory Scoping
```json
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "generated-sites"]
```
- **What this does:** Compiles only application code inside `src/` and explicitly excludes dependencies, compiled code, and the agent's sandboxed website workspace (`generated-sites/`).

---

## 1.6 Full Code File: `.gitignore`

```text
node_modules/
dist/
.env
generated-sites/
*.log
```

- **`node_modules/`:** Prevents committing third-party dependencies.
- **`dist/`:** Ignores compiled artifacts generated by `npm run build`.
- **`.env`:** Guarantees that private API keys and environment secrets are never committed to version control.
- **`generated-sites/`:** Isolates the agent's runtime workspace output from source code repositories.
