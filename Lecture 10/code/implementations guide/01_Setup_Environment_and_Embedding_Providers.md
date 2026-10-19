# Chapter 01: Setup, Environment & Embedding Providers

> **Chapter Goal:** Turn text into vectors through one stable contract, with a free offline provider for learning and two production providers behind the same interface. Validate configuration at boot, not at request time.

> **Lecture mapping:** Notes Chapter 01 (embeddings, models, dimensions, document vs query) and Chapter 02 (metric/model consistency at the boundary).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/types/vector.types.ts` | 144 | Shared contracts: vectors, records, metrics, filters, index configs. |
| `src/config/env.ts` | 78 | Zod-validated environment with provider-aware defaults. |
| `src/lib/async.ts` | 25 | Bounded-concurrency helper used by both HTTP providers. |
| `src/embeddings/provider.ts` | 35 | Interface + factory. |
| `src/embeddings/mock.provider.ts` | 57 | Deterministic offline embeddings. |
| `src/embeddings/openai.provider.ts` | 55 | Official OpenAI SDK adapter. |
| `src/embeddings/gemini.provider.ts` | 103 | Gemini REST adapter with task types. |
| `src/embeddings/embedding.service.ts` | 84 | Batching, dedupe, LRU cache. |

---

## 1. Commands

```bash
cd "Lecture 10/code"
npm install
cp .env.example .env
npm run verify
```

`verify` includes an embedding-service test that proves duplicate texts are embedded once and cached on the second call.

---

## 2. Shared Types — `src/types/vector.types.ts`

#### 📄 `src/types/vector.types.ts`

```ts
/**
 * Shared contracts for the whole codebase.
 *
 * A vector is a `Float32Array`, not `number[]`. Embeddings are float32 in every
 * real provider, and a typed array halves the memory of a JS number array while
 * keeping the math identical. The API converts incoming JSON arrays at the
 * boundary; the core never sees `number[]`.
 */

export type Metric = 'cosine' | 'dot' | 'euclid' | 'manhattan';

export type Vector = Float32Array;

/** A vector plus its precomputed L2 norm. Computing the norm once per record
 *  turns cosine from three passes into one dot product per comparison. */
export interface PreparedVector {
  data: Vector;
  norm: number;
}

/** The row a vector database actually stores and an index actually searches. */
export interface PreparedRecord<T = Record<string, unknown>> {
  id: string;
  vector: Vector;
  norm: number;
  payload: T;
  text?: string;
}

export type IndexKind = 'flat' | 'ivf' | 'hnsw' | 'pq';

export interface IvfConfig {
  nlist?: number;
  nprobe?: number;
  iterations?: number;
  seed?: number;
}

export interface HnswConfig {
  m?: number;
  efConstruction?: number;
  efSearch?: number;
  seed?: number;
}

export interface PqConfig {
  m?: number;
  ksub?: number;
  iterations?: number;
  seed?: number;
}

export interface IndexConfig {
  kind: IndexKind;
  ivf?: IvfConfig;
  hnsw?: HnswConfig;
  pq?: PqConfig;
}

export interface SearchHit<T = Record<string, unknown>> {
  id: string;
  /** Higher is always better. Distance metrics are negated internally. */
  score: number;
  /** Native distance when the metric has one: cosine distance `1 - cos`,
   *  Euclidean, Manhattan. For dot product this is `-score`. */
  distance: number;
  payload: T;
  text?: string;
}

export interface IndexStats {
  kind: IndexKind;
  size: number;
  deleted: number;
  memoryBytes: number;
  params: Record<string, number | string | boolean>;
}

export interface StoreStats {
  count: number;
  dimensions: number;
  metric: Metric;
  index: IndexStats | null;
  vectorBytes: number;
  totalMemoryBytes: number;
  embeddingModel?: string;
}

export type Scalar = string | number | boolean | null;

/** MongoDB-style operators, deliberately small and explicit. */
export interface FieldOperators {
  $eq?: Scalar;
  $ne?: Scalar;
  $in?: Scalar[];
  $nin?: Scalar[];
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $exists?: boolean;
  $contains?: string;
}

