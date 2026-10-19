# Chapter 07: Vector Store, CRUD & Hybrid Search

> **Chapter Goal:** Assemble the pieces into something that behaves like a vector database: upsert, read, delete, list, filter, choose an index, fall back to exact search when filtering underfills, and fuse dense retrieval with BM25.

> **Lecture mapping:** Notes Chapter 07 (record model, write/read paths, filtering strategies, hybrid search and RRF) and Chapter 09 (filter cardinality).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/store/filters.ts` | 112 | Filter DSL → compiled predicate. |
| `src/store/vector-store.ts` | 352 | CRUD, query, lazy indexes, exact fallback, stats. |
| `src/store/hybrid.ts` | 116 | BM25 index and reciprocal rank fusion. |
| `src/data/corpus.ts` | 138 | 24 documents with tenant/category/year. |
| `src/services/seed.service.ts` | 28 | Embed the corpus and upsert it. |

---

## 1. Commands

```bash
npm run verify
npm run demo
```

Relevant checks:

```text
  ok  store CRUD, filters and ANN query paths
  ok  filter operators compile to a predicate
  ok  BM25 and reciprocal rank fusion
```

---

## 2. Filters — `src/store/filters.ts`

#### 📄 `src/store/filters.ts`

```ts
import { BadRequestError } from '../lib/errors.js';
import type { FieldCondition, FieldOperators, Filter, Scalar } from '../types/vector.types.js';

/**
 * Compile a filter once per query, then evaluate the predicate per record.
 *
 * This is intentionally the same shape as Qdrant/pgvector filters: equality,
 * `$in`, range, existence and string containment, combined with `$and`/`$or`.
 * Compiling first avoids re-validating the JSON on every one of N records.
 */
export function compileFilter<T extends Record<string, unknown>>(
  filter: Filter | undefined,
): (payload: T) => boolean {
  if (!filter) return () => true;
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new BadRequestError('Filter must be a JSON object.');
  }
  return compileNode<T>(filter);
}

function compileNode<T extends Record<string, unknown>>(filter: Filter): (payload: T) => boolean {
  if (isAnd(filter)) {
    const children = filter.$and.map((child) => compileNode<T>(child));
    return (payload) => children.every((child) => child(payload));
  }
  if (isOr(filter)) {
    const children = filter.$or.map((child) => compileNode<T>(child));
    return (payload) => children.some((child) => child(payload));
  }
  if (isNot(filter)) {
    const child = compileNode<T>(filter.$not);
    return (payload) => !child(payload);
  }

  const conditions = Object.entries(filter).map(([field, condition]) =>
    compileField<T>(field, condition as FieldCondition),
  );
  return (payload) => conditions.every((condition) => condition(payload));
}

function compileField<T extends Record<string, unknown>>(
  field: string,
  condition: FieldCondition,
): (payload: T) => boolean {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    if (Array.isArray(condition)) {
      const allowed = new Set<Scalar>(condition);
      return (payload) => allowed.has(getPath(payload, field) as Scalar);
    }
    return (payload) => getPath(payload, field) === condition;
  }

  const operators = condition as FieldOperators;
  const known = new Set([
    '$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists', '$contains',
  ]);
  for (const key of Object.keys(operators)) {
    if (!known.has(key)) throw new BadRequestError(`Unsupported filter operator: ${key}`);
  }

  return (payload) => {
    const value = getPath(payload, field);
    if (operators.$exists !== undefined && (value !== undefined) !== operators.$exists) return false;
    if (operators.$eq !== undefined && value !== operators.$eq) return false;
    if (operators.$ne !== undefined && value === operators.$ne) return false;
    if (operators.$in !== undefined && !operators.$in.includes(value as Scalar)) return false;
    if (operators.$nin !== undefined && operators.$nin.includes(value as Scalar)) return false;
    if (operators.$gt !== undefined && !(typeof value === 'number' && value > operators.$gt)) {
      return false;
    }
    if (operators.$gte !== undefined && !(typeof value === 'number' && value >= operators.$gte)) {
      return false;
    }
    if (operators.$lt !== undefined && !(typeof value === 'number' && value < operators.$lt)) {
      return false;
    }
    if (operators.$lte !== undefined && !(typeof value === 'number' && value <= operators.$lte)) {
      return false;
    }
    if (operators.$contains !== undefined) {
      if (typeof value === 'string') {
        if (!value.toLowerCase().includes(operators.$contains.toLowerCase())) return false;
      } else if (Array.isArray(value)) {
        if (!value.includes(operators.$contains)) return false;
      } else {
        return false;
      }
    }
    return true;
  };
}

function getPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isAnd(filter: Filter): filter is { $and: Filter[] } {
  return '$and' in filter && Array.isArray((filter as { $and?: unknown }).$and);
}

function isOr(filter: Filter): filter is { $or: Filter[] } {
  return '$or' in filter && Array.isArray((filter as { $or?: unknown }).$or);
}

function isNot(filter: Filter): filter is { $not: Filter } {
  return '$not' in filter;
}
```

**Block by block:**

- **`compileFilter`** — returns a predicate. Compiling once and reusing it for N records avoids re-validating the JSON N times.
- **Top-level validation** — a filter must be a non-null object, not an array. Without this, `'$and' in filter` would throw a confusing `TypeError` for a string.
- **`compileNode`** — recursively handles `$and`, `$or`, `$not`, or a set of field conditions. Each branch returns a closure; the final predicate is a composition of closures.
- **`isAnd` / `isOr` / `isNot`** — type guards. They check the key and, for `$and`/`$or`, that the value is an array.
- **`compileField`**:
  - A scalar means equality.
  - An array means membership (`$in` semantics).
  - An object is treated as operators; unknown keys throw `BadRequestError`.
- **Operator evaluation**:
  - `$eq` / `$ne` — strict equality.
  - `$in` / `$nin` — array membership.
  - `$gt` / `$gte` / `$lt` / `$lte` — require a number; a string does not silently compare.
  - `$exists` — compares `(value !== undefined)` to the boolean.
  - `$contains` — case-insensitive substring for strings, membership for arrays.
- **`getPath`** — dot notation (`payload.tenant`) with null/primitive guards. A missing path yields `undefined`.
- **Ordering** — `$exists` is checked first, then equality, then ranges. That is not strictly required, but it makes the common case cheap.

### Why a DSL instead of SQL?

The in-memory store has no SQL engine. A small structural filter compiles to a JS predicate, while the PostgreSQL adapter translates a subset to parameterized SQL and Qdrant receives its native filter. Keeping the DSL independent of any backend is what allows one API to expose all three.

### Filter strategies

| Strategy | How | Risk |
| :--- | :--- | :--- |
| **Pre-filter** | Select matching records first, then score | Correct; can be slow if the filter is broad |
| **Post-filter** | Search ANN, then drop non-matches | Can return fewer than K |
| **Filter-aware** | Index uses filter information during traversal | Best, but engine-specific |

This chapter implements pre-filter for exact search and post-filter for ANN, with an exact fallback when post-filtering underfills. That fallback is correct but potentially expensive — the latency is the lesson.

---

## 3. Vector Store — `src/store/vector-store.ts`

#### 📄 `src/store/vector-store.ts`

```ts
import { exactKnn } from '../core/exact-knn.js';
import { HnswIndex } from '../core/hnsw.js';
import { IvfIndex } from '../core/ivf.js';
import { PqIndex } from '../core/pq.js';
import { assertValidVector, prepare, toVector } from '../core/metrics.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { compileFilter } from './filters.js';
import type {
  Filter,
  HnswConfig,
  IndexConfig,
  IndexKind,
  IndexSearchResult,
  IndexStats,
  IvfConfig,
  Metric,
  PqConfig,
  PreparedRecord,
  SearchHit,
  StoreQueryOptions,
  StoreStats,
  UpsertInput,
} from '../types/vector.types.js';

export interface VectorStoreOptions {
  dimensions: number;
  metric: Metric;
  defaultIndex?: IndexConfig;
}

export interface StoreQueryResult<T = Record<string, unknown>> {
  hits: SearchHit<T>[];
  index: IndexKind;
  tookMs: number;
  /** True when a filtered ANN query underfilled and exact KNN finished it. */
  exactFallback: boolean;
}

export interface StoredRecordView<T = Record<string, unknown>> {
  id: string;
  payload: T;
  text?: string;
  vector?: number[];
}

interface BuiltIndex<T> {
  config: IndexConfig;
  index: IvfIndex<T> | HnswIndex<T> | PqIndex<T> | null;
  buildMs: number;
}

/**
 * A small vector database with the operations that matter:
 * upsert, get, delete, query, filter, index management and stats.
 *
 * Indexes are snapshots. Any write invalidates them and the next ANN query
 * rebuilds lazily. That is honest for a learning implementation: production
 * engines maintain indexes incrementally instead of rebuilding.
 */
