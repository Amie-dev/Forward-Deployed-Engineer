# Chapter 01: Data Contracts & Configuration

> **Chapter Goal:** Define the shapes that travel through the pipeline, and make the process refuse to start with an impossible configuration. Every later chapter reads and writes these types — fixing them first is what stops the pipeline from degenerating into string passing.

> **Lecture mapping:** Notes Chapter 01 (the model is stateless; the application owns everything it sends) and Chapter 02 (the two pipelines and their stages).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/types/rag.types.ts` | 97 | Chunk, record, match, citation, trace, report contracts. |
| `src/config/env.ts` | 105 | Zod-validated environment with provider-aware defaults. |
| `src/lib/errors.ts` | 30 | HTTP-aware errors so routes never guess a status code. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm install
cp .env.example .env      # optional: the system runs without it

npm run ingest            # proves config + contracts load
```

Then prove the validation actually validates:

```bash
CHUNK_OVERLAP=400 CHUNK_SIZE=300 npx tsx src/scripts/ingest.ts
# [env] Invalid configuration:
# { "CHUNK_OVERLAP": ["CHUNK_OVERLAP must be smaller than CHUNK_SIZE, or the window never advances."] }
# Error: Environment validation failed...
```

An overlap larger than the chunk size means the window never advances. The process must die at boot, not index the same 300 tokens forever.

---

## 2. The Contracts — `src/types/rag.types.ts`

#### 📄 `src/types/rag.types.ts`

```ts
/**
 * Data contracts for the RAG pipeline.
 *
 * Every stage reads and writes exactly one of these shapes. Keeping them in one
 * file is what stops the pipeline from turning into string-passing: you can see
 * where a chunk becomes a vector, and where a match becomes a citation.
 */

/** A file as it came off disk, before any chunking. */
export interface SourceDocument {
  /** File name — this is the label the customer eventually sees in a citation. */
  source: string;
  title: string;
  text: string;
}

/** The unit of retrieval. If the answer is not inside one chunk, it cannot be found. */
export interface Chunk {
  /** Deterministic id: sha256(source:index:text). Re-ingesting the same bytes is a no-op. */
  id: string;
  text: string;
  source: string;
  section: string;
  chunkIndex: number;
  tokens: number;
}

/** A chunk plus its embedding — the shape a vector store actually persists. */
export interface IndexRecord extends Chunk {
  vector: number[];
}

/** A chunk plus a similarity score — what retrieval returns. */
export interface Match extends Chunk {
  score: number;
}

/** A `[n]` marker in the answer, resolved back to the chunk it claims to cite. */
export interface Citation {
  label: number;
  chunkId: string;
  source: string;
  section: string;
  score: number;
  /** False when the model invented a label that was never in the prompt. */
  valid: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One completed exchange, kept for continuity and query rewriting. */
export interface Turn {
  question: string;
  answer: string;
  /** The query that was actually sent to retrieval (after rewriting). */
  searchQuery: string;
  at: number;
}

/** Everything needed to explain one answer without a debugger. */
export interface RagTrace {
  question: string;
  searchQuery: string;
  topK: number;
  candidates: number;
  matches: Array<{ id: string; score: number; source: string; section: string }>;
  contextTokens: number;
  citations: number;
  invalidCitations: number;
  refused: boolean;
  providers: { embedding: string; generation: string };
  latencyMs: { embed: number; search: number; generate: number; total: number };
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  refused: boolean;
  sessionId: string;
  trace: RagTrace;
}

/** The result of one ingestion run — the numbers you alert on. */
export interface IngestReport {
  documents: number;
  chunks: number;
  tokens: number;
  /** Files that produced no usable text (scanned PDFs, empty files). */
  skipped: string[];
  /** Sources deleted because they no longer exist on disk. */
  staleSourcesRemoved: string[];
  durationMs: number;
  store: string;
}
```

**Block by block:**

- **`SourceDocument`** — a file after extraction, before chunking. `source` is the file name and it survives all the way to the citation the customer reads. `title` comes from the first markdown `H1`, or from the file name.
- **`Chunk`** — the unit of retrieval. Note what it carries: `id`, `text`, `source`, `section`, `chunkIndex`, `tokens`. Chapter 03 decides the text; `section` exists so a citation can say *"refund-policy.md · Refund window"* instead of just *"refund-policy.md"*.
- **`IndexRecord extends Chunk`** — the same thing plus `vector`. Keeping the vector in a separate type means the prompt builder cannot accidentally serialise a 1,024-float array into the model's context.
- **`Match extends Chunk`** — plus `score`. Retrieval returns matches; generation receives matches; nothing downstream needs the raw vector.
- **`Citation`** — the resolved form of a `[n]` marker, including `valid: false` for a label the model invented. That boolean is the cheapest hallucination signal in the system.
- **`Turn`** — one completed exchange. `searchQuery` is stored next to `question` on purpose: chapter 11 rewrites follow-ups, and the rewrite is what future turns should build on, not the raw fragment.
- **`RagTrace`** — the observability contract. `matches[]` with scores, `contextTokens`, `invalidCitations`, `refused`, and `latencyMs` per stage. If this is absent, every RAG bug becomes an argument.
- **`IngestReport`** — the ingestion contract: documents, chunks, tokens, `skipped` (files with no extractable text), `staleSourcesRemoved`. Those four numbers are what you alert on.
- **`ChatMessage`** — the only shape a generation provider accepts besides `instructions`. Deliberately narrow: `system` is not allowed here, because retrieved text must never be able to become a system message.