export type FieldCondition = Scalar | Scalar[] | FieldOperators;

export type Filter =
  | { $and: Filter[] }
  | { $or: Filter[] }
  | { $not: Filter }
  | { [field: string]: FieldCondition };

export interface UpsertInput<T = Record<string, unknown>> {
  id: string;
  vector: Vector | number[];
  payload?: T;
  text?: string;
}

export interface StoreQueryOptions {
  vector: Vector | number[];
  k?: number;
  filter?: Filter;
  index?: IndexKind;
  nprobe?: number;
  efSearch?: number;
  /** PQ only: exact rescoring depth. Set to 0 to disable. */
  rescore?: number;
}

export interface IndexSearchOptions<T = Record<string, unknown>> {
  k: number;
  filter?: (record: PreparedRecord<T>) => boolean;
  nprobe?: number;
  efSearch?: number;
  rescore?: number;
}

export interface IndexSearchResult<T = Record<string, unknown>> {
  id: string;
  score: number;
  distance: number;
  record: PreparedRecord<T>;
}
```

**Block by block:**

- **`Metric` and `Vector`** — the four supported metrics and `Float32Array`. The type alias is the decision: JSON arrays stop at the boundary.
- **`PreparedVector` / `PreparedRecord`** — a vector plus its precomputed L2 norm, and the row the store/index actually holds. Carrying `norm` turns cosine into one dot product per comparison instead of three passes.
- **`IndexKind` and configs** — `flat`, `ivf`, `hnsw`, `pq`, with optional parameters. Optional because the store supplies defaults from the collection size (`nlist ≈ √N`, `M=16`, etc.).
- **`SearchHit`** — the API-facing result. `score` is always higher-is-better; `distance` is the native distance (cosine distance, L2, L1, or `-dot`).
- **`IndexStats` / `StoreStats`** — memory accounting separated into raw vectors and index structure, so a benchmark never double-counts.
- **`Filter` / `FieldOperators`** — the deliberately small MongoDB-style DSL: equality, `$in`, range, `$exists`, `$contains`, combined with `$and`/`$or`/`$not`.
- **`UpsertInput` / `StoreQueryOptions` / `IndexSearchOptions`** — the write and read contracts. `StoreQueryOptions.index` is how one store exposes four search strategies without four endpoints.

The important design choice is that `PreparedRecord` carries the vector, norm, payload and optional text together. An index never needs a second lookup to return a result.

---

## 3. Environment Validation — `src/config/env.ts`

#### 📄 `src/config/env.ts`

```ts
import 'dotenv/config';
import { z } from 'zod';

/**
 * Boot-time environment validation.
 *
 * Fail fast and loudly: a missing API key or an invalid metric should stop the
 * process, not surface as a 500 on the first request.
 */