export class VectorStore<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly dimensions: number;
  readonly metric: Metric;

  private readonly records = new Map<string, PreparedRecord<T>>();
  private readonly indexes = new Map<string, BuiltIndex<T>>();
  private readonly defaultIndex: IndexConfig;

  constructor(options: VectorStoreOptions) {
    if (options.dimensions < 1) throw new Error('Dimensions must be >= 1.');
    this.dimensions = options.dimensions;
    this.metric = options.metric;
    this.defaultIndex = options.defaultIndex ?? { kind: 'flat' };
  }

  upsert(inputs: readonly UpsertInput<T>[]): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;

    for (const input of inputs) {
      if (!input.id) throw new BadRequestError('Every record needs a non-empty id.');
      const vector = Float32Array.from(toVector(input.vector));
      if (vector.length !== this.dimensions) {
        throw new BadRequestError(
          `Dimension mismatch for "${input.id}": expected ${this.dimensions}, got ${vector.length}.`,
        );
      }
      assertValidVector(vector);

      const existed = this.records.has(input.id);
      this.records.set(input.id, {
        id: input.id,
        vector,
        norm: prepare(vector).norm,
        payload: (input.payload ?? {}) as T,
        text: input.text,
      });
      if (existed) updated++;
      else inserted++;
    }

    this.indexes.clear();
    return { inserted, updated };
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string, includeVector = false): StoredRecordView<T> {
    const record = this.records.get(id);
    if (!record) throw new NotFoundError(`Record "${id}" does not exist.`);
    return {
      id: record.id,
      payload: record.payload,
      text: record.text,
      vector: includeVector ? [...record.vector] : undefined,
    };
  }

  delete(ids: readonly string[]): number {
    let deleted = 0;
    for (const id of ids) if (this.records.delete(id)) deleted++;
    if (deleted > 0) this.indexes.clear();
    return deleted;
  }

  list(options: { limit?: number; offset?: number; filter?: Filter } = {}): {
    total: number;
    items: StoredRecordView<T>[];
  } {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const predicate = compileFilter<T>(options.filter);
    const matches = [...this.records.values()].filter((record) => predicate(record.payload));
    return {
      total: matches.length,
      items: matches.slice(offset, offset + limit).map((record) => ({
        id: record.id,
        payload: record.payload,
        text: record.text,
      })),
    };
  }

  query(options: StoreQueryOptions): StoreQueryResult<T> {
    const started = performance.now();
    const k = Math.min(Math.max(options.k ?? 10, 1), 1_000);
    const query = Float32Array.from(toVector(options.vector));
    if (query.length !== this.dimensions) {
      throw new BadRequestError(
        `Query dimension mismatch: expected ${this.dimensions}, got ${query.length}.`,
      );
    }
    assertValidVector(query);

    const filter = compileFilter<T>(options.filter);
    const recordFilter = (record: PreparedRecord<T>) => filter(record.payload);
    const kind = options.index ?? this.defaultIndex.kind;
    const config = this.queryConfig(kind, options);

    let results: IndexSearchResult<T>[];
    if (kind === 'flat') {
      results = exactKnn(this.snapshot(), query, {
        metric: this.metric,
        k,
        filter: recordFilter,
        recordsById: this.records,
      });
    } else {
      const built = this.ensureIndex(config);
      results = built.index!.search(query, {
        k,
        filter: recordFilter,
        nprobe: options.nprobe,
        efSearch: options.efSearch,
        rescore: options.rescore,
      });
    }

    let exactFallback = false;
    // Post-filtering can underfill. Rather than return fewer than K results,
    // fall back to an exact filtered scan — correct, but the latency is the
    // lesson: filtering inside the index is a first-class design problem.
    if (results.length < k && options.filter) {
      results = exactKnn(this.snapshot(), query, {
        metric: this.metric,
        k,
        filter: recordFilter,
        recordsById: this.records,
      });
      exactFallback = true;
    }

    return {
      hits: results.map((result) => this.toHit(result)),
      index: kind,
      tookMs: Number((performance.now() - started).toFixed(2)),
      exactFallback,
    };
  }

  buildIndex(config: IndexConfig): { stats: IndexStats; buildMs: number } {
    const normalized = this.normalizeConfig(config);
    if (normalized.kind === 'flat') return { stats: this.flatStats(), buildMs: 0 };
    const built = this.ensureIndex(normalized, true);
    return { stats: built.index!.stats(), buildMs: built.buildMs };
  }

  stats(): StoreStats {
    const records = this.snapshot();
    const vectorBytes = records.reduce((sum, record) => sum + record.vector.byteLength, 0);
    const built = [...this.indexes.values()].at(-1);
    const index = built?.index ? built.index.stats() : null;
    return {
      count: records.length,
      dimensions: this.dimensions,
      metric: this.metric,
      index,
      vectorBytes,
      totalMemoryBytes: vectorBytes + (index?.memoryBytes ?? 0),
    };
  }

  clear(): void {
    this.records.clear();
    this.indexes.clear();
  }

  all(): PreparedRecord<T>[] {
    return this.snapshot();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private snapshot(): PreparedRecord<T>[] {
    return [...this.records.values()];
  }

  private ensureIndex(config: IndexConfig, force = false): BuiltIndex<T> {
    const key = JSON.stringify(config);
    if (!force) {
      const existing = this.indexes.get(key);
      if (existing) return existing;
    }

    const started = performance.now();
    const index = this.createIndex(config);
    index?.build(this.snapshot());
    const built: BuiltIndex<T> = {
      config,
      index,
      buildMs: Number((performance.now() - started).toFixed(2)),
    };
    this.indexes.set(key, built);
    return built;
  }

  private createIndex(config: IndexConfig): IvfIndex<T> | HnswIndex<T> | PqIndex<T> | null {
    switch (config.kind) {
      case 'flat':
        return null;
      case 'ivf':
        return new IvfIndex<T>(this.metric, config.ivf ?? this.resolveIvf());
      case 'hnsw':
        return new HnswIndex<T>(this.metric, config.hnsw ?? this.resolveHnsw());
      case 'pq':
        return new PqIndex<T>(this.metric, config.pq ?? this.resolvePq());
    }
  }

  private normalizeConfig(config: IndexConfig): IndexConfig {
    switch (config.kind) {
      case 'flat':
        return { kind: 'flat' };
      case 'ivf':
        return { kind: 'ivf', ivf: this.resolveIvf(config.ivf) };
      case 'hnsw':
        return { kind: 'hnsw', hnsw: this.resolveHnsw(config.hnsw) };
      case 'pq':
        return { kind: 'pq', pq: this.resolvePq(config.pq) };
    }
  }

  private queryConfig(kind: IndexKind, options: StoreQueryOptions): IndexConfig {
    const base: IndexConfig = this.defaultIndex.kind === kind ? this.defaultIndex : { kind };
    const normalized = this.normalizeConfig(base);

    if (normalized.ivf) {
      normalized.ivf.nprobe = options.nprobe ?? normalized.ivf.nprobe;
    }
    if (normalized.hnsw) {
      normalized.hnsw.efSearch = options.efSearch ?? normalized.hnsw.efSearch;
    }
    return normalized;
  }

  private resolveIvf(config?: IvfConfig): IvfConfig {
    const nlist = config?.nlist ?? Math.max(1, Math.round(Math.sqrt(this.records.size || 1)));
    return {
      nlist,
      nprobe: config?.nprobe ?? Math.max(1, Math.round(Math.sqrt(nlist))),
      iterations: config?.iterations ?? 20,
      seed: config?.seed ?? 42,
    };
  }

  private resolveHnsw(config?: HnswConfig): HnswConfig {
    return {
      m: config?.m ?? 16,
      efConstruction: config?.efConstruction ?? 100,
      efSearch: config?.efSearch ?? 64,
      seed: config?.seed ?? 42,
    };
  }

  private resolvePq(config?: PqConfig): PqConfig {
    return {
      m: config?.m ?? defaultPqSubspaces(this.dimensions),
      ksub: config?.ksub ?? 256,
      iterations: config?.iterations ?? 15,
      seed: config?.seed ?? 42,
    };
  }

  private flatStats(): IndexStats {
    return {
      kind: 'flat',
      size: this.records.size,
      deleted: 0,
      memoryBytes: 0,
      params: { metric: this.metric },
    };
  }

  private toHit(result: IndexSearchResult<T>): SearchHit<T> {
    return {
      id: result.id,
      score: result.score,
      distance: result.distance,
      payload: result.record.payload,
      text: result.record.text,
    };
  }
}

