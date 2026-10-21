# Chapter 06: Vector Stores

> **Chapter Goal:** Define the smallest surface the rest of the system needs from "the vector database", implement it exactly in memory, and implement the same surface against a managed index. Swapping them must be a configuration change, not a rewrite.

> **Lecture mapping:** Notes Chapter 05 — namespaces, top-K queries, filters, delete-by-source, and the difference between an index you own and one you rent.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/store/vector-store.ts` | 155 | Interface plus the exact-cosine in-memory implementation. |
| `src/store/factory.ts` | 36 | Chooses the store at boot; loads the persisted index. |
| `src/store/pinecone.store.ts` | 98 | The managed adapter, same interface. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run ingest
ls -lh data/index.json          # the persisted index (~19 records)
npm run ask -- "What is the refund window for apparel?"

VECTOR_STORE=pinecone npm run ask -- "anything"   # without a key:
# Error: PINECONE_API_KEY is required when VECTOR_STORE=pinecone.
```

The failure happens at boot, before any request. A store that cannot connect should stop the process, not fail the third customer of the day.

---

## 2. The Interface and the In-Memory Store — `src/store/vector-store.ts`

#### 📄 `src/store/vector-store.ts`

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cosineSimilarity } from '../lib/vectors.js';
import type { IndexRecord, Match } from '../types/rag.types.js';

/**
 * The only surface the rest of the code needs from "the vector database".
 *
 * Chapter 05 in one interface: upsert, query with a top-K, delete by source so
 * removed documents stop being retrievable, and a count so `/health` can prove
 * the index is not empty.
 */
export interface VectorFilter {
  source?: string;
}

export interface VectorQuery {
  vector: readonly number[];
  topK: number;
  filter?: VectorFilter;
}

export interface VectorStore {
  readonly name: string;
  upsert(records: readonly IndexRecord[]): Promise<number>;
  query(request: VectorQuery): Promise<Match[]>;
  deleteBySource(source: string): Promise<number>;
  count(): Promise<number>;
  /** Optional: only stores that can enumerate sources support orphan cleanup. */
  listSources?(): Promise<string[]>;
}

interface Snapshot {
  version: 1;
  model: string;
  dimensions: number;
  records: IndexRecord[];
}

/**
 * Exact cosine search over an in-memory map, persisted to one JSON file.
 *
 * At a few thousand chunks this is faster than a network round trip, which is
 * exactly why it is the default here. The interface is the same one the Pinecone
 * adapter implements, so switching is a config change.
 */
export class MemoryVectorStore implements VectorStore {
  readonly name = 'memory';

  private readonly records = new Map<string, IndexRecord>();
  private readonly indexPath: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(config: { indexPath: string; model: string; dimensions: number }) {
    this.indexPath = config.indexPath;
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  /** Reload the persisted index. A model or dimension change invalidates it. */
  async load(): Promise<number> {
    let snapshot: Snapshot;

    try {
      snapshot = JSON.parse(await readFile(this.indexPath, 'utf8')) as Snapshot;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 0;
      console.warn(`[store] ignoring unreadable index at ${this.indexPath}: ${String(error)}`);
      return 0;
    }

    if (snapshot.model !== this.model || snapshot.dimensions !== this.dimensions) {
      console.warn(
        `[store] index was built with ${snapshot.model}/${snapshot.dimensions} dims, ` +
          `config says ${this.model}/${this.dimensions} — re-ingesting.`,
      );
      return 0;
    }

    for (const record of snapshot.records) this.records.set(record.id, record);
    return this.records.size;
  }

  async upsert(records: readonly IndexRecord[]): Promise<number> {
    for (const record of records) {
      if (record.vector.length !== this.dimensions) {
        throw new Error(
          `Record ${record.id} has ${record.vector.length} dimensions, index expects ${this.dimensions}.`,
        );
      }
      this.records.set(record.id, record);
    }

    await this.persist();
    return records.length;
  }

  async query({ vector, topK, filter }: VectorQuery): Promise<Match[]> {
    const scored: Match[] = [];

    for (const record of this.records.values()) {
      if (filter?.source && record.source !== filter.source) continue;
      const { vector: stored, ...chunk } = record;
      scored.push({ ...chunk, score: cosineSimilarity(vector, stored) });
    }

    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, topK);
  }

