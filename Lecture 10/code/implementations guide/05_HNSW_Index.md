# Chapter 05: HNSW — Hierarchical Navigable Small World

> **Chapter Goal:** Build a navigable proximity graph with exponentially thinning layers, then search it with greedy descent and a bounded beam. This is the index behind Qdrant, pgvector's HNSW, FAISS, and most production vector databases.

> **Lecture mapping:** Notes Chapter 05 (graph navigation, flat-graph problem, highway analogy, layers, insert, query, memory, build cost, filtering weakness).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/core/hnsw.ts` | 363 | Level sampling, insertion, greedy search, beam search, neighbour diversity, pruning, tombstones, stats. |

This is the longest file in the codebase. Read it in the order below, not top to bottom.

---

## 1. Commands

```bash
npm run verify
```

Expected:

```text
      HNSW recall@10 = 100.0%
  ok  HNSW recall is high and search visits few nodes (899.4 ms)
```

The build is the slow part (`O(N log N)` graph construction); queries are fast.

---

## 2. Data Structures

Before the code, hold these five ideas:

```text
nodes[i]        record + level + deleted flag
layers[l]       Map<nodeIndex, Set<neighbourIndex>>
entryPoint      the node where every search starts (top layer)
maxLevel        the highest layer currently populated
m, m0           max neighbours on upper layers / layer 0
```

Layer 0 contains **every** node. Layer 1 contains roughly `1/M` of them, layer 2 roughly `1/M²`, and so on. That exponential decay is what makes the top of the graph a sparse highway and the bottom a dense local road network.

The graph is stored as adjacency sets, not a matrix. A matrix would be `N²`; a set is proportional to the number of edges.

---

## 3. Complete Source — `src/core/hnsw.ts`

#### 📄 `src/core/hnsw.ts`

```ts
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
```

---

## 4. Block-by-Block Explanation

### 4.1 Class fields and constructor

- **`nodes`** — every inserted record, including tombstoned ones. Array indices are stable, so edges can store integers.
- **`layers`** — `layers[l]` is a `Map` from node index to its neighbour set on that layer. Sparse layers only contain the nodes that reached them.
- **`byId`** — external id → node index. Used by `add` (duplicate detection) and `remove`.
- **`deleted`** — tombstones. The node remains for navigation; results filter it out.
- **`entryPoint` / `maxLevel`** — the search entry and current height.
- **`m` / `m0`** — `M` on upper layers, `2M` on layer 0. Layer 0 needs more links because it carries all the local detail.
- **`efConstruction`** — beam width during insertion. Higher means a better graph and a slower build.
- **`defaultEfSearch`** — beam width at query time. Higher means higher recall and more latency.
- **`levelMultiplier`** — `1 / ln(M)`. This is the `mL` from the paper.
- **`rng`** — seeded, so builds are reproducible.

Validation (`M >= 2`) prevents a degenerate graph with no navigable links.

### 4.2 `build`

Clears every structure and inserts records one by one. HNSW is an **incremental** index by design; there is no separate training phase.

### 4.3 `add` — insertion in two phases

1. **Assign a level** with `randomLevel()`.
2. **Create the node** and register it on every layer from `0` to `level`.
3. **First node?** It becomes the entry point and the graph height.
4. **Phase 1 — descend:** from `maxLevel` down to `level + 1`, greedily move to the closest neighbour. This finds a good entry point on the layer where the new node will start connecting.
5. **Phase 2 — connect:** for each layer from `min(level, maxLevel)` down to `0`:
   - Run `searchLayer` with `efConstruction` to get a candidate pool.
   - Select at most `M` neighbours with the diversity heuristic.
   - Add bidirectional links.
   - Move the entry point to the closest candidate for the next layer down.
6. **New tallest node?** It becomes the entry point and `maxLevel` rises.

Why the two phases? The upper layers are for navigation, the lower layers are for precision. A new node only needs to be connected where it exists, but it must start its search from a good place.

### 4.4 `remove` — tombstones

Deleting a node from every neighbour set is expensive and can disconnect the graph. Instead:

- Mark `deleted = true`.
- Remove it from `byId` so it cannot be fetched again.
- Leave its edges in place so it still helps navigation.
- Filter it from results.

The cost is memory and a slowly degrading graph. Production systems compact or rebuild. This trade-off is exactly what the notes describe for HNSW deletes.

### 4.5 `search` — query path

1. **Empty graph** → return `[]`.
2. **Prepare the query** once (validate + norm).
3. **Greedy descent** from `maxLevel` to layer 1, moving to the closest neighbour at each layer. This is the highway phase: cheap, approximate, and only there to reach the right neighbourhood.
4. **Beam search on layer 0** with `ef = max(efSearch, k, filter ? k*8 : k)`.
   - `ef >= k` is required; a beam narrower than K cannot return K results.
   - When a filter is present, the graph still traverses unfiltered nodes (it must, to stay connected), but many candidates are discarded afterwards. Oversampling is the cheapest mitigation.
5. **Map candidates to hits**, skipping tombstones and filter rejections, until K results are collected.
6. **Score** is `-distance`; distance is `-scoreWithNorms`, so higher-is-better is preserved.

The filter weakness is real: a highly selective filter can leave fewer than K results even with a wide beam. Chapter 07 adds an exact fallback for that case.

### 4.6 `stats`

- Counts directed edges across all layers (`Set.size` per node).
- Reports nodes, tombstones, layers, `M`, `M0`, `efConstruction`, `efSearch`.
- Memory is **adjacency only**; raw vectors are owned by the store.

### 4.7 `searchLayer` — the beam search

Two heaps:

```text
candidates  min-heap by distance  → next node to explore
results     max-heap by distance  → current beam, farthest at the root
```

The loop:

1. Pop the closest unexplored candidate.
2. If the beam is full and this candidate is farther than the worst result, **stop**. Everything left is worse; this is the pruning proof.
3. For each neighbour:
   - Skip if visited.
   - Compute distance.
   - If the beam is not full, or the neighbour beats the worst result, add it to both heaps.
   - If the beam exceeds `ef`, pop the farthest.

The return is sorted ascending by distance. `visited` prevents cycles — a graph, unlike a tree, can loop.

**Why `ef` controls recall:** a larger beam keeps more candidates alive, so a path that temporarily looks worse can still lead to a better neighbourhood. A smaller beam commits earlier and misses more.

### 4.8 `greedy` — descent

At each hop, scan the current node's neighbours and move to the first strictly closer one. Stop at a local minimum. The `1e-9` epsilon prevents infinite loops on equal distances.

This is `O(degree)` per hop and typically `O(log N)` hops. It is not guaranteed to find the global nearest neighbour; it is a router.

### 4.9 `selectNeighbours` — the diversity heuristic

This is the block that separates HNSW from a naive k-nearest-neighbour graph.

For each candidate (closest first):

```text
keep it only if it is closer to the base node
than to every neighbour already selected
```

If a candidate is closer to an existing neighbour than to the base, it is redundant — it lives in the same direction. Keeping it would fill the neighbour list with near-duplicates and destroy long-range connectivity.

After the diverse pass, the list is filled to `M` from the remaining candidates. Perfect diversity is not worth returning fewer than `M` links.

**Why it matters:** a graph of near-duplicates is a set of cliques. Greedy search enters a clique and cannot jump to another cluster. The heuristic preserves the "small world" shortcuts that make HNSW work.

### 4.10 `connect` and `prune`

`connect(a, b, layer)`:

1. Add `b` to `a`'s neighbour set and `a` to `b`'s.
2. Prune each side if it exceeds `maxConnections(layer)`.

`prune`:

- If the degree is within limit, do nothing.
- Otherwise rebuild the neighbour list with `selectNeighbours` over the current neighbours.
- Clear and re-add the kept indices.

Pruning is **local and directed**: the reverse edge may remain even after one side drops it. That is acceptable — the graph is a navigable network, not a symmetric social graph — and it avoids cascading rewrites during insertion. Production implementations may maintain stricter symmetry.

### 4.11 Helpers

- **`neighboursOf`** — returns an empty set when the node/layer has no entry, so callers never branch on `undefined`.
- **`distanceToQuery`** — `-scoreWithNorms(...)`. For cosine this is negative cosine; for Euclidean it is the true distance. Smaller is always closer, which is the invariant the graph relies on.
- **`distanceBetween`** — same, between two stored records. Used by the diversity heuristic.
- **`maxConnections`** — `M0` on layer 0, `M` above.
- **`ensureLayer`** — grows the layer array as needed.
- **`randomLevel`** — `floor(-ln(U) × mL)`, capped at 32. `U` is clamped away from zero to avoid `Infinity`.

### 4.12 Level sampling math

With `mL = 1 / ln(M)`:

```text
P(level >= l) = exp(-l / mL) = M^(-l)
```

For `M=16`:

| Level | Approx. fraction of nodes |
| ---: | ---: |
| 0 | 100% |
| 1 | 6.25% |
| 2 | 0.39% |
| 3 | 0.024% |

At 1M vectors: ~62K nodes on layer 1, ~3.9K on layer 2, ~244 on layer 3. That is the highway system.

### 4.13 Parameters

| Parameter | Effect of increasing | Typical start |
| :--- | :--- | :--- |
| `M` | Better recall, more memory, slower build | 16 |
| `M0` | More layer-0 links; usually `2M` | 32 |
| `efConstruction` | Better graph, slower build | 100–200 |
| `efSearch` | Higher recall, slower query | 64–128 |

`efSearch` can be changed per query; `M` and `efConstruction` require a rebuild. That is the operational split: tune recall at query time, tune graph quality at build time.

### 4.14 Memory

Approximate upper-layer links per node: `M × 2` directed edges (bidirectional). Layer 0 adds `M0 × 2`. Each edge is a 4-byte integer in this implementation.

For 10M vectors, `M=16`, `M0=32`:

```text
edges ≈ 10M × (2M + 2M0) = 960M directed edges
bytes ≈ 960M × 4 ≈ 3.8 GB
```

Plus the vectors themselves (61 GB at 1536 float32). This is why quantization (Chapter 06) and on-disk indexes matter.

### 4.15 Complexity

| Operation | Typical cost |
| :--- | :--- |
| Insert | `O(log N)` layers × `O(efConstruction × M)` |
| Query | `O(log N)` descent + `O(efSearch × M)` beam |
| Memory | `O(N × M)` edges |

The logarithmic claim assumes the graph stays navigable. A bad `M`, severe filtering, or heavy tombstoning can degrade it toward a scan.

---

## 5. Verification

```bash
npm run verify
```

```text
      HNSW recall@10 = 100.0%
  ok  HNSW recall is high and search visits few nodes (899.4 ms)
```

The test builds over 1,200 vectors (`M=16`, `efConstruction=100`, `efSearch=64`) and compares 25 queries with exact KNN. Clustered data with clean separation is friendly to HNSW; the harder benchmark shows ~83% at `efSearch=12`.

`npm run bench`:

```text
| hnsw | 3903.0 | 386.5 | 0.07 | 0.11 | 83.2% |
```

Read that row as: ~3.9 s to build, ~387 KB of adjacency, 0.07 ms median query, 83% of exact neighbours. The exact scan is slower but perfect; the graph is faster but approximate. Neither is "better" without a target.

**Next:** [Chapter 06 — Product Quantization](./06_Product_Quantization.md)


