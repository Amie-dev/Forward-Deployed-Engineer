# Chapter 04: Indexing — Embeddings and the Vector Store

> **Chapter Goal:** Turn chunks into a queryable index without losing the metadata that makes
> them filterable. Two things are being built here: the *string* that gets embedded, and the
> *store* that scans it — including the difference between filtering during the scan and
> filtering after it.

> **Lecture mapping:** Notes Chapters 02–03 (what gets embedded) and 05 (what a store must be
> able to do). The score floor is deliberately *not* here; it belongs to Chapter 05, because
> it is calibrated rather than configured.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/embeddings.ts` | 150 | `hash` (offline) and `openai` providers behind one interface |
| `src/ingest/indexer.ts` | 167 | chunk → contextualise → embed → blend → records, with stats |
| `src/store/vector-store.ts` | 88 | cosine search with pre- and post-filtering |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- chunks detail              # what gets embedded, per chunk
EMBEDDING_PROVIDER=openai npm run cli -- chunks   # same pipeline, real vectors
npm run dev & curl -s localhost:3100/health       # index stats as the API sees them
```

---

## 2. Embedding Providers — `src/embeddings.ts`

```ts
import { contentWords } from './lib/text.js';
import { normalise } from './lib/vectors.js';

/**
 * Embeddings behind one narrow interface.
 *
 * Two implementations, and the difference is the whole lesson of Chapter 03:
 *  - `HashEmbeddingProvider` is deterministic and offline. It hashes words,
 *    five-character prefixes and bigrams into a fixed space, so documents that
 *    share vocabulary land close together. It is NOT semantic — it does not know
 *    that "refund" and "return" are related — which is exactly why the pipeline
 *    has to earn its quality with chunking, filters, hybrid search and reranking.
 *  - `OpenAiEmbeddingProvider` is the real thing, called over plain `fetch` so
 *    the request is visible instead of hidden in an SDK.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash';
  readonly model: string;
  readonly dimensions: number;

  constructor(config: { model?: string; dimensions: number }) {
    if (config.dimensions < 8) throw new Error('Hash embeddings need at least 8 dimensions.');
    this.model = config.model ?? 'hash-1024-v1';
    this.dimensions = config.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = contentWords(text);

    for (let position = 0; position < tokens.length; position++) {
      const token = tokens[position];
      this.addFeature(vector, token, 1);

      // A five-character prefix groups simple morphology: refund/refunds,
      // ship/shipping, deliver/delivered.
      this.addFeature(vector, `~${token.slice(0, 5)}`, 0.8);

      // Character 4-grams catch the rest of it: "delivered" and "delivery" share
      // most of their 4-grams even though no prefix rule connects them. This is
      // the cheapest known substitute for a real semantic model, and it is what
      // makes the offline arm of the ablation usable at all.
      if (token.length >= 7) {
        for (let start = 0; start + 4 <= token.length; start++) {
          this.addFeature(vector, `#${token.slice(start, start + 4)}`, 0.3);
        }
      }

      const next = tokens[position + 1];
      if (next) this.addFeature(vector, `${token}_${next}`, 0.6);
    }

    return normalise(vector);
  }

  /** Signed feature hashing: one index, one sign, no collisions map to a bias. */
  private addFeature(vector: number[], feature: string, weight: number): void {
    const hash = fnv1a(feature);
    const index = hash % this.dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;

  constructor(private readonly options: { apiKey: string; model: string; dimensions: number }) {
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  /**
   * Batched on purpose. Embedding APIs bill and rate-limit per request, so a
   * 5,000-chunk ingestion must not become 5,000 HTTP calls.
   */
  async embed(texts: readonly string[]): Promise<number[][]> {
    const output: number[][] = [];

    for (let start = 0; start < texts.length; start += 64) {
      const batch = texts.slice(start, start + 64);
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI embeddings failed (${response.status}): ${await response.text()}`);
      }

      const payload = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
      for (const item of payload.data.sort((a, b) => a.index - b.index)) {
        output.push(normalise(item.embedding));
      }
    }

    return output;
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

export interface EmbeddingConfig {
  provider: 'hash' | 'openai';
  model: string;
  dimensions: number;
  openaiApiKey?: string;
}

export function createEmbeddings(config: EmbeddingConfig): EmbeddingProvider {
  if (config.provider === 'openai') {
    if (!config.openaiApiKey) throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY.');
    return new OpenAiEmbeddingProvider({
      apiKey: config.openaiApiKey,
      model: config.model,
      dimensions: config.dimensions,
    });
  }

  return new HashEmbeddingProvider({ model: config.model, dimensions: config.dimensions });
}
```

**Block by block:**

- **`EmbeddingProvider` is three fields and one method**: `name`, `model`, `dimensions`,
  `embed(texts)`. Nothing above this interface knows which provider is running, which is what
  makes the entire guide reproducible offline.
- **`HashEmbeddingProvider` is signed feature hashing over four feature families**: the word
  itself, its five-character stem, its character 4-grams, and the word bigram. Each feature
  is hashed to an index and a sign, so collisions cancel instead of accumulating a bias.
- **The weights encode the priority**: word `1.0` > stem `0.8` > bigram `0.6` > 4-gram
  `0.3`. The 4-grams exist because `delivered` and `delivery` share most of them even though
  no prefix rule connects them. This is the cheapest known substitute for a semantic model,
  and without it the dense arm of the ablation is unusable.
- **`OpenAiEmbeddingProvider` batches 64 texts per request and sorts the response by index.**
  Batching is not an optimisation: a 5,000-chunk ingestion must not become 5,000 HTTP calls.
  Sorting matters because the API does not promise response order, and a mis-ordered vector
  silently attaches the wrong embedding to the wrong chunk.
- **Every vector is normalised on the way in**, so cosine and dot product agree and the
  numbers in the trace are comparable.
- **`createEmbeddings` is the only place that knows about keys.** A missing key for an
  explicitly requested provider throws; the `auto` resolution happened back in `env.ts`.

---

## 3. The Indexer — `src/ingest/indexer.ts`

```ts
import { countTokens } from '../lib/text.js';
import { blend, normalise } from '../lib/vectors.js';
import type { EmbeddingProvider } from '../embeddings.js';
import { contextualize, embedText, type ContextMode } from './context.js';
import { chunkFixed, findOrphans } from './fixed-chunker.js';
import { chunkSemantic } from './semantic-chunker.js';
import { chunkStructural } from './structural-chunker.js';
import { MemoryVectorStore } from '../store/vector-store.js';
import type { Chunk, IndexRecord, SourceDocument } from '../types.js';

/**
 * Ingestion: documents in, a queryable index out.
 *
 * The order is fixed and every step is observable, because "the index is bad" is
 * never actionable on its own:
 *
 *   chunk → add context → build the embedding text → embed → (optional) blend in
 *   document context → store with metadata
 *
 * The one non-obvious step is the optional blend (`lateChunkAlpha`). Late chunking
 * in the literature embeds the whole document with a long-context model and then
 * pools token vectors per chunk, so a chunk's vector literally contains its
 * neighbours. We cannot do that through an embeddings API, which only returns one
 * vector per input. The approximation here — a weighted blend of the child vector
 * with the document mean — buys most of the effect on a small corpus and is honest
 * about what it is.
 */

export interface IndexOptions {
  strategy: 'fixed' | 'structural' | 'semantic';
  chunkSize: number;
  chunkOverlap: number;
  chunkUnit: 'tokens' | 'chars';
  parentMaxTokens: number;
  minChunkTokens: number;
  contextualize: ContextMode;
  lateChunkAlpha: number;
  semanticThreshold: number;
  embeddings: EmbeddingProvider;
  openaiApiKey?: string;
  chatModel: string;
}

export interface IndexStats {
  documents: number;
  chunks: number;
  tokens: number;
  averageTokens: number;
  orphans: number;
  storageMultiplier: number;
  dimensions: number;
  embedMs: number;
  strategy: IndexOptions['strategy'];
  contextualized: number;
}

export interface BuiltIndex {
  store: MemoryVectorStore;
  records: IndexRecord[];
  stats: IndexStats;
}

export async function buildIndex(docs: readonly SourceDocument[], options: IndexOptions): Promise<BuiltIndex> {
  const startedAt = performance.now();

  // 1. Chunk. Every strategy produces the same `Chunk` shape, so everything
  //    downstream is strategy-agnostic — that is what makes the ablation possible.
  const rawChunks: Chunk[] = [];
  for (const doc of docs) {
    if (options.strategy === 'fixed') {
      rawChunks.push(
        ...chunkFixed(doc, { size: options.chunkSize, overlap: options.chunkOverlap, unit: options.chunkUnit }),
      );
    } else if (options.strategy === 'semantic') {
      rawChunks.push(
        ...(await chunkSemantic(doc, options.embeddings, {
          maxTokens: options.chunkSize,
          threshold: options.semanticThreshold,
          minTokens: 60,
        })),
      );
    } else {
      rawChunks.push(
        ...chunkStructural(doc, {
          size: options.chunkSize,
          overlap: options.chunkOverlap,
          parentMaxTokens: options.parentMaxTokens,
          minTokens: options.minChunkTokens,
        }),
      );
    }
  }

  // 2. Situate each chunk in its document (Chapter 03).
  const docsBySource = new Map(docs.map((doc) => [doc.source, doc]));
  const chunks = await contextualize(rawChunks, docsBySource, {
    mode: options.contextualize,
    apiKey: options.openaiApiKey,
    model: options.chatModel,
  });

  // 3. Embed one string per chunk — the same string the retriever will search.
  const texts = chunks.map((chunk) => embedText(chunk));
  const vectors = await options.embeddings.embed(texts);

  // 4. Optional document-context blend.
  const documentVectors = options.lateChunkAlpha > 0 ? meanBySource(chunks, vectors) : new Map<string, number[]>();

  const records: IndexRecord[] = chunks.map((chunk, index) => {
    const own = vectors[index] ?? [];
    const documentVector = documentVectors.get(chunk.source);
    const vector = documentVector ? blend(own, documentVector, options.lateChunkAlpha) : normalise(own);

    return { ...chunk, embedText: texts[index] ?? '', vector };
  });

  const tokens = records.reduce((sum, record) => sum + record.tokens, 0);
  const documentTokens = docs.reduce((sum, doc) => sum + countTokens(doc.text), 0);

  return {
    store: new MemoryVectorStore(records, {
      model: options.embeddings.model,
      dimensions: options.embeddings.dimensions,
    }),
    records,
    stats: {
      documents: docs.length,
      chunks: records.length,
      tokens,
      averageTokens: records.length === 0 ? 0 : Math.round(tokens / records.length),
      orphans: findOrphans(records).length,
      storageMultiplier: documentTokens === 0 ? 0 : Number((tokens / documentTokens).toFixed(2)),
      dimensions: options.embeddings.dimensions,
      embedMs: Math.round(performance.now() - startedAt),
      strategy: options.strategy,
      contextualized: records.filter((record) => Boolean(record.contextPrefix)).length,
    },
  };
}

/** One vector per document: the mean of its chunk vectors, re-normalised. */
function meanBySource(chunks: readonly Chunk[], vectors: readonly number[][]): Map<string, number[]> {
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();

  chunks.forEach((chunk, index) => {
    const vector = vectors[index];
    if (!vector) return;

    const current = sums.get(chunk.source);
    if (!current) {
      sums.set(chunk.source, [...vector]);
      counts.set(chunk.source, 1);
      return;
    }

    for (let position = 0; position < current.length; position++) current[position] += vector[position];
    counts.set(chunk.source, (counts.get(chunk.source) ?? 0) + 1);
  });

  const means = new Map<string, number[]>();
  for (const [source, sum] of sums) {
    const count = counts.get(source) ?? 1;
    means.set(source, normalise(sum.map((value) => value / count)));
  }
  return means;
}
```

**Block by block:**

- **The order is fixed and each step is observable**: chunk → add context → build the
  embedding text → embed → optionally blend document context → store with metadata. "The
  index is bad" is never actionable on its own; "the index has 27 chunks, 0 orphans and 1.14
  storage" is.
- **`buildIndex` is strategy-agnostic.** All three chunkers produce the same `Chunk` shape, so
  everything downstream — context, embedding, BM25, filtering, reranking — is shared. That is
  what makes the ablation a config change rather than three code paths.
- **`contextualize` runs before embedding**, which is the whole point of Chapter 03's prefix:
  the prefix has to be inside the embedded string to affect retrieval.
- **`meanBySource` + `blend` implement late chunking, approximated.** The document vector is
  the re-normalised mean of its chunk vectors; `lateChunkAlpha` (0.25 by default) mixes it
  into each child. Set `LATE_CHUNK_ALPHA=0` to disable. The real technique pools token
  vectors from a long-context model; this is the honest version of what an embeddings API
  allows.
- **`IndexStats` is the alertable surface**: documents, chunks, tokens, average tokens,
  orphans, storage multiplier, dimensions, embed time, strategy, and how many chunks got a
  context prefix. If ingestion runs nightly, this is what you compare.
- **`MemoryVectorStore` is constructed with the model and dimensions** so the store can refuse
  a vector of the wrong shape later.


---

## 4. The Store — `src/store/vector-store.ts`

```ts
import { cosine } from '../lib/vectors.js';
import type { DenseCandidate, DocMeta, IndexRecord } from '../types.js';

/**
 * An in-memory vector store, small enough to read in one sitting.
 *
 * It has exactly the two behaviours this lecture needs to demonstrate:
 *
 *  - **Pre-filtering.** The predicate runs during the scan, so the K results are
 *    the best K *eligible* results. This is what a real database does when it can
 *    push the filter into the index.
 *  - **Post-filtering.** The predicate runs after the top-K, which is what happens
 *    when a system retrieves first and filters second. `mode: 'post'` exists so the
 *    guide can show the failure instead of describing it: with a restrictive filter
 *    the result set collapses to zero even though matching documents exist.
 */

export interface VectorQuery {
  vector: readonly number[];
  topK: number;
  predicate?: (meta: DocMeta) => boolean;
  mode?: 'pre' | 'post';
}

export interface VectorQueryResult {
  hits: DenseCandidate[];
  /** Records examined by the scan — the number that decides your latency. */
  scanned: number;
  /** Records that passed the predicate before ranking. */
  eligible: number;
}

export class MemoryVectorStore {
  readonly model: string;
  readonly dimensions: number;
  private readonly records: IndexRecord[];

  constructor(records: readonly IndexRecord[], meta: { model: string; dimensions: number }) {
    this.records = [...records];
    this.model = meta.model;
    this.dimensions = meta.dimensions;
  }

  get size(): number {
    return this.records.length;
  }

  all(): readonly IndexRecord[] {
    return this.records;
  }

  query({ vector, topK, predicate, mode = 'pre' }: VectorQuery): VectorQueryResult {
    const accept = predicate ?? (() => true);

    if (mode === 'post') {
      const ranked = this.records
        .map((record) => this.score(record, vector))
        .sort((left, right) => right.score - left.score)
        .slice(0, topK);

      return {
        hits: ranked.filter((hit) => accept(hit.chunk.meta)),
        scanned: this.records.length,
        eligible: this.records.filter((record) => accept(record.meta)).length,
      };
    }

    const hits: DenseCandidate[] = [];

    for (const record of this.records) {
      if (!accept(record.meta)) continue;
      hits.push(this.score(record, vector));
    }

    hits.sort((left, right) => right.score - left.score);

    return {
      hits: hits.slice(0, topK),
      scanned: this.records.length,
      eligible: hits.length,
    };
  }

  private score(record: IndexRecord, query: readonly number[]): DenseCandidate {
    const { vector, embedText: _embedText, ...chunk } = record;
    return { chunk, score: cosine(query, vector), origin: 'dense', vector };
  }
}
```

**Block by block:**

- **`VectorQuery` carries `predicate` and `mode`.** The predicate is compiled by the caller
  (Chapter 06) and the mode decides *when* it runs — which is the most important design
  decision in this file.
- **`mode: 'pre'`** filters during the scan: only eligible records are scored, so the top-K
  are the best K *eligible* results. This is what a real database does when it can push the
  filter into the index.
- **`mode: 'post'`** scores everything first, takes the top-K, then filters. It exists so the
  failure can be *shown* rather than described: with a narrow filter the result set collapses
  to zero even though matching documents exist. Chapter 06 runs both and prints the counts.
- **`eligible` is returned separately from `hits`.** When a filtered query returns nothing,
  the first question is whether the filter excluded everything (eligible 0) or the scores
  were all below the floor (eligible > 0, hits 0). Those are different bugs.
- **`score` strips `vector` and `embedText` from the returned chunk** with a destructuring
  pattern, so a scored chunk is small and serialisable. The vector is re-attached only for
  `DenseCandidate`, which MMR needs.
- **`scanned` is reported** because that is the number that decides latency when the corpus
  grows. An exact scan over 27 chunks is fine; the same code over 5 million is a decision you
  make with your eyes open.

---

## 5. What to Take Away

- **The embedded string is a design artefact, not an implementation detail.** Context, then
  breadcrumb, then body — and store it on the record so you can inspect it later.
- **Batch your embedding calls, and sort the responses.** Both are one-liners; both are
  silent-corruption bugs if omitted.
- **Normalise once, at the boundary.** Every comparison downstream then means the same thing.
- **Late chunking is a blend, and it is labelled as an approximation.** Do not claim a
  technique you did not implement.
- **Pre-filter, not post-filter.** The store supports both so the difference is visible, but
  only one of them is correct.
- **Return `eligible` and `scanned`.** When a query returns nothing, those two numbers tell you
  which kind of nothing it is.

> **Where This Goes Next:** [Chapter 05](./05_TopK_Thresholds_and_Calibration.md) uses the
> store's scores to answer two questions the store deliberately does not: how many results to
> ask for, and how good a result has to be.