const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    EMBEDDING_PROVIDER: z.enum(['mock', 'openai', 'gemini']).default('mock'),
    EMBEDDING_MODEL: z.string().trim().optional(),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(8).max(3072).optional(),
    OPENAI_API_KEY: z.string().trim().optional(),
    GEMINI_API_KEY: z.string().trim().optional(),

    VECTOR_METRIC: z.enum(['cosine', 'dot', 'euclid', 'manhattan']).default('cosine'),
    DEFAULT_INDEX: z.enum(['flat', 'ivf', 'hnsw', 'pq']).default('flat'),
    AUTO_SEED: booleanString.default('true'),

    QDRANT_URL: z.string().url().default('http://localhost:6333'),
    QDRANT_API_KEY: z.string().trim().optional(),
    QDRANT_COLLECTION: z.string().default('lecture10_documents'),

    DATABASE_URL: z.string().optional(),
    PGVECTOR_TABLE: z.string().default('lecture10_documents'),
  })
  .superRefine((value, context) => {
    if (value.EMBEDDING_PROVIDER === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.',
      });
    }
    if (value.EMBEDDING_PROVIDER === 'gemini' && !value.GEMINI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GEMINI_API_KEY'],
        message: 'GEMINI_API_KEY is required when EMBEDDING_PROVIDER=gemini.',
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
const defaultModel =
  raw.EMBEDDING_PROVIDER === 'mock'
    ? 'mock-hash-v1'
    : raw.EMBEDDING_PROVIDER === 'gemini'
      ? 'gemini-embedding-001'
      : 'text-embedding-3-small';
const model = raw.EMBEDDING_MODEL || defaultModel;
const defaultDimensions =
  raw.EMBEDDING_PROVIDER === 'mock' ? 128 : raw.EMBEDDING_PROVIDER === 'gemini' ? 3072 : 1536;

export const env = {
  ...raw,
  EMBEDDING_MODEL: model,
  EMBEDDING_DIMENSIONS: raw.EMBEDDING_DIMENSIONS ?? defaultDimensions,
};

export type Env = typeof env;
```

**Block by block:**

- **`import 'dotenv/config'`** — loads `.env` before the schema runs. Environment variables already set by the shell win, which is what you want in CI and Docker.
- **`booleanString`** — `AUTO_SEED=false` must be `false`. `z.coerce.boolean()` would turn the non-empty string `"false"` into `true`; this enum transform does not.
- **`schema`** — every variable has a type and a default. `EMBEDDING_DIMENSIONS` is optional because the correct default depends on the provider.
- **`superRefine`** — cross-field validation: `openai` requires `OPENAI_API_KEY`, `gemini` requires `GEMINI_API_KEY`. This is fail-fast configuration, not a runtime surprise.
- **`safeParse` + throw** — a bad environment stops the process with a readable field map. Containers should crash-loop on misconfiguration rather than serve 500s.
- **Model resolution** — blank `EMBEDDING_MODEL` becomes `mock-hash-v1`, `text-embedding-3-small`, or `gemini-embedding-001`.
- **Dimension resolution** — mock defaults to 128, Gemini to 3072, OpenAI to 1536. The export always has concrete values, so downstream code never handles `undefined`.

The schema does **not** accept an arbitrary provider string. A typo becomes a validation error, not a silent fallback to mock.

---

## 4. Bounded Concurrency — `src/lib/async.ts`

#### 📄 `src/lib/async.ts`

```ts
/** Run async work with a fixed concurrency limit; preserves input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error('Concurrency limit must be >= 1.');
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Block by block:**

- **`mapWithConcurrency`** — starts `min(limit, items.length)` workers. Each worker pulls the next index from a shared counter, so slow requests do not block a single queue and input order is preserved in `results[index]`.
- **No dependency** — this is 15 lines; `p-limit` would be a reasonable production choice, but the logic is small enough to own and explain.
- **`sleep`** — used by the Gemini retry loop for exponential backoff.

Why cap concurrency? Embedding endpoints rate-limit. Firing 100 batches at once converts a fast job into a 429 storm and a retry storm after it.

---

## 5. The Provider Contract — `src/embeddings/provider.ts`

#### 📄 `src/embeddings/provider.ts`

```ts
import { MockEmbeddingProvider } from './mock.provider.js';
import { OpenAiEmbeddingProvider } from './openai.provider.js';
import { GeminiEmbeddingProvider } from './gemini.provider.js';

export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /**
   * Embed a batch. Providers return one vector per input, in input order.
   * `task` lets providers that support it use asymmetric retrieval prompts;
   * OpenAI ignores it, Gemini maps it to RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY.
   */
  embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]>;
}

