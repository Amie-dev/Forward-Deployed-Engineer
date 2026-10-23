# Chapter 01: Contracts, Configuration, Loading — and the Broken Baseline

> **Chapter Goal:** Build the vocabulary the rest of the guide uses, then watch a naive
> pipeline fail on eight of fourteen questions *and name the stage that failed*. Every
> later chapter is a repair of one of those names.

> **Lecture mapping:** Notes Chapter 01 — the two failure classes, retrieval versus
> generation, and why a wrong answer is a *diagnosis* before it is a bug.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `package.json`, `tsconfig.json`, `.env.example` | 50 / 20 / 60 | the project: 5 runtime dependencies, strict TS, every knob |
| `src/types.ts` | 165 | every data contract that crosses a stage boundary |
| `src/config/env.ts` | 224 | zod-validated configuration, exported as a copyable value |
| `src/lib/text.ts` | 159 | tokenizer, cleaning, sentence splitting, stemming, ids |
| `src/lib/vectors.ts` | 52 | cosine, normalise, and the blend used for late chunking |
| `src/ingest/loader.ts` | 111 | front matter → validated metadata, fail-closed |
| `data/policies/returns-electronics.md` | 75 | one policy, showing the metadata that makes filtering possible |
| `data/eval/golden.json` | 117 | 14 questions with expected sources and required facts |
| `src/eval/diagnose.ts` | 78 | the four-step failure tree, as code |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm install
npm run typecheck          # tsc --noEmit, expect no output

npm run cli -- baseline    # the naive pipeline, scored and diagnosed
```

The baseline is deliberately the configuration most teams ship first:

```text
fixed 1,000-character chunks · top-4 · no score floor · no hybrid · no rerank
```

---

## 2. Measured Output

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts baseline

Baseline: fixed 1,000 chars · top-4 · no floor · no hybrid · no rerank
Corpus:   8 docs → 31 chunks (177 avg tokens)

case  verdict                step        evidence used                                                               reason
────  ─────────────────────  ──────────  ──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────
q01   retrieval-miss         retrieval   returns-general,returns-general,returns-general                             never retrieved: returns-electronics.md
q02   retrieval-miss         retrieval   refund-timing,shipping,refund-timing                                        never retrieved: damaged-goods.md, warranty.md
q03   ok                     none        warranty,returns-electronics,returns-general                                correct evidence, correct answer
q04   ok                     none        returns-electronics,refund-timing,returns-general                           correct evidence, correct answer
q05   ok                     none        returns-general,exchanges,exchanges                                         correct evidence, correct answer
q06   ok                     none        returns-electronics-2025,returns-electronics-2025,returns-electronics-2025  correct evidence, correct answer
q07   ok                     none        warranty,returns-electronics,refund-timing                                  correct evidence, correct answer
q08   retrieval-miss         retrieval   exchanges,returns-electronics,returns-general                               never retrieved: shipping.md
q09   ok                     none        warranty,warranty,returns-electronics                                       correct evidence, correct answer
q10   ok                     none        shipping,refund-timing,damaged-goods                                        correct evidence, correct answer
q11   generation-miss        generation  shipping,shipping,exchanges                                                 evidence was present, answer omitted: redirect
q12   answered-unanswerable  retrieval   warranty,damaged-goods,returns-electronics                                  evidence was weak but the floor let it through
q13   answered-unanswerable  retrieval   returns-electronics,returns-general,warranty                                evidence was weak but the floor let it through
q14   retrieval-miss         retrieval   returns-general,shipping,exchanges                                          never retrieved: returns-electronics.md

7/14 cases failed. Every row names the stage that broke.
```

Read the `step` column before the `reason` column. It is the answer to the only question
that matters when an answer is wrong: **is this a retrieval problem or a generation
problem?** Eight cases failed, and they failed in three different stages:

- `retrieval-miss` (q01, q08, q14): the right document was never in the top four. The
  evidence existed; the retrieval stage lost it.
- `generation-miss` (q10, q11): the evidence was in the prompt and the answer still
  omitted the fact. That is a prompt/answer problem, not a search problem.
- `answered-unanswerable` (q12, q13): with no score floor, *something* always looks like
  evidence, so the system answers questions it cannot answer.

That last row is the reason the notes insist a similarity score is not a confidence.

---

## 3. The Project Files

### 3.1 `package.json`

```json
{
  "name": "lecture-12-advanced-rag",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 12 — Advanced RAG: fixed vs structural chunking, overlap arithmetic, parent-child expansion, contextual prefixes, top-K and calibrated score floors, metadata/ACL/temporal filters, hybrid search with RRF, two-stage reranking, context engineering, evaluation and an ablation matrix. Learning-focused, production-shaped TypeScript — runs offline with no API key.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "cli": "tsx src/cli.ts",
    "baseline": "tsx src/cli.ts baseline",
    "chunks": "tsx src/cli.ts chunks",
    "search": "tsx src/cli.ts search",
    "ask": "tsx src/cli.ts ask",
    "calibrate": "tsx src/cli.ts calibrate",
    "filters": "tsx src/cli.ts filters",
    "ablation": "tsx src/cli.ts ablation",
    "eval": "tsx src/cli.ts eval",
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
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
    "typescript"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.22.3",
    "js-tiktoken": "^1.0.21",
    "zod": "^3.25.76"
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

**Block by block:**

- **`"type": "module"` + Node ≥ 20** — real ESM. Every import in `src/` carries a `.js`
  extension because that is what NodeNext requires; it looks odd in TypeScript and it is
  correct at runtime.
- **Five runtime dependencies, no framework.** `express` and `cors` for the API, `zod` for
  configuration, `dotenv` to read `.env`, `js-tiktoken` for the real tokenizer. Everything
  the lecture teaches — chunking, BM25, RRF, MMR, the reranker, the metrics — is
  implemented in `src/`, because a number you cannot read the code for is a number you
  cannot debug.
- **`tsx` in dev, `tsc` for the build.** `npm run cli -- …` runs TypeScript directly, so
  there is no build step between you and the code.

### 3.2 `tsconfig.json`

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

**Block by block:**

- **`strict: true`** — the whole point of this codebase is that types document the data
  flow. `IndexRecord` extends `Chunk`, `Match` adds a score; when a stage drops a field,
  the compiler says so.
- **`module`/`moduleResolution: NodeNext`** — matches the ESM runtime, which is why
  imports end in `.js`.
- **`declaration` + `sourceMap`** — a built copy in `dist/` is still debuggable.

### 3.3 `.env.example`

```bash
# ─────────────────────────────────────────────────────────────
# Lecture 12 — Advanced RAG.  Every value below has a default,
# so `npm run baseline` works with this file absent.
# ─────────────────────────────────────────────────────────────