/** Pick a valid PQ partition: D divisible by M, at least 4 values per subspace. */
export function defaultPqSubspaces(dimensions: number): number {
  for (let m = Math.min(96, dimensions); m >= 1; m--) {
    if (dimensions % m === 0 && dimensions / m >= 4) return m;
  }
  return 1;
}
```

**Block by block:**

### 3.1 Options and results

- **`VectorStoreOptions`** — dimensions, metric, optional default index. Dimensions and metric are immutable for the life of the store, just like a collection in Qdrant.
- **`StoreQueryResult`** — hits, the index used, latency, and `exactFallback`. Returning the effective index makes tuning visible in the API response.
- **`StoredRecordView`** — the API-facing row. The vector is omitted unless explicitly requested; sending 128–3072 floats per row by default is wasteful and leaks internal representation.
- **`BuiltIndex`** — config, concrete index instance (or `null` for flat), and build time.

### 3.2 Fields and constructor

- **`records`** — `Map<id, PreparedRecord>`. A map gives O(1) get/delete/upsert; insertion order provides stable list pagination.
- **`indexes`** — cache keyed by `JSON.stringify(config)`. Different `nprobe`/`efSearch` values create different keys because they are part of the config.
- **`defaultIndex`** — used when a query does not specify one.

### 3.3 `upsert` — insert and update in one operation

1. Validate a non-empty id.
2. Convert the vector to `Float32Array` and **copy** it. Without the copy, a caller could mutate the array after insertion and silently corrupt the store and any index built from it.
3. Check dimensions against the collection.
4. Validate finite values.
5. Record whether the id existed.
6. Write the prepared record.
7. Clear the index cache.

Returning `{ inserted, updated }` makes the operation observable and lets the HTTP layer choose 201 vs 200.

**Why clear every index?** Because an index is a snapshot of the old record set. Incremental maintenance is possible (and is what Qdrant does), but a partial update that forgets one index is worse than a lazy rebuild. The trade-off is documented in the code.

### 3.4 `get`, `delete`, `list`

- **`get`** — 404 via `NotFoundError`; optionally includes a copied vector.
- **`delete`** — deletes by id, returns the count, clears indexes only if something changed.
- **`list`** — compiles the filter, filters payloads, then paginates. Limit is clamped to 200 to keep a single request bounded.
- **`has`** — used by the PUT route to decide 201 vs 200.

### 3.5 `query` — the read path

1. Clamp K to `1..1000`.
2. Convert and validate the query vector.
3. Compile the payload filter into `filter(payload)`, then adapt it to `recordFilter(record)` for the index APIs.
4. Resolve the index kind and its normalized config.
5. **Flat** → `exactKnn`.
6. **ANN** → `ensureIndex(config)` then `index.search(...)`.
7. **Fallback** — if the ANN result has fewer than K hits *and* a filter was supplied, rerun exact KNN over the filtered set and mark `exactFallback: true`.
8. Map internal results to API hits.

Step 7 is the honest handling of the filter problem. Returning 3 results when the client asked for 10 is a bug; silently returning 3 without telling anyone is worse. The response carries the flag so the caller can see the cost.

### 3.6 `buildIndex` and `stats`

- **`buildIndex`** normalizes the config, handles `flat` separately (no index object), builds with `force=true`, and returns stats plus build time.
- **`stats`** reports live count, dimensions, metric, the last built index, raw vector bytes, and total bytes = vectors + index structure.
- Memory is deliberately split. An index that reports 6 GB when 6 GB is actually the vectors is lying about its overhead.

### 3.7 `ensureIndex` — lazy snapshots

- Key = serialized config.
- Cache hit → return it.
- Miss → create the concrete index, build from the current snapshot, measure, cache.

The `force` flag is used by the explicit admin build route. The lazy path is used by queries.

### 3.8 `normalizeConfig` / `queryConfig`

- `normalizeConfig` fills defaults from the current collection size:
  - IVF `nlist ≈ √N`, `nprobe ≈ √nlist`.
  - HNSW `M=16`, `efConstruction=100`, `efSearch=64`.
  - PQ `m` chosen so D is divisible and sub-dimension ≥ 4, `ksub=256`.
- `queryConfig` starts from the default config when the requested kind matches, then applies per-query `nprobe`/`efSearch`. This is why tuning one request does not rebuild the world with every possible parameter combination.

### 3.9 `defaultPqSubspaces`

Scans downward from `min(96, D)` for an `m` that divides D with at least 4 values per sub-space. For D=128 it returns 32 (sub-dim 4); for D=1536 it returns 96 (sub-dim 16). Returning 1 is the safe fallback for prime dimensions.

### 3.10 What this store deliberately does not do

- No persistence. A restart loses everything; Qdrant/pgvector adapters are the durable path.
- No incremental index maintenance. Writes invalidate; reads rebuild.
- No transactions across indexes.
- No replication, sharding, or auth.

The point is the contract: `upsert/get/delete/list/query/stats`. The production engines implement the same contract with very different internals.

---

## 4. Hybrid Search — `src/store/hybrid.ts`

#### 📄 `src/store/hybrid.ts`

```ts
import { TopK } from '../lib/topk.js';

