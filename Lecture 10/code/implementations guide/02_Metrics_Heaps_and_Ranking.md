# Chapter 02: Metrics, Heaps & Ranking

> **Chapter Goal:** Implement the mathematics once, behind one score convention, and rank results without sorting the entire collection. Every index in Chapters 04–06 reuses these functions.

> **Lecture mapping:** Notes Chapter 02 (distance and metric consistency) and Chapter 03 (exact KNN, top-K cost).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/core/metrics.ts` | 148 | Dot, norms, cosine, L2, L1, squared L2, score conversion. |
| `src/lib/heap.ts` | 80 | Generic binary heap with a comparator. |
| `src/lib/topk.ts` | 47 | Bounded K-result collector. |
| `src/core/evaluation.ts` | 47 | Recall@K, precision, MRR, nDCG, percentile. |

---

## 1. Commands

```bash
npm run verify
```

The first two checks cover this chapter:

```text
  ok  metric identities and guards
  ok  bounded top-K keeps the largest scores
```

---

## 2. Metrics — `src/core/metrics.ts`

#### 📄 `src/core/metrics.ts`

```ts
import type { Metric, PreparedVector, Vector } from '../types/vector.types.js';

/**
 * Similarity and distance primitives.
 *
 * Contract used everywhere above this module:
 *   `score` is always HIGHER-IS-BETTER.
 *   cosine / dot  -> native similarity
 *   euclid / manhattan -> negated distance
 *
 * That single convention prevents the classic bug where one endpoint sorts
 * ascending and another sorts descending. The native distance is still exposed
 * on search hits when you need to report it.
 */

export function toVector(input: Vector | number[]): Vector {
  if (input instanceof Float32Array) return input;
  if (Array.isArray(input)) return Float32Array.from(input);
  throw new TypeError('Vector must be a Float32Array or an array of numbers.');
}

export function assertSameDimensions(a: Vector, b: Vector): void {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}.`);
  }
}

export function assertValidVector(vector: Vector): void {
  if (vector.length === 0) throw new Error('Vector must not be empty.');
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(`Vector contains a non-finite value at index ${i}.`);
    }
  }
}

export function dot(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  // A plain indexed loop is faster than reduce/map for typed arrays.
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a: Vector): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

export function normalize(a: Vector): Vector {
  const length = norm(a);
  const out = new Float32Array(a.length);
  if (length === 0) return out; // Zero vector stays zero; never emit NaN.
  const inverse = 1 / length;
  for (let i = 0; i < a.length; i++) out[i] = a[i] * inverse;
  return out;
}

export function cosineSimilarity(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  const denominator = norm(a) * norm(b);
  if (denominator === 0) return 0;
  return dot(a, b) / denominator;
}

export function euclideanDistance(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function manhattanDistance(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

/** Squared L2 — the right form for k-means and ADC: no sqrt in hot loops. */
export function squaredEuclidean(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export function prepare(vector: Vector): PreparedVector {
  assertValidVector(vector);
  return { data: vector, norm: norm(vector) };
}

/** Hot path: norms arrive precomputed with the record, so cosine costs one dot. */
export function scoreWithNorms(
  metric: Metric,
  query: Vector,
  queryNorm: number,
  vector: Vector,
  vectorNorm: number,
): number {
  switch (metric) {
    case 'cosine': {
      const denominator = queryNorm * vectorNorm;
      return denominator === 0 ? 0 : dot(query, vector) / denominator;
    }
    case 'dot':
      return dot(query, vector);
    case 'euclid':
      return -euclideanDistance(query, vector);
    case 'manhattan':
      return -manhattanDistance(query, vector);
  }
}

export function scorePrepared(metric: Metric, query: PreparedVector, vector: PreparedVector): number {
  return scoreWithNorms(metric, query.data, query.norm, vector.data, vector.norm);
}

/** Convenience wrapper for tests and demos; not used in hot loops. */
export function score(metric: Metric, a: Vector, b: Vector): number {
  return scoreWithNorms(metric, a, norm(a), b, norm(b));
}

/** Convert the internal higher-is-better score back to a native distance. */
export function distanceFromScore(metric: Metric, scoreValue: number): number {
  switch (metric) {
    case 'cosine':
      return 1 - scoreValue;
    case 'dot':
    case 'euclid':
    case 'manhattan':
      return -scoreValue;
  }
}

export const METRIC_LABELS: Record<Metric, string> = {
  cosine: 'cosine similarity',
  dot: 'dot product',
  euclid: 'Euclidean distance',
  manhattan: 'Manhattan distance',
};
```

**Block by block:**