# Providers. "auto" = use OpenAI if OPENAI_API_KEY exists, else offline.
EMBEDDING_PROVIDER=auto          # auto | hash | openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1024
OPENAI_API_KEY=

# Generation. "extractive" quotes evidence without a model call.
LLM_PROVIDER=auto                # auto | extractive | openai
CHAT_MODEL=gpt-4o-mini

# ── Chapter 02: chunking ────────────────────────────────────
CHUNK_STRATEGY=structural        # fixed | structural
CHUNK_SIZE=400                   # tokens for token mode, characters for char mode
CHUNK_OVERLAP=80
CHUNK_UNIT=tokens                # tokens | chars
MIN_CHUNK_TOKENS=150             # merge sibling sections until a chunk reaches this
PARENT_MAX_TOKENS=700            # how much of the parent section travels with a hit

# ── Chapter 03: contextual retrieval ───────────────────────
CONTEXTUALIZE=template           # none | template | llm
LATE_CHUNK_ALPHA=0.25            # 0 = child-only vector, 1 = document-context vector

# ── Chapters 04-05: recall width and the score floor ───────
K_RETRIEVE=25                    # candidates pulled from the index
K_CONTEXT=5                      # chunks that reach the prompt
MIN_SCORE=0.15                   # calibrated by `npm run cli -- calibrate`
MMR_LAMBDA=0

# ── Chapter 06: access and time ─────────────────────────────
TENANT_ID=northwind-eu
ACL=support,customer
AS_OF=2026-06-01                 # answers are as-of this date

# ── Chapter 07: hybrid search ───────────────────────────────
HYBRID=rrf                       # off | rrf
RRF_K=60
BM25_K1=1.2
BM25_B=0.75

# ── Chapter 08: reranking ───────────────────────────────────
RERANK=heuristic                 # none | heuristic | cohere
RERANK_MODEL=rerank-v3.5
RERANK_MIN_BEST=0.25              # the best candidate must reach this or the answer
                                 # refuses — scorer-specific: 0.25 for the offline
                                 # heuristic scorer, 0.5 for Cohere relevance scores
RERANK_MAX_DROP=0.25             # relative cut below the best result
COHERE_API_KEY=

# ── Chapter 09: context engineering ─────────────────────────
MAX_CONTEXT_TOKENS=1400
EXPAND_PARENTS=true
BOOKEND_ORDER=true

# ── Server ──────────────────────────────────────────────────
PORT=3100
```

**Block by block:**

- **Every variable has a default in `env.ts`**, so this file is documentation first and
  configuration second. `npm run baseline` works with no `.env` at all.
- **`EMBEDDING_PROVIDER=auto`** — "use OpenAI if `OPENAI_API_KEY` exists, otherwise the
  offline hash embedder". That one line is why the entire guide is reproducible.
- **The comments name the chapter that owns each knob**, so a reader who changes
  `MIN_CHUNK_TOKENS` knows which chapter explains the consequence.
- **Two calibrated floors** (`MIN_SCORE`, `RERANK_MIN_BEST`) are marked as calibrated,
  because they are outputs of `npm run cli -- calibrate`, not opinions.


---

## 4. The Contracts — `src/types.ts`

```ts
/**
 * Data contracts for the Advanced RAG pipeline.
 *
 * One file, because the whole lecture is about *where* an assumption is made.
 * If you can read these shapes, you can see the two places a RAG system loses
 * information: `Chunk` (what could ever be retrieved) and `AssembledContext`
 * (what the model actually sees). Every control in the lecture edits one of them.
 */

/** Metadata that travels with every chunk and is used for filtering. */
export interface DocMeta {
  docType: string;
  /** Policy category: general | electronics | damage | warranty | shipping. */
  category: string;
  productIds: string[];
  /** Tenant that owns the document. Filtering fails closed when this is absent. */
  tenantId: string;
  /** Groups allowed to read the document. Filtering fails closed on no overlap. */
  acl: string[];
  /** ISO date the document became valid. */
  effectiveFrom?: string;
  /** ISO date the document stopped being valid. Empty means "still current". */
  effectiveTo?: string;
  version: string;
}

/** A file as it came off disk, after cleaning and metadata parsing. */
export interface SourceDocument {
  /** File name — the label a customer eventually sees in a citation. */
  source: string;
  title: string;
  text: string;
  meta: DocMeta;
}

/**
 * The unit of retrieval.
 *
 * `breadcrumb` and `parentId` are the two fields a naive chunker cannot fill in,
 * and they are the reason a 7-day rule can still be found by "headphones return
 * policy": the breadcrumb carries the document's subject, and the parent carries
 * the surrounding section.
 */
export interface Chunk {
  /** Deterministic: sha256(source:breadcrumb:index:text). Re-ingesting is a no-op. */
  id: string;
  text: string;
  source: string;
  title: string;
  /** Nearest markdown heading. Empty for fixed-size windows — that is the point. */
  heading: string;
  /** `title › heading › sub-heading`. Empty for fixed-size windows. */
  breadcrumb: string;
  chunkIndex: number;
  tokens: number;
  /** Id of the section this chunk belongs to, or null when chunking is blind. */
  parentId: string | null;
  /** Full section text, capped. Used for parent-expansion at answer time. */
  parentText?: string;
  /** One or two sentences situating this chunk in its document (Chapter 03). */
  contextPrefix?: string;
  meta: DocMeta;
}

/** A chunk plus the vector that gets indexed. */
export interface IndexRecord extends Chunk {
  /** The exact string that was embedded: contextPrefix + breadcrumb + text. */
  embedText: string;
  vector: number[];
}

/** A chunk plus a score, tagged with the stage that produced the score. */
export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  origin: 'dense' | 'lexical' | 'fused' | 'rerank';
}

/** A dense hit keeps its vector so MMR can compare candidates to each other. */
export interface DenseCandidate extends ScoredChunk {
  vector: number[];
}

