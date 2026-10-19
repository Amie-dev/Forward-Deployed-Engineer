# Chapter 04: IVF — Inverted File Index

> **Chapter Goal:** Partition the vector space with k-means, store one inverted list per cell, and search only the `nprobe` closest cells. Understand why this is fast, why it misses boundary points, and how the parameters move the recall/latency curve.

> **Lecture mapping:** Notes Chapter 04 (centroids, clustering, construction, search, boundary problem, `nlist`/`nprobe`).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/core/kmeans.ts` | 133 | k-means++ initialization and Lloyd iterations. |
| `src/lib/rng.ts` | 21 | Seeded mulberry32 RNG used by k-means, HNSW and PQ. |
| `src/core/ivf.ts` | 202 | Inverted lists, build, incremental add, tombstones, search, stats. |

---

## 1. Commands

```bash
npm run verify
```

Expected:

```text
      IVF recall@10 = 100.0%
  ok  IVF recall is high with clustered data (58.0 ms)
```

The synthetic data is deliberately clustered; a uniform-random dataset would show lower recall at the same `nprobe`.

---

## 2. k-means — `src/core/kmeans.ts`

#### 📄 `src/core/kmeans.ts`

```ts
import { squaredEuclidean } from './metrics.js';
import { createRng, randomInt } from '../lib/rng.js';
import type { Vector } from '../types/vector.types.js';

export interface KMeansOptions {
  k: number;
  iterations?: number;
  seed?: number;
}

export interface KMeansResult {
  centroids: Vector[];
  assignments: Int32Array;
  inertia: number;
  iterations: number;
}

/**
 * Lloyd's algorithm with k-means++ seeding.
 *
 * IVF uses this to learn `nlist` regions; PQ uses the same function once per
 * sub-space. It always clusters with squared L2 — for cosine workloads the
 * caller normalizes first, which makes L2 and cosine rank identically.
 */
export function kmeans(points: readonly Vector[], options: KMeansOptions): KMeansResult {
  const { k, iterations = 25, seed = 42 } = options;
  if (points.length === 0) throw new Error('k-means needs at least one point.');
  if (k < 1) throw new Error('k must be >= 1.');
  if (k > points.length) throw new Error(`k (${k}) cannot exceed points (${points.length}).`);

  const dimensions = points[0].length;
  for (const point of points) {
    if (point.length !== dimensions) throw new Error('All points must share one dimension.');
  }

  const rng = createRng(seed);
  const centroids = initializeKMeansPlusPlus(points, k, rng);
  let assignments = new Int32Array(points.length).fill(-1);
  let inertia = 0;
  let completed = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    completed = iteration + 1;
    const next = new Int32Array(points.length);
    const sums = Array.from({ length: k }, () => new Float64Array(dimensions));
    const counts = new Int32Array(k);
    let nextInertia = 0;

    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const distance = squaredEuclidean(points[i], centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      next[i] = best;
      counts[best]++;
      nextInertia += bestDistance;
      const sum = sums[best];
      for (let d = 0; d < dimensions; d++) sum[d] += points[i][d];
    }

    // Empty clusters are a real failure mode, not a theoretical one. Re-seed
    // them at the point currently worst represented by its centroid.
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        const centroid = new Float32Array(dimensions);
        for (let d = 0; d < dimensions; d++) centroid[d] = sums[c][d] / counts[c];
        centroids[c] = centroid;
        continue;
      }
      let farthest = 0;
      let farthestDistance = -1;
      for (let i = 0; i < points.length; i++) {
        const distance = squaredEuclidean(points[i], centroids[next[i]]);
        if (distance > farthestDistance) {
          farthestDistance = distance;
          farthest = i;
        }
      }
      centroids[c] = Float32Array.from(points[farthest]);
    }

    inertia = nextInertia;
    const converged = assignments.every((value, index) => value === next[index]);
    assignments = next;
    if (converged) break;
  }

  return { centroids, assignments, inertia, iterations: completed };
}

