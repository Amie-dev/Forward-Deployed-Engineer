# Chapter 01: Project Initialization & Tooling

> **Chapter Goal:** Set up a strict TypeScript/Node.js project whose toolchain makes mistakes expensive *before* runtime. Understand every dependency, compiler flag, environment variable, and ignored path.

> **Files covered:**

| File | Purpose |
| :--- | :--- |
| `package.json` | Dependencies and the three lifecycle scripts (`dev`, `build`, `start`) |
| `tsconfig.json` | Strict ES2022 + NodeNext compilation |
| `.env.example` | Portable configuration template |
| `.gitignore` | Keeps secrets and build output out of Git |

---

## 1. Commands

```bash
mkdir -p "Lecture 08/code/src"
cd "Lecture 08/code"

npm init -y

npm install express cors dotenv openai zod
npm install -D typescript tsx @types/node @types/express @types/cors

# create the files below, then:
npm run build
npm run dev
```

---

## 2. Complete Source Code

### 📄 `package.json` (39 lines)

```json
{
  "name": "lecture-08-vector-embeddings-movie-recommendation",
  "version": "1.0.0",
  "description": "Movie Recommendation Engine using Vector Embeddings and Cosine Similarity — demonstrating REPRESENT → STORE → COMPARE → RANK pattern with OpenAI text-embedding-3-small",
  "main": "dist/server.js",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "tsc && node dist/server.js"
  },
  "keywords": [
    "fde",
    "vector-embeddings",
    "cosine-similarity",
    "semantic-search",
    "movie-recommendation",
    "content-based-filtering",
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

### 📄 `tsconfig.json` (15 lines)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 📄 `.env.example` (12 lines)

```dotenv
# Server
PORT=3008

# OpenAI API Key — required for embedding generation
OPENAI_API_KEY=your_openai_api_key_here

# Embedding model — text-embedding-3-small is fast, cheap, and 1536-dim
# Options: text-embedding-3-small | text-embedding-3-large | text-embedding-ada-002
EMBEDDING_MODEL=text-embedding-3-small