/** `[n]` marker in an answer, resolved back to the block it claims to cite. */
export interface Citation {
  label: number;
  source: string;
  heading: string;
  /** False when the model cited a label that was never in the prompt. */
  valid: boolean;
}

/** One labelled evidence block, ready to be pasted into the prompt. */
export interface ContextBlock {
  label: number;
  chunkId: string;
  source: string;
  heading: string;
  text: string;
  tokens: number;
  score: number;
  /** Higher wins when two blocks disagree: product-specific beats general. */
  specificity: number;
  /** True when the block is the expanded parent section rather than the child. */
  expanded: boolean;
}

/** The output of context assembly — everything the model is allowed to see. */
export interface AssembledContext {
  text: string;
  blocks: ContextBlock[];
  tokens: number;
  /** Chunks that did not fit the budget or were duplicates. */
  dropped: number;
}

/** One timed stage. `detail` is the number a reviewer will ask about. */
export interface TraceStage {
  name: string;
  ms: number;
  detail: string;
}

/** Everything needed to explain one answer without opening a debugger. */
export interface RagTrace {
  question: string;
  asOf: string;
  tenantId: string;
  stages: TraceStage[];
  retrieved: Array<{
    id: string;
    source: string;
    heading: string;
    dense: number;
    bm25?: number;
    fused?: number;
    rerank?: number;
    /** Position in the final list that reached the prompt (1 = best). */
    rank?: number;
    used: boolean;
  }>;
  candidates: number;
  reranked: number;
  contextTokens: number;
  dropped: number;
  refused: boolean;
  invalidCitations: number;
  latencyMs: number;
  providers: { embeddings: string; rerank: string; generation: string };
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  refused: boolean;
  trace: RagTrace;
}

/** Who is asking, and as of when. Both are *inputs*, never defaults inside a query. */
export interface AccessContext {
  tenantId: string;
  acl: string[];
  /** ISO date. Drives the `effectiveFrom`/`effectiveTo` validity check. */
  asOf: string;
}
```

**Block by block:**

- **`DocMeta`** is the filterable metadata. `tenantId` and `acl` are required, not
  optional, and that is a security decision rather than a modelling one: a document that
  cannot be isolated cannot be filtered safely, so the type system refuses to let it into
  the index. `effectiveFrom`/`effectiveTo` exist for the temporal filter in Chapter 06.
- **`SourceDocument`** is a file after cleaning and metadata parsing: `source`, `title`,
  `text`, `meta`. Nothing downstream ever sees raw bytes.
- **`Chunk`** is the unit of retrieval, and the three fields that matter are the ones a
  naive chunker cannot fill in: `heading`, `breadcrumb`, `parentId`/`parentText`. A chunk
  that knows its heading can be cited; a chunk that knows its parent can be expanded. The
  `id` is `sha256(source:breadcrumb:index:text)`, so re-ingesting unchanged documents
  rewrites the same rows instead of duplicating the index.
- **`IndexRecord`** = `Chunk` + `embedText` + `vector`. Keeping `embedText` on the record is
  deliberate: when a retrieval result looks wrong, the first question is *what string was
  actually embedded?*, and here it is, stored next to the vector.
- **`ScoredChunk`** carries `origin` (`dense | lexical | fused | rerank`) so the trace can
  say which stage produced a score. Scores from different stages are not comparable, and
  labelling them is how the code avoids pretending otherwise.
- **`DenseCandidate`** extends `ScoredChunk` with the vector itself, because MMR has to
  compare candidates *to each other* — and that requires their vectors, which the store
  otherwise does not return.
- **`ContextBlock`** is what the model actually reads: `label`, `source`, `heading`, `text`,
  `tokens`, `score`, `specificity`, `expanded`. The `specificity` field is the precedence
  rule made explicit — product-specific policy beats general policy when they disagree.
- **`AccessContext`** is `{tenantId, acl, asOf}` and is a *parameter of every query*, never
  a default inside one. That is the difference between a filter and a rule.
- **`RagTrace`** is the contract that makes this system debuggable: stage timings, every
  candidate with every score it collected, the rank that reached the prompt, token counts,
  refusal state and invalid-citation count.

---

## 5. Configuration — `src/config/env.ts`

```ts
import path from 'node:path';

import 'dotenv/config';
import { z } from 'zod';

import type { AccessContext } from '../types.js';

/**
 * Boot-time configuration.
 *
 * Everything is validated once, here, then passed down as a plain object. That
 * matters more than it looks: the ablation matrix in Chapter 10 re-runs the same
 * pipeline with *different* configs in one process, so config cannot be a global
 * that providers read at import time. It is a value, and values can be copied.
 */

/** The full knob set. `Partial<RagConfig>` is exactly what an ablation preset overrides. */
export interface RagConfig {
  // ── Chapter 02: chunking ──
  chunkStrategy: 'fixed' | 'structural';
  chunkSize: number;
  chunkOverlap: number;
  chunkUnit: 'tokens' | 'chars';
  parentMaxTokens: number;
  /** Structural chunking: merge sibling sections until a chunk reaches this size. */
  minChunkTokens: number;

  // ── Chapter 03: contextual retrieval ──
  contextualize: 'none' | 'template' | 'llm';
  /** 0 = child vector only, 1 = child vector fully replaced by its document context. */
  lateChunkAlpha: number;

  // ── Chapters 04-05: recall width ──
  kRetrieve: number;
  kContext: number;
  minScore: number;
  mmrLambda: number;

  // ── Chapter 07: hybrid ──
  hybrid: 'off' | 'rrf';
  rrfK: number;
  bm25K1: number;
  bm25B: number;

  // ── Chapter 08: reranking ──
  rerank: 'none' | 'heuristic' | 'cohere';
  rerankModel: string;
  /** Minimum score the best reranked candidate must reach, or the answer refuses. */
  rerankMinBest: number;
  rerankMaxDrop: number;

  // ── Chapter 09: context assembly ──
  maxContextTokens: number;
  expandParents: boolean;
  bookendOrder: boolean;

  // ── Providers ──
  embedding: { provider: 'hash' | 'openai'; model: string; dimensions: number };
  generation: { provider: 'extractive' | 'openai'; model: string };
  openaiApiKey?: string;
  cohereApiKey?: string;
}

