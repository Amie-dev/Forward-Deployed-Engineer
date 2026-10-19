# Chapter 03: Exact KNN & the ANN Bargain

> **Chapter Goal:** Implement the ground truth. A full scan with a bounded heap returns 100% recall and is the only way to prove an approximate index is any good. Then build the synthetic dataset used to measure the bargain.

> **Lecture mapping:** Notes Chapter 03 (baseline loop, cost model, ANN contract, recall@K, spectrum).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/core/exact-knn.ts` | 58 | Full scan, filter, top-K, result mapping. |
| `src/data/synthetic.ts` | 95 | Seeded clustered dataset and queries for tests/benchmarks. |

---

## 1. Commands

```bash
npm run verify
npm run bench
```

`verify` checks that exact KNN returns the query itself first and is correctly ordered. `bench` uses exact KNN as the baseline column.

---

## 2. Exact KNN — `src/core/exact-knn.ts`

#### 📄 `src/core/exact-knn.ts`

```ts
import { prepare, scoreWithNorms, distanceFromScore } from './metrics.js';
import { TopK } from '../lib/topk.js';
import type {
  IndexSearchOptions,
  IndexSearchResult,
  Metric,
  PreparedRecord,
  Vector,
} from '../types/vector.types.js';

export interface ExactKnnOptions<T = Record<string, unknown>> extends IndexSearchOptions<T> {
  metric: Metric;
  /** Reuse the store's id map instead of rebuilding one per query. */
  recordsById?: ReadonlyMap<string, PreparedRecord<T>>;
}

/**
 * Exact KNN — the ground truth.
 *
 * Scans every record, keeps only K candidates in a bounded heap, and therefore
 * returns 100% recall by construction. Cost is O(N × D) comparisons and O(K)
 * extra memory. Every ANN claim in this codebase is measured against this.
 */
export function exactKnn<T>(
  records: readonly PreparedRecord<T>[],
  query: Vector,
  options: ExactKnnOptions<T>,
): IndexSearchResult<T>[] {
  const { k, metric, filter } = options;
  if (k <= 0) return [];

  const preparedQuery = prepare(query);
  const top = new TopK(k);
  const byId = options.recordsById ?? new Map(records.map((record) => [record.id, record]));

  for (const record of records) {
    if (filter && !filter(record)) continue;
    const score = scoreWithNorms(
      metric,
      preparedQuery.data,
      preparedQuery.norm,
      record.vector,
      record.norm,
    );
    top.push(record.id, score);
  }

  return top.results().map((ranked) => {
    const record = byId.get(ranked.id);
    if (!record) throw new Error(`Internal error: missing record ${ranked.id}.`);
    return {
      id: record.id,
      score: ranked.score,
      distance: distanceFromScore(metric, ranked.score),
      record,
    };
  });
}
```

**Block by block:**

- **`ExactKnnOptions`** — adds `metric` and an optional `recordsById` map to the shared search options. The map is an optimization: the store already owns one, so exact search does not rebuild it on every query.
- **`exactKnn`**:
  - `k <= 0` returns immediately.
  - `prepare(query)` validates and computes the query norm once.
  - `TopK(k)` keeps only the best K; no N-element score array is allocated.
  - `recordsById` is either supplied or built once from the scan.
- **The scan loop** — filter first, then score. Filtering before scoring is strictly cheaper; a rejected record never enters the dot product. `scoreWithNorms` reuses `record.norm`, so cosine is one dot product.
- **Result mapping** — `top.results()` gives ids and scores; the map resolves the full record. The final array has `id`, `score`, `distance`, `payload` and `text`.

### Why this is the specification

Exact KNN is not the "slow version to be replaced". It is the **definition** of the answer:

```text
trueTopK = argmax over all records of score(query, record)
```

Every ANN index is an optimization that hopes to return the same set. Without this function:

- Recall@K is undefined.
- You cannot tell whether a parameter change improved or broke quality.
- You cannot detect a corrupt index.

### Cost

```text
comparisons = N
work per comparison = D multiply-adds
total = O(N × D)
```

At 1536 dimensions:

| N | Dimension operations | float32 bytes read |
| ---: | ---: | ---: |
| 10K | 15.4M | 61 MB |
| 1M | 1.54B | 6.1 GB |
| 10M | 15.4B | 61 GB |
| 100M | 153.6B | 614 GB |

The arithmetic is not the bottleneck; memory bandwidth is. A CPU cannot dot-product data it is still waiting to read. That is why ANN indexes reduce the number of vectors touched, not the cost of a single dot product.

### When exact is still the right answer

- The collection is small (< ~100K vectors).
- The query needs a guarantee (compliance, deduplication, evaluation).
- The filter is so selective that only a few hundred records remain.
- You are building the golden set for ANN tuning.

This code uses exact search as the fallback when a filtered ANN query underfills (Chapter 07).

---

## 3. Synthetic Dataset — `src/data/synthetic.ts`

#### 📄 `src/data/synthetic.ts`

```ts
import { createRng } from '../lib/rng.js';
import { prepare } from '../core/metrics.js';
import type { PreparedRecord, Vector } from '../types/vector.types.js';

