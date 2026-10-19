# Chapter 09: pgvector Adapter

> **Chapter Goal:** Store vectors inside PostgreSQL and let the database rank them with `pgvector`. Use the official `pg` driver, parameterize every value, create HNSW/IVFFlat indexes, and keep the same CRUD contract as Qdrant.

> **Lecture mapping:** Notes Chapter 08 (pgvector operators, halfvec/bit limits, iterative scans, when PostgreSQL is the right choice).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/adapters/pgvector.adapter.ts` | 284 | Pool, DDL, upsert, query, filters, health. |
| `src/scripts/adapter-crud.ts` | 86 | Real-database CRUD proof for Qdrant and pgvector. |

---

## 1. Start PostgreSQL with pgvector

Port 5432 is often already occupied. Use 5433 locally:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5433:5432 pgvector/pgvector:pg17

export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
npm run seed:pgvector
npm run adapter:crud:pgvector
```

The adapter runs `CREATE EXTENSION IF NOT EXISTS vector`; the image ships the extension, but the database must still enable it.

---

## 2. Schema

```sql
CREATE TABLE lecture10_documents (
  id text PRIMARY KEY,
  embedding vector(128) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  text text,
  embedding_model text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 100);
```

Why this shape:

- `vector(D)` enforces the dimension at the database level. A wrong-width insert fails instead of silently storing garbage.
- `payload jsonb` keeps metadata flexible; a GIN index can be added if containment filters become hot.
- `text` stores the original content for hybrid search and display.
- `embedding_model` is provenance. Mixing models in one table is the same coordinate-system bug as mixing them in Qdrant.
- `updated_at` supports freshness and debugging.
- One index per metric. `vector_cosine_ops`, `vector_l2_ops`, `vector_ip_ops`, `vector_l1_ops` are not interchangeable.

---

## 3. Adapter — `src/adapters/pgvector.adapter.ts`

#### 📄 `src/adapters/pgvector.adapter.ts`