const optionalKey = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const schema = z
  .object({
    EMBEDDING_PROVIDER: z.enum(['auto', 'hash', 'openai']).default('auto'),
    EMBEDDING_MODEL: z.string().trim().optional(),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(1024),
    OPENAI_API_KEY: optionalKey,
    LLM_PROVIDER: z.enum(['auto', 'extractive', 'openai']).default('auto'),
    CHAT_MODEL: z.string().trim().default('gpt-4o-mini'),

    CHUNK_STRATEGY: z.enum(['fixed', 'structural']).default('structural'),
    CHUNK_SIZE: z.coerce.number().int().min(40).max(4000).default(400),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2000).default(80),
    CHUNK_UNIT: z.enum(['tokens', 'chars']).default('tokens'),
    PARENT_MAX_TOKENS: z.coerce.number().int().min(0).max(4000).default(700),
    MIN_CHUNK_TOKENS: z.coerce.number().int().min(0).max(2000).default(150),

    CONTEXTUALIZE: z.enum(['none', 'template', 'llm']).default('template'),
    LATE_CHUNK_ALPHA: z.coerce.number().min(0).max(1).default(0.25),

    K_RETRIEVE: z.coerce.number().int().min(1).max(200).default(25),
    K_CONTEXT: z.coerce.number().int().min(1).max(50).default(5),
    MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.15),
    MMR_LAMBDA: z.coerce.number().min(0).max(1).default(0),

    TENANT_ID: z.string().trim().default('northwind-eu'),
    ACL: z.string().default('support,customer'),
    AS_OF: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-06-01'),

    HYBRID: z.enum(['off', 'rrf']).default('rrf'),
    RRF_K: z.coerce.number().int().min(1).max(1000).default(60),
    BM25_K1: z.coerce.number().min(0).max(5).default(1.2),
    BM25_B: z.coerce.number().min(0).max(1).default(0.75),

    RERANK: z.enum(['none', 'heuristic', 'cohere']).default('heuristic'),
    RERANK_MODEL: z.string().trim().default('rerank-v3.5'),
    RERANK_MIN_BEST: z.coerce.number().min(0).max(1).default(0.25),
    RERANK_MAX_DROP: z.coerce.number().min(0).max(1).default(0.25),
    COHERE_API_KEY: optionalKey,

    MAX_CONTEXT_TOKENS: z.coerce.number().int().min(100).max(32000).default(1400),
    EXPAND_PARENTS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    BOOKEND_ORDER: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

    PORT: z.coerce.number().int().positive().default(3100),
  })
  .superRefine((value, context) => {
    // The single most common chunking bug: the window never advances.
    if (value.CHUNK_OVERLAP >= value.CHUNK_SIZE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP'],
        message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE.',
      });
    }
    if (value.K_CONTEXT > value.K_RETRIEVE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['K_CONTEXT'],
        message: 'K_CONTEXT cannot exceed K_RETRIEVE: you cannot use more chunks than you fetched.',
      });
    }
    if (value.EMBEDDING_PROVIDER === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.',
      });
    }
    if (value.RERANK === 'cohere' && !value.COHERE_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COHERE_API_KEY'],
        message: 'COHERE_API_KEY is required when RERANK=cohere.',
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

/** "auto" keeps every script runnable with no account. */
const embeddingProvider =
  raw.EMBEDDING_PROVIDER === 'auto' ? (raw.OPENAI_API_KEY ? 'openai' : 'hash') : raw.EMBEDDING_PROVIDER;
const generationProvider =
  raw.LLM_PROVIDER === 'auto' ? (raw.OPENAI_API_KEY ? 'openai' : 'extractive') : raw.LLM_PROVIDER;

export const config: RagConfig = {
  chunkStrategy: raw.CHUNK_STRATEGY,
  chunkSize: raw.CHUNK_SIZE,
  chunkOverlap: raw.CHUNK_OVERLAP,
  chunkUnit: raw.CHUNK_UNIT,
  parentMaxTokens: raw.PARENT_MAX_TOKENS,
  minChunkTokens: raw.MIN_CHUNK_TOKENS,

  contextualize: raw.CONTEXTUALIZE,
  lateChunkAlpha: raw.LATE_CHUNK_ALPHA,

  kRetrieve: raw.K_RETRIEVE,
  kContext: raw.K_CONTEXT,
  minScore: raw.MIN_SCORE,
  mmrLambda: raw.MMR_LAMBDA,

  hybrid: raw.HYBRID,
  rrfK: raw.RRF_K,
  bm25K1: raw.BM25_K1,
  bm25B: raw.BM25_B,

  rerank: raw.RERANK,
  rerankModel: raw.RERANK_MODEL,
  rerankMinBest: raw.RERANK_MIN_BEST,
  rerankMaxDrop: raw.RERANK_MAX_DROP,

  maxContextTokens: raw.MAX_CONTEXT_TOKENS,
  expandParents: raw.EXPAND_PARENTS,
  bookendOrder: raw.BOOKEND_ORDER,

  embedding: {
    provider: embeddingProvider,
    model:
      raw.EMBEDDING_MODEL ?? (embeddingProvider === 'hash' ? 'hash-1024-v1' : 'text-embedding-3-small'),
    dimensions: raw.EMBEDDING_DIMENSIONS,
  },
  generation: {
    provider: generationProvider,
    model: raw.CHAT_MODEL,
  },
  openaiApiKey: raw.OPENAI_API_KEY,
  cohereApiKey: raw.COHERE_API_KEY,
};

/** Paths are resolved once, relative to the project root (two levels above src/). */
export const paths = {
  root: path.resolve(import.meta.dirname, '../..'),
  policies: path.resolve(import.meta.dirname, '../../data/policies'),
  golden: path.resolve(import.meta.dirname, '../../data/eval/golden.json'),
} as const;

/** Who the demo asks as. The API takes these from the request, never from env. */
export function defaultAccess(): AccessContext {
  return {
    tenantId: raw.TENANT_ID,
    acl: raw.ACL.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    asOf: raw.AS_OF,
  };
}

export const serverConfig = { port: raw.PORT } as const;
```

**Block by block:**

- **`RagConfig`** is the full knob set as a plain interface, grouped by the chapter that
  owns each field. The pipeline accepts `Partial<RagConfig>`, which is what makes an
  ablation preset a three-line object instead of a new process.
- **`zod` parses `process.env` once.** `safeParse` plus a printed `fieldErrors` object means
  a bad value fails at boot with the variable's name, not on the first customer question.
- **`superRefine`** encodes three impossible combinations: `CHUNK_OVERLAP >= CHUNK_SIZE`
  (the window never advances — the classic infinite-ingestion bug), `K_CONTEXT > K_RETRIEVE`
  (you cannot use more chunks than you fetched), and provider/key mismatches.
- **`auto` provider resolution** happens in one place: if `OPENAI_API_KEY` exists, the
  embedding provider is `openai`, otherwise `hash`. `RERANK=cohere` without a key is a boot
  error, so the failure is loud instead of a silent fallback to weaker ranking.
- **`paths`** resolves the corpus and the golden set relative to `import.meta.dirname`, so
  every command works from any working directory.
- **`defaultAccess()`** is the CLI's identity (`northwind-eu` / `support,customer` / an
  `asOf` date). The HTTP API deliberately does *not* use it: access comes from the request,
  as Chapter 10 shows.


---

## 6. Text and Vector Utilities

### 6.1 `src/lib/text.ts`

```ts
import { createHash } from 'node:crypto';

import { getEncoding, type Tiktoken } from 'js-tiktoken';

/**
 * Text utilities. Small on purpose: every function here is a decision that shows
 * up in retrieval quality, so each one is worth reading.
 */

let cached: Tiktoken | undefined;

/** cl100k_base — the tokenizer behind text-embedding-3-* and GPT-4-class models. */
export function tokenizer(): Tiktoken {
  cached ??= getEncoding('cl100k_base');
  return cached;
}

export function countTokens(text: string): number {
  return tokenizer().encode(text).length;
}

/** Stable id for a chunk. Same source + position + text always produces the same id. */
export function sha256(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Clean extracted text without changing its meaning.
 *
 * Only fixes what extraction breaks: ligatures, CRLF, words hyphenated across a
 * line break, and the blank-line runs that page headers leave behind. Cleaning is
 * not cosmetic — boilerplate repeated in every chunk flattens the vector space and
 * destroys retrieval precision.
 */
export function normaliseText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    // Markdown emphasis is formatting, not content. Leaving `**7 days**` in the text
    // splits the token across the asterisks and makes the number harder to match.
    // `[\s\S]` because a bold run may span a line break in a hard-wrapped document.
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sentence-ish units. Used to split long sections and to build extractive answers.
 *
 * Splitting on a single newline is wrong: documents are hard-wrapped, so a sentence
 * that happens to cross a line break would be cut in half and the second half would
 * become a sentence of its own. Only a blank line ends a sentence here.
 */
export function sentences(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

/**
 * Tokens for BM25.
 *
 * Keeps `ax-204` as one token instead of splitting it into `ax` and `204`,
 * because the whole point of lexical search is that a SKU is a single term.
 */
export function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+(?:-\d+)?|\d+/g) ?? [];
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Five characters is enough to group refund/refunds, ship/shipping, exchange/exchanged. */
export function stem(word: string): string {
  return word.slice(0, 5);
}

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'our', 'can', 'could', 'what', 'how', 'does', 'did', 'are',
  'was', 'were', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'not', 'but', 'still', 'any',
  'get', 'got', 'after', 'before', 'when', 'where', 'which', 'who', 'why', 'use', 'used', 'about',
  'they', 'them', 'then', 'there', 'these', 'those', 'been', 'would', 'should', 'please', 'want',
]);