export interface LexicalDoc {
  id: string;
  text: string;
}

export interface LexicalHit {
  id: string;
  score: number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it',
  'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'with',
]);

/**
 * BM25 — the lexical half of hybrid search.
 *
 * Dense vectors capture meaning but lose exact tokens (IDs, names, error codes).
 * BM25 captures term overlap and rare-term importance. Fusing both is standard
 * production retrieval; generation is deliberately out of scope for Lecture 10.
 */
export class Bm25Index {
  private readonly docs: { id: string; tokens: string[]; length: number }[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private averageLength = 0;

  constructor(
    documents: readonly LexicalDoc[],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    for (const document of documents) {
      const tokens = tokenize(document.text);
      this.docs.push({ id: document.id, tokens, length: tokens.length });
      for (const token of new Set(tokens)) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
    }
    this.averageLength =
      this.docs.length === 0
        ? 0
        : this.docs.reduce((sum, document) => sum + document.length, 0) / this.docs.length;
  }

  search(query: string, k = 10): LexicalHit[] {
    if (this.docs.length === 0 || k <= 0) return [];
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const top = new TopK(k);
    for (const document of this.docs) {
      const frequencies = new Map<string, number>();
      for (const token of document.tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }

      let score = 0;
      for (const term of new Set(terms)) {
        const tf = frequencies.get(term) ?? 0;
        if (tf === 0) continue;
        const df = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (document.length / (this.averageLength || 1)));
        score += idf * ((tf * (this.k1 + 1)) / denominator);
      }
      if (score > 0) top.push(document.id, score);
    }
    return top.results();
  }
}

