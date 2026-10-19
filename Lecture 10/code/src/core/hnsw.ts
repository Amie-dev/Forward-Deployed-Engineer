import { distanceFromScore, prepare, scoreWithNorms } from './metrics.js';
import { BinaryHeap } from '../lib/heap.js';
import { createRng } from '../lib/rng.js';
import type {
  HnswConfig,
  IndexSearchOptions,
  IndexSearchResult,
  IndexStats,
  Metric,
  PreparedRecord,
  PreparedVector,
  Vector,
} from '../types/vector.types.js';

interface HnswNode<T> {
  record: PreparedRecord<T>;
  level: number;
  deleted: boolean;
}

interface HeapNode {
  index: number;
  distance: number;
}

const EMPTY_NEIGHBOURS: ReadonlySet<number> = new Set<number>();

/**
 * HNSW — Hierarchical Navigable Small World.
 *
 * Layer 0 contains every node and is densely connected. Each higher layer is a
 * sparser "express lane" sampled exponentially. A query greedily descends the
 * hierarchy, then runs a best-first search (`efSearch`) on layer 0.
 *
 * This is a complete teaching implementation: level sampling, the neighbour
 * diversity heuristic, bidirectional links, degree pruning and tombstones.
 * Production implementations add SIMD kernels, on-disk storage and incremental
 * compaction; the algorithm is the same.
 */
export class HnswIndex<T = Record<string, unknown>> {
  readonly kind = 'hnsw' as const;

  private nodes: HnswNode<T>[] = [];
  private readonly layers: Map<number, Set<number>>[] = [];
  private readonly byId = new Map<string, number>();
  private readonly deleted = new Set<number>();
  private entryPoint = -1;
  private maxLevel = -1;

  private readonly m: number;
  private readonly m0: number;
  private readonly efConstruction: number;
  private readonly defaultEfSearch: number;
  private readonly levelMultiplier: number;
  private readonly rng: () => number;

  constructor(
    private readonly metric: Metric,
    config: HnswConfig,
  ) {
    const m = config.m ?? 16;
    if (m < 2) throw new Error('HNSW M must be >= 2.');
    this.m = m;
    this.m0 = 2 * m;
    this.efConstruction = Math.max(config.efConstruction ?? 100, m);
    this.defaultEfSearch = Math.max(config.efSearch ?? 64, 1);
    this.levelMultiplier = 1 / Math.log(m);
    this.rng = createRng(config.seed ?? 42);
  }

  get size(): number {
    return this.nodes.length - this.deleted.size;
  }

  build(records: readonly PreparedRecord<T>[]): void {
    this.nodes = [];
    this.layers.length = 0;
    this.byId.clear();
    this.deleted.clear();
    this.entryPoint = -1;
    this.maxLevel = -1;
    for (const record of records) this.add(record);
  }