/**
 * Query-side terms, stemmed, for *scoring* comparisons only.
 *
 * Never build an inverted index out of these: a BM25 postings list must tokenise a
 * document exactly the way the query is tokenised, and it deliberately keeps the
 * exact term so that `ax-204` stays one token. Scoring, by contrast, wants
 * `exchange` to match `exchanged`, which is what the stem gives it.
 */
export function queryTerms(text: string, limit = 12): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const term of terms(text)) {
    if (term.length < 4 || QUERY_STOPWORDS.has(term)) continue;
    const stemmed = stem(term);
    if (seen.has(stemmed)) continue;
    seen.add(stemmed);
    result.push(stemmed);
    if (result.length === limit) break;
  }

  return result;
}

/** The same stemmed view of a document, so both sides of a comparison agree. */
export function stemsOf(text: string): Set<string> {
  return new Set(terms(text).map(stem));
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'so', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'still', 'just', 'any',
]);

/**
 * Content words, deduplicated, in order.
 *
 * The offline embedder uses this: "what / is / the / for" appear in every
 * sentence and would otherwise dominate the hash features, making every chunk
 * look equally similar to every question.
 */
export function contentWords(text: string, limit = 64): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const word of words(text)) {
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    result.push(word);
    if (result.length === limit) break;
  }

  return result;
}

/** Trim to a character budget without cutting mid-word where avoidable. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** `7 days` → `7 days`; `do NOT extend` → `do NOT extend`. Used only for display. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
```

**Block by block:**

- **`tokenizer()` / `countTokens()`** — `cl100k_base` via `js-tiktoken`, the same tokenizer
  family as the embedding models. Counting characters instead is how a "1,000-character"
  chunk becomes 180 tokens in German and 320 in English.
- **`sha256(...parts)`** — deterministic ids. Re-running ingestion is idempotent, which is
  the difference between a re-index and an outage.
- **`normaliseText`** — cleaning is not cosmetic. It fixes ligatures, CRLF, words hyphenated
  across a line break, and *strips markdown bold markers*, because `**7 days**` splits the
  number across asterisks and makes it harder to match and uglier to quote.
- **`sentences`** — splits on blank lines and sentence-ending punctuation, **never on a
  single newline**. Documents are hard-wrapped, so splitting on `\n` cuts sentences in half
  and produces exactly the fragment answers the naive baseline shows.
- **`terms`** — the lexical tokenizer, and the reason `ax-204` stays one token
  (`/[a-z]+(?:-\d+)?|\d+/g`) instead of becoming `ax` and `204`. A SKU is a term, not two.
- **`contentWords`** — stopword-filtered words, used by the offline embedder. "what / is /
  the / for" appears in every sentence and would otherwise dominate the hash features.
- **`stem` / `queryTerms` / `stemsOf`** — a five-character prefix, applied to **both sides**
  of a comparison. `queryTerms` is explicitly *not* for building an inverted index: BM25
  must tokenise a document exactly as it tokenises the query, and it wants the exact term.
  Scoring wants `exchange` to match `exchanged`, which is what the stem gives it.
- **`clip`** — a character budget that avoids cutting mid-word when it can.

### 6.2 `src/lib/vectors.ts`

```ts
/**
 * Vector maths. Four functions, because retrieval only ever needs four.
 *
 * Everything here assumes L2-normalised vectors when cosine is used, which is
 * what every embedding API returns. The `normalise` guard matters: an all-zero
 * vector (an empty chunk) has no direction, and dividing by its norm produces
 * NaN scores that poison sorting in ways that are painful to debug.
 */

