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
