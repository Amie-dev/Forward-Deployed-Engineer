# Chapter 04: Embedding Service — REPRESENT

> **Chapter Goal:** Implement the **REPRESENT** step: turn arbitrary text into a fixed-size numeric vector. Wrap the OpenAI Embeddings API behind a small class, batch the catalog for efficiency, and provide a deterministic offline fallback so the whole pipeline can run without a key.

> **Lecture mapping:** Notes Chapters 01 (what an embedding is), 02 (embedding model ≠ chat model), and 03 (precompute stable data).

> **Files covered:**

| File | Lines | Purpose |
| :--- | :--- | :--- |
| `src/services/embedding.service.ts` | 93 | `embed()`, `embedBatch()`, deterministic mock vectors, singleton export |

---

## 1. Complete Source Code

### 📄 `src/services/embedding.service.ts` (93 lines)

```typescript
import OpenAI from 'openai';
import { env, isLiveOpenAIEnabled } from '../config/env.js';

/**
 * EmbeddingService — wraps the OpenAI Embeddings API.
 *
 * Concepts from the notes implemented here:
 *   - Embedding Model: text → fixed-size vector
 *   - The model is NOT a chatbot — it only returns numerical representations
 *   - Uses text-embedding-3-small by default: fast, cheap, 1536 dimensions
 */
export class EmbeddingService {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    this.model = env.EMBEDDING_MODEL;
  }

  /**
   * Convert a single piece of text into an embedding vector.
   *
   * This is the REPRESENT step of: REPRESENT → STORE → COMPARE → RANK
   *
   * @param text  Any natural language string (movie description, user query)
   * @returns     A fixed-size array of numbers encoding the semantic meaning
   */
  async embed(text: string): Promise<number[]> {
    if (!isLiveOpenAIEnabled()) {
      // Mock mode — return deterministic fake vector for development without API key
      console.warn('[EmbeddingService] MOCK MODE — returning stub vector (set OPENAI_API_KEY for real embeddings)');
      return this.mockVector(text);
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      encoding_format: 'float',
    });

    return response.data[0].embedding;
  }

  /**
   * Batch-embed multiple texts in a single API call.
   *
   * The OpenAI Embeddings API natively supports batch input — much more
   * efficient than calling embed() in a loop.
   *
   * Used during Phase 1 (catalog precomputation) to process all movies at once.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!isLiveOpenAIEnabled()) {
      console.warn('[EmbeddingService] MOCK MODE — returning stub vectors for batch');
      return texts.map(t => this.mockVector(t));
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      encoding_format: 'float',
    });

    // The API returns embeddings in the same order as input texts
    return response.data
      .sort((a, b) => a.index - b.index)
      .map(item => item.embedding);
  }

  /**
   * Deterministic mock vector for development without an API key.
   * Generates a normalized pseudo-random vector seeded by the input text.
   * NOT semantically meaningful — only for testing the pipeline without costs.
   */
  private mockVector(text: string): number[] {
    const dim = 128; // Smaller for mock — real is 1536
    let seed = text.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);

    const raw = Array.from({ length: dim }, () => {
      // Simple LCG pseudo-random seeded by text content
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return ((seed >>> 0) / 0xffffffff) * 2 - 1; // Range: -1 to 1
    });

    // L2-normalize so cosine similarity works correctly
    const magnitude = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
    return raw.map(v => v / magnitude);
  }
}

// Singleton — one client shared across the app
export const embeddingService = new EmbeddingService();
```

---

## 2. Block-by-Block Explanation

### Block 1: Imports

```typescript
import OpenAI from 'openai';
import { env, isLiveOpenAIEnabled } from '../config/env.js';
```

- `OpenAI` is the official SDK class. The default import works because Express/OpenAI ship CommonJS and `esModuleInterop` is enabled.
- `env` supplies the key and model.
- `isLiveOpenAIEnabled()` decides whether to call the network or return mock data.

Notice what is **not** imported: no Express, no `Request`, no `Response`. This layer knows nothing about HTTP, which is what makes it reusable from a CLI, a job queue, or a test.

### Block 2: Class fields and constructor

```typescript
export class EmbeddingService {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    this.model = env.EMBEDDING_MODEL;
  }
```

- **`private readonly`** means the fields cannot be reassigned after construction. The SDK client is expensive to create (it owns a connection pool), so it is created once.
- The client is constructed even in mock mode. This is harmless: `new OpenAI()` performs no network I/O and accepts the placeholder key. It keeps the constructor branch-free.
- Storing `model` separately avoids reading `env` on every request and makes the dependency obvious.

### Block 3: `embed()` — the REPRESENT operation

```typescript
async embed(text: string): Promise<number[]> {
  if (!isLiveOpenAIEnabled()) {
    console.warn('[EmbeddingService] MOCK MODE — returning stub vector (set OPENAI_API_KEY for real embeddings)');
    return this.mockVector(text);
  }

  const response = await this.client.embeddings.create({
    model: this.model,
    input: text,
    encoding_format: 'float',
  });

  return response.data[0].embedding;
}
```

The method has two completely different execution paths behind one signature:

| Condition | Path | Result |
| :--- | :--- | :--- |
| No usable key | `mockVector(text)` | Deterministic 128-dim vector |
| Usable key | `client.embeddings.create` | Real 1536-dim vector |

Key details:

- **`input: text`** accepts a single string. The API also accepts an array; that is what `embedBatch()` uses.
- **`encoding_format: 'float'`** requests plain JSON numbers. The alternative (`base64`) is more compact on the wire but requires decoding; floats are clearer for a learning project.
- **`response.data[0].embedding`** — for a single input the response contains one item. The SDK types it as `Embedding[]`, so index `0` is safe here by construction.
- **Called per search request** — the query is *changing data*, so it cannot be precomputed.