export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare vectors of different sizes: ${a.length} vs ${b.length}.`);
  }
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot(a, b) / denominator;
}

/** Unit length, so cosine and dot-product search agree numerically. */
export function normalise(vector: number[]): number[] {
  const length = norm(vector);
  if (length === 0) return vector;
  return vector.map((value) => value / length);
}

/**
 * Linear interpolation — the whole of "late chunking (approximated)".
 *
 * `blend(child, parent, 0.25)` keeps three quarters of the child's own signal and
 * one quarter of the context it sits in. That is enough for a bare sentence like
 * "This does not apply to electronics." to be findable by "electronics return
 * window" without erasing what makes the child specific.
 */
export function blend(child: readonly number[], parent: readonly number[], alpha: number): number[] {
  const a = Math.min(1, Math.max(0, alpha));
  return normalise(child.map((value, index) => (1 - a) * value + a * (parent[index] ?? 0)));
}

/** Rounded scores are for display only — never sort on the rounded value. */
export function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
```

**Block by block:**

- **`dot` / `norm` / `cosine`** — four lines each, with one guard that earns its keep:
  `cosine` throws when the dimensions differ. A dimension mismatch between an index and a
  query is a silent catastrophe — every score becomes meaningless — so it is an error
  rather than a warning.
- **`cosine` returns 0 for a zero vector** instead of `NaN`. An empty chunk has no
  direction, and `NaN` poisons sorting in ways that are painful to debug.
- **`blend(child, parent, alpha)`** — the whole of "late chunking, approximated": keep three
  quarters of the child's own signal and one quarter of the document context it sits in.
  The real technique pools *token* vectors from a long-context model; an embeddings API
  returns one vector per input, so this is the honest approximation.
- **`round`** exists to be used for *display only* — never sort on a rounded value.


---

## 7. Loading Documents — `src/ingest/loader.ts`

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { normaliseText } from '../lib/text.js';
import type { DocMeta, SourceDocument } from '../types.js';

/**
 * Document loading, with metadata as a hard requirement.
 *
 * Every file carries a front-matter block that becomes the filterable metadata
 * from Chapter 05. Parsing it is boring; *validating* it is the interesting part.
 * A document with no `tenantId` or no `acl` cannot be filtered safely, so it is
 * rejected at ingestion rather than leaking into an answer later. That is the
 * fail-closed rule applied at the earliest possible point.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');

const metaSchema = z.object({
  docType: z.string().min(1).default('policy'),
  category: z.string().min(1).default('general'),
  productIds: z.array(z.string()).default([]),
  tenantId: z.string().min(1, 'tenantId is required — an unfiltered document cannot be isolated.'),
  acl: z.array(z.string()).min(1, 'acl must list at least one group.'),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional(),
  version: z.string().min(1).default('1.0'),
});

export { metaSchema };

/** Split `---` front matter from the body. Deliberately not a full YAML parser. */
export function parseFrontMatter(raw: string, source: string): { data: Record<string, string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error(`${source}: missing front matter. Every document needs tenantId and acl.`);
  }

  const data: Record<string, string[]> = {};

  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) throw new Error(`${source}: malformed front-matter line "${trimmed}".`);

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value ? [value.replace(/^["']|["']$/g, '')] : [];
    }
  }

  return { data, body: match[2] };
}

/** Front matter → validated `DocMeta`. Throws with the file name, not a stack trace. */
export function toMeta(data: Record<string, string[]>, source: string): DocMeta {
  const parsed = metaSchema.safeParse({
    docType: data.docType?.[0],
    category: data.category?.[0],
    productIds: data.productIds ?? [],
    tenantId: data.tenantId?.[0],
    acl: data.acl ?? [],
    effectiveFrom: data.effectiveFrom?.[0],
    effectiveTo: data.effectiveTo?.[0],
    version: data.version?.[0],
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`${source}: invalid metadata — ${issues.join('; ')}`);
  }

  return parsed.data;
}

/** The document title is the first H1, falling back to the file name. */
export function titleOf(body: string, source: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : source.replace(/\.md$/, '');
}

export async function loadDocument(filePath: string): Promise<SourceDocument> {
  const source = path.basename(filePath);
  const raw = await readFile(filePath, 'utf8');
  const { data, body } = parseFrontMatter(raw, source);

  return {
    source,
    title: titleOf(body, source),
    text: normaliseText(body),
    meta: toMeta(data, source),
  };
}

/** Every `.md` file in the policy directory, sorted so ingestion is reproducible. */
export async function loadDocuments(directory: string): Promise<SourceDocument[]> {
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.md')).sort();
  return Promise.all(entries.map((entry) => loadDocument(path.join(directory, entry))));
}
```

**Block by block:**

- **`metaSchema` is strict about the two fields that make filtering possible.** `tenantId`
  and `acl` have no defaults. A missing tenant is a boot-time error with the file name in
  the message, which is the earliest possible place to fail closed.
- **`parseFrontMatter`** is a deliberately small YAML subset: `key: value`, `key: [a, b]`,
  and empty values. It is a parser, not a dependency, because the interesting part is the
  next function.
- **`toMeta`** validates with zod and rewrites the failure into
  `file.md: invalid metadata — tenantId: ...`. Errors that name the file are the difference
  between a five-minute fix and an afternoon.
- **`titleOf`** takes the first H1 as the document title, falling back to the file name, so
  a citation always has a human label even for a badly formatted file.
- **`loadDocuments`** sorts the directory listing. Ingestion order affects chunk indices,
  which affect ids, which affect the index — so it is made deterministic.

### 7.1 A document, and why its metadata looks like that

```markdown
---
docType: policy
category: electronics
productIds: [AX-204, BX-900]
tenantId: northwind-eu
acl: [support, customer]
effectiveFrom: 2026-01-01
effectiveTo:
version: 2026.1
---
# Electronics Returns Policy