export interface SyntheticPayload {
  [key: string]: unknown;
  cluster: number;
  tenant: 'acme' | 'globex';
  year: number;
  category: string;
}

export interface SyntheticDataset {
  records: PreparedRecord<SyntheticPayload>[];
  queries: Vector[];
  queryClusters: number[];
  dimensions: number;
}

export interface SyntheticOptions {
  count?: number;
  dimensions?: number;
  clusters?: number;
  seed?: number;
  noise?: number;
  /** `random` produces queries between clusters — a harder recall test. */
  querySource?: 'record' | 'random';
}

/**
 * Clustered synthetic vectors. Real embeddings are clustered too, which is why
 * IVF and HNSW work at all; uniform random points are the adversarial case.
 */
export function makeSyntheticDataset(options: SyntheticOptions = {}): SyntheticDataset {
  const {
    count = 1_000,
    dimensions = 32,
    clusters = 20,
    seed = 7,
    noise = 0.18,
    querySource = 'record',
  } = options;

  const rng = createRng(seed);
  const centres = Array.from({ length: clusters }, () =>
    Array.from({ length: dimensions }, () => gaussian(rng)),
  );

  const records: PreparedRecord<SyntheticPayload>[] = [];
  const categories = ['embeddings', 'ann', 'storage', 'ops'];

  for (let i = 0; i < count; i++) {
    const cluster = i % clusters;
    const vector = new Float32Array(dimensions);
    for (let d = 0; d < dimensions; d++) {
      vector[d] = centres[cluster][d] + gaussian(rng) * noise;
    }
    records.push({
      id: `vec-${String(i).padStart(5, '0')}`,
      vector,
      norm: prepare(vector).norm,
      payload: {
        cluster,
        tenant: cluster % 2 === 0 ? 'acme' : 'globex',
        year: 2020 + (cluster % 5),
        category: categories[cluster % categories.length],
      },
    });
  }

  const queries: Vector[] = [];
  const queryClusters: number[] = [];
  for (let q = 0; q < 25; q++) {
    const source = records[(q * 37) % records.length];
    const vector = new Float32Array(dimensions);
    if (querySource === 'random') {
      for (let d = 0; d < dimensions; d++) vector[d] = gaussian(rng);
    } else {
      for (let d = 0; d < dimensions; d++) {
        vector[d] = source.vector[d] + gaussian(rng) * noise * 0.6;
      }
    }
    queries.push(vector);
    queryClusters.push(source.payload.cluster);
  }

  return { records, queries, queryClusters, dimensions };
}

/** Box–Muller transform: two uniforms in, one standard normal out. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
```

**Block by block:**

- **`SyntheticPayload`** — cluster, tenant, year and category. The payload exists so filter tests have real fields; the index string is there because the payload must satisfy `Record<string, unknown>`.
- **`SyntheticDataset`** — records, queries, query clusters, dimensions. Query clusters are kept for diagnostics, not used by the retrieval code.
- **`SyntheticOptions`**:
  - `count` — number of vectors.
  - `dimensions` — width.
  - `clusters` — number of Gaussian centres.
  - `seed` — reproducibility.
  - `noise` — spread around each centre.
  - `querySource` — `record` (near a stored point) or `random` (between clusters). Random queries are the harder recall test.
- **`makeSyntheticDataset`** — creates `clusters` centres with standard-normal coordinates, then `count` points around those centres. Every point carries its cluster/tenant/category so filter tests are meaningful.
- **Query generation** — with `record`, a query is a stored vector plus smaller noise (easy, near-duplicate queries). With `random`, it is a fresh Gaussian point (hard, between clusters).
- **`gaussian`** — Box–Muller: two uniforms in, one standard normal out. `Math.max(rng(), Number.EPSILON)` prevents `log(0)`.

### Why clustered data?

Real embeddings are clustered: support tickets about billing, movies in the same genre, code in the same repository. IVF and HNSW exploit that structure. Uniform random points in 1536 dimensions are the adversarial case where every index struggles; they are useful for failure testing, but they are not representative.

The generator gives you both: keep `querySource: 'record'` for a friendly benchmark, switch to `'random'` to watch recall fall.

### Determinism

Every random choice uses `mulberry32(seed)`. The same seed produces the same points, queries, index build and recall number. That is what makes a benchmark a regression test instead of a demo.

---

## 4. Verification

```bash
npm run verify
```

```text
  ok  exact KNN is ordered and self-consistent (2.1 ms)
```

The test queries with a stored vector and asserts:

1. The top result is the record itself (cosine 1.0).
2. Scores are monotonically non-increasing.

`npm run bench` prints the exact baseline:

```text
| flat (exact) | 0.0 | 0.0 | 0.58 | 0.84 | 100.0% |
```

The exact column is deliberately not optimized. It is the control group.

### The ANN bargain in one sentence

> Every approximate index is correct only relative to a recall target measured against this function.

If a change makes an index faster but nobody measured recall, the change is not an optimization — it is a hope.

**Next:** [Chapter 04 — IVF Index](./04_IVF_Index.md)