# How many similar movies to return per request
DEFAULT_TOP_N=5
```

### 📄 `.gitignore` (3 lines)

```gitignore
node_modules/
dist/
.env
```

---

## 3. Block-by-Block Explanation

### Part A: `package.json`

#### Block 1: Module system

```json
"type": "module",
```

This makes every `.js` file in the package an **ES module** instead of CommonJS. It is required because the TypeScript compiler is configured with `"module": "NodeNext"`, which emits modern `import`/`export` syntax and expects Node to treat the output the same way.

#### Block 2: Scripts

```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "build": "tsc",
  "start": "tsc && node dist/server.js"
}
```

| Script | Mechanism | Why it exists |
| :--- | :--- | :--- |
| `dev` | `tsx watch` | Runs TypeScript directly, restarts on file changes — no build step while learning |
| `build` | `tsc` | Performs the strict typecheck and emits JavaScript into `dist/` |
| `start` | `tsc && node dist/server.js` | Guarantees the emitted code is current before running it |

`tsx` is only a **development** dependency. Production runs plain Node against compiled output.

#### Block 3: Runtime dependencies

```json
"dependencies": {
  "cors": "^2.8.5",
  "dotenv": "^16.4.7",
  "express": "^4.21.2",
  "openai": "^4.85.4",
  "zod": "^3.24.2"
}
```

| Package | Role in this project |
| :--- | :--- |
| `express` | HTTP server, routing, middleware |
| `cors` | Allows browser clients on other origins to call the API |
| `dotenv` | Loads `.env` into `process.env` at boot |
| `openai` | Official SDK for the Embeddings API (`client.embeddings.create`) |
| `zod` | Validates environment variables and request bodies |

Every dependency is used; there is no framework or vector-database client because the lecture's goal is to show the raw mechanics.

#### Block 4: Development dependencies

```json
"devDependencies": {
  "@types/cors": "^2.8.17",
  "@types/express": "^5.0.0",
  "@types/node": "^22.13.8",
  "tsx": "^4.19.3",
  "typescript": "^5.7.3"
}
```

- `@types/*` provide TypeScript declarations for JavaScript libraries.
- `typescript` supplies `tsc`.
- `tsx` executes TypeScript directly and provides the watcher.

`@types/express` is v5 while `express` is v4. The handler signatures used here (`Request`, `Response`, `NextFunction`) are compatible, and `skipLibCheck` prevents unrelated declaration conflicts from failing the build.

---

### Part B: `tsconfig.json`

#### Block 1: Output and module resolution

```json
"target": "ES2022",
"module": "NodeNext",
"moduleResolution": "NodeNext",
"outDir": "./dist",
"rootDir": "./src",
```

- **`target: ES2022`** — Node 18+ supports top-level `await`, private class fields, and modern array methods natively. No down-levelling is needed.
- **`module: NodeNext` + `moduleResolution: NodeNext`** — emit ESM and resolve imports the way Node does. This is why every relative import in the source ends in `.js` (for example `../config/env.js`) even though the file on disk is `.ts`: the compiler keeps the specifier exactly as written, and the emitted JavaScript must be able to find it.
- **`outDir` / `rootDir`** — `src/` is the only source root; output mirrors that tree under `dist/`.

#### Block 2: Strictness and interoperability

```json
"strict": true,
"esModuleInterop": true,
"skipLibCheck": true,
"resolveJsonModule": true
```

- **`strict`** turns on `strictNullChecks`, `noImplicitAny`, and related checks. This is what forces the `movie.vector!` assertion in the vector store and the explicit `undefined` handling in the routes.
- **`esModuleInterop`** lets `import express from 'express'` work even though Express is a CommonJS package.
- **`skipLibCheck`** skips type-checking inside `node_modules`, keeping builds fast and insulated from third-party declaration bugs.
- **`resolveJsonModule`** allows importing `.json` files if the project later moves the catalog to JSON. The current code does not use it, but it is harmless and useful for experiments.

#### Block 3: Scope

```json
"include": ["src/**/*"],
"exclude": ["node_modules", "dist"]
```

Only `src/` is compiled. `dist/` is excluded so a build never recompiles its own output.

---

### Part C: `.env.example`

```dotenv
PORT=3008
OPENAI_API_KEY=your_openai_api_key_here
EMBEDDING_MODEL=text-embedding-3-small
DEFAULT_TOP_N=5
```

- **`PORT=3008`** — the HTTP port, chosen to avoid collisions with the earlier lectures.
- **`OPENAI_API_KEY`** — the placeholder is deliberately detectable. Chapter 02 treats this exact string as “no key”, which enables mock mode.
- **`EMBEDDING_MODEL`** — `text-embedding-3-small` produces **1536-dimensional** vectors, is inexpensive, and is more than accurate enough for an 18-movie demo. Changing the model changes the vector dimension, but the rest of the code only requires that *all* vectors come from the same model.
- **`DEFAULT_TOP_N=5`** — the default result count when the client does not send `topN`.

The file is named `.env.example` so it can be committed safely. The real `.env` is ignored.

---

### Part D: `.gitignore`

```gitignore
node_modules/
dist/
.env
```

- `node_modules/` is reproducible from `package-lock.json`.
- `dist/` is generated by `npm run build`.
- `.env` contains a secret and must never be committed.

---

## 4. Verification

```bash
npm install
npm run build
```

Expected: `tsc` exits with code `0` and a `dist/` directory appears containing `server.js`, `app.js`, and the mirrored `config/`, `data/`, `routes/`, `services/`, and `types/` folders.

Confirm the dependency graph is clean:

```bash
npm ls --depth=0
```

Expected: `express`, `cors`, `dotenv`, `openai`, and `zod` at the top level with no `UNMET` markers.

---

**Next:** [Chapter 02 — Environment Configuration & Boot-Time Validation](./02_Environment_Configuration_and_Validation.md)
