# Chapter 06: Product Quantization & ADC

> **Chapter Goal:** Compress float32 vectors into a few bytes without giving up the ability to rank them. Split, quantize each sub-space, store 8-bit codes, and compute approximate distances from a lookup table. Then restore precision with exact rescoring.

> **Lecture mapping:** Notes Chapter 06 (precision, scalar quantization, PQ split/codebooks/compression, ADC, lossy compression, rescoring).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/core/pq.ts` | 289 | Codebook training, encoding, ADC tables, rescoring, compression stats. |

---

## 1. Commands

```bash
npm run verify
npm run bench
```

Expected:

```text
      PQ recall@10 = 96.4%, ratio = 8.63x
  ok  PQ compresses and rescoring restores ranking quality
```

The ratio is small in the test because the vectors are only 32 dimensions and the codebook is amortized over 1,200 points. The 1536-dimensional example below shows the real payoff.

---

## 2. The Idea in One Diagram

```text
1536 floats
[ f0 f1 ... f15 | f16 ... f31 | ... | f1520 ... f1535 ]
      sub-vector 0   sub-vector 1         sub-vector 95
           │              │                     │
           ▼              ▼                     ▼
      256 codewords  256 codewords        256 codewords
           │              │                     │
      code 0 (8 bit)  code 1 (8 bit)       code 95 (8 bit)
```

With `m = 96` sub-vectors of 16 floats each:

```text
original: 1536 × 4 B = 6,144 B
code:       96 × 1 B =    96 B
compression: 64×
```

The codebook itself is `96 × 256 × 16 × 4 B ≈ 1.57 MB` — independent of N. At 1M vectors it costs 1.6 bytes per vector; at 100 vectors it dominates. That is why compression ratios must be quoted at a given N.

---

## 3. Complete Source — `src/core/pq.ts`

#### 📄 `src/core/pq.ts`

```ts
import {
  distanceFromScore,
  dot,
  manhattanDistance,
  normalize,
  prepare,
  scoreWithNorms,
  squaredEuclidean,
} from './metrics.js';
import { kmeans } from './kmeans.js';
import { TopK } from '../lib/topk.js';
import type {
  IndexSearchOptions,
  IndexSearchResult,
  IndexStats,
  Metric,
  PqConfig,
  PreparedRecord,
  Vector,
} from '../types/vector.types.js';

/**
 * Product Quantization.
 *
 * Split a D-dimensional vector into M sub-vectors, learn 256 codewords per
 * sub-space, and store only the 8-bit codeword index for each sub-vector:
 *
 *   1536 floats (6144 B)  ->  96 bytes   (64x smaller)
 *
 * Distances are approximated with asymmetric distance computation (ADC): build
 * one lookup table per query sub-space, then sum M table reads per candidate.
 * Optional exact rescoring recovers the precision lost by compression.
 */
export class PqIndex<T = Record<string, unknown>> {
  readonly kind = 'pq' as const;

  private records: PreparedRecord<T>[] = [];
  private codes: Uint8Array[] = [];
  private codebooks: Vector[][] = [];
  private readonly byId = new Map<string, number>();
  private readonly deleted = new Set<number>();
  private readonly m: number;
  private readonly requestedKsub: number;
  private readonly iterations: number;
  private readonly seed: number;
  private subDim = 0;
  private ksub = 0;
  private dimensions = 0;

  constructor(
    private readonly metric: Metric,
    config: PqConfig,
  ) {
    const m = config.m ?? 8;
    if (m < 1) throw new Error('PQ m must be >= 1.');
    this.m = m;
    this.requestedKsub = config.ksub ?? 256;
    this.iterations = config.iterations ?? 20;
    this.seed = config.seed ?? 42;
    if (this.requestedKsub < 1 || this.requestedKsub > 256) {
      throw new Error('PQ ksub must be between 1 and 256 (codes are Uint8).');
    }
  }

  get size(): number {
    return this.records.length - this.deleted.size;
  }

  build(records: readonly PreparedRecord<T>[]): void {
    if (records.length < 2) throw new Error('PQ needs at least two training vectors.');
    this.records = [...records];
    this.codes = [];
    this.byId.clear();
    this.deleted.clear();

    this.dimensions = this.records[0].vector.length;
    if (this.dimensions % this.m !== 0) {
      throw new Error(`Dimension ${this.dimensions} is not divisible by m=${this.m}.`);
    }
    this.subDim = this.dimensions / this.m;
    this.ksub = Math.min(this.requestedKsub, this.records.length);

    const training = this.records.map((record) => this.forMetric(record.vector));
    this.codebooks = [];
    for (let subspace = 0; subspace < this.m; subspace++) {
      const slices = training.map((vector) => this.slice(vector, subspace));
      const trained = kmeans(slices, {
        k: this.ksub,
        iterations: this.iterations,
        seed: this.seed + subspace,
      });
      this.codebooks.push(trained.centroids);
    }

    for (let i = 0; i < this.records.length; i++) {
      this.codes.push(this.encode(this.forMetric(this.records[i].vector)));
      this.byId.set(this.records[i].id, i);
    }
  }