- **The contract comment** — this is the most important block in the file. `score` is higher-is-better everywhere. Cosine and dot are used directly; Euclidean and Manhattan are negated. Without this rule, exact search sorts ascending while IVF sorts descending and nobody notices until production.
- **`toVector`** — converts a JSON `number[]` to `Float32Array` at the boundary. A `Float32Array` input is passed through; the store clones when it needs ownership.
- **`assertSameDimensions`** — one length check per call. A dimension mismatch is a data-integrity bug, not a result to be scored.
- **`assertValidVector`** — rejects empty vectors and `NaN`/`Infinity`. A single `NaN` poisons every comparison and silently sorts to the end.
- **`dot`** — one indexed loop. This is the hot path; no `reduce`, no allocation.
- **`norm`** — L2 length. Note that `normalize` computes it again; callers that need both should use `prepare`.
- **`normalize`** — returns a new unit vector, or a zero vector for zero input. It never divides by zero and never emits `NaN`.
- **`cosineSimilarity`** — computes both norms, guards a zero denominator, and returns `0` for a zero vector. The notes call this out explicitly; it is a real edge case for empty documents.
- **`euclideanDistance` / `manhattanDistance`** — straight-line and grid distance. L1 is more robust to a single large coordinate difference; L2 punishes it more.
- **`squaredEuclidean`** — the form used by k-means and PQ. The square root is monotonic, so ranking does not need it; skipping it saves a `sqrt` per comparison.
- **`prepare`** — validates and returns `{ data, norm }`. This is how records enter the store and indexes.
- **`scoreWithNorms`** — the single switch that implements the contract. It takes precomputed norms, so cosine is `dot / (qNorm * vNorm)` with no second pass.
- **`scorePrepared` / `score`** — convenience wrappers for tests and demos. The hot loops call `scoreWithNorms` directly to avoid object creation.
- **`distanceFromScore`** — converts back to a native distance for the API: cosine distance, L2, L1, or `-dot`.
- **`METRIC_LABELS`** — human-readable names for logs and documentation.

### Why precomputed norms matter

A naive cosine implementation does three loops: norm A, norm B, dot. At 1536 dimensions that is 4,608 multiply-adds per comparison. With norms stored once per record, the query norm computed once, and a single dot, it is 1,536. That is a **3×** reduction in the hot loop without changing the result.

For 1M vectors and K=10, exact search still does 1.5 billion operations — which is the point of Lecture 09 and Chapter 03. The optimization reduces the constant; it does not change the asymptote.

---

## 3. Binary Heap — `src/lib/heap.ts`

#### 📄 `src/lib/heap.ts`

```ts
/**
 * A tiny generic binary heap.
 *
 * Comparator contract: negative means `a` has higher priority than `b`.
 * That one rule lets the same class act as a min-heap or a max-heap, which is
 * exactly what HNSW needs (closest-first candidates, farthest-first results).
 */
export type Comparator<T> = (a: T, b: T) => number;

export class BinaryHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: Comparator<T>) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Replace the root in O(log n). Used by bounded top-K. */
  replaceTop(item: T): void {
    if (this.items.length === 0) return;
    this.items[0] = item;
    this.siftDown(0);
  }

  /** Snapshot sorted by the heap's own priority order. */
  toArray(): T[] {
    return [...this.items].sort(this.compare);
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.items[i], this.items[parent]) >= 0) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;

      if (left < this.items.length && this.compare(this.items[left], this.items[best]) < 0) {
        best = left;
      }
      if (right < this.items.length && this.compare(this.items[right], this.items[best]) < 0) {
        best = right;
      }
      if (best === i) break;

      [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
      i = best;
    }
  }
}
```

**Block by block:**

- **`Comparator<T>`** — negative means `a` has higher priority. One convention supports both directions:
  - Min-heap by score: `(a, b) => a.score - b.score` → smallest score at the root.
  - Max-heap by distance: `(a, b) => b.distance - a.distance` → farthest result at the root.
- **`items`** — a plain array; index `0` is the root. Children of `i` are `2i+1` and `2i+2`.
- **`push`** — append, then sift up until the parent has priority.
- **`pop`** — take the root, move the last element to the root, sift down. `O(log n)`.
- **`replaceTop`** — swap the root in place and sift down. This is the operation that makes bounded top-K cheap: the new candidate replaces the worst result without growing the heap.
- **`toArray`** — copies and sorts by the same comparator. Used only at the end of a query, not per candidate.
- **`siftUp` / `siftDown`** — standard binary-heap maintenance with tuple swaps.

**Why not sort?** Sorting N scores is `O(N log N)` and allocates an N-element array. A heap of size K is `O(N log K)` time and `O(K)` memory. At N=100M, the difference is the difference between a query and an outage.

---

## 4. Bounded Top-K — `src/lib/topk.ts`

#### 📄 `src/lib/topk.ts`

