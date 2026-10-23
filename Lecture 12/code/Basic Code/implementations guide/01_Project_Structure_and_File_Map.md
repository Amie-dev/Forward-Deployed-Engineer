# Chapter 01 — Project Structure & File Map

> **Goal of this chapter:** before reading a single line of TypeScript, understand
> *the map*: every folder, every file, what it is for, and the order in which the
> files depend on each other. This is the "explain the overall file structure"
> chapter you start from.
>
> **Lecture chapters:** all of them — this file is the index into
> [01](../../../notes/01_Why_Basic_RAG_Breaks.md) →
> [09](../../../notes/09_Evaluation_and_Production_Playbook.md).

---

## 1.1 What the project is (in one paragraph)

It is **one pipeline** that answers a question from a small corpus of policy
documents, and **one CLI** that lets you look at any stage of it. Every stage is
one of Lecture 12's eight controls: chunking, top-K, the similarity floor,
metadata filters, hybrid search with RRF, reranking, context engineering and
evaluation.

It runs **offline with no API key**: the embedder hashes tokens into a vector and
the generator quotes sentences. That design choice is what makes the numbers in
this guide reproducible on any machine — and it is honest about its limits
(Chapter 12 covers them).

---

## 1.2 Prerequisites

| Requirement | Version | Why it is needed |
|---|---|---|
| **Node.js** | `>= 20.0.0` | declared in `package.json` `engines.node`; the code uses ESM and modern syntax |
| **npm** | recent | installs the dependencies and runs the scripts in `package.json` |

```bash
node --version    # must print v20.x or newer (this guide was verified on v24.22.0)
npm --version
```

---

## 1.3 The complete file structure

```text
Basic Code/
├── .env                        # the eight controls + PORT (gitignored)
├── .env.example                # committed template that `.env` is copied from
├── package.json                # project metadata, dependencies, npm scripts
├── package-lock.json           # exact dependency tree npm install resolved
├── tsconfig.json               # TypeScript compiler configuration
├── README.md                   # the project's own overview (short)
├── implementations guide/      # ← you are here: this chapter-wise guide
└── src/
    ├── index.ts                # Chapter 19 — the server entry: listen(PORT)
    ├── app.ts                  # Chapter 19 — the Express app
    ├── cli.ts                  # Chapter 13 — the chapter CLI
    ├── config/
    │   └── config.ts           # Chapter 02 — every control as a value
    ├── models/
    │   └── types.ts            # Chapter 14 — every contract (no imports)
    ├── utils/
    │   └── hash.ts             # Chapter 15 — FNV-1a: chunk ids + buckets
    ├── middleware/
    │   └── errorHandler.ts     # Chapter 18 — the 404 and the error handler
    ├── routes/
    │   └── index.ts            # Chapter 17 — the route table
    ├── controllers/
    │   └── ragController.ts    # Chapter 16 — request → service → response
    └── services/
        ├── documents.ts        # Chapter 03 — the corpus + its metadata
        ├── chunking.ts         # Chapter 04 — fixed + structural chunking
        ├── embeddings.ts       # Chapter 05 — the offline embedder + analyzer
        ├── store.ts            # Chapter 06 — the index + the eligibility filter
        ├── search.ts           # Chapter 07 — dense, BM25, RRF
        ├── rerank.ts           # Chapter 08 — the joint reranker + the gate
        ├── context.ts          # Chapter 09 — assemble the prompt
        ├── generate.ts         # Chapter 10 — grounded answer or refusal
        ├── index.ts            # Chapter 11 — the pipeline (the orchestrator)
        └── eval.ts             # Chapter 12 — golden set, metrics, ablation
```

`node_modules/` and `dist/` are intentionally **not** listed: `node_modules/` is
created by `npm install`, and `dist/` only appears if you run a build (this project
runs from source via `tsx`, so you never need it).

### File-by-file role