The types are `interface`, not `type`, so they can be extended and so editor tooling shows them by name in errors.

---

## 3. Configuration — `src/config/env.ts`

#### 📄 `src/config/env.ts`

```ts
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * Boot-time configuration.
 *
 * Fail fast and loudly: a missing key or an impossible chunk size should stop
 * the process, not surface as a 500 on the first customer question.
 *
 * Both provider pairs default to "auto": if an OpenAI key exists you get real
 * embeddings and a real model, otherwise the deterministic offline pair. That
 * keeps `npm run demo` and `npm run eval` runnable with no account.
 */
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    EMBEDDING_PROVIDER: z.enum(['openai', 'mock']).optional(),
    EMBEDDING_MODEL: z.string().trim().optional(),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(1024),

    LLM_PROVIDER: z.enum(['openai', 'extractive']).optional(),
    CHAT_MODEL: z.string().trim().default('gpt-4o-mini'),
    OPENAI_API_KEY: z.string().trim().optional(),

    KNOWLEDGE_DIR: z.string().default('knowledge'),
    CHUNK_SIZE: z.coerce.number().int().min(50).max(2000).default(300),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).max(1000).default(50),
    AUTO_INGEST: booleanString.default('true'),

    TOP_K: z.coerce.number().int().min(1).max(20).default(4),
    CANDIDATE_MULTIPLIER: z.coerce.number().int().min(1).max(10).default(3),
    MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.15),
    HYBRID_LEXICAL_WEIGHT: z.coerce.number().min(0).max(1).default(0.35),
    MAX_CONTEXT_TOKENS: z.coerce.number().int().min(100).max(16000).default(1200),

    HISTORY_TURNS: z.coerce.number().int().min(0).max(50).default(6),
    SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),

    VECTOR_STORE: z.enum(['memory', 'pinecone']).default('memory'),
    INDEX_PATH: z.string().default('data/index.json'),
    PINECONE_API_KEY: z.string().trim().optional(),
    PINECONE_INDEX_NAME: z.string().default('shop-support'),
    PINECONE_NAMESPACE: z.string().default('policies'),
  })
  .superRefine((value, context) => {
    const embeddingProvider = value.EMBEDDING_PROVIDER ?? (value.OPENAI_API_KEY ? 'openai' : 'mock');
    const llmProvider = value.LLM_PROVIDER ?? (value.OPENAI_API_KEY ? 'openai' : 'extractive');

    if (embeddingProvider === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.',
      });
    }
    if (llmProvider === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai.',
      });
    }
    if (value.VECTOR_STORE === 'pinecone' && !value.PINECONE_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PINECONE_API_KEY'],
        message: 'PINECONE_API_KEY is required when VECTOR_STORE=pinecone.',
      });
    }
    if (value.CHUNK_OVERLAP >= value.CHUNK_SIZE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP'],
        message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE, or the window never advances.',
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] Invalid configuration:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  throw new Error('Environment validation failed. Copy .env.example to .env and fill it in.');
}

const raw = parsed.data;
const embeddingProvider = raw.EMBEDDING_PROVIDER ?? (raw.OPENAI_API_KEY ? 'openai' : 'mock');
const llmProvider = raw.LLM_PROVIDER ?? (raw.OPENAI_API_KEY ? 'openai' : 'extractive');

export const env = {
  ...raw,
  EMBEDDING_PROVIDER: embeddingProvider,
  EMBEDDING_MODEL:
    raw.EMBEDDING_MODEL || (embeddingProvider === 'mock' ? 'mock-hash-v1' : 'text-embedding-3-small'),
  LLM_PROVIDER: llmProvider,
  KNOWLEDGE_DIR: path.resolve(CODE_ROOT, raw.KNOWLEDGE_DIR),
  INDEX_PATH: path.resolve(CODE_ROOT, raw.INDEX_PATH),
} as const;

export type Env = typeof env;
```

**Block by block:**