```ts
import { BinaryHeap } from './heap.js';

export interface Ranked {
  id: string;
  score: number;
}

/**
 * Bounded top-K collector: O(N log K) time, O(K) memory.
 *
 * Keeping the *worst* score at the root lets us reject almost every candidate
 * with one comparison. Sorting all N scores would be O(N log N) and allocate an
 * array proportional to the collection — unacceptable at 100M vectors.
 */
export class TopK {
  private readonly heap: BinaryHeap<Ranked>;

  constructor(private readonly k: number) {
    // Min-heap by score: the weakest result sits at the root.
    this.heap = new BinaryHeap<Ranked>((a, b) => a.score - b.score);
  }

  /** Score of the current K-th best, or -Infinity while the heap is filling. */
  get threshold(): number {
    if (this.heap.size < this.k) return -Infinity;
    return this.heap.peek()!.score;
  }

  push(id: string, score: number): void {
    if (this.k <= 0 || !Number.isFinite(score)) return;

    if (this.heap.size < this.k) {
      this.heap.push({ id, score });
      return;
    }
    if (score > this.heap.peek()!.score) {
      this.heap.replaceTop({ id, score });
    }
  }

  /** Deterministic order: score descending, then id ascending. */
  results(): Ranked[] {
    return this.heap
      .toArray()
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
}
```

**Block by block:**

- **`Ranked`** — the minimum a result needs: `id` and `score`.
- **Constructor** — a min-heap by score. The **worst** kept result is always at the root, so rejection is one comparison.
- **`threshold`** — the current K-th best score, or `-Infinity` while filling. Useful for early termination in index scans.
- **`push`**:
  - Ignore `k <= 0` and non-finite scores.
  - Fill the heap until it has K items.
  - After that, accept only `score > root.score` and replace the root.
  - Equal scores are rejected; deterministic tie-breaking happens at the end.
- **`results`** — sorts by score descending, then id ascending. The id tie-break makes tests and pagination stable.

**Subtle point:** the heap stores only ids and scores, not payloads. The caller maps ids back to records once, at the end. That keeps the hot loop small and avoids retaining large payload objects K times.

---

## 5. Evaluation — `src/core/evaluation.ts`

#### 📄 `src/core/evaluation.ts`

```ts
/** Retrieval metrics — the only honest way to compare an ANN index to exact KNN. */

export function recallAtK(approximate: readonly string[], exact: readonly string[], k: number): number {
  if (k <= 0 || exact.length === 0) return 0;
  const truth = new Set(exact.slice(0, k));
  let hits = 0;
  for (const id of approximate.slice(0, k)) if (truth.has(id)) hits++;
  return hits / Math.min(k, exact.length);
}

export function precisionAtK(approximate: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (k <= 0) return 0;
  let hits = 0;
  for (const id of approximate.slice(0, k)) if (relevant.has(id)) hits++;
  return hits / k;
}

/** Mean reciprocal rank of the first relevant result. */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/** nDCG with graded relevance, the standard ranking-quality metric. */
export function ndcgAtK(
  ranked: readonly string[],
  relevance: ReadonlyMap<string, number>,
  k: number,
): number {
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, id, index) => sum + (relevance.get(id) ?? 0) / Math.log2(index + 2), 0);
  const ideal = [...relevance.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, value, index) => sum + value / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}
```

**Block by block:**

- **`recallAtK`** — intersection of the approximate top-K and the exact top-K, divided by K. This is the headline ANN metric: "of the true 10 neighbours, how many did we return?"
- **`precisionAtK`** — fraction of returned results that are relevant. Useful when relevance is a labelled set rather than "the exact top-K".
- **`reciprocalRank`** — `1 / rank` of the first relevant result. Sensitive to getting *one* good result high; used for question answering.
- **`ndcgAtK`** — graded relevance with logarithmic discount. A relevant result at rank 1 contributes more than the same result at rank 10. The ideal DCG is computed from the sorted relevance values, so the score is normalized to 0..1.
- **`percentile`** — nearest-rank percentile for latency. `p95` is the number that exposes tail pain; averages hide it.
- **Empty guards** — every function returns 0 rather than `NaN` for empty inputs.

### Which metric when?

| Question | Metric |
| :--- | :--- |
| Did ANN return the exact neighbours? | Recall@K |
| Are the returned documents relevant? | Precision@K, nDCG@K |
| Is the first good answer high enough? | MRR |
| Is the tail slow? | p95 / p99 latency |
| Is the index worth its memory? | Recall@K per byte, per millisecond |

Recall is not a quality metric for the user; it is a **diagnostic** for the index. A system can have 95% recall@10 and still rank the best answer at position 9. That is why nDCG and reranking exist.

---

## 6. Verification

```bash
npm run verify
```

```text
  ok  metric identities and guards (1.5 ms)
  ok  bounded top-K keeps the largest scores (0.5 ms)
```

The assertions cover:

- `cos(a, a) = 1` and `cos([1,0], [0,1]) = 0`.
- `euclidean([1,0], [0,1]) = √2`.
- `normalize([3,4]) = [0.6, 0.8]`.
- A zero vector returns cosine `0`, not `NaN`.
- A dimension mismatch throws.
- `TopK(3)` over `[0.2, 0.9, 0.5, 0.7]` returns `b, d, c`.

**Next:** [Chapter 03 — Exact KNN & the ANN Bargain](./03_Exact_KNN_and_the_ANN_Bargain.md)