/**
 * Reciprocal Rank Fusion: score = Σ weight / (k + rank).
 *
 * It needs only ranks, not comparable scores, which is why it can fuse cosine
 * similarity (0..1), BM25 (unbounded) and reranker scores without calibration.
 */
export function reciprocalRankFusion(
  resultSets: readonly (readonly LexicalHit[])[],
  options: { k?: number; weights?: readonly number[]; limit?: number } = {},
): LexicalHit[] {
  const k = options.k ?? 60;
  const weights = options.weights ?? [];
  const scores = new Map<string, number>();

  resultSets.forEach((results, setIndex) => {
    const weight = weights[setIndex] ?? 1;
    [...results]
      .sort((a, b) => b.score - a.score)
      .forEach((result, rank) => {
        scores.set(result.id, (scores.get(result.id) ?? 0) + weight / (k + rank + 1));
      });
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, options.limit ?? 10);
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(singularize);
}

function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}
```

**Block by block:**

- **`STOP_WORDS`** — a small list. Removing stop words prevents "the" from dominating BM25 scores; a real system uses a language-specific list.
- **`Bm25Index` constructor**:
  - Tokenize every document.
  - Store tokens and length.
  - Count document frequency per token.
  - Compute the average document length.
- **`search`**:
  - Tokenize the query.
  - For each document, build a term-frequency map.
  - For each unique query term, compute IDF and the BM25 term score.
  - Keep the top K with the same bounded heap.
- **BM25 formula**:
  ```text
  idf = ln(1 + (N - df + 0.5) / (df + 0.5))
  score = idf × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × dl / avgdl))
  ```
  - `k1=1.5` controls term-frequency saturation.
  - `b=0.75` controls length normalization.
  - A rare term (high IDF) matters more than a common one.
- **`reciprocalRankFusion`**:
  - For each result list, sort by score.
  - Add `weight / (k + rank + 1)` per id.
  - Merge and sort by fused score.
  - `k=60` is the standard RRF constant; it dampens the difference between the top few ranks.
- **`tokenize`** — Unicode words/numbers, drop single characters and stop words, then singularize. The singularization is deliberately naive: `vectors → vector`, but `analysis → analysi`. It is enough for the demo and honest about being a toy.
- **`singularize`** — strips a trailing `s` when the token is longer than 3 and does not end in `ss`.

### Why RRF instead of score addition?

Dense scores are cosine similarities in `[-1, 1]`; BM25 scores are unbounded. Adding them directly lets BM25 dominate. RRF uses only **ranks**, so it needs no calibration between retrievers. That is why it is the default fusion in Elasticsearch, Qdrant and Weaviate.

### Hybrid in the API

`POST /api/query` with `"hybrid": true`:

1. Dense search returns `k × 3` candidates.
2. BM25 returns `k × 3` candidates over the same filtered corpus.
3. RRF fuses them and returns K.

The BM25 index is rebuilt per request in this learning implementation. Production keeps a persistent inverted index and updates it incrementally.

---

## 5. Corpus and Seeding

#### 📄 `src/data/corpus.ts`

```ts
export interface CorpusDocument {
  id: string;
  text: string;
  payload: {
    tenant: 'acme' | 'globex';
    category: 'embeddings' | 'ann' | 'storage' | 'operations';
    year: number;
    [key: string]: unknown;
  };
}

