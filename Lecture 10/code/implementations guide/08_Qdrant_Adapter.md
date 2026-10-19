# Chapter 08: Qdrant Adapter

> **Chapter Goal:** Replace the in-memory store with a real vector database through its official client. Keep the same conceptual operations — create, upsert, query, filter, delete — and learn the details that only appear in production: UUID point IDs, payload indexes, quantization and collection configuration.

> **Lecture mapping:** Notes Chapter 08 (Qdrant object model, collections, points, payload indexes, filtering, multi-tenancy, operations).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/adapters/qdrant.adapter.ts` | 227 | Typed wrapper over `@qdrant/js-client-rest`. |
| `src/scripts/seed.ts` | 78 | Create collection, indexes, upsert the corpus, run a filtered query. |
| `src/scripts/check-services.ts` | 53 | Connectivity check for Qdrant and pgvector. |

---

## 1. Start Qdrant

```bash
npm run qdrant:up
# docker run --rm -p 6333:6333 -p 6334:6334 qdrant/qdrant
```

- `6333` — REST API and dashboard (`http://localhost:6333/dashboard`).
- `6334` — gRPC.

Then:

```bash
npm run seed:qdrant
npm run adapter:crud:qdrant
```

---

## 2. Adapter — `src/adapters/qdrant.adapter.ts`

#### 📄 `src/adapters/qdrant.adapter.ts`