  async deleteBySource(source: string): Promise<number> {
    let removed = 0;

    for (const [id, record] of this.records) {
      if (record.source === source) {
        this.records.delete(id);
        removed++;
      }
    }

    if (removed > 0) await this.persist();
    return removed;
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async listSources(): Promise<string[]> {
    return [...new Set([...this.records.values()].map((record) => record.source))].sort();
  }

  async clear(): Promise<void> {
    this.records.clear();
    await this.persist();
  }

  /** Write to a temp file, then rename: a crash never leaves a truncated index. */
  private async persist(): Promise<void> {
    const snapshot: Snapshot = {
      version: 1,
      model: this.model,
      dimensions: this.dimensions,
      records: [...this.records.values()],
    };

    await mkdir(path.dirname(this.indexPath), { recursive: true });
    const temporaryPath = `${this.indexPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
    await rename(temporaryPath, this.indexPath);
  }
}
```

**Block by block:**

- **`VectorFilter`** — one field today (`source`). It exists as a type so the interface already has a place for the tenant/ACL filter that chapter 05 of the notes insists must live *inside* retrieval, not after it.
- **`VectorStore`** — five methods. `upsert` (idempotent write), `query` (ranked read), `deleteBySource` (forget a document), `count` (prove the index is not empty), and an **optional** `listSources` for orphan cleanup. Optional because a managed store may not be able to enumerate sources cheaply.
- **`MemoryVectorStore.records`** — a `Map<string, IndexRecord>`. Insertion order is stable, which makes the persisted JSON diffable and the demo reproducible.
- **`load()`** — three outcomes, all explicit:
  - `ENOENT` → `0` records, normal first run.
  - Unparseable JSON → warn and continue empty. A corrupt cache must not prevent boot; the next ingest rewrites it.
  - **Model or dimension mismatch** → warn and return `0`. This is the important one: loading 512-dim vectors into a 1024-dim configuration would produce `NaN`-adjacent garbage scores.
- **`upsert()` dimension guard** — throws on the first record whose vector length disagrees with the index. A guard at the boundary is worth more than a check at every comparison.
- **`query()`** — destructures the record to drop `vector` from the returned `Match`. The caller never sees 1,024 floats it does not need, and the payload stays small in logs and JSON responses.
- **`filter?.source`** — applied *before* scoring, which is both faster and safer than filtering results afterwards.
- **`deleteBySource()`** — iterates the map and deletes matches, then persists once. This is what stops an edited document from leaving orphan chunks behind (see chapter 12).
- **`listSources()`** — a sorted, deduplicated set. Sorted for deterministic reporting.
- **`persist()`** — writes `${path}.tmp` then `rename`s it. `rename` is atomic on POSIX, so a crash mid-write leaves the previous index intact instead of a truncated file.
- **The snapshot header** — `{ version, model, dimensions, records }`. Even the file format records the embedding contract.

---

## 3. The Factory — `src/store/factory.ts`

#### 📄 `src/store/factory.ts`

```ts
import { MemoryVectorStore } from './vector-store.js';
import type { VectorStore } from './vector-store.js';

export interface VectorStoreConfig {
  kind: 'memory' | 'pinecone';
  indexPath: string;
  model: string;
  dimensions: number;
  pinecone?: { apiKey?: string; indexName: string; namespace: string };
}

/**
 * Pick the store at boot, never at request time.
 *
 * A store that is unavailable should stop the process, not fail the third
 * customer question of the day.
 */
export async function createVectorStore(config: VectorStoreConfig): Promise<VectorStore> {
  if (config.kind === 'pinecone') {
    const { PineconeVectorStore } = await import('./pinecone.store.js');
    return PineconeVectorStore.connect(
      config.pinecone ?? { indexName: 'shop-support', namespace: 'policies' },
    );
  }

  const store = new MemoryVectorStore({
    indexPath: config.indexPath,
    model: config.model,
    dimensions: config.dimensions,
  });

  const loaded = await store.load();
  if (loaded > 0) console.log(`[store] loaded ${loaded} records from ${config.indexPath}`);

  return store;
}
```

**Block by block:**

- **`VectorStoreConfig`** — everything the choice needs, in one object: kind, path, model, dimensions, Pinecone coordinates.
- **The lazy `import('./pinecone.store.js')`** — the Pinecone SDK is only loaded when `VECTOR_STORE=pinecone`. A memory-backed deployment never pays its import cost, and a missing optional dependency cannot break the offline path.
- **`MemoryVectorStore` + `load()` at boot** — the store is hydrated before the first request, so a cold start either has an index or knows it has none. Loading lazily on first query would put disk I/O on the customer's critical path.
- **The boot log** — `[store] loaded N records from …`. One line that answers "did my index survive the restart?".

---

## 4. The Managed Adapter — `src/store/pinecone.store.ts`

#### 📄 `src/store/pinecone.store.ts`

```ts
import type { Pinecone as PineconeClient } from '@pinecone-database/pinecone';

import type { IndexRecord, Match } from '../types/rag.types.js';
import type { VectorQuery, VectorStore } from './vector-store.js';

const UPSERT_BATCH = 100;

/**
 * The managed path: same interface as `MemoryVectorStore`, different machine.
 *
 * The namespace is the tenant/domain boundary. A query that forgets it searches
 * every namespace, which is how one customer's documents end up in another
 * customer's answer — so the namespace is set once, in the constructor.
 */
export class PineconeVectorStore implements VectorStore {
  readonly name = 'pinecone';

  private constructor(
    private readonly client: PineconeClient,
    private readonly indexName: string,
    private readonly namespace: string,
  ) {}

  static async connect(config: {
    apiKey?: string;
    indexName: string;
    namespace: string;
  }): Promise<PineconeVectorStore> {
    if (!config.apiKey) throw new Error('PINECONE_API_KEY is required for VECTOR_STORE=pinecone.');

    // Imported lazily so the in-memory path never pays for the SDK at boot.
    const { Pinecone } = await import('@pinecone-database/pinecone');
    return new PineconeVectorStore(new Pinecone({ apiKey: config.apiKey }), config.indexName, config.namespace);
  }

  async upsert(records: readonly IndexRecord[]): Promise<number> {
    const index = this.index();

    for (let start = 0; start < records.length; start += UPSERT_BATCH) {
      await index.upsert({
        records: records.slice(start, start + UPSERT_BATCH).map((record) => ({
          id: record.id,
          values: record.vector,
          metadata: {
            text: record.text,
            source: record.source,
            section: record.section,
            chunkIndex: record.chunkIndex,
            tokens: record.tokens,
          },
        })),
      });
    }

    return records.length;
  }

  async query({ vector, topK, filter }: VectorQuery): Promise<Match[]> {
    const response = await this.index().query({
      vector: [...vector],
      topK,
      includeMetadata: true,
      ...(filter?.source ? { filter: { source: { $eq: filter.source } } } : {}),
    });

    return response.matches.flatMap((match) => {
      const metadata = match.metadata;
      if (!metadata || typeof metadata.text !== 'string') return [];

      return [
        {
          id: match.id,
          // Pinecone returns cosine similarity directly for a cosine index.
          score: match.score ?? 0,
          text: metadata.text,
          source: String(metadata.source ?? 'unknown'),
          section: String(metadata.section ?? ''),
          chunkIndex: Number(metadata.chunkIndex ?? 0),
          tokens: Number(metadata.tokens ?? 0),
        },
      ];
    });
  }

  async deleteBySource(source: string): Promise<number> {
    await this.index().deleteMany({ filter: { source: { $eq: source } } });
    return 1;
  }

  async count(): Promise<number> {
    const stats = await this.client.index(this.indexName).describeIndexStats();
    return stats.namespaces?.[this.namespace]?.recordCount ?? 0;
  }

  private index() {
    return this.client.index(this.indexName).namespace(this.namespace);
  }
}
```

**Block by block:**

- **`import type { Pinecone as PineconeClient }`** — a *type-only* import. It is erased at compile time, so the SDK is never loaded by the memory path.
- **Private constructor + static `connect()`** — a `PineconeVectorStore` can only exist if the SDK loaded and the client was constructed successfully. There is no half-built state.
- **The namespace is set once, in the constructor** — `index(name).namespace(ns)`. A query that forgets the namespace searches everything, which is how one tenant's documents end up cited in another tenant's answer.
- **`upsert({ records: [...] })`** — the v9 client takes an options object, not a bare array. Batches of 100 keep failures small.
- **Metadata mapping** — `text`, `source`, `section`, `chunkIndex`, `tokens`. The chunk text lives in metadata because the vector alone cannot be turned back into a quotable passage. `section` is what makes the citation readable.
- **`query({ vector, topK, includeMetadata: true })`** — `includeMetadata` is not optional in practice: without it the response has ids and scores but no text to put in the prompt.
- **`filter: { source: { $eq: … } }`** — Pinecone's filter language, server-side. Filtering after the call would still leak forbidden text into your process.
- **`flatMap` + metadata guard** — a match without `text` is dropped rather than rendered as `undefined` in a prompt. Defensive, because metadata is user-writable.
- **`deleteMany({ filter })`** — deletes every chunk of one source. Returns `1` because the API does not report a count; the contract only needs "it happened".
- **`count()`** — `describeIndexStats().namespaces[ns].recordCount`. `/health` uses it to prove the index is not empty.
- **`index()`** — one private accessor so the namespace can never be applied inconsistently.

### Memory vs managed

| Concern | `MemoryVectorStore` | `PineconeVectorStore` |
| :--- | :--- | :--- |
| Search | Exact cosine, `O(N × D)` per query | ANN inside the service |
| Persistence | One JSON file, atomic rename | The service |
| Scale | Thousands of chunks | Millions |
| Filtering | In-process | Server-side, indexed metadata |
| Cold start | Disk read at boot | Network round trip per query |
| Failure mode | Process memory | Timeouts, rate limits, outages |
| Use it for | Learning, tests, CI, small corpora | Production |

The interface is identical on purpose. Swapping stores is a config change; the retriever, the service and the prompt builder do not know which one they are talking to.

### What the interface deliberately omits

- **Hybrid search** — implemented in the retriever (chapter 07), so it works with either store.
- **Reranking** — a separate stage that takes matches and returns fewer matches.
- **Transactions** — not needed: ingestion is idempotent and retryable.
- **Namespaces as a parameter** — the Pinecone adapter binds the namespace at construction, because a per-request namespace is an authorisation decision disguised as a parameter.

---

## 5. Verify the Chapter

```bash
npm run ingest
cat data/index.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['model'], d['dimensions'], len(d['records']))"
# mock-hash-v1 1024 19

npm run ask -- "What is the refund window for apparel?"
# [trace] candidates=12 matches=3 …
```

`candidates=12` proves the retriever asked for `topK × 3`. `matches=3` proves the floor dropped the rest.

**Next:** [Chapter 07 — Retrieval and Hybrid Scoring](./07_Retrieval_and_Hybrid_Scoring.md)