export interface EmbeddingProviderConfig {
  provider: 'mock' | 'openai' | 'gemini';
  model?: string;
  dimensions?: number;
  apiKey?: string;
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider(config.dimensions);
    case 'openai':
      return new OpenAiEmbeddingProvider(config);
    case 'gemini':
      return new GeminiEmbeddingProvider(config);
  }
}
```

**Block by block:**

- **`EmbeddingTask`** — `'document' | 'query'`. Retrieval is asymmetric; Gemini can use different instruction prefixes for each side, and a future provider may too.
- **`EmbeddingProvider`** — four readonly fields and one method. `dimensions` is part of the interface because the store must enforce a fixed width.
- **`EmbeddingProviderConfig`** — the factory input. It intentionally contains no store or database concerns.
- **`createEmbeddingProvider`** — exhaustive switch over the three providers. If a fourth is added, TypeScript forces the branch.
- **Imports at the top** — the implementations import the interface with `import type`, so no runtime cycle exists.

> **Why a factory?** Routes and scripts never import `openai` or a Gemini SDK. They import this file. Replacing a provider, adding a local model, or wrapping one with a circuit breaker happens behind this boundary.

---

## 6. Offline Provider — `src/embeddings/mock.provider.ts`

#### 📄 `src/embeddings/mock.provider.ts`

```ts
import { normalize } from '../core/metrics.js';
import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/**
 * Deterministic, offline, zero-cost embeddings.
 *
 * This is NOT a semantic model. It hashes words and character trigrams into a
 * fixed space, so texts that share vocabulary land close together. That is
 * enough to exercise every storage and retrieval path without an API key, and
 * it makes demos and tests reproducible.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock-hash-v1';
  readonly dimensions: number;

  constructor(dimensions = 128) {
    if (dimensions < 8) throw new Error('Mock embeddings need at least 8 dimensions.');
    this.dimensions = dimensions;
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Float32Array(this.dimensions);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

    for (const token of tokens) {
      this.addFeature(vector, token, 1);
      const padded = `^${token}$`;
      for (let i = 0; i < padded.length - 2; i++) {
        this.addFeature(vector, padded.slice(i, i + 3), 0.35);
      }
    }

    return [...normalize(vector)];
  }

  private addFeature(vector: Float32Array, feature: string, weight: number): void {
    const hash = fnv1a(feature);
    const index = hash % this.dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }
}

/** FNV-1a: small, fast and stable across processes. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
```

**Block by block:**

- **Class fields** — name, model and dimensions are stable metadata used in health output and cache keys.
- **Constructor guard** — fewer than 8 dimensions makes hash collisions dominate; fail early.
- **`embed`** — maps every input through `embedOne`. It is async to satisfy the interface, not because it does I/O.
- **`embedOne`** — extracts Unicode word tokens, adds each word as a signed feature, then adds character trigrams at 0.35 weight. Trigrams make `vector` and `vectors` overlap before any stemming.
- **`addFeature`** — FNV-1a produces a 32-bit hash; the low bits choose a dimension; the sign bit chooses `+1` or `-1`. Signed hashing keeps collisions from systematically inflating similarity.
- **`normalize`** — the returned vector has unit length, so cosine and dot rank identically for mock data.

**What it is not:** a semantic model. `car` and `automobile` do not become neighbours unless they share characters. This provider exists so Chapters 02–10 run without a key. Conclusions about index behaviour still hold; conclusions about semantic quality do not.

---

## 7. OpenAI Provider — `src/embeddings/openai.provider.ts`

#### 📄 `src/embeddings/openai.provider.ts`

```ts
import OpenAI from 'openai';
import { mapWithConcurrency } from '../lib/async.js';
import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingTask } from './provider.js';

/**
 * OpenAI embeddings through the official SDK.
 *
 * Production details that matter: batch the input (the endpoint accepts arrays),
 * cap concurrency, and let the SDK retry 429/5xx with exponential backoff.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  readonly client: OpenAI;

  constructor(config: EmbeddingProviderConfig) {
    if (!config.apiKey) throw new Error('OPENAI_API_KEY is required for the OpenAI provider.');
    this.model = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions ?? (this.model.includes('large') ? 3072 : 1536);
    this.client = new OpenAI({ apiKey: config.apiKey, maxRetries: 3, timeout: 30_000 });
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error('Embedding input must not contain empty strings.');
    }

    const batches = chunk(texts, 64);
    const vectors = await mapWithConcurrency(batches, 4, (batch) => this.embedBatch(batch));
    return vectors.flat();
  }

  private async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: [...texts],
      encoding_format: 'float',
      // Only text-embedding-3-* supports Matryoshka truncation.
      ...(this.model.startsWith('text-embedding-3') ? { dimensions: this.dimensions } : {}),
    });

    return response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
```

**Block by block:**

- **Constructor** — requires a key; model defaults to `text-embedding-3-small`; dimensions default to 3072 for `large`, otherwise 1536. `maxRetries: 3` and a 30 s timeout are delegated to the SDK.
- **`embed`** — rejects empty strings first (they waste a request and some providers reject them), splits into batches of 64, and runs at most 4 batches concurrently.
- **`embedBatch`** — one SDK call per batch, `encoding_format: 'float'`, and `dimensions` only for `text-embedding-3-*`.
- **Response ordering** — sort by `index` before returning. The API's array order is not guaranteed to match input order; assuming it does silently assigns the wrong vector to the wrong document.
- **`chunk`** — a pure helper; no mutation.

**Cost note:** one batch call for 64 documents is dramatically cheaper and faster than 64 calls. The store then writes all vectors in one upsert.

---

## 8. Gemini Provider — `src/embeddings/gemini.provider.ts`

#### 📄 `src/embeddings/gemini.provider.ts`

```ts
import { mapWithConcurrency, sleep } from '../lib/async.js';
import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingTask } from './provider.js';

interface GeminiBatchResponse {
  embeddings: { values: number[] }[];
}

/**
 * Gemini embeddings through the REST API (no extra SDK).
 *
 * Gemini distinguishes document and query tasks, which materially improves
 * retrieval quality. `outputDimensionality` exposes Matryoshka truncation:
 * 3072 -> 768 is a 4x storage cut, validated on your own recall set.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(config: EmbeddingProviderConfig) {
    if (!config.apiKey) throw new Error('GEMINI_API_KEY is required for the Gemini provider.');
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-embedding-001';
    this.dimensions = config.dimensions ?? 3072;
    if (this.dimensions < 128 || this.dimensions > 3072) {
      throw new Error('Gemini embedding dimensions must be between 128 and 3072.');
    }
  }

  async embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error('Embedding input must not contain empty strings.');
    }

    const batches = chunk(texts, 100);
    const vectors = await mapWithConcurrency(batches, 2, (batch) => this.embedBatch(batch, task));
    return vectors.flat();
  }

  private async embedBatch(texts: readonly string[], task: EmbeddingTask): Promise<number[][]> {
    const body = {
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        outputDimensionality: this.dimensions,
      })),
    };

    const response = await this.request(body);
    if (response.embeddings.length !== texts.length) {
      throw new Error(
        `Gemini returned ${response.embeddings.length} embeddings for ${texts.length} inputs.`,
      );
    }
    return response.embeddings.map((item) => item.values);
  }

  private async request(body: unknown): Promise<GeminiBatchResponse> {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(this.model)}:batchEmbedContents`;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });

        if (response.ok) return (await response.json()) as GeminiBatchResponse;

        const detail = (await response.text()).slice(0, 500);
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Gemini ${response.status}: ${detail}`);
        } else {
          throw new NonRetryableError(`Gemini embeddings failed (${response.status}): ${detail}`);
        }
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        lastError = error;
      }

      await sleep(300 * 2 ** attempt + Math.random() * 200);
    }

    throw lastError instanceof Error ? lastError : new Error('Gemini embeddings failed.');
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Marker so the retry loop never retries a deterministic 4xx. */
class NonRetryableError extends Error {}
```

**Block by block:**

- **Constructor** — requires a key; defaults to `gemini-embedding-001` at 3072 dimensions. Dimensions are constrained to 128–3072 because that is the Matryoshka range.
- **`embed`** — batches of 100 (the endpoint limit), concurrency 2, one retryable `fetch` per batch.
- **`embedBatch`** — builds one request per text:
  - `model: models/<model>` — the fully qualified model name.
  - `content.parts[0].text` — the input.
  - `taskType` — `RETRIEVAL_DOCUMENT` or `RETRIEVAL_QUERY`. This is the asymmetric-retrieval feature OpenAI does not expose.
  - `outputDimensionality` — truncates the Matryoshka vector.
- **Length check** — a provider returning 9 vectors for 10 inputs is a bug; fail loudly instead of shifting every document by one.
- **`request`** — `POST` with `x-goog-api-key` in a header, 45 s timeout, 3 attempts. 429 and 5xx are retried with exponential backoff plus jitter; a deterministic 4xx is wrapped in `NonRetryableError` and thrown immediately.
- **`chunk`** — same helper shape as OpenAI; duplication is acceptable here because each provider owns its batching policy.

**Security detail:** the key is not placed in the query string. Query strings appear in proxy logs and browser history; headers are the safer default.

---

## 9. Embedding Service — `src/embeddings/embedding.service.ts`

#### 📄 `src/embeddings/embedding.service.ts`

```ts
import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/**
 * Embedding service: batching, deduplication and an LRU cache.
 *
 * Query embeddings are pure functions of (model, task, text), so caching them
 * is safe and removes a provider round-trip on repeated queries. The cache is
 * intentionally small and process-local: a multi-instance deployment needs a
 * shared cache (Redis) and a versioned key that includes the model id.
 */