```ts
import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { Schemas } from '@qdrant/js-client-rest';
import type { Metric } from '../types/vector.types.js';

export interface QdrantAdapterOptions {
  url: string;
  apiKey?: string;
  collection: string;
  dimensions: number;
  metric: Metric;
}

export interface QdrantRecord {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
  text?: string;
}

export interface QdrantHit {
  id: string;
  score: number;
  distance: number;
  payload: Record<string, unknown>;
  text?: string;
}

/**
 * Thin, typed adapter over `@qdrant/js-client-rest`.
 *
 * Two production details are visible here:
 *  1. Qdrant point IDs must be UUIDs or uint64. Arbitrary application IDs are
 *     mapped to deterministic UUIDs and kept in `_external_id`.
 *  2. Payload indexes are declared up front. Filtering without an index forces
 *     a scan and is the usual cause of "vector search is slow" tickets.
 */
export class QdrantAdapter {
  readonly client: QdrantClient;
  readonly collection: string;
  readonly dimensions: number;
  readonly metric: Metric;

  constructor(options: QdrantAdapterOptions) {
    this.client = new QdrantClient({
      url: options.url,
      apiKey: options.apiKey,
      timeout: 30_000,
    });
    this.collection = options.collection;
    this.dimensions = options.dimensions;
    this.metric = options.metric;
  }

  async ensureCollection(options: {
    m?: number;
    efConstruction?: number;
    quantization?: 'none' | 'int8';
  } = {}): Promise<boolean> {
    const exists = await this.client.collectionExists(this.collection);
    if (exists.exists) return false;

    await this.client.createCollection(this.collection, {
      vectors: { size: this.dimensions, distance: distanceName(this.metric) },
      hnsw_config: {
        m: options.m ?? 16,
        ef_construct: options.efConstruction ?? 100,
      },
      quantization_config:
        options.quantization === 'int8'
          ? { scalar: { type: 'int8', quantile: 0.99, always_ram: true } }
          : undefined,
    });
    return true;
  }

  async createPayloadIndexes(): Promise<void> {
    const indexes: { field: string; schema: 'keyword' | 'integer' }[] = [
      { field: 'tenant', schema: 'keyword' },
      { field: 'category', schema: 'keyword' },
      { field: 'year', schema: 'integer' },
      { field: '_external_id', schema: 'keyword' },
    ];
    for (const index of indexes) {
      await this.client.createPayloadIndex(this.collection, {
        wait: true,
        field_name: index.field,
        field_schema: index.schema,
      });
    }
  }

  async upsert(records: readonly QdrantRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    await this.client.upsert(this.collection, {
      wait: true,
      points: records.map((record) => ({
        id: toPointId(record.id),
        vector: record.vector,
        payload: { ...record.payload, _external_id: record.id, text: record.text },
      })),
    });
    return records.length;
  }

  async get(id: string, withVector = false): Promise<QdrantHit | null> {
    const points = await this.client.retrieve(this.collection, {
      ids: [toPointId(id)],
      with_payload: true,
      with_vector: withVector,
    });
    if (points.length === 0) return null;
    return toHit(points[0], this.metric);
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete(this.collection, {
      wait: true,
      points: ids.map(toPointId),
    });
  }

  async query(
    vector: readonly number[],
    options: {
      k?: number;
      filter?: Schemas['Filter'];
      scoreThreshold?: number;
      efSearch?: number;
      withPayload?: boolean;
    } = {},
  ): Promise<QdrantHit[]> {
    const response = await this.client.query(this.collection, {
      query: [...vector],
      limit: options.k ?? 10,
      with_payload: options.withPayload ?? true,
      with_vector: false,
      filter: options.filter,
      score_threshold: options.scoreThreshold,
      params:
        options.efSearch !== undefined
          ? { hnsw_ef: options.efSearch, exact: false }
          : undefined,
    });
    return response.points.map((point) => toHit(point, this.metric));
  }

  async count(): Promise<number> {
    const result = await this.client.count(this.collection, { exact: true });
    return result.count;
  }

  async scroll(limit = 20, offset?: string | number): Promise<QdrantHit[]> {
    const result = await this.client.scroll(this.collection, {
      limit,
      offset,
      with_payload: true,
      with_vector: false,
    });
    return result.points.map((point) => toHit(point, this.metric));
  }

  async health(): Promise<{ ok: boolean; collections: string[]; count: number }> {
    const collections = await this.client.getCollections();
    const exists = await this.client.collectionExists(this.collection);
    return {
      ok: true,
      collections: collections.collections.map((collection) => collection.name),
      count: exists.exists ? await this.count() : 0,
    };
  }

  async deleteCollection(): Promise<void> {
    await this.client.deleteCollection(this.collection);
  }
}

/** Application id -> deterministic UUIDv5-shaped point id. */
export function toPointId(id: string): string {
  const hex = createHash('sha1').update(`lecture10:${id}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function distanceName(metric: Metric): 'Cosine' | 'Dot' | 'Euclid' | 'Manhattan' {
  switch (metric) {
    case 'cosine':
      return 'Cosine';
    case 'dot':
      return 'Dot';
    case 'euclid':
      return 'Euclid';
    case 'manhattan':
      return 'Manhattan';
  }
}