The return type is `Promise<number[]>`, not `Float32Array`. A plain array is simpler to serialise, compare, and inspect. Production vector stores often use typed arrays for memory efficiency.

---

### Block 4: `embedBatch()` — one call for the whole catalog

```typescript
async embedBatch(texts: string[]): Promise<number[][]> {
  if (!isLiveOpenAIEnabled()) {
    console.warn('[EmbeddingService] MOCK MODE — returning stub vectors for batch');
    return texts.map(t => this.mockVector(t));
  }

  const response = await this.client.embeddings.create({
    model: this.model,
    input: texts,
    encoding_format: 'float',
  });

  // The API returns embeddings in the same order as input texts
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(item => item.embedding);
}
```

This is the method used by `vectorStore.build()`.

**Why batch?** The Embeddings API accepts a list of strings in a single request. Embedding 18 descriptions one by one would mean 18 network round trips, 18 authentication checks, and 18 opportunities for a transient failure. One batch call is dramatically cheaper and faster.

**Why sort by `index`?** The API documents that responses contain an `index` field. Sorting by it guarantees that `result[i]` corresponds to `texts[i]`, even if the provider returns items out of order. The code then maps to just the vectors, discarding the index. Without this step, a movie could silently receive another movie's vector — a bug that is almost impossible to notice from similarity scores alone.

**Why map mock vectors in order?** `texts.map(...)` preserves order by definition, so the mock path is consistent with the live path.

**Shape check:** `texts: string[]` → `Promise<number[][]>`. The outer array length always equals `texts.length`; every inner array has the same dimension (128 in mock mode, 1536 with `text-embedding-3-small`).

### Block 5: `mockVector()` — deterministic offline embedding

```typescript
private mockVector(text: string): number[] {
  const dim = 128; // Smaller for mock — real is 1536
  let seed = text.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);

  const raw = Array.from({ length: dim }, () => {
    // Simple LCG pseudo-random seeded by text content
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1; // Range: -1 to 1
  });

  // L2-normalize so cosine similarity works correctly
  const magnitude = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map(v => v / magnitude);
}
```

This is **not** a semantic embedding. It is a deterministic pseudo-random vector used only to exercise the pipeline.

1. **Seed from content** — summing character codes gives the same text the same starting seed every run. Identical queries therefore produce identical vectors, which makes debugging reproducible.
2. **Linear Congruential Generator (LCG)** — `seed = (seed * 1664525 + 1013904223) & 0xffffffff` is a classic PRNG. The bitwise `&` keeps the value in 32-bit range. `(seed >>> 0)` reinterprets it as unsigned before normalising to `[0, 1]`; multiplying by 2 and subtracting 1 yields `[-1, 1]`.
3. **L2 normalisation** — divide every component by the vector's Euclidean length so the resulting vector has magnitude `1`. This is not strictly required for cosine similarity (which divides by magnitudes anyway), but it keeps mock vectors well-scaled and avoids a zero-magnitude edge case.

Because the vectors are random, a “space” query will **not** rank space movies first in mock mode. The endpoint still returns a valid, sorted list — the math runs, the semantics do not.

### Block 6: Singleton export

```typescript
export const embeddingService = new EmbeddingService();
```

One instance is shared by the vector store and recommendation service. Benefits:

- The OpenAI client (and its connection pool) is created once.
- Configuration is read once.
- Tests can import the same object and observe consistent behaviour.

The class is exported as well, so a test could instantiate an isolated service if needed.

---

## 3. Why This Is an Embedding Model, Not an LLM

| Property | Embedding model (this file) | Generative LLM |
| :--- | :--- | :--- |
| Input | Text | Text (messages) |
| Output | Fixed-length `number[]` | Generated tokens |
| Purpose | Represent meaning | Produce language |
| Deterministic | Yes (same input → same vector) | No (sampling, temperature) |
| Used at request time | Search query only | Not used in this codebase |
| Cost driver | Input tokens | Input + output tokens |

The service never asks the model to “recommend” anything. It asks for coordinates. The recommendation decision is made later by cosine similarity.

---

## 4. Verification

### Build

```bash
npm run build
```

Expected: no errors.

### Mock-mode smoke test

```bash
npx tsx -e "import { embeddingService } from './src/services/embedding.service.ts'; const v = await embeddingService.embed('astronaut stranded on Mars'); console.log(v.length, v.slice(0, 3)); const w = await embeddingService.embed('astronaut stranded on Mars'); console.log('deterministic:', JSON.stringify(v) === JSON.stringify(w));"
```

Expected:

```text
[EmbeddingService] MOCK MODE — returning stub vector (set OPENAI_API_KEY for real embeddings)
128 [ ...three numbers... ]
deterministic: true
```

### Live-mode check

With a real key in `.env`:

```bash
npx tsx -e "import { embeddingService } from './src/services/embedding.service.ts'; const v = await embeddingService.embed('astronaut stranded on Mars'); console.log(v.length);"
```

Expected: `1536` for `text-embedding-3-small`.

### Batch-order check

```bash
npx tsx -e "import { embeddingService } from './src/services/embedding.service.ts'; const vs = await embeddingService.embedBatch(['space survival','romantic tragedy']); console.log(vs.length, vs[0].length, vs[1].length);"
```

Expected: `2 128 128` in mock mode (or `2 1536 1536` live).

---

**Next:** [Chapter 05 — Vector Store & Cosine Similarity](./05_Vector_Store_and_Cosine_Similarity.md)
