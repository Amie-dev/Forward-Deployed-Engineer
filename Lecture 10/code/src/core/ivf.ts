import { distanceFromScore, normalize, prepare, scoreWithNorms, squaredEuclidean } from './metrics.js';
import { kmeans } from './kmeans.js';
import { TopK } from '../lib/topk.js';
import type {
  IndexSearchOptions,
  IndexSearchResult,
  IndexStats,
  IvfConfig,
  Metric,
  PreparedRecord,
  Vector,
} from '../types/vector.types.js';

/**
 * IVF — Inverted File Index.
 *
 * Build:  k-means partitions vectors into `nlist` Voronoi cells.
 * Query:  rank the centroids, scan only the `nprobe` closest lists.
 *
 * Cost per query is roughly `nprobe / nlist` of a full scan plus `nlist`
 * centroid comparisons. The recall loss comes from vectors just across a cell
 * boundary that are therefore never examined.
 */
export class IvfIndex<T = Record<string, unknown>> {
  readonly kind = 'ivf' as const;

  private records: PreparedRecord<T>[] = [];
  private centroids: Vector[] = [];
  private centroidNorms: number[] = [];
  private lists: number[][] = [];
  private positions = new Map<string, number>();
  private recordById = new Map<string, PreparedRecord<T>>();
  private deleted = new Set<number>();
  private readonly nlist: number;
  private readonly defaultNprobe: number;
  private readonly iterations: number;
  private readonly seed: number;

  constructor(
    private readonly metric: Metric,
    config: IvfConfig,
  ) {
    if (config.nlist !== undefined && config.nlist < 1) {
      throw new Error('IVF nlist must be >= 1.');
    }
    this.nlist = config.nlist ?? 1;
    this.defaultNprobe = config.nprobe ?? Math.max(1, Math.round(Math.sqrt(this.nlist)));
    this.iterations = config.iterations ?? 20;
    this.seed = config.seed ?? 42;
  }

  get size(): number {
    return this.records.length - this.deleted.size;
  }

  build(records: readonly PreparedRecord<T>[]): void {
    this.records = [...records];
    this.positions.clear();
    this.recordById.clear();
    this.deleted.clear();

    const actualLists = Math.min(this.nlist, Math.max(1, this.records.length));
    const clusterVectors = this.records.map((record) => this.forClustering(record.vector));
    const trained =
      this.records.length > 0
        ? kmeans(clusterVectors, { k: actualLists, iterations: this.iterations, seed: this.seed })
        : { centroids: [] as Vector[] };

    this.centroids = trained.centroids.map((centroid) =>
      this.metric === 'cosine' ? normalize(centroid) : centroid,
    );
    this.centroidNorms = this.centroids.map((centroid) => {
      let sum = 0;
      for (let i = 0; i < centroid.length; i++) sum += centroid[i] * centroid[i];
      return Math.sqrt(sum);
    });

    this.lists = Array.from({ length: this.centroids.length }, () => []);
    for (let i = 0; i < this.records.length; i++) {
      const list = this.nearestCentroid(this.forClustering(this.records[i].vector));
      this.lists[list].push(i);
      this.positions.set(this.records[i].id, i);
      this.recordById.set(this.records[i].id, this.records[i]);
    }
  }

  /** Incremental insert: assign to the nearest existing cell, no re-training. */
  add(records: readonly PreparedRecord<T>[]): void {
    if (this.centroids.length === 0) {
      this.build(records);
      return;
    }
    for (const record of records) {
      const index = this.records.length;
      this.records.push(record);
      const list = this.nearestCentroid(this.forClustering(record.vector));
      this.lists[list].push(index);
      this.positions.set(record.id, index);
      this.recordById.set(record.id, record);
    }
  }

  /** Tombstone delete: O(1). Rebuild to reclaim memory and remove drift. */
  remove(ids: readonly string[]): void {
    for (const id of ids) {
      const index = this.positions.get(id);
      if (index === undefined) continue;
      this.deleted.add(index);
      this.positions.delete(id);
      this.recordById.delete(id);
    }
  }

  search(query: Vector, options: IndexSearchOptions<T>): IndexSearchResult<T>[] {
    const { k, filter } = options;
    if (k <= 0 || this.records.length === 0) return [];

    const preparedQuery = prepare(query);
    const nprobe = Math.min(
      Math.max(1, options.nprobe ?? this.defaultNprobe),
      this.centroids.length,
    );

    // Coarse quantizer: rank cells with the *query* metric, not blindly L2.
    const rankedCells = this.centroids
      .map((centroid, index) => ({
        index,
        score: scoreWithNorms(
          this.metric,
          preparedQuery.data,
          preparedQuery.norm,
          centroid,
          this.centroidNorms[index],
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, nprobe);

    const top = new TopK(k);
    for (const cell of rankedCells) {
      for (const recordIndex of this.lists[cell.index]) {
        if (this.deleted.has(recordIndex)) continue;
        const record = this.records[recordIndex];
        if (filter && !filter(record)) continue;
        const score = scoreWithNorms(
          this.metric,
          preparedQuery.data,
          preparedQuery.norm,
          record.vector,
          record.norm,
        );
        top.push(record.id, score);
      }
    }

    const byId = this.recordById;
    return top.results().map((ranked) => {
      const record = byId.get(ranked.id)!;
      return {
        id: record.id,
        score: ranked.score,
        distance: distanceFromScore(this.metric, ranked.score),
        record,
      };
    });
  }

  stats(): IndexStats {
    const listBytes = this.lists.reduce((sum, list) => sum + list.length * 4, 0);
    const centroidBytes = this.centroids.reduce((sum, centroid) => sum + centroid.byteLength, 0);
    return {
      kind: this.kind,
      size: this.size,
      deleted: this.deleted.size,
      // Index structure only. The vectors themselves are owned by the store.
      memoryBytes: listBytes + centroidBytes,
      params: {
        nlist: this.centroids.length,
        nprobe: this.defaultNprobe,
        metric: this.metric,
      },
    };
  }

  private forClustering(vector: Vector): Vector {
    // Normalising before L2 clustering makes the cells align with cosine.
    return this.metric === 'cosine' ? normalize(vector) : vector;
  }

  private nearestCentroid(vector: Vector): number {
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < this.centroids.length; c++) {
      const distance = squaredEuclidean(vector, this.centroids[c]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = c;
      }
    }
    return best;
  }
}