function toHit(point: Schemas['ScoredPoint'] | Schemas['Record'], metric: Metric): QdrantHit {
  const payload = { ...(point.payload ?? {}) } as Record<string, unknown>;
  const external = payload._external_id;
  const text = payload.text;
  delete payload._external_id;
  delete payload.text;

  // Qdrant returns similarity for cosine/dot and distance for euclid/manhattan.
  // Normalize to the codebase contract: score is always higher-is-better.
  // get()/scroll() have no query, so they carry no meaningful score.
  const hasScore = 'score' in point && typeof point.score === 'number';
  const raw = hasScore ? point.score : 0;
  const score = !hasScore ? 0 : metric === 'cosine' || metric === 'dot' ? raw : -raw;
  const distance = !hasScore ? 0 : metric === 'cosine' ? 1 - raw : metric === 'dot' ? -raw : raw;

  return {
    id: typeof external === 'string' ? external : String(point.id),
    score,
    distance,
    payload,
    text: typeof text === 'string' ? text : undefined,
  };
}
```

**Block by block:**

### 2.1 Client construction

```ts
this.client = new QdrantClient({ url, apiKey, timeout: 30_000 });
```

The official client handles request signing, retries and JSON shaping. A 30 s timeout is deliberate: vector operations should fail fast enough for the caller to retry, not hang until the load balancer gives up.

### 2.2 `ensureCollection`

1. `collectionExists` — idempotent.
2. If absent, `createCollection` with:
   - `vectors.size = dimensions`
   - `vectors.distance` mapped from our metric
   - `hnsw_config.m` and `ef_construct`
   - optional int8 scalar quantization

Qdrant fixes the vector size and distance at collection creation. Changing the embedding model requires a **new collection**, not an update. This is the operational form of the notes' "model and collection are coupled" rule.

### 2.3 `createPayloadIndexes`

Creates keyword indexes on `tenant`, `category`, `_external_id`, and an integer index on `year`.

Without an index, a filter forces a payload scan. With one, Qdrant can restrict the candidate set before graph traversal. This is the difference between a 20 ms query and a 2 s query on a large collection.

For multi-tenant workloads, Qdrant's `is_tenant: true` option on a keyword index is the production choice; it tells the planner that the field partitions the collection. The notes call this out; the adapter keeps the simpler `keyword` schema so it runs on every version.

### 2.4 `upsert`

Qdrant point IDs must be **UUIDs or unsigned 64-bit integers**. Application ids like `doc-001` are neither.

`toPointId` maps every external id to a deterministic UUID:

```ts
sha1("lecture10:" + id) → 8-4-4-4-12 UUIDv5-shaped string
```

The original id is stored in `payload._external_id`, and `toHit` restores it. Deterministic mapping means the same document always lands on the same point, so upsert is idempotent and delete works without a lookup table.

`wait: true` makes the write visible before returning. In production, batch writes often use `wait: false` and monitor the operation; for a learning demo, correctness beats throughput.

### 2.5 `get`, `delete`, `query`

- **`get`** — `retrieve` by mapped id, with optional vector.
- **`delete`** — `delete` with mapped point ids, `wait: true`.
- **`query`** — the universal query API:
  - `query: [...vector]` — dense vector query.
  - `limit` — K.
  - `with_payload` — true by default.
  - `with_vector: false` — do not ship floats the caller did not ask for.
  - `filter` — Qdrant-native filter (`{ must: [...] }`).
  - `score_threshold` — optional.
  - `params.hnsw_ef` — per-query `efSearch`.
- **`toHit`** — strips `_external_id` and `text` from the payload, restores the external id, and normalizes score.

### 2.6 `count`, `scroll`, `health`

- **`count`** — exact count. On large collections, use approximate counts unless the number is a business metric.
- **`scroll`** — paginated payload listing without vector search; useful for exports and audits.
- **`health`** — lists collections and checks whether the configured collection exists. `count` is only called if it exists.

### 2.7 `toPointId` — deterministic UUID

```ts
const hex = sha1("lecture10:" + id)
variant = (hex[16..18] & 0x3f) | 0x80
uuid = hex[0..8] - hex[8..12] - "5" + hex[13..16] - variant + hex[18..20] - hex[20..32]
```

- Version nibble is `5` (name-based).
- Variant bits are set to `10xx`.
- The namespace prefix `lecture10:` avoids collisions with other applications using the same ids.

This is UUIDv5-shaped, not a standards-compliant UUIDv5 (which would hash a namespace UUID plus the name). It is deterministic and collision-resistant enough for a point id; the original id remains the source of truth.

### 2.8 Distance mapping and score normalization

| Our metric | Qdrant distance | Qdrant raw score |
| :--- | :--- | :--- |
| `cosine` | `Cosine` | similarity (higher better) |
| `dot` | `Dot` | dot product (higher better) |
| `euclid` | `Euclid` | distance (lower better) |
| `manhattan` | `Manhattan` | distance (lower better) |

Qdrant returns similarity for cosine/dot and distance for Euclid/Manhattan. The adapter normalizes this in `toHit`:

```ts
score = cosine || dot ? raw : -raw
distance = cosine ? 1 - raw : dot ? -raw : raw
```

That keeps the multi-backend contract identical to the in-memory store: **score is always higher-is-better, distance is always native**. Without this normalization, a caller switching from `cosine` to `euclid` would silently invert the sort order.

---

## 3. Seed Script — `src/scripts/seed.ts`

#### 📄 `src/scripts/seed.ts`

```ts
import { env } from '../config/env.js';
import { CORPUS } from '../data/corpus.js';
import { createEmbeddingProvider } from '../embeddings/provider.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import { QdrantAdapter } from '../adapters/qdrant.adapter.js';
import { PgVectorAdapter } from '../adapters/pgvector.adapter.js';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target !== 'qdrant' && target !== 'pgvector') {
    throw new Error('Usage: tsx src/scripts/seed.ts <qdrant|pgvector>');
  }

  const provider = createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    apiKey:
      env.EMBEDDING_PROVIDER === 'openai'
        ? env.OPENAI_API_KEY
        : env.EMBEDDING_PROVIDER === 'gemini'
          ? env.GEMINI_API_KEY
          : undefined,
  });
  const embeddings = new EmbeddingService(provider);
  const vectors = await embeddings.embedDocuments(CORPUS.map((document) => document.text));
  const queryVector = await embeddings.embedQuery('graph based nearest neighbour index');

  const records = CORPUS.map((document, index) => ({
    id: document.id,
    vector: vectors[index],
    payload: document.payload as Record<string, unknown>,
    text: document.text,
    model: provider.model,
  }));

  if (target === 'qdrant') {
    const adapter = new QdrantAdapter({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      collection: env.QDRANT_COLLECTION,
      dimensions: provider.dimensions,
      metric: env.VECTOR_METRIC,
    });
    const created = await adapter.ensureCollection({ quantization: 'int8' });
    if (created) await adapter.createPayloadIndexes();
    const upserted = await adapter.upsert(records);
    const hits = await adapter.query(queryVector, {
      k: 3,
      filter: { must: [{ key: 'tenant', match: { value: 'acme' } }] },
    });

    console.log(`[qdrant] ${created ? 'created' : 'reused'} ${env.QDRANT_COLLECTION}`);
    console.log(`[qdrant] upserted ${upserted}, count=${await adapter.count()}`);
    for (const hit of hits) console.log(`  ${hit.id} score=${hit.score.toFixed(4)}`);
    return;
  }

  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for the pgvector target.');
  const adapter = new PgVectorAdapter({
    connectionString: env.DATABASE_URL,
    table: env.PGVECTOR_TABLE,
    dimensions: provider.dimensions,
    metric: env.VECTOR_METRIC,
  });
  await adapter.initialize({ index: 'hnsw' });
  const upserted = await adapter.upsert(records);
  const hits = await adapter.query(queryVector, { k: 3, filter: { tenant: 'acme' } });

  console.log(`[pgvector] upserted ${upserted}, count=${await adapter.count()}`);
  for (const hit of hits) console.log(`  ${hit.id} score=${hit.score.toFixed(4)}`);
  await adapter.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**Block by block:**