  add(record: PreparedRecord<T>): void {
    if (this.byId.has(record.id)) this.remove([record.id]);

    const level = this.randomLevel();
    const index = this.nodes.length;
    this.nodes.push({ record, level, deleted: false });
    this.byId.set(record.id, index);

    this.ensureLayer(level);
    for (let layer = 0; layer <= level; layer++) {
      this.layers[layer].set(index, new Set());
    }

    if (this.entryPoint === -1) {
      this.entryPoint = index;
      this.maxLevel = level;
      return;
    }

    const query: PreparedVector = { data: record.vector, norm: record.norm };
    let entry = this.entryPoint;

    // Phase 1: greedy descent through layers above the new node's top layer.
    for (let layer = this.maxLevel; layer > level; layer--) {
      entry = this.greedy(query, entry, layer);
    }

    // Phase 2: connect on every layer the node belongs to.
    for (let layer = Math.min(level, this.maxLevel); layer >= 0; layer--) {
      const candidates = this.searchLayer(query, [entry], this.efConstruction, layer);
      const neighbours = this.selectNeighbours(index, candidates, this.maxConnections(layer));
      for (const neighbour of neighbours) this.connect(index, neighbour.index, layer);
      if (candidates.length > 0) entry = candidates[0].index;
    }

    if (level > this.maxLevel) {
      this.entryPoint = index;
      this.maxLevel = level;
    }
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      const index = this.byId.get(id);
      if (index === undefined) continue;
      this.nodes[index].deleted = true;
      this.deleted.add(index);
      this.byId.delete(id);
    }
  }

  search(query: Vector, options: IndexSearchOptions<T>): IndexSearchResult<T>[] {
    const { k, filter } = options;
    if (k <= 0 || this.entryPoint === -1) return [];

    const prepared = prepare(query);
    let entry = this.entryPoint;

    for (let layer = this.maxLevel; layer > 0; layer--) {
      entry = this.greedy(prepared, entry, layer);
    }

    // Filters remove candidates after graph traversal. Oversampling is the
    // cheapest mitigation; a production engine also uses filter-aware links.
    const ef = Math.max(
      options.efSearch ?? this.defaultEfSearch,
      k,
      filter ? k * 8 : k,
    );
    const candidates = this.searchLayer(prepared, [entry], ef, 0);

    const results: IndexSearchResult<T>[] = [];
    for (const candidate of candidates) {
      const node = this.nodes[candidate.index];
      if (node.deleted) continue;
      if (filter && !filter(node.record)) continue;
      const score = -candidate.distance;
      results.push({
        id: node.record.id,
        score,
        distance: distanceFromScore(this.metric, score),
        record: node.record,
      });
      if (results.length >= k) break;
    }
    return results;
  }

  stats(): IndexStats {
    let directedEdges = 0;
    for (const layer of this.layers) {
      for (const neighbours of layer.values()) directedEdges += neighbours.size;
    }
    return {
      kind: this.kind,
      size: this.size,
      deleted: this.deleted.size,
      // Adjacency only; vectors are counted once by the store.
      memoryBytes: directedEdges * 4,
      params: {
        m: this.m,
        m0: this.m0,
        efConstruction: this.efConstruction,
        efSearch: this.defaultEfSearch,
        layers: this.layers.length,
        directedEdges,
        metric: this.metric,
      },
    };
  }

  // ── Graph internals ───────────────────────────────────────────────────────

  private searchLayer(
    query: PreparedVector,
    entryPoints: readonly number[],
    ef: number,
    layer: number,
  ): HeapNode[] {
    const visited = new Set<number>(entryPoints);
    const candidates = new BinaryHeap<HeapNode>((a, b) => a.distance - b.distance);
    const results = new BinaryHeap<HeapNode>((a, b) => b.distance - a.distance);

    for (const entry of entryPoints) {
      const distance = this.distanceToQuery(query, entry);
      candidates.push({ index: entry, distance });
      results.push({ index: entry, distance });
    }

    while (candidates.size > 0) {
      const current = candidates.pop()!;
      const worst = results.peek()!.distance;
      if (results.size >= ef && current.distance > worst) break;

      for (const neighbour of this.neighboursOf(current.index, layer)) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);

        const distance = this.distanceToQuery(query, neighbour);
        if (results.size < ef || distance < results.peek()!.distance) {
          candidates.push({ index: neighbour, distance });
          results.push({ index: neighbour, distance });
          if (results.size > ef) results.pop();
        }
      }
    }

    return results.toArray().sort((a, b) => a.distance - b.distance);
  }

  /** Walk to a local minimum: O(degree) per hop, no `ef` beam. */
  private greedy(query: PreparedVector, start: number, layer: number): number {
    let current = start;
    let currentDistance = this.distanceToQuery(query, current);

    for (;;) {
      let improved = false;
      for (const neighbour of this.neighboursOf(current, layer)) {
        const distance = this.distanceToQuery(query, neighbour);
        if (distance < currentDistance - 1e-9) {
          current = neighbour;
          currentDistance = distance;
          improved = true;
        }
      }
      if (!improved) return current;
    }
  }

  /**
   * HNSW's diversity heuristic. A candidate is kept only when it is closer to
   * the new node than to any neighbour already selected. This preserves long
   * links between clusters instead of filling the neighbour list with near
   * duplicates — the difference between a navigable graph and a clique.
   */
  private selectNeighbours(base: number, candidates: readonly HeapNode[], m: number): HeapNode[] {
    const ordered = [...candidates]
      .filter((candidate) => candidate.index !== base)
      .sort((a, b) => a.distance - b.distance);

    const selected: HeapNode[] = [];
    const selectedIndices = new Set<number>();

    for (const candidate of ordered) {
      if (selected.length >= m) break;
      const distanceToBase = this.distanceBetween(base, candidate.index);
      let diverse = true;
      for (const chosen of selected) {
        if (this.distanceBetween(candidate.index, chosen.index) <= distanceToBase) {
          diverse = false;
          break;
        }
      }
      if (diverse) {
        selected.push(candidate);
        selectedIndices.add(candidate.index);
      }
    }

    // Always fill to M: recall matters more than perfect diversity.
    if (selected.length < m) {
      for (const candidate of ordered) {
        if (selected.length >= m) break;
        if (selectedIndices.has(candidate.index)) continue;
        selected.push(candidate);
        selectedIndices.add(candidate.index);
      }
    }

    return selected;
  }

  private connect(a: number, b: number, layer: number): void {
    const aNeighbours = this.layers[layer]?.get(a);
    const bNeighbours = this.layers[layer]?.get(b);
    if (!aNeighbours || !bNeighbours) return;

    aNeighbours.add(b);
    bNeighbours.add(a);
    this.prune(a, layer);
    this.prune(b, layer);
  }

  private prune(index: number, layer: number): void {
    const neighbours = this.layers[layer]?.get(index);
    if (!neighbours) return;
    const limit = this.maxConnections(layer);
    if (neighbours.size <= limit) return;

    const candidates = [...neighbours].map((neighbour) => ({
      index: neighbour,
      distance: this.distanceBetween(index, neighbour),
    }));
    const kept = this.selectNeighbours(index, candidates, limit);
    neighbours.clear();
    for (const candidate of kept) neighbours.add(candidate.index);
  }

  private neighboursOf(index: number, layer: number): ReadonlySet<number> {
    return this.layers[layer]?.get(index) ?? EMPTY_NEIGHBOURS;
  }

  private distanceToQuery(query: PreparedVector, index: number): number {
    const node = this.nodes[index];
    return -scoreWithNorms(
      this.metric,
      query.data,
      query.norm,
      node.record.vector,
      node.record.norm,
    );
  }

  private distanceBetween(a: number, b: number): number {
    const left = this.nodes[a].record;
    const right = this.nodes[b].record;
    return -scoreWithNorms(
      this.metric,
      left.vector,
      left.norm,
      right.vector,
      right.norm,
    );
  }

  private maxConnections(layer: number): number {
    return layer === 0 ? this.m0 : this.m;
  }

  private ensureLayer(level: number): void {
    while (this.layers.length <= level) this.layers.push(new Map());
  }

  private randomLevel(): number {
    // P(level = l) ∝ exp(-l / mL), with mL = 1 / ln(M).
    const uniform = Math.max(this.rng(), Number.EPSILON);
    return Math.min(Math.floor(-Math.log(uniform) * this.levelMultiplier), 32);
  }
}
