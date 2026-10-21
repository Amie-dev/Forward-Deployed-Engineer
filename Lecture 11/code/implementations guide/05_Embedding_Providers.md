# Chapter 05: Embedding Providers

> **Chapter Goal:** Turn text into vectors through one narrow contract, with a deterministic offline provider for learning and a real model behind the same interface. Everything that must stay consistent between ingestion and query time lives here.

> **Lecture mapping:** Notes Chapter 04 — the embedding space contract, model choice, dimensions, symmetric vs asymmetric encoding, normalisation, and why the model is part of the schema.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/embeddings/provider.ts` | 33 | Interface, task type, and the factory. |
| `src/embeddings/mock.provider.ts` | 61 | Deterministic hash embeddings, offline. |
| `src/embeddings/openai.provider.ts` | 57 | Official SDK, batched, retried. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run ingest                    # mock embeddings, no key
npm run ingest                    # second run: same ids, same count (idempotent)

EMBEDDING_DIMENSIONS=512 npm run ingest   # rebuilds at a new dimension
EMBEDDING_DIMENSIONS=1024 npm run ask -- "What is the refund window for apparel?"
# [store] index was built with mock-hash-v1/512 dims, config says mock-hash-v1/1024 — re-ingesting.
```

That warning is the contract enforcing itself: an index is only valid for the model **and** the dimension that built it.

---

## 2. The Contract — `src/embeddings/provider.ts`

#### 📄 `src/embeddings/provider.ts`

```ts
import { MockEmbeddingProvider } from './mock.provider.js';
import { OpenAiEmbeddingProvider } from './openai.provider.js';

/**
 * `document` vs `query` is not cosmetic: some models are trained with different
 * prefixes for each side, and mixing them silently costs recall.
 */
export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** One vector per input, in input order. */
  embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]>;
}

export interface EmbeddingProviderConfig {
  provider: 'openai' | 'mock';
  model: string;
  dimensions: number;
  apiKey?: string;
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider(config);
    case 'openai':
      return new OpenAiEmbeddingProvider(config);
  }
}
```

**Block by block:**

- **`EmbeddingTask`** — `'document' | 'query'`. Not every provider needs it (OpenAI ignores it), but the type forces the caller to say which side of the search it is on. Models trained with asymmetric prefixes silently lose recall when a query is embedded as a document.
- **`EmbeddingProvider`** — four readonly fields and one method. `dimensions` is part of the interface, not a hidden constant, because the store, the config and `/health` all need it.
- **`embed(texts, task)`** — batch-first. Embedding one string at a time is the most common performance mistake in RAG ingestion: 19 chunks become 19 HTTP calls instead of one.
- **`createEmbeddingProvider`** — an exhaustive `switch` over the provider union. Adding a provider is a compile error until the switch handles it, which is the cheapest way to keep a factory honest.

---

## 3. The Offline Provider — `src/embeddings/mock.provider.ts`

#### 📄 `src/embeddings/mock.provider.ts`

```ts
import { contentWords } from '../lib/text.js';
import { normalise } from '../lib/vectors.js';
import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/**
 * Deterministic, offline, zero-cost embeddings.
 *
 * This is NOT a semantic model. It hashes words, character trigrams and word
 * bigrams into a fixed space, so texts that share vocabulary land close
 * together. That is enough to exercise ingestion, retrieval, citations and
 * evaluation with no API key, and it makes demos reproducible.
 *
 * Never ship this. It has no idea that "return" and "refund" are related.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model: string;
  readonly dimensions: number;

  constructor(config: { model?: string; dimensions: number }) {
    if (config.dimensions < 8) throw new Error('Mock embeddings need at least 8 dimensions.');
    this.model = config.model ?? 'mock-hash-v1';
    this.dimensions = config.dimensions;
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = contentWords(text);

    for (let position = 0; position < tokens.length; position++) {
      const token = tokens[position];
      this.addFeature(vector, token, 1);

      // A short prefix groups simple morphology: refund/refunds, ship/shipping.
      // Full trigrams were tried first and made unrelated text look similar.
      this.addFeature(vector, `~${token.slice(0, 5)}`, 0.5);

      const next = tokens[position + 1];
      if (next) this.addFeature(vector, `${token}_${next}`, 0.6);
    }

    return normalise(vector);
  }

  private addFeature(vector: number[], feature: string, weight: number): void {
    const hash = fnv1a(feature);
    const index = hash % this.dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }
}

/** FNV-1a: small, fast and stable across processes. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
```

**Block by block:**