| File | Layer | Owns | Guide chapter |
|---|---|---|---|
| `package.json` | project | dependencies + the `npm run …` scripts | 01 |
| `tsconfig.json` | project | how TypeScript type-checks the source | 01 |
| `.env` | project | the eight controls + `PORT` | 01 |
| `src/models/types.ts` | contracts | every shape that crosses a layer | 14 |
| `src/utils/hash.ts` | helpers | FNV-1a, shared by ids and the embedder | 15 |
| `src/config/config.ts` | configuration | one typed object of controls | 02 |
| `src/services/documents.ts` | data | the 7 documents and their metadata | 03 |
| `src/services/chunking.ts` | ingest | where a document is cut; the chunk id | 04 |
| `src/services/embeddings.ts` | ingest | the analyzer and the vector function | 05 |
| `src/services/store.ts` | store | the index, and the filter that guards it | 06 |
| `src/services/search.ts` | retrieval | dense + BM25 + RRF | 07 |
| `src/services/rerank.ts` | ranking | joint score + the refusal gate | 08 |
| `src/services/context.ts` | context | dedupe, order, label, budget, frame | 09 |
| `src/services/generate.ts` | generation | the answer, the citations, the refusal | 10 |
| `src/services/index.ts` | orchestration | the pipeline + the trace | 11 |
| `src/services/eval.ts` | evaluation | golden set, metrics, ablation presets | 12 |
| `src/controllers/ragController.ts` | HTTP in | validate → one service → serialise | 16 |
| `src/routes/index.ts` | binding | path + method → controller | 17 |
| `src/middleware/errorHandler.ts` | failure path | 404 + the single error handler | 18 |
| `src/app.ts` | composition | middleware → routes → failure path | 19 |
| `src/index.ts` | entry | `listen(PORT)` | 19 |
| `src/cli.ts` | entry | one command per chapter | 13 |

### The dependency graph

```text
                       index.ts (server)      cli.ts (commands)
                             │                      │
                    app.ts ──┴── routes/ ── controllers/ ── middleware/
                             │                      │
                             ▼                      ▼
  config/config.ts ──────────────────────────▶ services/
                                               │
  models/types.ts ────────────────────────────▶│   documents.ts ──▶ chunking.ts ──▶ store.ts
  utils/hash.ts ──────────────────────────────▶│        ▲               ▲              │
                                               │   embeddings.ts ───────┘              ▼
                                               │                              search.ts ──▶ rerank.ts
                                               │                                    ▲          │
                                               │                          context.ts ◀──────────┘
                                               │                              │
                                               │                        generate.ts ──▶ services/index.ts
                                               └────────────────────────────────▶ eval.ts
```

The rule to notice: **arrows only point forward, and never upward.** No service
imports Express; the controller imports no retrieval logic; `models/` and `utils/`
import nothing at all. That is what lets each file be explained on its own — and
what makes the ablation in Chapter 12 able to switch a stage off without touching
the others.

---