```ts
import { Pool } from 'pg';
import type { Metric } from '../types/vector.types.js';

export interface PgVectorOptions {
  connectionString: string;
  table: string;
  dimensions: number;
  metric: Metric;
}

export interface PgVectorRecord {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
  text?: string;
  model?: string;
}

export interface PgVectorFilter {
  tenant?: string;
  category?: string;
  yearFrom?: number;
  yearTo?: number;
  payloadContains?: Record<string, unknown>;
}

export interface PgVectorHit {
  id: string;
  score: number;
  distance: number;
  payload: Record<string, unknown>;
  text?: string;
}

/**
 * pgvector adapter over the official `pg` driver.
 *
 * The database does the ranking: `ORDER BY embedding <=> $1 LIMIT k` uses the
 * HNSW index. Scores are normalized to higher-is-better in JS so the API looks
 * the same as the in-memory store and Qdrant.
 */
export class PgVectorAdapter {
  private readonly pool: Pool;
  private readonly table: string;
  private readonly dimensions: number;
  private readonly metric: Metric;

  constructor(options: PgVectorOptions) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(options.table)) {
      throw new Error(`Unsafe table name: ${options.table}`);
    }
    if (options.dimensions < 1 || options.dimensions > 16_000) {
      throw new Error('pgvector dimensions must be between 1 and 16000.');
    }
    this.pool = new Pool({ connectionString: options.connectionString, max: 10 });
    this.table = options.table;
    this.dimensions = options.dimensions;
    this.metric = options.metric;
  }

  async initialize(options: { index?: 'hnsw' | 'ivfflat' | 'none'; lists?: number } = {}): Promise<void> {
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "${this.table}" (
        id text PRIMARY KEY,
        embedding vector(${this.dimensions}) NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        text text,
        embedding_model text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const index = options.index ?? 'hnsw';
    if (index === 'hnsw') {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS "${this.table}_embedding_hnsw"
        ON "${this.table}" USING hnsw (embedding ${opsClass(this.metric)})
        WITH (m = 16, ef_construction = 100)
      `);
    } else if (index === 'ivfflat') {
      const lists = Math.max(1, Math.floor(options.lists ?? 100));
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS "${this.table}_embedding_ivfflat"
        ON "${this.table}" USING ivfflat (embedding ${opsClass(this.metric)})
        WITH (lists = ${lists})
      `);
    }
  }

  async upsert(records: readonly PgVectorRecord[]): Promise<number> {
    for (const batch of chunk(records, 200)) {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      batch.forEach((record, index) => {
        this.assertDimensions(record.vector);
        const offset = index * 5;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}::vector, $${offset + 3}::jsonb, $${offset + 4}, $${offset + 5})`,
        );
        values.push(
          record.id,
          toSqlVector(record.vector),
          JSON.stringify(record.payload),
          record.text ?? null,
          record.model ?? null,
        );
      });

      await this.pool.query(
        `INSERT INTO "${this.table}" (id, embedding, payload, text, embedding_model)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (id) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           payload = EXCLUDED.payload,
           text = EXCLUDED.text,
           embedding_model = EXCLUDED.embedding_model,
           updated_at = now()`,
        values,
      );
    }
    return records.length;
  }

  async get(id: string, withVector = false): Promise<(PgVectorHit & { vector?: number[] }) | null> {
    const result = await this.pool.query(
      `SELECT id, payload, text,
              ${withVector ? 'embedding::text AS embedding' : 'NULL AS embedding'}
       FROM "${this.table}" WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      score: 0,
      distance: 0,
      payload: row.payload as Record<string, unknown>,
      text: row.text ?? undefined,
      vector: withVector && row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
    };
  }

  async delete(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `DELETE FROM "${this.table}" WHERE id = ANY($1::text[])`,
      [ids],
    );
    return result.rowCount ?? 0;
  }

  async query(
    vector: readonly number[],
    options: {
      k?: number;
      filter?: PgVectorFilter;
      efSearch?: number;
      withPayload?: boolean;
    } = {},
  ): Promise<PgVectorHit[]> {
    this.assertDimensions(vector);
    const params: unknown[] = [toSqlVector(vector)];
    const conditions: string[] = [];

    const filter = options.filter;
    if (filter?.tenant !== undefined) {
      conditions.push(`payload->>'tenant' = $${params.push(filter.tenant)}`);
    }
    if (filter?.category !== undefined) {
      conditions.push(`payload->>'category' = $${params.push(filter.category)}`);
    }
    if (filter?.yearFrom !== undefined) {
      conditions.push(`(payload->>'year')::int >= $${params.push(filter.yearFrom)}`);
    }
    if (filter?.yearTo !== undefined) {
      conditions.push(`(payload->>'year')::int <= $${params.push(filter.yearTo)}`);
    }
    if (filter?.payloadContains !== undefined) {
      conditions.push(`payload @> $${params.push(JSON.stringify(filter.payloadContains))}::jsonb`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const efSearch = Math.min(Math.max(options.efSearch ?? 64, 1), 1_000);
    const limit = Math.min(Math.max(options.k ?? 10, 1), 1_000);
    const sql = `
      SELECT id, payload, text,
             (embedding ${operator(this.metric)} $1::vector) AS distance
      FROM "${this.table}"
      ${where}
      ORDER BY embedding ${operator(this.metric)} $1::vector
      LIMIT $${params.push(limit)}
    `;

    // hnsw.ef_search is a session GUC. set_config(..., true) scopes it to the
    // transaction, so pooled connections never leak tuning between requests.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(efSearch)]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows.map((row) => ({
        id: row.id,
        distance: Number(row.distance),
        score: scoreFromDistance(this.metric, Number(row.distance)),
        payload: options.withPayload === false ? {} : (row.payload as Record<string, unknown>),
        text: row.text ?? undefined,
      }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async count(): Promise<number> {
    const result = await this.pool.query(`SELECT count(*)::int AS count FROM "${this.table}"`);
    return result.rows[0].count as number;
  }

  async health(): Promise<{ ok: boolean; extension: string | null; count: number }> {
    const extension = await this.pool.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    return {
      ok: extension.rows.length > 0,
      extension: extension.rows[0]?.extversion ?? null,
      count: extension.rows.length > 0 ? await this.count() : 0,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private assertDimensions(vector: readonly number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`Expected ${this.dimensions} dimensions, got ${vector.length}.`);
    }
  }
}

function operator(metric: Metric): '<->' | '<=>' | '<#>' | '<+>' {
  switch (metric) {
    case 'cosine':
      return '<=>';
    case 'dot':
      return '<#>';
    case 'euclid':
      return '<->';
    case 'manhattan':
      return '<+>';
  }
}

function opsClass(metric: Metric): string {
  switch (metric) {
    case 'cosine':
      return 'vector_cosine_ops';
    case 'dot':
      return 'vector_ip_ops';
    case 'euclid':
      return 'vector_l2_ops';
    case 'manhattan':
      return 'vector_l1_ops';
  }
}

function scoreFromDistance(metric: Metric, distance: number): number {
  return metric === 'cosine' ? 1 - distance : -distance;
}

function toSqlVector(vector: readonly number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value : 0)).join(',')}]`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
```

**Block by block:**

### 3.1 Constructor and identifier safety

- **Table name validation** — `/^[a-z_][a-z0-9_]*$/i`. Table names cannot be parameterized in SQL, so they are validated and then quoted. Without this, a table name is an injection vector.
- **Dimension validation** — 1..16,000. pgvector's `vector` type supports up to 16,000 dimensions; `halfvec` supports 4,000 and `bit` 64,000, but this adapter uses `vector`.
- **Pool** — `max: 10` connections. A vector query holds a connection for its duration; an unbounded pool under load is a self-inflicted outage.

### 3.2 `initialize`

1. `CREATE EXTENSION IF NOT EXISTS vector`.
2. `CREATE TABLE IF NOT EXISTS` with `vector(${dimensions})`.
3. Create an index:
   - `hnsw` with `m=16`, `ef_construction=100` and the metric's operator class.
   - or `ivfflat` with `lists` and the same operator class.
   - or `none`.

DDL values are integers validated by the schema and interpolated, not parameterized. PostgreSQL does not accept bind parameters in `WITH (m = $1)`.

### 3.3 `upsert`

Batch of 200 rows:

```sql
INSERT INTO "table" (id, embedding, payload, text, embedding_model)
VALUES ($1, $2::vector, $3::jsonb, $4, $5), ...
ON CONFLICT (id) DO UPDATE SET
  embedding = EXCLUDED.embedding,
  payload = EXCLUDED.payload,
  text = EXCLUDED.text,
  embedding_model = EXCLUDED.embedding_model,
  updated_at = now()
```

- **`toSqlVector`** — `[0.1,0.2,...]`; cast to `vector`.
- **`::jsonb`** — the payload is a JSON string parameter, cast by PostgreSQL.
- **`ON CONFLICT`** — one round trip for insert-or-update. This is the SQL equivalent of Qdrant's upsert.
- **`EXCLUDED`** — the row proposed by the insert; the conflict path reads from it.
- **`updated_at = now()`** — the conflict path refreshes freshness; the insert path uses the default.

### 3.4 `get`

A plain primary-key lookup. No distance is computed because there is no query vector. `score` and `distance` are returned as `0` to keep the shape; callers should not rank a `get`.

`embedding::text` returns `[0.1,0.2]`, which `JSON.parse` can parse when `withVector` is requested.

### 3.5 `delete`

```sql
DELETE FROM "table" WHERE id = ANY($1::text[])
```

One parameterized array, one round trip, `rowCount` returned.

### 3.6 `query`

1. Validate dimensions.
2. Start `params` with the vector literal.
3. Build optional WHERE conditions:
   - `payload->>'tenant' = $n`
   - `payload->>'category' = $n`
   - `(payload->>'year')::int >= $n`
   - `(payload->>'year')::int <= $n`
   - `payload @> $n::jsonb` for arbitrary containment
4. Select the distance expression:
   - cosine `<=>`
   - dot `<#>`
   - euclid `<->`
   - manhattan `<+>`
5. `ORDER BY embedding <op> $1::vector` ascending, `LIMIT $n`.

Why `ORDER BY` the expression rather than the alias? PostgreSQL can use the HNSW index with the expression form. The alias often works, but the explicit form is the one the planner recognizes most reliably.

### 3.7 Why a transaction for `ef_search`

```ts
await client.query('BEGIN');
await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(efSearch)]);
const result = await client.query(sql, params);
await client.query('COMMIT');
```

- `hnsw.ef_search` is a session GUC.
- `set_config(..., true)` scopes it to the **transaction**.
- Without the `true`, the setting leaks to the next request that borrows the same pooled connection. That is a classic, hard-to-reproduce tuning bug: one request's `ef_search=200` silently improves or distorts another's latency.
- `ROLLBACK` on error and `release()` in `finally` prevent connection leaks.

The same pattern would apply to `ivfflat.probes`.

### 3.8 Score conversion

```ts
score = cosine ? 1 - distance : -distance
```

- Cosine: `<=>` returns cosine distance, so similarity is `1 - d`.
- Dot: `<#>` returns negative inner product, so `-d` is the dot product.
- Euclid/Manhattan: `d` is the distance, so `-d` is higher-is-better.

This matches the in-memory store and the normalized Qdrant adapter.

### 3.9 `count` and `health`

- `count(*)::int` returns a JS number, not a string.
- `health` reads `pg_extension` for the vector version and counts the table. `ok` means the extension exists, not that the table is populated.
- `close` ends the pool; scripts must call it or the process hangs.

### 3.10 pgvector limits worth knowing

| Limit | Value |
| :--- | :--- |
| `vector` dimensions | 16,000 |
| `halfvec` dimensions | 4,000 |
| `bit` dimensions | 64,000 |
| HNSW `ef_search` max | 1,000 (use higher with care) |
| IVFFlat requires data | Build after inserting rows, not before |

The notes also cover iterative index scans (`hnsw.iterative_scan`, `hnsw.max_scan_tuples`) for filtered queries. This adapter does not enable them; add them when filtered recall becomes the bottleneck.

---

## 4. Real CRUD — `src/scripts/adapter-crud.ts`

#### 📄 `src/scripts/adapter-crud.ts`

```ts
import assert from 'node:assert/strict';
import { env } from '../config/env.js';
import { createEmbeddingProvider } from '../embeddings/provider.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import { QdrantAdapter } from '../adapters/qdrant.adapter.js';
import { PgVectorAdapter } from '../adapters/pgvector.adapter.js';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target !== 'qdrant' && target !== 'pgvector') {
    throw new Error('Usage: tsx src/scripts/adapter-crud.ts <qdrant|pgvector>');
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
  const [vector] = await embeddings.embedDocuments(['adapter CRUD smoke test']);
  const payload = { tenant: 'acme', category: 'operations', year: 2026 };
  const id = 'smoke-001';

  if (target === 'qdrant') {
    const adapter = new QdrantAdapter({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      collection: env.QDRANT_COLLECTION,
      dimensions: provider.dimensions,
      metric: env.VECTOR_METRIC,
    });
    const created = await adapter.ensureCollection();
    if (created) await adapter.createPayloadIndexes();

    await adapter.upsert([{ id, vector, payload, text: 'adapter CRUD smoke test' }]);
    assert.equal((await adapter.get(id))?.payload.tenant, 'acme');

    await adapter.upsert([{ id, vector, payload: { ...payload, year: 2027 }, text: 'updated' }]);
    assert.equal((await adapter.get(id))?.payload.year, 2027);

    const filtered = await adapter.query(vector, {
      k: 5,
      filter: { must: [{ key: 'tenant', match: { value: 'acme' } }] },
    });
    assert.ok(filtered.some((hit) => hit.id === id));

    await adapter.delete([id]);
    assert.equal(await adapter.get(id), null);
    console.log(`[qdrant] upsert -> update -> filter -> delete ok (count=${await adapter.count()})`);
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

  await adapter.upsert([{ id, vector, payload, text: 'adapter CRUD smoke test' }]);
  assert.equal((await adapter.get(id))?.payload.tenant, 'acme');

  await adapter.upsert([{ id, vector, payload: { ...payload, year: 2027 }, text: 'updated' }]);
  assert.equal((await adapter.get(id))?.payload.year, 2027);

  const filtered = await adapter.query(vector, { k: 5, filter: { tenant: 'acme' } });
  assert.ok(filtered.some((hit) => hit.id === id));

  assert.equal(await adapter.delete([id]), 1);
  assert.equal(await adapter.get(id), null);
  console.log(`[pgvector] upsert -> update -> filter -> delete ok (count=${await adapter.count()})`);
  await adapter.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**Block by block:**

- **Target argument** — `qdrant` or `pgvector`, same shape as `seed.ts`.
- **One vector** — embeds a single smoke-test string with the configured provider.
- **Qdrant path**:
  1. Ensure collection (and indexes if created).
  2. Upsert `smoke-001`.
  3. `get` and assert payload.
  4. Upsert again with `year: 2027`; assert the update.
  5. Query with a tenant filter; assert the id is present.
  6. Delete; assert `get` returns `null`; count returns to 24.
- **pgvector path** — identical assertions through the SQL adapter.
- **`assert`** — the script fails loudly if any step does not behave, so it is a test, not a demo.

This is the executable answer to "does upsert actually update?" and "does delete leave an orphan?" for both databases.

---

## 5. Verification

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres npm run seed:pgvector
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres npm run adapter:crud:pgvector
```

Actual output:

```text
[pgvector] upserted 24, count=24
  doc-001 score=0.1722
  doc-008 score=0.1521
  doc-010 score=0.1424
```

```text
[pgvector] upsert -> update -> filter -> delete ok (count=24)
```

The scores match Qdrant exactly because both used the same mock vectors, the same cosine metric and the same corpus. That is the multi-backend contract working.

### Operational notes

- **Index build is not free.** HNSW builds on write and can be slow for millions of rows; consider building after a bulk load.
- **`ANALYZE` matters.** The planner needs statistics to choose between the vector index and a sequential scan, especially for selective filters.
- **Connection pooling** is mandatory. PostgreSQL backends are processes; 1,000 direct connections will exhaust memory.
- **Backups** are normal PostgreSQL backups. The vector index is rebuilt from the table, so it is not a separate backup target.
- **pgvector is the right choice** when vectors must join relational data, share transactions, or live under existing row-level security. Qdrant is the right choice when vector search is the primary workload and you need its filtering/quantization features.

**Next:** [Chapter 10 — HTTP API & End-to-End Verification](./10_HTTP_API_and_End_to_End_Verification.md)