export class EmbeddingService {
  private readonly cache = new Map<string, number[]>();

  constructor(
    readonly provider: EmbeddingProvider,
    private readonly cacheSize = 1_000,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  get dimensions(): number {
    return this.provider.dimensions;
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return this.embed(texts, 'document');
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text], 'query');
    return vector;
  }

  private async embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];

    const missing = new Map<string, string>();
    const results = new Array<number[] | undefined>(texts.length);

    texts.forEach((text, index) => {
      const key = `${this.provider.model}:${task}:${text}`;
      const cached = this.cache.get(key);
      if (cached) {
        // Refresh LRU position.
        this.cache.delete(key);
        this.cache.set(key, cached);
        results[index] = cached;
      } else {
        missing.set(key, text);
      }
    });

    if (missing.size > 0) {
      const keys = [...missing.keys()];
      const values = await this.provider.embed([...missing.values()], task);
      if (values.length !== keys.length) {
        throw new Error(`Provider returned ${values.length} vectors for ${keys.length} inputs.`);
      }
      keys.forEach((key, i) => {
        this.cache.set(key, values[i]);
        this.evict();
      });
      texts.forEach((text, index) => {
        if (results[index]) return;
        results[index] = this.cache.get(`${this.provider.model}:${task}:${text}`);
      });
    }

    return results.map((vector, index) => {
      if (!vector) throw new Error(`Missing embedding for input ${index}.`);
      return vector;
    });
  }

  private evict(): void {
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      this.cache.delete(oldest);
    }
  }
}
```

**Block by block:**

- **`cache`** — a `Map` used as an LRU. Insertion order is the eviction order.
- **`embedDocuments` / `embedQuery`** — the two public verbs. Having separate methods makes the task type explicit at every call site.
- **`embed` — cache lookup** — key is `${model}:${task}:${text}`. Including the model prevents cross-model contamination; including the task prevents a query vector being reused as a document vector.
- **Cache hit refresh** — delete and re-set the key so it becomes the most recent entry.
- **Deduplication** — `missing` is keyed by the same cache key, so `['same', 'same']` sends one input, not two. This matters for repeated chunks and repeated queries.
- **Provider call** — one batch for all missing texts. The provider handles its own internal batching.
- **Result reconstruction** — walk the original input order, fill from cache. The caller always gets one vector per input, in order.
- **`evict`** — while over capacity, delete the oldest key. Bounded memory, no timers.

**Scope note:** this is a process-local cache. A multi-instance deployment needs a shared cache (Redis) and a versioned key that includes the embedding model version, not just its name.

---

## 10. Verification

```bash
npm run verify
```

Relevant output:

```text
  ok  embedding service deduplicates and caches (0.3 ms)
```

The test uses a counting provider:

1. `embedDocuments(['same', 'same'])` → provider called once, with **one** input.
2. Second `embedDocuments(['same'])` → still one provider call (cache hit).
3. `embedQuery('same')` → second provider call, because the task key changed.

To see the mock vectors and a cosine matrix:

```bash
npm run demo
```

```text
1. Cosine similarity matrix

                  s1      s2      s3
s1             1.000   0.124  -0.017
s2             0.124   1.000  -0.133
s3            -0.017  -0.133   1.000
```

**Next:** [Chapter 02 — Metrics, Heaps & Ranking](./02_Metrics_Heaps_and_Ranking.md)