- **Why it exists** — every later chapter needs embeddings to test retrieval, citations, refusal and evaluation. Requiring an API key for that would make the whole guide conditional on a billing account.
- **`contentWords(text)`** — stopwords removed. "what / is / the / for" appear in every sentence; leaving them in made every chunk look equally similar to every question, and the offline scores were unusable.
- **Word feature (weight 1)** — the base signal: exact vocabulary overlap.
- **Prefix feature (`~token.slice(0,5)`, weight 0.5)** — cheap morphology: `refund`/`refunds`, `ship`/`shipping`, `day`/`days`.
- **Bigram feature (`token_next`, weight 0.6)** — phrase sensitivity, so "refund window" scores above two unrelated occurrences of the same words.
- **`fnv1a` + signed bucket** — a stable 32-bit hash mapped into `[0, dimensions)` with a random sign. Signing stops collisions from systematically inflating similarity.
- **`normalise(vector)`** — unit length, so cosine is a dot product and no magnitude effect survives.
- **The honest disclaimer** — it has no idea that "return" and "refund" are related. It is a lexical model wearing a vector's clothes. Chapter 07 shows what that costs and what it buys.

### What was tried and removed

The first version also hashed every character trigram of every word. It matched morphology nicely — and made *unrelated* text look similar, because short trigrams collide across a 1,024-dimension space. With trigrams, "Can I pay with Bitcoin?" scored 0.13 against a warranty chunk; without them it scores 0.08, and the refusal threshold becomes reliable. That trade is recorded in the code comment: **fewer features, cleaner separation.**

---

## 4. The Real Provider — `src/embeddings/openai.provider.ts`

#### 📄 `src/embeddings/openai.provider.ts`

```ts
import OpenAI from 'openai';

import { withRetry } from '../lib/retry.js';
import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/** The embeddings endpoint accepts up to 2048 inputs per call; 100 keeps failures small. */
const BATCH_SIZE = 100;

/**
 * OpenAI embeddings.
 *
 * `dimensions` is sent on every call, at ingestion and at query time. If those
 * two numbers ever disagree, the query vector cannot be compared with the index
 * and the failure is a dimension-mismatch error at best, silently wrong results
 * at worst.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;

  private readonly client: OpenAI;

  constructor(config: { apiKey?: string; model: string; dimensions: number }) {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is required for the openai embedding provider.');
    }

    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);

      const response = await withRetry(
        () =>
          this.client.embeddings.create({
            model: this.model,
            input: [...batch],
            dimensions: this.dimensions,
            encoding_format: 'float',
          }),
        {
          attempts: 3,
          onRetry: (error, attempt) =>
            console.warn(`[embedding] attempt ${attempt} failed: ${describe(error)}`),
        },
      );

      for (const item of response.data) vectors.push(item.embedding);
    }

    return vectors;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

**Block by block:**

- **`BATCH_SIZE = 100`** — the endpoint accepts up to 2,048 inputs per call. A hundred keeps a failed batch small and the request body well under any limit.
- **Constructor guard** — refusing to construct without a key turns a runtime 401 into a boot-time error.
- **`dimensions` is sent on every request** — this is the Matryoshka truncation parameter. The model returns exactly this many floats, so ingestion and query cannot drift apart as long as both read the same config.
- **`encoding_format: 'float'`** — explicit, because the alternative (`base64`) would need decoding and buys nothing here.
- **`withRetry`** — 429 and 5xx are retried with jitter; a 400 is not. The `onRetry` hook logs the attempt, which is how you discover that your rate limit is 3 req/s and not 3,000.
- **The append loop** — the API returns `data[]` in input order, but the code appends explicitly rather than trusting index alignment across batches.
- **`_task`** — unused, and the underscore says so. If this were a model with task prefixes (Gemini, Cohere, some open models), this parameter would carry them.

---

## 5. The Contract, in One Table

| Must match between ingestion and query | Where it is enforced |
| :--- | :--- |
| Model name | `env.EMBEDDING_MODEL`, recorded in the index snapshot |
| Dimensions | `env.EMBEDDING_DIMENSIONS`, checked by the store and by `cosineSimilarity` |
| Normalisation | providers return unit vectors; the store still computes true cosine |
| Preprocessing | one `normaliseText` at load time, applied to corpus and queries |
| Task side | `embed(texts, 'document')` vs `embed([question], 'query')` |
| Distance metric | cosine, fixed by the store |

Change any row and the old index is no longer valid. That is not a bug to work around — it is why re-indexing is a first-class operation (chapter 12) rather than an afterthought.

### Cost of getting it wrong

| Mistake | What you observe |
| :--- | :--- |
| Query embedded with a different model | Scores near zero, everything refused |
| Dimension mismatch | Thrown error at the store, or at the cosine guard |
| Query embedded without the query prefix | Recall drops 5–15 points, silently |
| Documents embedded **with** the query prefix | Same, in the other direction |
| Metric changed to dot without normalising | Long documents dominate every result |

The first two are loud. The last three are why the evaluation harness in chapter 13 exists.

---

## 6. Verify the Chapter

```bash
npm run ingest
# [ingest] store=memory documents=3 chunks=19 tokens=870 31ms
```

Then check the snapshot records both the model and the dimensions:

```bash
head -c 90 data/index.json
# {"version":1,"model":"mock-hash-v1","dimensions":1024,"records":[…
```

With a key, the same command produces `"model":"text-embedding-3-small"` — same code path, different space.

**Next:** [Chapter 06 — Vector Stores](./06_Vector_Stores.md)
