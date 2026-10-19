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
    return toHit(points[0]);
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
    return response.points.map(toHit);
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
    return result.points.map(toHit);
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

function toHit(point: Schemas['ScoredPoint'] | Schemas['Record']): QdrantHit {
  const payload = { ...(point.payload ?? {}) } as Record<string, unknown>;
  const external = payload._external_id;
  const text = payload.text;
  delete payload._external_id;
  delete payload.text;
  const score = 'score' in point && typeof point.score === 'number' ? point.score : 0;

  return {
    id: typeof external === 'string' ? external : String(point.id),
    score,
    payload,
    text: typeof text === 'string' ? text : undefined,
  };
}