  add(records: readonly PreparedRecord<T>[]): void {
    if (this.codebooks.length === 0) {
      this.build(records);
      return;
    }
    for (const record of records) {
      const index = this.records.length;
      this.records.push(record);
      this.codes.push(this.encode(this.forMetric(record.vector)));
      this.byId.set(record.id, index);
    }
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      const index = this.byId.get(id);
      if (index === undefined) continue;
      this.deleted.add(index);
      this.byId.delete(id);
    }
  }

  search(query: Vector, options: IndexSearchOptions<T>): IndexSearchResult<T>[] {
    const { k, filter } = options;
    if (k <= 0 || this.records.length === 0) return [];

    const preparedQuery = prepare(query);
    const queryVector = this.forMetric(query);
    const table = this.buildAdcTable(queryVector);
    const rescoreDepth = Math.max(0, options.rescore ?? Math.min(50, Math.max(k * 4, k)));

    // Candidate generation must return at least as many points as we intend to
    // rescore; otherwise rescoring can only reorder the same K candidates.
    const top = new TopK(Math.max(k, rescoreDepth));

    for (let i = 0; i < this.records.length; i++) {
      if (this.deleted.has(i)) continue;
      const record = this.records[i];
      if (filter && !filter(record)) continue;
      const approximate = this.sumCodes(this.codes[i], table);
      const score =
        this.metric === 'cosine'
          ? 1 - approximate / 2 // ||a-b||² = 2 - 2cos for unit vectors
          : this.metric === 'euclid' || this.metric === 'manhattan'
            ? -approximate
            : approximate;
      top.push(record.id, score);
    }

    const ranked = top.results();

    if (rescoreDepth > 0) {
      // Exact rescoring on full-precision vectors. The candidate stage still
      // decides *which* points are eligible; rescoring only fixes their order.
      return ranked
        .slice(0, Math.min(rescoreDepth, ranked.length))
        .map((candidate) => {
          const record = this.records[this.byId.get(candidate.id)!];
          const exact = scoreWithNorms(
            this.metric,
            preparedQuery.data,
            preparedQuery.norm,
            record.vector,
            record.norm,
          );
          return {
            id: record.id,
            score: exact,
            distance: distanceFromScore(this.metric, exact),
            record,
          };
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, k);
    }

    return ranked.slice(0, k).map((candidate) => {
      const record = this.records[this.byId.get(candidate.id)!];
      return {
        id: record.id,
        score: candidate.score,
        distance: this.approximateDistance(candidate.score),
        record,
      };
    });
  }

  stats(): IndexStats {
    const originalVectorBytes = this.records.reduce(
      (sum, record) => sum + record.vector.byteLength,
      0,
    );
    const codeBytes = this.records.length * this.m;
    const codebookBytes = this.codebooks.reduce(
      (sum, codebook) => sum + codebook.reduce((inner, word) => inner + word.byteLength, 0),
      0,
    );
    return {
      kind: this.kind,
      size: this.size,
      deleted: this.deleted.size,
      memoryBytes: codeBytes + codebookBytes,
      params: {
        m: this.m,
        ksub: this.ksub,
        subDim: this.subDim,
        metric: this.metric,
        codeBytes,
        codebookBytes,
        originalVectorBytes,
        compressionRatio:
          codeBytes + codebookBytes > 0
            ? Number((originalVectorBytes / (codeBytes + codebookBytes)).toFixed(2))
            : 0,
      },
    };
  }

  // ── Encoding / ADC internals ──────────────────────────────────────────────

  private buildAdcTable(query: Vector): Float32Array {
    const table = new Float32Array(this.m * this.ksub);
    for (let subspace = 0; subspace < this.m; subspace++) {
      const querySlice = this.slice(query, subspace);
      const offset = subspace * this.ksub;
      for (let codeword = 0; codeword < this.ksub; codeword++) {
        const word = this.codebooks[subspace][codeword];
        if (this.metric === 'euclid' || this.metric === 'cosine') {
          // For unit vectors, L2² = 2 - 2cos, so L2 ADC is cosine ADC without
          // the codeword-norm bias of a raw dot-product table.
          table[offset + codeword] = squaredEuclidean(querySlice, word);
        } else if (this.metric === 'manhattan') {
          table[offset + codeword] = manhattanDistance(querySlice, word);
        } else {
          table[offset + codeword] = dot(querySlice, word);
        }
      }
    }
    return table;
  }

  private encode(vector: Vector): Uint8Array {
    const code = new Uint8Array(this.m);
    for (let subspace = 0; subspace < this.m; subspace++) {
      const slice = this.slice(vector, subspace);
      const codebook = this.codebooks[subspace];
      let best = 0;
      let bestDistance = Infinity;
      for (let codeword = 0; codeword < this.ksub; codeword++) {
        const distance = squaredEuclidean(slice, codebook[codeword]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = codeword;
        }
      }
      code[subspace] = best;
    }
    return code;
  }

  private sumCodes(code: Uint8Array, table: Float32Array): number {
    let sum = 0;
    for (let subspace = 0; subspace < this.m; subspace++) {
      sum += table[subspace * this.ksub + code[subspace]];
    }
    return sum;
  }

  private slice(vector: Vector, subspace: number): Vector {
    return vector.subarray(subspace * this.subDim, (subspace + 1) * this.subDim);
  }

  private forMetric(vector: Vector): Vector {
    // Cosine is angle: normalize once and the dot product becomes the answer.
    return this.metric === 'cosine' ? normalize(vector) : vector;
  }

  private approximateDistance(score: number): number {
    switch (this.metric) {
      case 'euclid':
        return Math.sqrt(Math.max(0, -score));
      case 'manhattan':
      case 'dot':
        return -score;
      case 'cosine':
        return 1 - score;
    }
  }
}
```

---

## 4. Block-by-Block Explanation

### 4.1 Fields and constructor

- **`records`** — the original vectors are retained for exact rescoring. In a production PQ index they may live on disk or in a separate store; keeping them here makes the trade-off visible.
- **`codes`** — one `Uint8Array(m)` per record. This is the compressed representation.
- **`codebooks`** — `codebooks[s][c]` is the centroid for codeword `c` in sub-space `s`.
- **`byId`** — external id → array index for O(1) result mapping.
- **`deleted`** — tombstones, same pattern as IVF/HNSW.
- **`m`** — number of sub-vectors.
- **`requestedKsub`** — default 256, capped at 256 because a code is one byte.
- **`subDim`** — `D / m`.
- **`ksub`** — actual number of codewords after clamping to the training-set size.

The constructor validates `m >= 1` and `ksub` in `1..256`. A silent `ksub=300` would overflow `Uint8Array` and produce wrong codes.

### 4.2 `build` — training

1. Require at least two vectors.
2. Copy the records and clear codes/maps.
3. Validate `D % m == 0`. If not, the caller must choose a valid `m` (the store does this with `defaultPqSubspaces`).
4. `subDim = D / m`.
5. `ksub = min(requested, N)`. Training 256 centroids from 24 vectors is impossible; clamping makes the demo work and is a real production guard.
6. For cosine, normalize every vector first.
7. For each sub-space:
   - Slice every training vector into that sub-space.
   - Run k-means with `k = ksub`.
   - Store the centroids as the codebook.
8. Encode every record and register its id.

The sub-space k-means uses squared L2. For cosine, normalization makes L2 ranking equivalent to cosine ranking, so the codebooks are aligned with the metric.

### 4.3 `encode` — vector → codes

For each sub-space:

```text
best = argmin_c || subvector - codebook[s][c] ||²
code[s] = best
```

The loops are `m × ksub × subDim` per vector: for `m=96`, `ksub=256`, `subDim=16`, that is 393K operations per vector at build time. Production PQ training and encoding are offline batch jobs for this reason.

### 4.4 `add` and `remove`

- `add` encodes with the **existing** codebooks. No re-training; new data may be poorly represented if the distribution drifted.
- `remove` tombstones the index and drops the id mapping.
- A rebuild is required to reclaim memory or adapt the codebooks.

### 4.5 `search` — ADC

1. Prepare the query and normalize it for cosine.
2. Compute `rescoreDepth` (default `min(50, max(4K, K))`).
3. **Candidate heap size = max(K, rescoreDepth)**. This is critical: if the heap only holds K, rescoring can only reorder those K. It cannot recover a true neighbour that the approximate stage ranked 11th.
4. For each live record:
   - Sum `m` table lookups at the code indices.
   - Convert the sum to a score.
5. Rescore the top `rescoreDepth` with full-precision vectors and return the best K.

### 4.6 ADC table — the trick that makes PQ fast

For each sub-space and codeword, precompute the distance between the query sub-vector and the codeword:

```text
table[s][c] = distance(query[s], codebook[s][c])
```

Then a candidate's approximate distance is:

```text
sum over s of table[s][code[s]]
```

That is `m` array reads, not `D` multiply-adds. For `m=96`, it is 96 reads instead of 1,536 multiply-adds — a 16× reduction in arithmetic per candidate, plus a much smaller memory footprint.

### 4.7 The cosine ADC trap (a real bug found during this build)

The first implementation used a dot-product table for cosine:

```text
table[s][c] = dot(query[s], codeword[s][c])
score = sum of table lookups
```

It seems right — cosine is a dot product of unit vectors. It is not, because the **codewords are not unit vectors**. A codeword is the mean of many normalized sub-vectors; its norm is less than 1 and varies by sub-space. The dot product therefore rewards long codewords regardless of direction. Benchmark recall dropped to ~46%.

The fix uses squared L2 for cosine as well:

```text
||a - b||² = 2 - 2·cos(a,b)   for unit vectors
```

Ranking by L2 is therefore identical to ranking by cosine, and the table has no norm bias:

```text
score = 1 - (sum of squared L2) / 2
```

This is a useful engineering lesson: the algebra is correct, but the **representation** violates its assumption. Always measure against exact KNN.

### 4.8 Rescoring

PQ is lossy. The code approximates a vector with `m` codewords, so two nearby vectors can share the same codes. Rescoring fixes the order of the candidate set:

```text
candidates = approximate top (rescoreDepth)
final      = exact score over candidates, top K
```

It does **not** fix candidate recall. If the true neighbour is not in the candidate set, rescoring cannot find it. That is why `rescoreDepth` must be larger than K, and why the candidate stage still matters.

The default in `search` is `min(50, max(4K, K))`; the API can override it, including `rescore: 0` to inspect raw PQ quality.

### 4.9 Score and distance conversion

- **Euclidean**: table sums squared L2; score is `-sum`; distance is `sqrt(sum)`.
- **Manhattan**: table sums L1; score is `-sum`; distance is `sum`.
- **Dot**: table sums dot products; score is `sum`; distance is `-sum`.
- **Cosine**: table sums squared L2; score is `1 - sum/2`; distance is `1 - score`.

The rescore path bypasses all of this and computes the exact metric with `scoreWithNorms`.

### 4.10 `stats` — honest memory accounting

- `codeBytes = N × m` — the compressed vectors.
- `codebookBytes = m × ksub × subDim × 4` — the model, independent of N.
- `originalVectorBytes = N × D × 4` — what the vectors would cost.
- `compressionRatio = original / (codes + codebooks)`.

At 1,200 vectors of 32 dimensions with `m=8`, `ksub=64`:

```text
original: 1,200 × 128 B = 153,600 B
codes:    1,200 × 8 B   =   9,600 B
codebook: 8 × 64 × 4 × 4 =  8,192 B
ratio:    153,600 / 17,792 ≈ 8.6×
```

At 1M vectors of 1,536 dimensions with `m=96`, `ksub=256`:

```text
original: 6.14 GB
codes:    96 MB
codebook: ~1.57 MB
ratio:    ~64×
```

The codebook is the fixed cost that makes PQ a scale play.

### 4.11 Parameters and limits

| Parameter | Effect | Notes |
| :--- | :--- | :--- |
| `m` | More sub-vectors → more accurate, larger codes | Must divide D |
| `ksub` | More codewords → more accurate, larger codebook | ≤256 for `Uint8` |
| `iterations` | Better codebooks, slower training | 10–25 |
| `rescore` | Better final order, more full-precision work | 0 disables |

PQ is not a replacement for an index. It compresses the vectors that an IVF/HNSW index searches, or it acts as a coarse filter before rescoring. Production systems combine them: IVF-PQ, HNSW+PQ, scalar quantization on top of HNSW.

---

## 5. Verification

```bash
npm run verify
```

```text
      PQ recall@10 = 96.4%, ratio = 8.63x
  ok  PQ compresses and rescoring restores ranking quality (116.8 ms)
```

The test trains `m=8`, `ksub=64` over 1,200 vectors, searches with `rescore: 40`, and requires recall > 0.8 and compression > 5×.

`npm run bench` uses `m=12`, `ksub=128`, `rescore=20`:

```text
| pq + rescore | 665.9 | 59.2 | 0.31 | 0.54 | 77.2% |
```

Build time includes training 12 codebooks. Query time is close to IVF because ADC is cheap; recall depends on the candidate depth and the codebook quality.

**Next:** [Chapter 07 — Vector Store, CRUD & Hybrid Search](./07_Vector_Store_CRUD_and_Filtering.md)