## Scope

This policy covers headphones, earbuds, portable speakers, turntables, smart watches and
every other powered audio product we sell, including the AX-204 over-ear headphones, the
AX-210 studio monitors and the BX-900 wireless earbuds. Where this document and the
general returns policy disagree, this document wins: electronics are the one category
where the shorter window applies, because opened electronics cannot be resold as new.

## Condition requirements

An electronics item must be unused, in its original sealed packaging, with the hygiene
seal on the ear cushions unbroken. Once the seal is broken the item can no longer be
sold as new, so it is accepted back only when it is faulty, and then only under the
damaged-goods policy or the manufacturer warranty. Photographs of the seal are not
required at the counter, but the warehouse checks the seal on arrival and declines any
return where it has been cut, stretched or re-taped.

## Return window

Electronics may be returned within **7 days** of delivery. The 30-day window described
in the general returns policy does not apply to this category, and the returns portal
enforces the shorter window automatically. The 7 days are counted from the carrier's
delivery scan in the same way as the general policy, so a delivery that is recorded on
Monday expires the following Monday.

## Restocking fee

A **15% restocking fee** is deducted from every electronics refund that is not caused by
a fault. The fee covers inspection, testing and repackaging. It is not charged when the
item is dead on arrival, when it was damaged in transit, or when the wrong item was
shipped — in those cases the full amount is refunded and the return shipping is paid by
Northwind Audio.

## Exclusions

Opened smart watches with a linked account, products with a broken warranty seal, and
items returned without their serial number label are refused. Serial numbers are matched
against the original shipment, so a swapped unit is detected during inspection.

## Serial numbers and warranty seals

Every electronics item carries a serial number label that is matched against the
original shipment during inspection. A serial number that does not match, or a label
that has been removed or replaced, makes the item ineligible for both a return and a
warranty claim, and the case is escalated to the fraud desk. The warranty seal on the
packaging is separate from the hygiene seal on the ear cushions: breaking one does not
automatically break the other, and support should read both when a customer describes
the condition of the box.

## Bundle purchases

When an item was bought as part of a bundle, the refund is calculated on the bundle
price apportioned across its components, not on the component's individual list price.
Returning one part of a bundle does not end the warranty on the parts the customer
keeps. Where a bundle included a free accessory, the accessory is treated as part of
the returned item and must travel back with it.

## How to start an electronics return

Start the return in the customer account under Orders → Return and choose the reason
"electronics". The portal prints a label with the return authorisation number and flags
the parcel for the electronics bench, which inspects seals and serial numbers before
approving the refund.
```

**Block by block:**

- **The front matter is the filter.** `category: electronics` is what makes
  `category in [electronics, general]` possible; `productIds: [AX-204, BX-900]` is what
  makes `productIds contains AX-204` possible; `tenantId` and `acl` are what make the
  access rules enforceable.
- **`effectiveFrom: 2026-01-01` with an empty `effectiveTo`** means "current". Its sibling
  file `returns-electronics-2025.md` has `effectiveTo: 2025-12-31`, and that single field is
  what makes the temporal filter demonstrable: the same question asked `asOf 2025-06-01`
  must return the 14-day window, and asked `asOf 2026-06-01` must not.
- **Headings are the chunking structure.** `## Return window` becomes a breadcrumb
  (`Electronics Returns Policy › Return window`) and a heading on every chunk, which is what
  lets a bare sentence be found by "electronics return window".