/**
 * A small, deliberately overlapping corpus. Dense retrieval finds paraphrases;
 * BM25 finds exact tokens such as "HNSW", "pgvector" or "recall@10". Having both
 * is the point of the hybrid-search chapter.
 */
export const CORPUS: CorpusDocument[] = [
  {
    id: 'doc-001',
    text: 'An embedding maps text, images or audio into a fixed-length vector of floating point numbers. Similar meanings land close together in this space.',
    payload: { tenant: 'acme', category: 'embeddings', year: 2026 },
  },
  {
    id: 'doc-002',
    text: 'Cosine similarity measures the angle between two vectors and ignores their magnitude. It is the default metric for normalized text embeddings.',
    payload: { tenant: 'acme', category: 'embeddings', year: 2026 },
  },
  {
    id: 'doc-003',
    text: 'Dot product similarity is sensitive to vector length. If vectors are normalized, dot product and cosine similarity produce the same ranking.',
    payload: { tenant: 'globex', category: 'embeddings', year: 2025 },
  },
  {
    id: 'doc-004',
    text: 'Euclidean distance measures straight-line distance between two points. It is useful when magnitude carries meaning, such as image features.',
    payload: { tenant: 'globex', category: 'embeddings', year: 2025 },
  },
  {
    id: 'doc-005',
    text: 'Never mix embeddings from different models in one collection. Dimension equality is not enough; each model defines its own coordinate system.',
    payload: { tenant: 'acme', category: 'embeddings', year: 2026 },
  },
  {
    id: 'doc-006',
    text: 'Exact KNN compares the query against every stored vector. It returns perfect recall but costs O(N times D) per query and does not scale to millions of vectors.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-007',
    text: 'Recall at K measures how many of the true nearest neighbours an approximate index returned. It is the contract that makes ANN tuning measurable.',
    payload: { tenant: 'globex', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-008',
    text: 'IVF partitions vectors into nlist Voronoi cells with k-means, then searches only nprobe cells at query time. Larger nprobe improves recall and latency.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-009',
    text: 'HNSW builds a multi-layer proximity graph. Upper layers are sparse highways and layer zero is dense. Queries greedily descend then search with efSearch.',
    payload: { tenant: 'globex', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-010',
    text: 'HNSW parameters trade resources for recall. M controls graph degree, efConstruction controls build quality, and efSearch controls query quality.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-011',
    text: 'Boundary vectors are the weakness of IVF. A point just across a cell boundary may be the true nearest neighbour but is never scanned when nprobe is small.',
    payload: { tenant: 'globex', category: 'ann', year: 2025 },
  },
  {
    id: 'doc-012',
    text: 'Product quantization splits a vector into sub-vectors, learns codewords per subspace, and stores only 8-bit codebook indices. ADC approximates distance from lookup tables.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-013',
    text: 'Scalar quantization stores each float as int8 instead of float32. It typically cuts memory four times with a small recall loss and is easy to enable in Qdrant.',
    payload: { tenant: 'globex', category: 'ann', year: 2025 },
  },
  {
    id: 'doc-014',
    text: 'Two-stage retrieval uses an ANN index to generate candidates and then rescores them with full-precision vectors. Final recall cannot exceed candidate recall.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-015',
    text: 'A vector database stores an ID, a vector, and a payload. Collections fix the dimension, metric, and index so that records remain comparable.',
    payload: { tenant: 'acme', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-016',
    text: 'Qdrant is an HNSW-based vector database written in Rust. It supports payload filtering, scalar and product quantization, snapshots and multi-tenancy.',
    payload: { tenant: 'globex', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-017',
    text: 'pgvector adds a vector column type and HNSW or IVFFlat indexes to PostgreSQL. It is a strong choice when vectors must join relational data.',
    payload: { tenant: 'acme', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-018',
    text: 'A B-tree cannot index cosine similarity because embeddings have no total order. That is why dedicated ANN indexes such as HNSW and IVF exist.',
    payload: { tenant: 'globex', category: 'storage', year: 2025 },
  },
  {
    id: 'doc-019',
    text: 'Metadata filtering has three strategies: pre-filter, post-filter, and filter-aware search. Post-filtering can return fewer than K results when the filter is selective.',
    payload: { tenant: 'acme', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-020',
    text: 'Hybrid search fuses dense semantic retrieval with sparse lexical retrieval. Reciprocal rank fusion combines ranks without calibrating scores across systems.',
    payload: { tenant: 'globex', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-021',
    text: 'Deletes in HNSW are usually tombstones. The graph keeps the node for navigation, filters it from results, and compacts later to reclaim memory.',
    payload: { tenant: 'acme', category: 'operations', year: 2026 },
  },
  {
    id: 'doc-022',
    text: 'Re-embedding a collection is a migration. Build the new collection, backfill with the new model, compare recall, then swap an alias and keep the old one for rollback.',
    payload: { tenant: 'globex', category: 'operations', year: 2026 },
  },
  {
    id: 'doc-023',
    text: 'Monitor p95 and p99 query latency, recall on a golden set, index build time, deletion backlog, and embedding provider error rates. Averages hide tail pain.',
    payload: { tenant: 'acme', category: 'operations', year: 2026 },
  },
  {
    id: 'doc-024',
    text: 'A tenant filter should be mandatory in every query. Use a tenant-aware payload index and, in Qdrant, is_tenant to keep each tenant isolated and fast.',
    payload: { tenant: 'globex', category: 'operations', year: 2026 },
  },
];
```

**Block by block:**

- **`CorpusDocument`** — id, text, and payload with tenant/category/year. The index signature satisfies the generic payload constraint.
- **`CORPUS`** — 24 documents covering embeddings, ANN, storage and operations. Each is short, self-contained, and overlaps semantically with its neighbours.
- **Tenant split** — `acme` and `globex` alternate so filter tests have two real partitions.
- **Exact tokens** — `HNSW`, `pgvector`, `Qdrant`, `recall@10` appear so BM25 has something dense retrieval might miss.

#### 📄 `src/services/seed.service.ts`

```ts
import type { CorpusDocument } from '../data/corpus.js';
import { CORPUS } from '../data/corpus.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';

export interface SeedResult {
  inserted: number;
  updated: number;
  documents: number;
}

/** Embed the corpus once, then upsert. Used by boot, the admin route and scripts. */
export async function seedStore(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
  documents: readonly CorpusDocument[] = CORPUS,
): Promise<SeedResult> {
  const vectors = await embeddings.embedDocuments(documents.map((document) => document.text));
  const result = store.upsert(
    documents.map((document, index) => ({
      id: document.id,
      vector: vectors[index],
      payload: document.payload,
      text: document.text,
    })),
  );
  return { ...result, documents: documents.length };
}
```

**Block by block:**

- **`seedStore`** — batches all texts into one `embedDocuments` call, maps vectors to ids/payloads/text, and performs one upsert.
- **Return value** — inserted/updated counts plus document count, so boot logs and the admin endpoint report something meaningful.
- **No index build** — the store rebuilds lazily on the first ANN query, or `server.ts` builds the configured default eagerly.

Seeding is idempotent: ids are stable, so re-running updates rather than duplicates.

---

## 6. Verification

```bash
npm run verify
```

```text
  ok  store CRUD, filters and ANN query paths (1.4 ms)
  ok  filter operators compile to a predicate (0.2 ms)
  ok  BM25 and reciprocal rank fusion (0.9 ms)
```

The store test covers:

- upsert (insert + update), get, delete, has, missing id.
- dimension mismatch rejection.
- exact query order.
- tenant filter.
- IVF, HNSW and PQ query paths on a three-record store.

The filter test covers `$and`, `$gte`, `$lt`, `$ne`, `$contains`, and an unsupported operator.

The hybrid test asserts that BM25 ranks the HNSW document first for "hnsw" and that RRF puts the document appearing in both lists first.

```bash
npm run demo
```

```text
3. Metadata filter: tenant = acme
  doc-001  score=0.1888 ...
  doc-008  score=0.1205 ...
  doc-005  score=0.1078 ...

4. Hybrid retrieval (dense + BM25, fused with RRF)
  doc-007  rrf=0.03279
  doc-001  rrf=0.01613
  doc-011  rrf=0.01613
```

**Next:** [Chapter 08 — Qdrant Adapter](./08_Qdrant_Adapter.md)