## 1.4 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm install          # one time: installs tsx, typescript, dotenv
npm run typecheck    # tsc --noEmit — the only compiler step in the project
npm run ask          # the default question, end to end
```

Every other script is introduced in the chapter that owns it.

---

## 1.5 `package.json` (full file)

**Path:** `package.json`

```json
{
  "name": "lecture-12-advanced-rag-basics",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 12 — Advanced RAG (Basic Code): the minimum runnable code behind the notes. The eight retrieval-quality controls — chunking + overlap, top-K, similarity floor, metadata/ACL/time filters, hybrid search with RRF, reranking, context engineering and a small evaluation — behind a conventional layered structure (config · models · services · controllers · routes · middleware · utils) with an HTTP API and a chapter CLI. Runs offline with no API key.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "ask": "tsx src/cli.ts ask",
    "chunks": "tsx src/cli.ts chunks",
    "search": "tsx src/cli.ts search",
    "filters": "tsx src/cli.ts filters",
    "eval": "tsx src/cli.ts eval",
    "ablation": "tsx src/cli.ts ablation",
    "typecheck": "tsc --noEmit"
  },
  "keywords": [
    "fde",
    "genai",
    "rag",
    "advanced-rag",
    "chunking",
    "hybrid-search",
    "rrf",
    "reranking",
    "context-engineering",
    "controllers",
    "routes",
    "typescript"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.22.3"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.25",
    "@types/node": "^22.13.8",
    "tsx": "^4.23.15",
    "typescript": "^5.9.3"
  }
}
```

### Block-by-block explanation

**Block 1 — identity and module system**

```json
"name": "lecture-12-advanced-rag-basics",
"type": "module",
"engines": { "node": ">=20.0.0" }
```

- `"type": "module"` makes every file an **ES module**, so `import` works and
  there is no `require`. This is why the source files import each other with a
  `.js` extension (Block 4).
- `engines.node` is documentation *and* enforcement: `npm install` warns on an
  older Node.

**Block 2 — the scripts**

```json
"ask": "tsx src/index.ts ask",
```

- One script per chapter. `tsx` runs TypeScript directly — no build step, no
  `dist/`.
- The word after the file (`ask`, `chunks`, `search`, …) is the **CLI
  subcommand** that `src/index.ts` dispatches on (Chapter 13). That is how a
  single entry file serves six demos.
- `npm run search -- "a question"` passes everything after `--` as arguments, so
  the same script answers your own questions.

**Block 3 — dependencies (only one at runtime)**

```json
"dependencies": { "dotenv": "^16.4.7" }
```

- **`dotenv`** loads `.env` into `process.env`. Nothing else is needed at
  runtime: no vector database, no embedding SDK, no HTTP framework.
- Everything else is a **devDependency**: `typescript` (the type checker), `tsx`
  (the runner), `@types/node` (Node's types).

**Block 4 — why the imports end in `.js`**

With `module: "NodeNext"`, a relative import must name the file that will exist
at runtime. TypeScript compiles `chunking.ts` to `chunking.js`, so you write:

```ts
import { chunkCorpus } from "./chunking.js";   // correct
// import { chunkCorpus } from "./chunking";   // fails at runtime
```

`tsx` maps `.js` back to the `.ts` file it is actually running, so the same code
works from source and from a build.

---

## 1.6 `tsconfig.json` (full file)

**Path:** `tsconfig.json`

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
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Block-by-block explanation

**Block 1 — language level**

```json
"target": "ES2022",
"lib": ["ES2022"],
```

- `ES2022` gives native class fields, `Object.hasOwn`, and top-level `await` —
  and, more importantly for this project, `String.prototype.matchAll`-era
  RegExp features and the `d` flag behaviour the analyzer relies on.

**Block 2 — module resolution**

```json
"module": "NodeNext",
"moduleResolution": "NodeNext",
```

- `NodeNext` means *"resolve modules the way Node does"*: ESM, and relative
  imports must carry the real extension (`.js`). It is the setting that makes
  the code behave the same under `tsx` and under `node dist/server.js`.

**Block 3 — strictness**

```json
"strict": true,
```

- Turns on `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes` and the
  rest. This is what makes the type contracts in `services/` meaningful: a
  `Hit` without a `score` does not compile.

**Block 4 — emit options**

```json
"outDir": "./dist",
"rootDir": "./src",
"declaration": true,
"sourceMap": true,
"resolveJsonModule": true
```

- `outDir`/`rootDir` — a build would put `src/**` into `dist/**`. You do not
  need to build: `npm run typecheck` (`tsc --noEmit`) is the only compiler step.
- `declaration` — emit `.d.ts` type declarations if you build.
- `sourceMap` — emit source maps for debugging.
- `resolveJsonModule` — allow `import data from "./x.json"`.

**Block 5 — which files are compiled**

```json
"include": ["src/**/*"],
"exclude": ["node_modules", "dist"]
```

- `include` — type-check everything under `src/`.
- `exclude` — never look inside `node_modules/` or `dist/`.

---

## 1.7 `.env` and `.env.example` (full files)

**Path:** `Basic Code/.env.example` (committed template)

```dotenv
# ─────────────────────────────────────────────────────────────
# Lecture 12 — Advanced RAG (Basic Code).
# Every value below has a default, so the code runs with this
# file absent. Copy to `.env` to change a control.
# ─────────────────────────────────────────────────────────────

# ── Chapter 02/03 — chunking ────────────────────────────────
CHUNK_STRATEGY=structural      # fixed | structural
CHUNK_SIZE=40                  # tokens (words). Real default: 400-600
CHUNK_OVERLAP=8                # tokens. 8/40 = 20% (the board's example)

# ── Chapter 04 — top-K and the similarity floor ─────────────
K_RETRIEVE=10                  # candidates pulled from the index
K_CONTEXT=4                    # chunks that reach the prompt
MIN_SCORE=0.15                 # the floor; calibrated, never copied

# ── Chapter 05 — eligibility (the authorisation boundary) ───
TENANT_ID=northwind
ACL=support,customer
AS_OF=2026-06-01               # answers are as-of this date
CATEGORIES=electronics,damaged,product,general

# ── Chapter 06 — hybrid search + RRF ────────────────────────
HYBRID=rrf                     # off | rrf
RRF_K=60
BM25_K1=1.2
BM25_B=0.75

# ── Chapter 07 — reranking ──────────────────────────────────
RERANK=on                      # off | on
RERANK_MIN_BEST=0.2            # gate: best candidate must reach this