- **The `## Scope` section names the products** ("the AX-204 over-ear headphones … the
  BX-900 wireless earbuds"). That is why a lexical reranker can find the electronics policy
  for a question about earbuds — and also why it sometimes prefers the *scope* paragraph to
  the *rule* paragraph, which Chapter 08 examines.


---

## 8. The Golden Set — `data/eval/golden.json`

```json
{
  "$comment": "Golden set for Lecture 12. expectedSources drive retrieval metrics; mustInclude is a deterministic stand-in for answer correctness; answerable=false drives refusal metrics. asOf is the policy date the question is asked against.",
  "cases": [
    {
      "id": "q01",
      "question": "What is the return window for your headphones?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["returns-electronics.md"],
      "mustInclude": ["7 days"]
    },
    {
      "id": "q02",
      "question": "My headphones arrived 10 days ago and the left earpiece is silent. Can I get a refund?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["damaged-goods.md", "warranty.md"],
      "mustInclude": ["48 hours"]
    },
    {
      "id": "q03",
      "question": "Is the AX-204 still covered after 18 months?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["warranty.md"],
      "mustInclude": ["12-month"]
    },
    {
      "id": "q04",
      "question": "How long does a refund take after the warehouse inspects the item?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["refund-timing.md"],
      "mustInclude": ["5 to 7"]
    },
    {
      "id": "q05",
      "question": "Can I exchange earbuds that I have already opened?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["exchanges.md"],
      "mustInclude": ["unopened"]
    },
    {
      "id": "q06",
      "question": "What was the electronics return window for an order delivered in June 2025?",
      "asOf": "2025-06-01",
      "answerable": true,
      "expectedSources": ["returns-electronics-2025.md"],
      "mustInclude": ["14 days"]
    },
    {
      "id": "q07",
      "question": "Do you charge a restocking fee when the item arrived damaged?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["damaged-goods.md"],
      "mustInclude": ["restocking fee"]
    },
    {
      "id": "q08",
      "question": "How much does return shipping cost if I simply changed my mind?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["shipping.md"],
      "mustInclude": ["4.95"]
    },
    {
      "id": "q09",
      "question": "What is the warranty on the BX-900 earbuds?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["warranty.md"],
      "mustInclude": ["24 months"]
    },
    {
      "id": "q10",
      "question": "The courier delivered my parcel 10 days ago and the box was crushed. Can I still claim transit damage?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["damaged-goods.md"],
      "mustInclude": ["48 hours"]
    },
    {
      "id": "q11",
      "question": "Can I change the delivery address after the parcel has shipped?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["shipping.md"],
      "mustInclude": ["redirect"]
    },
    {
      "id": "q12",
      "question": "Can I pay with Bitcoin?",
      "asOf": "2026-06-01",
      "answerable": false,
      "expectedSources": [],
      "mustInclude": []
    },
    {
      "id": "q13",
      "question": "Do you offer a student discount on turntables?",
      "asOf": "2026-06-01",
      "answerable": false,
      "expectedSources": [],
      "mustInclude": []
    },
    {
      "id": "q14",
      "question": "What is the return window for an unopened speaker delivered last week?",
      "asOf": "2026-06-01",
      "answerable": true,
      "expectedSources": ["returns-electronics.md"],
      "mustInclude": ["7 days"]
    }
  ]
}
```

**Block by block:**

- **`expectedSources`** is what makes retrieval measurable. Recall is computed against
  *documents*, not chunk ids, so re-chunking does not invalidate the golden set — the thing
  being tested is whether the right policy reached the prompt.
- **`mustInclude`** is a deterministic stand-in for answer correctness: strings that must
  appear in the answer, case-insensitively. It is crude, and it is the reason the offline
  demo can report a fact-accuracy number at all without a judge model.
- **`answerable: false`** on q12 and q13 is what makes *refusal* measurable. Without
  unanswerable questions in the set, a system that answers everything scores perfectly.
- **`asOf` per case** — q06 is asked `asOf 2025-06-01` and expects the *superseded* 2025
  policy. A single global date would make the temporal filter untestable.
- **Fourteen cases is small on purpose.** It runs in under a second offline, which means it
  gets run. A 2,000-case set that nobody runs measures nothing.

---

## 9. The Failure Tree — `src/eval/diagnose.ts`

```ts
import type { GoldenCase } from './metrics.js';

/**
 * The failure tree from Chapter 01, as code.
 *
 * When an answer is wrong there are exactly four places to look, and they are
 * ordered: evidence that was never retrieved cannot be assembled, and evidence
 * that never reached the prompt cannot be quoted. Walking the tree in order
 * prevents the most expensive mistake in RAG debugging — rewriting the prompt to
 * fix a chunking problem.
 *
 *   retrieved bad?        → retrieval   (chunking, embedding, filter, top-K)
 *   retrieved, not in prompt? → context (budget, dedupe, parent expansion)
 *   in prompt, not in answer? → generation (prompt contract, model, citations)
 *   everything present?   → ok
 */

export type Verdict =
  | 'ok'
  | 'retrieval-miss'
  | 'context-miss'
  | 'generation-miss'
  | 'refusal-ok'
  | 'answered-unanswerable';

export interface Diagnosis {
  verdict: Verdict;
  step: 'retrieval' | 'context' | 'generation' | 'refusal' | 'none';
  reason: string;
}

export function diagnose(input: {
  testCase: GoldenCase;
  refused: boolean;
  answer: string;
  contextText: string;
  retrievedSources: readonly string[];
}): Diagnosis {
  const { testCase } = input;

  if (!testCase.answerable) {
    return input.refused
      ? { verdict: 'refusal-ok', step: 'refusal', reason: 'no evidence cleared the gate; refused' }
      : { verdict: 'answered-unanswerable', step: 'retrieval', reason: 'evidence was weak but the floor let it through' };
  }

  const retrieved = new Set(input.retrievedSources);
  const missingSources = testCase.expectedSources.filter((source) => !retrieved.has(source));
  if (missingSources.length > 0) {
    return {
      verdict: 'retrieval-miss',
      step: 'retrieval',
      reason: `never retrieved: ${missingSources.join(', ')}`,
    };
  }

  const context = input.contextText.toLowerCase();
  const missingInContext = testCase.mustInclude.filter((phrase) => !context.includes(phrase.toLowerCase()));
  if (missingInContext.length > 0) {
    return {
      verdict: 'context-miss',
      step: 'context',
      reason: `dropped before the prompt: ${missingInContext.join(', ')}`,
    };
  }

  const answer = input.answer.toLowerCase();
  const missingInAnswer = testCase.mustInclude.filter((phrase) => !answer.includes(phrase.toLowerCase()));
  if (missingInAnswer.length > 0) {
    return {
      verdict: 'generation-miss',
      step: 'generation',
      reason: `evidence was present, answer omitted: ${missingInAnswer.join(', ')}`,
    };
  }

  return { verdict: 'ok', step: 'none', reason: 'correct evidence, correct answer' };
}
```

**Block by block:**

- **The order of the checks is the design.** Evidence that was never retrieved cannot be
  assembled; evidence that never reached the prompt cannot be quoted. Walking the tree in
  order prevents the most expensive mistake in RAG debugging — rewriting the prompt to fix a
  chunking problem.
- **`retrieval-miss`** means an expected source was not among the used chunks. The fix lives
  in chunking, filters, K, fusion or the floor — not in the prompt.
- **`context-miss`** means the source *was* retrieved but its required facts are not in the
  assembled context: the budget, the dedupe or the parent expansion dropped it.
- **`generation-miss`** means the facts were in the prompt and the answer omitted them. Now
  it is a prompt problem, and only now.
- **`answered-unanswerable`** is the floor being too permissive: something scored above
  `MIN_SCORE` on a question with no answer in the corpus.
- **`reason`** always names the missing source or phrase, so the row is actionable without
  opening the trace.

---

## 10. What to Take Away

- **A wrong answer is a diagnosis.** The baseline fails eight of fourteen cases and every
  row names a stage. The rest of this guide repairs those names, one at a time.
- **Types are the map of the data flow.** `Chunk` → `IndexRecord` → `ScoredChunk` →
  `ContextBlock` → answer: five shapes, and every control in the lecture edits one of them.
- **Fail closed at the earliest point.** A missing `tenantId` is an ingestion error, not a
  query-time filter decision.
- **Cleaning is retrieval work.** Stripping markdown emphasis and refusing to split
  sentences on hard-wrapped newlines is worth more than most reranker tuning.
- **Everything is a value.** Config, presets and access are plain objects, which is why the
  ablation in Chapter 10 can change one control at a time.

> **Where This Goes Next:** [Chapter 02](./02_Fixed_Size_Chunking_and_Overlap.md) implements
> the chunker the baseline uses, properly — including the arithmetic that says what overlap
> really costs.