- **Argument check** — `qdrant` or `pgvector`; anything else fails with usage.
- **Provider construction** — same factory as the API. With the default env this is the mock provider at 128 dimensions, which is why the Docker demo needs no API key.
- **Embedding** — one batch for all 24 documents, one query embedding for the smoke query.
- **Record mapping** — id, vector, payload, text, model. The model is useful provenance in both databases.
- **Qdrant path**:
  1. `ensureCollection({ quantization: 'int8' })` — create if absent.
  2. `createPayloadIndexes()` only when newly created.
  3. `upsert(records)`.
  4. Query with a tenant filter.
- **pgvector path** — see Chapter 09.
- **Output** — count and top-3 scores. The same corpus should produce the same ids in both databases when the same embedding model and metric are used.

### Why `quantization: 'int8'`?

It demonstrates the production memory lever: each float32 becomes one signed byte inside Qdrant, with rescoring. The collection remains queryable in full precision at the API level. For a 128-dimension mock vector the saving is small; at 1536 dimensions it is 4×.

---

## 4. Connectivity Script — `src/scripts/check-services.ts`

#### 📄 `src/scripts/check-services.ts`

```ts
import { env } from '../config/env.js';
import { QdrantAdapter } from '../adapters/qdrant.adapter.js';
import { PgVectorAdapter } from '../adapters/pgvector.adapter.js';

async function main(): Promise<void> {
  console.log('\nService connectivity\n');

  const qdrant = new QdrantAdapter({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
    collection: env.QDRANT_COLLECTION,
    dimensions: env.EMBEDDING_DIMENSIONS,
    metric: env.VECTOR_METRIC,
  });
  try {
    const health = await qdrant.health();
    console.log(`  qdrant    ok  url=${env.QDRANT_URL} collections=${health.collections.join(', ')}`);
    console.log(`            collection=${env.QDRANT_COLLECTION} count=${health.count}`);
  } catch (error) {
    console.log(`  qdrant    unavailable at ${env.QDRANT_URL}`);
    console.log(`            ${error instanceof Error ? error.message : String(error)}`);
    console.log('            start it with: npm run qdrant:up');
  }

  if (!env.DATABASE_URL) {
    console.log('  pgvector  skipped (DATABASE_URL is not set)');
  } else {
    const pgvector = new PgVectorAdapter({
      connectionString: env.DATABASE_URL,
      table: env.PGVECTOR_TABLE,
      dimensions: env.EMBEDDING_DIMENSIONS,
      metric: env.VECTOR_METRIC,
    });
    try {
      const health = await pgvector.health();
      console.log(`  pgvector  ${health.ok ? 'ok' : 'extension missing'}  version=${health.extension}`);
      console.log(`            table=${env.PGVECTOR_TABLE} count=${health.count}`);
    } catch (error) {
      console.log(`  pgvector  unavailable at ${env.DATABASE_URL}`);
      console.log(`            ${error instanceof Error ? error.message : String(error)}`);
      console.log('            start it with: npm run pgvector:up');
    } finally {
      await pgvector.close();
    }
  }

  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**Block by block:**

- **Qdrant** — `health()` lists collections and counts the configured one. If the service is down, it prints the start command instead of a stack trace.
- **pgvector** — checks the `vector` extension and the table count. Before `initialize`, the extension may be missing; that is reported, not thrown.
- **No hard failure** — a missing service is an environment condition, not a code bug. The script exits 0 and tells you what to run.

---

## 5. Verification

```bash
npm run services:check
npm run seed:qdrant
npm run adapter:crud:qdrant
```

Actual output from the validated run:

```text
Service connectivity

  qdrant    ok  url=http://localhost:6333 collections=lecture10_documents
            collection=lecture10_documents count=24
  pgvector  extension missing  version=null
            table=lecture10_documents_written_by_me count=0
```

```text
[qdrant] created lecture10_documents
[qdrant] upserted 24, count=24
  doc-001 score=0.1722
  doc-008 score=0.1521
  doc-010 score=0.1424
```

```text
[qdrant] upsert -> update -> filter -> delete ok (count=24)
```

The CRUD script proves:

1. Upsert inserts the smoke document.
2. Upsert again with the same id updates `year` from 2026 to 2027.
3. A tenant-filtered query returns it.
4. Delete removes it; `get` returns `null`.
5. Count returns to 24 — no orphan.

### Operational notes

- **Collection dims/metric are immutable.** Re-embedding needs a new collection and an alias swap.
- **Payload indexes are not optional** for filtered search at scale.
- **`wait: true`** is for correctness. Batch ingestion should use async waits and monitor.
- **Qdrant is HNSW-only.** Unlike the teaching code, it does not expose IVF; product quantization and scalar quantization are configuration.
- **Snapshots** — Qdrant supports them, but this adapter does not wrap the snapshot API. Add it before production backups.

**Next:** [Chapter 09 — pgvector Adapter](./09_pgvector_Adapter.md)