# ── Chapter 08 — context engineering ────────────────────────
MAX_CONTEXT_TOKENS=900         # budget cap; whole chunks are dropped

# ── Chapters 14–17 — the HTTP layer ─────────────────────────
PORT=3100                      # npm run dev → http://localhost:3100
```

**Path:** `Basic Code/.env` (your local copy — gitignored, same content)

```dotenv
CHUNK_STRATEGY=structural
CHUNK_SIZE=40
CHUNK_OVERLAP=8
K_RETRIEVE=10
K_CONTEXT=4
MIN_SCORE=0.15
TENANT_ID=northwind
ACL=support,customer
AS_OF=2026-06-01
CATEGORIES=electronics,damaged,product,general
HYBRID=rrf
RRF_K=60
BM25_K1=1.2
BM25_B=0.75
RERANK=on
RERANK_MIN_BEST=0.2
MAX_CONTEXT_TOKENS=900
PORT=3100
```

### Block-by-block explanation

**Block 1 — the controls are grouped by the chapter that owns them**

```dotenv
# ── Chapter 02/03 — chunking ────────────────────────────────
CHUNK_STRATEGY=structural
```

- Each comment names the lecture chapter the values below belong to. Reading the
  file top to bottom is reading the pipeline left to right.

**Block 2 — chunking is scaled down on purpose**

```dotenv
CHUNK_SIZE=40                  # tokens (words). Real default: 400-600
CHUNK_OVERLAP=8                # tokens. 8/40 = 20% (the board's example)
```

- The notes' real defaults are 400–600 tokens with 10–20% overlap. This corpus is
  seven short documents, so 40/8 keeps the *ratio* (20%) while making the cuts
  visible on screen.

**Block 3 — the two Ks**

```dotenv
K_RETRIEVE=10                  # candidates pulled from the index
K_CONTEXT=4                    # chunks that reach the prompt
```

- This is Chapter 04's **two-K architecture**: *retrieve generously, present
  sparingly*. Two numbers, two different jobs — one is recall, the other is
  precision and cost.

**Block 4 — the authorisation boundary**

```dotenv
TENANT_ID=northwind
ACL=support,customer
AS_OF=2026-06-01
```

- These three lines are Chapter 05's production requirements in configuration
  form. Note that they are **not** part of a question: a caller never sends a
  tenant, which is what stops the IDOR case in the notes.

**Block 5 — everything has a default**

Every value uses `??` in `config.ts`, so deleting `.env` does not break the
project — it just reverts to the same numbers. That is why the README can claim
`npm install && npm run ask` works on a clean checkout.

> **Why a `.env` at all?** So the eight controls are *configuration*, not *code*.
> The ablation in Chapter 12 is then just `{ ...config, ...overrides }` — one
> line, no code change.

---

## 1.8 What is intentionally missing

| Not present | Why |
|---|---|
| `dist/` | the project runs from source with `tsx`; nothing is built |
| a vector database | the store is an in-memory array (Chapter 06) |
| an embedding API / API key | the embedder hashes tokens (Chapter 05) |
| an LLM SDK | the generator is extractive (Chapter 10) |
| a database or a session store | every request is stateless; the corpus is a constant |
| auth middleware | there are no users in the demo — the *shape* of the boundary is the filter (Chapter 06) |
| a test runner | `npm run typecheck` plus the six CLI commands are the checks |
| a `build` script | not needed; `typecheck` is the only compiler step |

---

## 1.9 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm install          # if you have not already
npm run typecheck    # should print nothing and exit 0
npm run ask          # should print the trace, the assembled context and an answer
```

Expected: `typecheck` is silent (no errors) and `ask` ends with a two-sentence
extractive answer plus `citations: [2, 3]  refused: false`.

---

## 1.10 Checkpoint

Before moving on, you should be able to answer:

1. **Which file would you edit to change the chunk size** without touching any
   TypeScript? → `.env` (`CHUNK_SIZE`), read by `config/config.ts`.
2. **Which file does the model never see** but which does the real work? →
   `src/services/documents.ts` (the corpus) — the model only ever sees the
   assembled context from Chapter 09.
3. **Why do imports end in `.js` when the files are `.ts`?** → ESM + `NodeNext`
   resolution import the emitted file name; `tsx` maps it back to `.ts`.

**Next:** [Chapter 02 — Config: the eight controls](./02_Config_The_Eight_Controls.md)


