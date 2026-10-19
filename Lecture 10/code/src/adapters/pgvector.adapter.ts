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
