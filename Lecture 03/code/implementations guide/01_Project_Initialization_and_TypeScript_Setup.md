# Chapter 01: Project Initialization & Toolchain Setup

> **Chapter Goal:** Initialize the Node.js project, install production and development dependencies, configure the modern TypeScript compiler (`tsconfig.json`), establish Git security boundaries (`.gitignore`), and define the environment variable template (`.env.example`).

---

## 1.1 Overview & Terminal Commands

Before writing application logic, we must establish a reproducible development environment. We use modern ECMAScript Modules (`type: "module"`), Node.js native resolution (`NodeNext`), and `tsx` for high-speed TypeScript execution without manual recompilation cycles.

### Terminal Commands to Execute:

```bash
# 1. Create and enter the project directory
mkdir -p "Lecture 03/code"
cd "Lecture 03/code"

# 2. Initialize package.json
npm init -y

# 3. Install Production Dependencies
npm install express dotenv openai zod

# 4. Install Developer & TypeScript Tooling
npm install -D typescript @types/node @types/express tsx
```

### Dependency Role Matrix:

| Package | Category | Version | Purpose in Architecture |
| :--- | :--- | :--- | :--- |
| **`express`** | Production | `^4.21.2` | Minimal, flexible HTTP web framework providing routing and middleware. |
| **`dotenv`** | Production | `^16.4.7` | Loads environment variables from `.env` into `process.env`. |
| **`openai`** | Production | `^4.85.4` | Official SDK for OpenAI models with connection pooling, retries, and typing. |
| **`zod`** | Production | `^3.24.2` | TypeScript-first schema validation for runtime environment & request payloads. |
| **`typescript`** | DevDependency | `^5.7.3` | Type checker and compiler producing clean ECMAScript in `dist/`. |
| **`tsx`** | DevDependency | `^4.19.3` | Instant TypeScript execution and hot-reloading development runner (`tsx watch`). |
| **`@types/*`** | DevDependency | Latest | Type definition packages providing IDE autocomplete and compile-time checks. |

---

## 1.2 Full Code: `package.json`

File Path: `Lecture 03/code/package.json`

```json
{
  "name": "lecture-03-support-summarizer",
  "version": "1.0.0",
  "description": "Enterprise Support Ticket Summarizer microservice using Node.js, Express, TypeScript, and OpenAI SDK",
  "main": "dist/server.js",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "prototype": "tsx src/scripts/direct-prototype.ts",
    "test:injection": "tsx src/scripts/test-injection.ts"
  },
  "keywords": [
    "fde",
    "llm",
    "genai",
    "express",
    "typescript",
    "openai",
    "spring-ai-equivalent"
  ],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "openai": "^4.85.4",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.13.8",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3"
  }
}
```

### Block-by-Block Explanation of `package.json`:

#### Block 1: Module System Declaration
```json
"type": "module",
```
- **What it does:** Declares that the package uses native ECMAScript Modules (ESM) rather than legacy CommonJS (`require()`).
- **Why it is written this way:** Modern AI libraries and Node.js LTS runtimes are moving to ESM. It allows top-level `import / export` syntax and tree-shaking.
- **How it works:** When Node encounters `.js` or `.ts` files, it treats `import` statements as native ESM imports.

#### Block 2: Runner & Build Scripts
```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "build": "tsc",
  "start": "node dist/server.js",
  "prototype": "tsx src/scripts/direct-prototype.ts",
  "test:injection": "tsx src/scripts/test-injection.ts"
}
```
- **`npm run dev`:** Uses `tsx watch` to monitor `src/server.ts` and restart the Express server instantly on file edits without slow compilation steps.
- **`npm run build`:** Invokes the TypeScript compiler (`tsc`) to check types and compile files from `src/` into standard JavaScript in `dist/`.
- **`npm start`:** Executes the compiled production bundle (`dist/server.js`) via standard Node.js without development overhead.
- **`npm run prototype`:** Runs the standalone CLI prototype script to test direct LLM calls without booting the Express server.
- **`npm run test:injection`:** Executes the adversarial security script comparing vulnerable string concatenation against role-separated prompt hygiene.

---

## 1.3 Full Code: `tsconfig.json`

File Path: `Lecture 03/code/tsconfig.json`

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

### Block-by-Block Explanation of `tsconfig.json`:

#### Block 1: Target & Modern Module Resolution
```json
"target": "ES2022",
"module": "NodeNext",
"moduleResolution": "NodeNext",
"lib": ["ES2022"],
```
- **What it does:** Sets the JavaScript language version to ECMAScript 2022 and configures Node’s official ESM module resolution algorithm (`NodeNext`).
- **Why it is written this way:** Matches Node.js v18+ and v24+ specifications. Requires relative imports to specify file extensions (e.g., `import ... from './app.js'`), aligning with standard web and modern Node specs.

#### Block 2: Build Output & Directory Scoping
```json
"outDir": "./dist",
"rootDir": "./src",
"declaration": true,
```
- **What it does:** Compiles all files inside `src/` to `dist/` and emits `.d.ts` TypeScript type definition files.
- **Why it is written this way:** Keeps production artifacts completely separate from source code, making Docker deployments clean and lightweight.

#### Block 3: Strict Type Checking & Interoperability
```json
"strict": true,
"esModuleInterop": true,
"skipLibCheck": true,
"forceConsistentCasingInFileNames": true
```
- **`strict: true`:** Enables all strict type-checking options (`noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`). Essential for enterprise code to eliminate `undefined` runtime crashes.
- **`esModuleInterop: true`:** Enables smooth interoperability when importing CommonJS packages into ESM.
- **`skipLibCheck: true`:** Skips type-checking declaration files (`.d.ts`) of third-party dependencies, drastically speeding up compilation.

---

## 1.4 Full Code: `.gitignore`

File Path: `Lecture 03/code/.gitignore`

```gitignore
# Dependencies
node_modules/

# Compiled Output
dist/

# Environment Variables & Secrets
.env
*.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Editor directories
.vscode/
.idea/
*.swp
*.swo
```

### Block-by-Block Explanation of `.gitignore`:

- **`node_modules/` & `dist/`:** Prevents committing bloated dependency packages or transient compiled build artifacts to Git.
- **`.env` & `*.local` (CRITICAL):** Protects API keys and secrets from being committed to public or private source control repositories.
- **Editor & OS files:** Ignores local editor workspace settings and temporary swap files across developer workstations.

---

## 1.5 Full Code: `.env.example`

File Path: `Lecture 03/code/.env.example`

```ini
# Server Port
PORT=8080

# OpenAI API Key (Required)
OPENAI_API_KEY=your_openai_api_key_here

# Target LLM Model (e.g. gpt-5-mini, gpt-4o-mini, gpt-4o)
AI_MODEL=gpt-4o-mini

# Sampling Temperature (0.0 = Deterministic/Focused, 1.0 = Balanced, 2.0 = Creative)
AI_TEMPERATURE=0.3
```

### Block-by-Block Explanation of `.env.example`:

- **`PORT=8080`:** Configures the TCP port for Express. Defaults to `8080`.
- **`OPENAI_API_KEY`:** Placeholder instructing developers to provide their personal or enterprise API key from `platform.openai.com`.
- **`AI_MODEL=gpt-4o-mini`:** Sets the target model engine. Allows changing the model tier (e.g., from `gpt-4o-mini` to `gpt-4o`) without editing source code.
- **`AI_TEMPERATURE=0.3`:** Calibrates output probability distribution. Set low (`0.3`) for consistent, factual, deterministic summaries.

In Chapter 02, we build the boot-time environment validation engine in `src/config/env.ts`.