function initializeKMeansPlusPlus(
  points: readonly Vector[],
  k: number,
  rng: () => number,
): Vector[] {
  const centroids: Vector[] = [Float32Array.from(points[randomInt(rng, points.length)])];
  const closest = new Float64Array(points.length).fill(Infinity);

  while (centroids.length < k) {
    const latest = centroids[centroids.length - 1];
    let total = 0;

    for (let i = 0; i < points.length; i++) {
      const distance = squaredEuclidean(points[i], latest);
      if (distance < closest[i]) closest[i] = distance;
      total += closest[i];
    }

    // All points identical: any point is a valid centroid.
    if (total === 0) {
      centroids.push(Float32Array.from(points[randomInt(rng, points.length)]));
      continue;
    }

    let target = rng() * total;
    let chosen = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      target -= closest[i];
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(Float32Array.from(points[chosen]));
  }

  return centroids;
}
```

**Block by block:**

- **`KMeansOptions`** — `k`, iteration cap, seed. No tolerance parameter: convergence is detected by an unchanged assignment vector, which is exact and cheap.
- **`KMeansResult`** — centroids, assignments, inertia, iterations. Inertia (sum of squared distances) is useful for choosing `k` and for detecting a bad fit.
- **Validation** — non-empty points, `1 <= k <= N`, one shared dimension. These are programmer errors, not runtime data conditions.
- **Initialization** — `initializeKMeansPlusPlus`.
- **Lloyd loop**:
  1. Assign every point to the nearest centroid by squared L2.
  2. Accumulate sums and counts per cluster.
  3. Recompute each centroid as the mean.
  4. Compute inertia.
  5. Stop when assignments do not change.
- **Empty-cluster handling** — a real failure mode: a centroid can lose every point. It is re-seeded at the point currently worst represented by its own centroid. Without this, the cluster stays empty forever and `k` silently shrinks.
- **`initializeKMeansPlusPlus`**:
  - Pick the first centroid uniformly at random.
  - Track each point's squared distance to the nearest chosen centroid.
  - Choose the next centroid with probability proportional to that distance.
  - If all distances are zero (identical points), pick any point.
- **`Float64Array` accumulators** — summing thousands of float32 values in float32 loses precision; float64 keeps the centroid stable.

### Why k-means++?

Random initialization can place two centroids in the same dense cluster and leave another region unrepresented. k-means++ spreads the initial centroids out, which reduces bad local minima and makes recall more stable across seeds. It costs one extra pass per centroid at build time — irrelevant compared with the query savings.

### Complexity

```text
per iteration: O(N × k × D)
total:         O(iterations × N × k × D)
```

### 2.1 Seeded RNG — `src/lib/rng.ts`

#### 📄 `src/lib/rng.ts`

```ts
/**
 * Deterministic RNG (mulberry32).
 *
 * IVF k-means and HNSW level sampling are randomized. A seed makes demos,
 * benchmarks and tests reproducible — a small detail that separates a toy from
 * an engineering artifact.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}
```

**Block by block:**

- **`createRng(seed)`** — mulberry32. The state is a single 32-bit integer; each call mixes it and returns a float in `[0, 1)`.
- **Why not `Math.random()`?** A benchmark that produces different clusters, codebooks or HNSW levels on every run is not a benchmark. Seeding makes the build reproducible and turns recall into a regression test.
- **`randomInt`** — a small helper for uniform integer selection, used by k-means++ for the first centroid.
- **No cryptographic claim** — this is a fast deterministic generator for algorithms, not for secrets.

The same generator seeds k-means (Chapter 04), HNSW level sampling (Chapter 05), PQ codebooks (Chapter 06) and the synthetic dataset (Chapter 03).

---

### 2.2 k-means cost at scale

For N=1M, k=1,000, D=1,536, 20 iterations, this is enormous. Production IVF trains on a **sample** (often 50K–100K vectors), not the full collection. The code trains on what it is given; Chapter 10's benchmark uses 3,000 points on purpose.

---

## 3. IVF — `src/core/ivf.ts`

#### 📄 `src/core/ivf.ts`

```ts
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
```

**Block by block:**

- **Class fields**
  - `records` — a stable array; list entries are integer positions into it.
  - `centroids` + `centroidNorms` — the coarse quantizer.
  - `lists` — `lists[c]` contains the record indices assigned to cell `c`. This is the "inverted file".
  - `positions` — id → array index, for O(1) delete.
  - `recordById` — id → record, so search does not rebuild a map per query.
  - `deleted` — tombstones. Deleting from a list would be O(list length); tombstoning is O(1).
- **Constructor** — validates `nlist`, sets the default `nprobe` to `√nlist`, and stores iteration/seed. `nprobe=√nlist` is the standard starting heuristic; tune from there.
- **`build`**
  1. Copy the snapshot.
  2. For cosine, normalize every vector **before clustering**. L2 on unit vectors ranks identically to cosine, so the cells align with the query metric.
  3. Train k-means with `actualLists = min(nlist, N)`.
  4. Normalize centroids for cosine as well.
  5. Precompute centroid norms.
  6. Allocate one list per centroid.
  7. Assign each record to its nearest centroid and record its position.
- **`nearestCentroid`** — squared L2 over the clustering vectors. At build time this is the only assignment criterion; at query time the coarse ranking uses the configured metric.
- **`add`** — if the index is untrained, build. Otherwise assign each new record to the nearest existing cell and append. No re-training. This is how a live IVF index absorbs writes, at the cost of drift.
- **`remove`** — mark the position deleted, drop it from `positions` and `recordById`. The list entry remains until a rebuild; search skips tombstones.
- **`search`**
  - Prepare the query once.
  - Clamp `nprobe` to `[1, nlist]`.
  - Rank **all centroids** with `scoreWithNorms` using the query metric. This is `nlist` comparisons — cheap compared with the lists.
  - Take the top `nprobe` cells.
  - Scan only those lists; skip tombstones and filter rejections; score with `scoreWithNorms`; push into `TopK(k)`.
  - Resolve ids through `recordById`.
- **`stats`** — reports `nlist`, default `nprobe`, metric and **index structure bytes only** (lists + centroids). Raw vectors are counted once by the store.

### The boundary problem

Voronoi cells are convex, but the true nearest neighbour does not care about cell boundaries. If the query lies near a boundary, the best match may be in cell B while the query's own cell is A. With `nprobe=1`, B is never scanned.

This is the entire recall story of IVF:

- `nprobe=1` → fastest, most boundary misses.
- `nprobe=nlist` → exact scan (plus centroid ranking), no recall loss.
- `nprobe≈√nlist` → the usual starting point.

Increasing `nlist` makes cells smaller (faster scans, more boundaries). Increasing `nprobe` scans more cells (higher recall, more latency). There is no free setting; measure on your data.

### Incremental add and drift

`add` assigns to the nearest **existing** centroid. Over time the distribution shifts, cells become unbalanced, and recall degrades. Production systems periodically retrain on a sample and rebuild, or use a streaming variant. This code exposes the trade-off rather than hiding it.

---

## 4. Verification

```bash
npm run verify
```

```text
      IVF recall@10 = 100.0%
  ok  IVF recall is high with clustered data (58.0 ms)
```

The check builds `nlist=24`, `nprobe=4` over 1,200 vectors in 24 clusters and compares every query with exact KNN. Because each cluster is well separated, four cells cover the true neighbours almost every time.

`npm run bench` uses a harder configuration (`nprobe=1`, queries between clusters) and reports the other end of the curve:

```text
| ivf | 285.2 | 22.0 | 0.25 | 0.45 | 73.6% |
```

Same index, different `nprobe` and query distribution — that is the bargain.

**Next:** [Chapter 05 — HNSW Index](./05_HNSW_Index.md)

