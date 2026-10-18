# Chapter 05: Vector Store & Cosine Similarity — STORE / COMPARE / RANK

> **Chapter Goal:** Implement the three remaining operations of the mental model. Build the catalog once, keep each movie's vector in memory, score every candidate with cosine similarity, and rank the results. Understand the formula well enough to defend why it beats Euclidean distance for text embeddings.

> **Lecture mapping:** Notes Chapters 03 (precomputation), 05 (cosine similarity), and 06 (the four-step mental model).

> **Files covered:**

| File | Lines | Purpose |
| :--- | :--- | :--- |
| `src/services/vector.store.ts` | 140 | `VectorStore` class, `cosineSimilarity()`, singleton export |

---

## 1. Complete Source Code

### 📄 `src/services/vector.store.ts` (140 lines)

```typescript
import type { Movie, ScoredMovie, CatalogStatus } from '../types/movie.types.js';
import { MOVIE_CATALOG } from '../data/movies.js';
import { embeddingService } from './embedding.service.js';

/**
 * VectorStore — in-memory implementation of the STORE step.
 *
 * Responsibilities:
 *   1. Phase 1 (build)  — embed every movie description once, cache the result
 *   2. Phase 2 (query)  — compare a query vector against all stored vectors
 *
 * In production this would be backed by pgvector, Pinecone, or Qdrant.
 * For this learning demo, a simple in-memory array is sufficient and clear.
 */
export class VectorStore {
  private catalog: Movie[] = [];
  private isReady = false;

  /**
   * PHASE 1 — REPRESENT + STORE
   *
   * Embeds all movie descriptions in a single batch API call, then stores
   * each movie alongside its vector for future comparisons.
   *
   * Key engineering insight from notes:
   *   Movie descriptions are STABLE data → process once, reuse forever.
   *   User queries are CHANGING data  → process per request.
   */
  async build(): Promise<void> {
    console.log(`[VectorStore] Building catalog: ${MOVIE_CATALOG.length} movies...`);

    // Extract all descriptions for batch embedding (one API call, not N calls)
    const descriptions = MOVIE_CATALOG.map(m => m.description);
    const vectors = await embeddingService.embedBatch(descriptions);

    // Pair each movie with its embedding vector
    this.catalog = MOVIE_CATALOG.map((movie, i) => ({
      ...movie,
      vector: vectors[i],
    }));

    this.isReady = true;
    console.log(`[VectorStore] ✅ Catalog ready — ${this.catalog.length} movies embedded.`);
  }

  /**
   * PHASE 2, STEP 1 — COMPARE
   *
   * Score every movie in the catalog against the provided query vector
   * using cosine similarity, then sort descending (most similar first).
   *
   * @param queryVector   Embedding of the user's query or source movie
   * @param excludeId     Movie to exclude from results (used for "similar to X")
   * @returns             Scored and sorted list of movies
   */
  findSimilar(queryVector: number[], excludeId?: string): ScoredMovie[] {
    this.assertReady();

    return this.catalog
      .filter(movie => movie.id !== excludeId)
      .map(movie => ({
        movie,
        // COMPARE: Cosine similarity between query vector and movie vector
        score: cosineSimilarity(queryVector, movie.vector!),
      }))
      .sort((a, b) => b.score - a.score); // RANK: highest similarity first
  }

  /**
   * Look up a movie by its ID.
   */
  getById(id: string): Movie | undefined {
    return this.catalog.find(m => m.id === id);
  }

  /**
   * Return all movies (without their internal vectors).
   */
  getAllMovies(): Movie[] {
    return this.catalog;
  }

  status(): CatalogStatus {
    return {
      totalMovies: MOVIE_CATALOG.length,
      embeddedMovies: this.catalog.filter(m => m.vector !== undefined).length,
      isReady: this.isReady,
    };
  }

  private assertReady(): void {
    if (!this.isReady) {
      throw new Error(
        'VectorStore is not ready. Call build() first or wait for startup to complete.'
      );
    }
  }
}

// ─── Cosine Similarity ────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 *
 * Measures the angle between the vectors — ignores magnitude entirely.
 * This is exactly what we want for text embeddings: two semantically
 * identical texts may produce vectors of different magnitudes but they
 * should point in the same direction.
 *
 * Formula: cos(θ) = (A · B) / (|A| × |B|)
 *
 * Output range: -1.0 (opposite) to +1.0 (identical)
 * In practice for text:  0.0 (unrelated) to 1.0 (very similar)
 *
 * @see Chapter 05 of the lecture notes for full explanation
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  // Single loop — compute all three values together for efficiency
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0; // Guard against zero-vectors

  return dotProduct / magnitude;
}

// Singleton — one store shared across the application
export const vectorStore = new VectorStore();
```

---

## 2. Block-by-Block Explanation

### Part A: The `VectorStore` class

#### Block 1: State

```typescript
export class VectorStore {
  private catalog: Movie[] = [];
  private isReady = false;
```

Two pieces of private state:

- **`catalog`** starts empty. It becomes the *embedded* catalog after `build()`, where every entry includes a `vector`.
- **`isReady`** is a guard flag. It prevents requests from scoring against an empty or partially built catalog.

Both are `private`, so no route can mutate them directly. All access goes through methods.

#### Block 2: `build()` — REPRESENT + STORE

```typescript
async build(): Promise<void> {
  console.log(`[VectorStore] Building catalog: ${MOVIE_CATALOG.length} movies...`);

  const descriptions = MOVIE_CATALOG.map(m => m.description);
  const vectors = await embeddingService.embedBatch(descriptions);

  this.catalog = MOVIE_CATALOG.map((movie, i) => ({
    ...movie,
    vector: vectors[i],
  }));

  this.isReady = true;
  console.log(`[VectorStore] ✅ Catalog ready — ${this.catalog.length} movies embedded.`);
}
```

This is the entire precomputation phase.

1. **Extract descriptions** — only the semantic field is sent to the model.
2. **One batch call** — `embedBatch()` handles both live and mock modes. This is the expensive step; it happens once at startup, not per request.
3. **Pair movie with vector** — the spread `...movie` copies the source object, then `vector: vectors[i]` attaches the embedding. The source `MOVIE_CATALOG` objects are **not** mutated. Index alignment is guaranteed because `embedBatch()` returns vectors in input order.
4. **Flip the readiness flag** — only after the new catalog is fully assigned. If the embedding call throws, `isReady` stays `false` and the process fails during bootstrap rather than serving half-built data.

The assignment is atomic from the perspective of single-threaded JavaScript: no request handler can observe a partially filled `catalog`, because the event loop does not interleave synchronous code.

#### Block 3: `findSimilar()` — COMPARE + RANK

```typescript
findSimilar(queryVector: number[], excludeId?: string): ScoredMovie[] {
  this.assertReady();

  return this.catalog
    .filter(movie => movie.id !== excludeId)
    .map(movie => ({
      movie,
      score: cosineSimilarity(queryVector, movie.vector!),
    }))
    .sort((a, b) => b.score - a.score);
}
```

The method is a three-stage pipeline:

| Stage | Method | Purpose |
| :--- | :--- | :--- |
| Filter | `.filter(movie => movie.id !== excludeId)` | Remove the source movie for “similar to X” |
| Compare | `.map(... cosineSimilarity ...)` | Score each remaining movie |
| Rank | `.sort((a, b) => b.score - a.score)` | Descending order — highest similarity first |

**Why `excludeId` is optional.** Semantic search has no source movie, so it passes nothing and the filter keeps everything. Similar-movie requests pass the current movie's ID so the engine never recommends the movie the user is already watching.

**Why `movie.vector!` uses a non-null assertion.** `Movie.vector` is optional in the type because a raw catalog entry has no vector. Inside `findSimilar()`, `assertReady()` has already guaranteed that `build()` ran, and `build()` assigns a vector to every entry. The `!` tells the compiler what the invariant already guarantees at runtime. A stricter alternative would be a separate `EmbeddedMovie` type (`Movie & { vector: number[] }`), which is what a production codebase would likely use.

**Why sort the whole list?** Ranking must consider every candidate, so the full `O(N log N)` sort is appropriate for 18 movies. At millions of vectors, a bounded heap or an approximate-nearest-neighbour index replaces this.

**The method does not slice.** It returns all scored candidates. Choosing `topN` is an orchestration concern, handled in Chapter 06. This keeps the store reusable for callers that need different limits.

#### Block 4: Lookup helpers

```typescript
getById(id: string): Movie | undefined {
  return this.catalog.find(m => m.id === id);
}

getAllMovies(): Movie[] {
  return this.catalog;
}
```

- `getById()` returns `undefined` when the ID is absent; the service converts that into a 404.
- `getAllMovies()` returns the internal array by reference. The service immediately maps it through `toMovieResponse()`, so vectors never reach the client. Returning the reference is cheap but means callers must not mutate it; a defensive copy (`[...this.catalog]`) would be safer if this grew beyond a demo.

#### Block 5: Status and readiness guard

```typescript
status(): CatalogStatus {
  return {
    totalMovies: MOVIE_CATALOG.length,
    embeddedMovies: this.catalog.filter(m => m.vector !== undefined).length,
    isReady: this.isReady,
  };
}

private assertReady(): void {
  if (!this.isReady) {
    throw new Error(
      'VectorStore is not ready. Call build() first or wait for startup to complete.'
    );
  }
}
```

- `totalMovies` uses the **source** catalog length, so it is correct even before the build finishes.
- `embeddedMovies` counts entries that actually carry a vector.
- `isReady` exposes the flag for observability.
- `assertReady()` turns a programming error (querying before build) into a clear exception instead of silently returning `[]` or `NaN` scores.

---

### Part B: `cosineSimilarity()`

#### Block 1: The formula in code

```typescript
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}
```

The mathematical definition is:

```text
cos(θ) = (A · B) / (‖A‖ × ‖B‖)
```

The loop computes all three quantities in **one pass**:

| Accumulator | Update | Meaning |
| :--- | :--- | :--- |
| `dotProduct` | `+= a[i] * b[i]` | `A · B` — directional agreement |
| `magA` | `+= a[i] * a[i]` | `‖A‖²` — squared length of A |
| `magB` | `+= b[i] * b[i]` | `‖B‖²` — squared length of B |

Then `Math.sqrt(magA) * Math.sqrt(magB)` takes the square roots once, at the end. Taking a square root inside the loop would be needlessly expensive.

#### Block 2: Guards

```typescript
if (a.length !== b.length) {
  throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
}
```

Cosine similarity is undefined for vectors of different lengths. Throwing is better than silently comparing the first `min(a.length, b.length)` components, which would produce a plausible but meaningless score. This guard catches a serious bug: mixing embeddings from two different models (for example `text-embedding-3-small` at 1536 dimensions with `text-embedding-ada-002` at 1536 — same here, but other models differ) or mixing mock vectors (128) with live vectors (1536).

```typescript
if (magnitude === 0) return 0;
```

If either vector is all zeros, its length is zero and division would produce `NaN`. Returning `0` defines “no directional information” as “no similarity”, which is a safe, sortable value.

#### Block 3: What the score means

| Score | Interpretation |
| :--- | :--- |
| `+1.0` | Same direction — semantically equivalent for the model |
| `0.0` | Orthogonal — no shared direction |
| `-1.0` | Opposite directions |
| `NaN` (prevented) | Zero-magnitude vector |

For real text embeddings, negative scores are rare and near-zero scores mean “unrelated”. The ranking only depends on relative order, so the absolute scale is less important than consistency.

#### Block 4: Why not Euclidean distance?

Euclidean distance measures the straight-line gap:

```text
d(A, B) = √Σ(aᵢ − bᵢ)²
```

It is sensitive to **magnitude**. A long, detailed movie description and a short query can produce vectors that point in nearly the same direction but have different lengths. Euclidean distance would call them far apart; cosine similarity calls them close, because it divides out the lengths.

| Metric | Sensitive to magnitude? | Range | Good for |
| :--- | :--- | :--- | :--- |
| Dot product | Yes | Unbounded | When magnitude carries meaning |
| Euclidean distance | Yes | `0 → ∞` (lower is better) | Geometric distance in a fixed space |
| **Cosine similarity** | **No** | `-1 → +1` | **Text embeddings, semantic closeness** |

For text, direction encodes meaning and length is mostly an artefact of wording and sentence length. That is why cosine is the default choice in this codebase.

#### Block 5: Complexity

For `N` movies and `D` dimensions:

| Phase | Time | Space |
| :--- | :--- | :--- |
| `build()` | `O(N × D)` to copy/attach + API time | `O(N × D)` for stored vectors |
| `findSimilar()` | `O(N × D)` to score + `O(N log N)` to sort | `O(N)` for the scored array |

With `N = 18` and `D = 1536`, scoring is about 27,000 multiply-add operations — trivial. At `N = 1,000,000`, a linear scan per query becomes expensive, which is why production systems use approximate nearest-neighbour indexes (HNSW, IVF, ScaNN). The API shape would stay the same; only the store implementation would change.

#### Block 6: Singleton

```typescript
export const vectorStore = new VectorStore();
```

One store is shared by the recommendation service and the routes. `server.ts` calls `vectorStore.build()` exactly once before listening. The exported `VectorStore` class allows an isolated instance in tests.

#### Block 7: In-memory trade-off

The catalog lives in process memory. Consequences:

- **Fast** — no network hop per comparison.
- **Volatile** — a restart rebuilds embeddings (and re-bills the API in live mode).
- **Per-process** — two server instances each hold their own copy.

A production version would persist vectors in Postgres with `pgvector`, Pinecone, Qdrant, or Weaviate. The lecture deliberately keeps this in memory so the *math* is visible.

---

## 3. Verification

### Build

```bash
npm run build
```

### Mathematical sanity check

```bash
npx tsx -e "import { cosineSimilarity } from './src/services/vector.store.ts'; console.log(cosineSimilarity([1,0],[1,0])); console.log(cosineSimilarity([1,0],[0,1])); console.log(cosineSimilarity([1,0],[-1,0])); console.log(cosineSimilarity([0,0],[1,0]));"
```

Expected:

```text
1
0
-1
0
```

This proves identical, orthogonal, opposite, and zero-vector behaviour in one command.

### Dimension guard

```bash
npx tsx -e "import { cosineSimilarity } from './src/services/vector.store.ts'; try { cosineSimilarity([1,2],[1]); } catch (e) { console.log((e as Error).message); }"
```

Expected:

```text
Vector dimension mismatch: 2 vs 1
```

### Catalog readiness

Start the server and query the status endpoint:

```bash
npm run dev
curl http://localhost:3008/api/movies/status
```

Expected:

```json
{"totalMovies":18,"embeddedMovies":18,"isReady":true}
```

---

**Next:** [Chapter 06 — Recommendation Service: Orchestration](./06_Recommendation_Service_Orchestration.md)