- **`import 'dotenv/config'`** — loads `.env` before the schema runs. Variables already exported by the shell win, which is what you want in CI and containers.
- **`CODE_ROOT`** — `src/config/env.ts` sits two levels down, and the compiled `dist/config/env.js` sits at the same depth. Resolving from the module URL means `KNOWLEDGE_DIR=knowledge` works from the project root regardless of the current working directory.
- **`booleanString`** — `AUTO_INGEST=false` must be `false`. `z.coerce.boolean()` converts the non-empty string `"false"` to `true`, which is a classic production incident. The enum transform does not.
- **`EMBEDDING_PROVIDER` / `LLM_PROVIDER` are `.optional()`** — not defaulted. Absence has a *meaning*: auto-select. Defaulting them to `mock` would silently ignore a key that is present.
- **`EMBEDDING_DIMENSIONS` (64–3072, default 1024)** — the same number is sent at ingestion and at query time. The range guards against a typo like `10240`.
- **`CHUNK_SIZE` (50–2000) / `CHUNK_OVERLAP` (0–1000)** — bounds that a real document set can live with. Below 50 tokens a chunk stops carrying a whole rule.
- **`TOP_K` max 20** — a hard ceiling on how much context can be requested, regardless of what a caller asks for.
- **`MIN_SCORE` (-1…1)** — the full cosine range, because a real embedding model's useful floor differs from the mock's.
- **`HYBRID_LEXICAL_WEIGHT` (0…1)** — `0` reproduces pure vector search; `1` is pure keyword matching. Making it a number instead of a boolean is what allows tuning it.
- **`VECTOR_STORE` enum** — a typo becomes a validation error instead of a silent fallback to memory.
- **`superRefine`** — cross-field rules, the part a per-field schema cannot express:
  - `openai` embeddings without a key → error naming `OPENAI_API_KEY`.
  - `openai` generation without a key → same.
  - `pinecone` without a key → error naming `PINECONE_API_KEY`.
  - `CHUNK_OVERLAP >= CHUNK_SIZE` → error, because the slide would never advance and ingestion would loop.
- **`safeParse` + throw** — a bad environment prints a field map and exits. A container should crash-loop on misconfiguration rather than serve 500s to customers.
- **Provider resolution after validation** — `EMBEDDING_PROVIDER ?? (OPENAI_API_KEY ? 'openai' : 'mock')`. The decision is made once, at boot, and the exported object always has concrete values, so no downstream code handles `undefined`.
- **Model defaults** — `mock-hash-v1` or `text-embedding-3-small`. Chapter 05 explains why the model name must be recorded next to the vectors.
- **`as const`** — makes `env` readonly, so a route cannot reassign `env.TOP_K` at runtime.

### Why directories are resolved, not trusted

`KNOWLEDGE_DIR` and `INDEX_PATH` are resolved against `CODE_ROOT` at boot. A relative path in `.env` is therefore independent of `process.cwd()`, and `npm run demo` works from any directory. `path.resolve` leaves absolute paths untouched, so an operator can still point at `/mnt/documents`.

---

## 4. Errors — `src/lib/errors.ts`

#### 📄 `src/lib/errors.ts`

```ts
/** Errors that carry an HTTP status, so routes never guess a status code. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, code = 'BAD_REQUEST') {
    super(message, 400, code);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, code = 'SERVICE_UNAVAILABLE') {
    super(message, 503, code);
  }
}
```

**Block by block:**

- **`HttpError`** — carries `status` and a machine-readable `code` next to the message. The route layer maps it without a `switch` on message text.
- **`BadRequestError` / `NotFoundError` / `ServiceUnavailableError`** — the three that actually occur here: invalid input, unknown session, provider down.
- **Why not return `{ error }` objects** — throwing keeps the happy path flat. `ask()` reads as six steps, and the error handler is the single place that decides what a client sees.
- **Why not leak provider messages** — the handler logs the real error and returns a generic message for unknown failures. An OpenAI stack trace is not a customer-facing artefact.

---

## 5. Verify the Chapter

```bash
npx tsc --noEmit                 # contracts + config compile under strict mode
npm run ingest                   # boots, validates env, writes data/index.json
cat data/index.json | head -c 200
```

Expected: a snapshot whose first bytes look like

```json
{"version":1,"model":"mock-hash-v1","dimensions":1024,"records":[{"id":"…"
```

`model` and `dimensions` are stored **with** the vectors. That is the contract from chapter 01 of the notes: a vector without its model is a number with no meaning.

---

## 6. What This Chapter Prevents

| Failure | Prevented by |
| :--- | :--- |
| Query embedded with 1536 dims against a 1024-dim index | `EMBEDDING_DIMENSIONS` in one validated config, used by both paths |
| Index built with `text-embedding-3-small`, queried with `mock` | `model` recorded in the snapshot; the store refuses to load a mismatched index |
| Infinite ingestion loop | `CHUNK_OVERLAP < CHUNK_SIZE` enforced at boot |
| 500s instead of a clear startup error | `superRefine` + `safeParse` |
| A `[7]` citation with no source | `Citation.valid` is part of the contract, not an afterthought |

**Next:** [Chapter 02 — Text, Vector & Retry Utilities](./02_Text_Vector_and_Retry_Utilities.md)
