# Chapter 00: Overview, Provider Structure & File Map

> **Chapter Goal:** Understand the shape of the codebase before reading a single algorithm. Know which layer owns which decision, how an embedding provider plugs in, and how a request travels from text to ranked records.

> **Lecture mapping:** all chapters. This is the map; Chapters 01–10 are the territory.

> **Files covered:**

| File | Purpose |
| :--- | :--- |
| `package.json` | Dependencies owned by the project: Express, Zod, OpenAI SDK, Qdrant client, `pg`, TypeScript tooling. |
| `tsconfig.json` | Strict ES2022/NodeNext compilation. |
| `.env.example` | Every environment variable, with safe offline defaults. |
| `src/**` | The 39 source files, grouped by responsibility. |

---

## 1. What This Codebase Builds

Lecture 10 answers one question: **how do you store and retrieve vectors at scale?**

The code implements the full retrieval path, in the order the notes teach it:

```text
text ──► embedding ──► record ──► index ──► query ──► filter ──► rescore ──► ranked hits
```

It deliberately stops there. There is no prompt, no LLM call, no generated answer. Chapter 09 of the notes calls this the retrieval half of RAG; Lecture 11 owns the generation half.

The answer layer is not hidden in a helper — it does not exist.

---

## 2. The Four Design Decisions

### 2.1 One score contract

Every metric is normalized to **higher-is-better**:

| Metric | Internal score | Native `distance` |
| :--- | :--- | :--- |
| `cosine` | cosine similarity | `1 - cosine` |
| `dot` | dot product | `-dot` |
| `euclid` | `-distance` | Euclidean distance |
| `manhattan` | `-distance` | Manhattan distance |

This removes the most common retrieval bug: one endpoint sorts ascending because it uses a distance, while another sorts descending because it uses a similarity. All indexes use the same convention.

### 2.2 Typed arrays at the core

`Vector = Float32Array`. Embeddings are float32 in every real provider. A `Float32Array` uses 4 bytes per dimension and gives the JIT a predictable, contiguous loop. JSON `number[]` exists only at the HTTP boundary.

### 2.3 Indexes are snapshots

The in-memory store is the source of truth. An index is built from a snapshot of that store:

```text
write → store mutates → index cache cleared → next ANN query rebuilds
```

That is not how Qdrant or pgvector work — they maintain indexes incrementally. It is how a teaching implementation can stay small and correct while still exposing the real trade-off.

### 2.4 Providers are adapters

The store knows nothing about OpenAI, Gemini, or hashing. It knows `EmbeddingService`. The service knows `EmbeddingProvider`. Only the provider file knows an SDK.

That boundary is what lets every chapter run offline with the mock provider and still use a real model in one environment change.

---

## 3. Complete File Tree

```text
Lecture 10/code/
├── package.json                 # dependencies + scripts
├── tsconfig.json                # strict ES2022 / NodeNext
├── .env.example                 # provider, metric, index, Qdrant, pgvector
├── .gitignore
├── README.md                    # codebase guide and measured results
├── test-requests.http           # every endpoint, ready for REST Client
├── implementations guide/       # this guide (00 → 10)
└── src/
    ├── server.ts                # load env → provider → store → seed → listen
    ├── app.ts                   # Express app, health, 404, error mapping
    ├── config/
    │   └── env.ts               # Zod-validated, fail-fast configuration
    ├── types/
    │   └── vector.types.ts      # Metric, Vector, records, filters, index configs
    ├── lib/
    │   ├── async.ts             # bounded-concurrency map, sleep
    │   ├── errors.ts            # HttpError, BadRequest, NotFound, Unavailable
    │   ├── heap.ts              # generic binary heap
    │   ├── http.ts              # asyncHandler for Express
    │   ├── rng.ts               # seeded mulberry32
    │   └── topk.ts              # bounded top-K collector
    ├── core/
    │   ├── metrics.ts           # dot, cosine, L2, L1, norms, score contract
    │   ├── exact-knn.ts         # brute-force ground truth
    │   ├── kmeans.ts            # k-means++ + Lloyd
    │   ├── ivf.ts               # inverted lists + nprobe
    │   ├── hnsw.ts              # multi-layer proximity graph
    │   ├── pq.ts                # codebooks, encoding, ADC, rescore
    │   └── evaluation.ts        # recall, precision, MRR, nDCG, percentile
    ├── embeddings/
    │   ├── provider.ts          # interface + factory
    │   ├── mock.provider.ts     # deterministic hash embedding
    │   ├── openai.provider.ts   # official OpenAI SDK
    │   ├── gemini.provider.ts   # Gemini REST, task types, Matryoshka
    │   └── embedding.service.ts # batching, dedupe, LRU cache
    ├── store/
    │   ├── filters.ts           # filter DSL → predicate
    │   ├── vector-store.ts      # CRUD, query, lazy indexes, fallback
    │   └── hybrid.ts            # BM25 + reciprocal rank fusion
    ├── adapters/
    │   ├── qdrant.adapter.ts    # official Qdrant JS client
    │   └── pgvector.adapter.ts  # pg Pool + vector SQL
    ├── routes/
    │   ├── documents.routes.ts  # PUT/batch/GET/DELETE/list
    │   ├── query.routes.ts      # dense, raw-vector, hybrid
    │   └── admin.routes.ts      # stats, index build, seed, reset
    ├── services/
    │   └── seed.service.ts      # embed + upsert the demo corpus
    ├── data/
    │   ├── corpus.ts            # 24 documents with tenant/category/year
    │   └── synthetic.ts         # seeded clustered vectors for tests/bench
    └── scripts/
        ├── verify.ts            # 10 assertions (no services needed)
        ├── demo.ts              # cosine matrix, indexes, filter, hybrid
        ├── benchmark.ts         # build/memory/p50/p95/recall table
        ├── seed.ts              # seed Qdrant or pgvector
        ├── adapter-crud.ts      # real-database CRUD smoke test
        └── check-services.ts    # Qdrant/pgvector connectivity
```

### Why this shape?

| Layer | May depend on | Must not depend on |
| :--- | :--- | :--- |
| `types` | nothing | everything |
| `lib` | types | core/store/adapters |
| `core` | types, lib | store, routes, SDKs |
| `store` | core, types, lib | Express, Qdrant, PostgreSQL |
| `embeddings` | types, lib, provider SDKs | store, routes |
| `adapters` | types, official DB clients | store, core indexes |
| `routes` | store, embeddings, Zod | concrete index classes |
| `scripts` | anything, by design | — |

The dependency direction is the architecture. `core` never imports Express; `store` never imports Qdrant; routes never instantiate `HnswIndex` directly.

---

## 4. Provider Structure — Every File Explained

The embedding subsystem is the best example of the codebase's boundary design.

```text
src/embeddings/
├── provider.ts            ← contract + factory (the only import routes need)
├── mock.provider.ts       ← deterministic, offline, free
├── openai.provider.ts     ← official `openai` SDK
├── gemini.provider.ts     ← REST, task-aware, Matryoshka
└── embedding.service.ts   ← batching + dedupe + LRU cache
```

### `provider.ts` — the contract

```ts
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]>;
}
```

Everything above this interface depends only on these four members. `dimensions` is part of the contract because a collection with fixed dimensions must reject a provider that returns a different width. `task` is part of the contract because retrieval is asymmetric: a stored document and a search query are not the same kind of text.

`createEmbeddingProvider(config)` is a factory:

```ts
switch (config.provider) {
  case 'mock':   return new MockEmbeddingProvider(config.dimensions);
  case 'openai': return new OpenAiEmbeddingProvider(config);
  case 'gemini': return new GeminiEmbeddingProvider(config);
}
```

No caller ever writes `new OpenAiEmbeddingProvider(...)` outside this file. Swapping providers is a configuration change, not a refactor.

### `mock.provider.ts` — the offline provider

It hashes each word and each character trigram into a fixed-width vector with FNV-1a, adds signed weights, then L2-normalizes.

- Same text → same vector, forever.
- Shared vocabulary → positive cosine similarity.
- No network, no key, no cost.
- **It is not a semantic model.** It is a deterministic feature hasher that lets us exercise storage and retrieval.

### `openai.provider.ts` — the SDK provider

- Uses the official `openai` package with `maxRetries: 3`.
- Batches 64 inputs per request and runs at most 4 requests concurrently.
- Sorts the response by `index` before returning, because API order is not a contract.
- Passes `dimensions` only for `text-embedding-3-*` (Matryoshka-capable models).
- Rejects empty strings before spending a request.

### `gemini.provider.ts` — the REST provider

- Calls `batchEmbedContents` with `x-goog-api-key` in a header (not the URL).
- Maps `document` → `RETRIEVAL_DOCUMENT`, `query` → `RETRIEVAL_QUERY`.
- Sends `outputDimensionality` (128–3072) for Matryoshka truncation.
- Batches 100 inputs, concurrency 2.
- Retries 429/5xx with exponential backoff; a 4xx is wrapped in `NonRetryableError` and fails immediately.

### `embedding.service.ts` — the policy layer

The provider is a transport. The service adds the policies every production embedding path needs:

1. **Deduplicate** identical texts inside one batch.
2. **Cache** by `model:task:text` in a small LRU.
3. **Refresh** recency on cache hits.
4. **Fail loudly** if the provider returns the wrong number of vectors.

The cache key includes the model. A model change must not silently reuse vectors from a different coordinate system.

---

## 5. Request Lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant A as Express API
    participant E as EmbeddingService
    participant P as Provider
    participant S as VectorStore
    participant I as ANN index

    C->>A: PUT /api/documents/doc-101 {text, payload}
    A->>E: embedDocuments([text])
    E->>P: embed(texts, "document")
    P-->>E: number[][]
    E-->>A: vector
    A->>S: upsert(record)
    S->>S: clear index cache
    A-->>C: 201 Created

    C->>A: POST /api/query {query, k, index}
    A->>E: embedQuery(query)
    E->>P: embed([query], "query")
    P-->>E: vector
    A->>S: query({vector, k, filter, index})
    S->>I: ensureIndex(config) + search
    I-->>S: candidates
    S-->>A: hits
    A-->>C: {hits, tookMs, exactFallback}
```

Two details are worth noticing now:

- The document path uses `task = document`; the query path uses `task = query`. The mock ignores the difference; Gemini does not.
- A write clears the ANN cache. The next query rebuilds the selected index. This is why the first ANN request after a write is slower.

---

## 6. Project Contract

These three files define how the project is built and configured.

#### 📄 `package.json`

```json
{
  "name": "lecture-10-vector-databases",
  "version": "1.0.0",
  "description": "Lecture 10 — embeddings, similarity metrics, exact KNN, IVF, HNSW, product quantization, a CRUD vector store, and Qdrant/pgvector adapters. Learning-focused, production-shaped TypeScript.",
  "main": "dist/server.js",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "verify": "tsx src/scripts/verify.ts",
    "demo": "tsx src/scripts/demo.ts",
    "bench": "tsx src/scripts/benchmark.ts",
    "services:check": "tsx src/scripts/check-services.ts",
    "seed:qdrant": "tsx src/scripts/seed.ts qdrant",
    "seed:pgvector": "tsx src/scripts/seed.ts pgvector",
    "adapter:crud:qdrant": "tsx src/scripts/adapter-crud.ts qdrant",
    "adapter:crud:pgvector": "tsx src/scripts/adapter-crud.ts pgvector",
    "qdrant:up": "docker run --rm -p 6333:6333 -p 6334:6334 qdrant/qdrant",
    "pgvector:up": "docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17"
  },
  "keywords": [
    "fde",
    "genai",
    "embeddings",
    "vector-database",
    "knn",
    "ivf",
    "hnsw",
    "product-quantization",
    "qdrant",
    "pgvector",
    "typescript"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "@qdrant/js-client-rest": "^1.19.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "openai": "^4.85.4",
    "pg": "^8.13.1",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/node": "^22.13.8",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3"
  }
}
```

**Block by block:**

- `"type": "module"` — every file is an ES module. Imports inside `src/` use `.js` extensions because NodeNext resolves the emitted file, not the TypeScript source.
- `engines.node >= 20` — `AbortSignal.timeout`, `fetch`, and modern `Array.prototype.at` are used without polyfills.
- `scripts` — `dev`, `build`, `start` for normal use; `verify`, `demo`, `bench` for proof; `seed:*` and `adapter:crud:*` for real services.
- `dependencies` — each one earns its place:
  - `express` + `cors` — the HTTP surface.
  - `zod` — request and environment validation with typed output.
  - `openai` — official embeddings SDK.
  - `@qdrant/js-client-rest` — official Qdrant client.
  - `pg` — official PostgreSQL driver.
  - `dotenv` — loads `.env` in development.
- `devDependencies` — `typescript` + `tsx` for execution, and the matching `@types/*` packages.

No vector library is used for IVF/HNSW/PQ. Those are the subject of the lecture, so they are implemented explicitly. The production packages are used where the lecture is about integration, not algorithms: embeddings, Qdrant, PostgreSQL.

#### 📄 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Block by block:**

- `target: ES2022` and `module: NodeNext` — native ESM with top-level `await` available in scripts.
- `strict: true` — no implicit `any`, no unchecked nulls. The algorithms are numeric; strictness catches dimension and index mistakes early.
- `rootDir: src`, `outDir: dist` — `npm run build` emits a runnable `dist/server.js`.
- `declaration: true` + `sourceMap: true` — usable as a library and debuggable in production.
- `skipLibCheck: true` — keeps third-party type noise out of the build without weakening our own code.

#### 📄 `.env.example`

```ini
# ── HTTP ──────────────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# ── Embeddings ────────────────────────────────────────────────────────────────
# mock | openai | gemini
# `mock` is deterministic, offline and free — use it for every chapter demo.
EMBEDDING_PROVIDER=mock
# Leave blank to use the provider default:
#   mock   -> mock-hash-v1 (128 dims)
#   openai -> text-embedding-3-small (1536 dims)
#   gemini -> gemini-embedding-001 (3072 dims; Matryoshka truncation supported)
EMBEDDING_MODEL=
EMBEDDING_DIMENSIONS=128

OPENAI_API_KEY=
GEMINI_API_KEY=

# ── In-memory vector store ────────────────────────────────────────────────────
# cosine | dot | euclid | manhattan
VECTOR_METRIC=cosine
# flat | ivf | hnsw | pq
DEFAULT_INDEX=flat
AUTO_SEED=true

# ── Qdrant (official @qdrant/js-client-rest) ─────────────────────────────────
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=lecture10_documents

# ── pgvector (official pg driver) ─────────────────────────────────────────────
# docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
PGVECTOR_TABLE=lecture10_documents_written_by_me
```

**Block by block:**

- `EMBEDDING_PROVIDER=mock` — the default is offline and free. A missing API key never blocks a learner.
- `EMBEDDING_MODEL` blank — the factory picks the provider default (`mock-hash-v1`, `text-embedding-3-small`, `gemini-embedding-001`).
- `EMBEDDING_DIMENSIONS=128` — deliberately small for the mock; switch to 1536/3072 for real models.
- `VECTOR_METRIC=cosine` — collection-level decision. Changing it requires re-indexing.
- `DEFAULT_INDEX=flat` — exact search first; ANN is opt-in per request or via this variable.
- `AUTO_SEED=true` — loads the 24-document corpus at boot. Set `false` in production.
- `QDRANT_*` and `DATABASE_URL` — only used by the adapter scripts; the in-memory API works without them.

---

## 7. Commands

| Command | What it does | Needs |
| :--- | :--- | :--- |
| `npm install` | Install 128 packages | network |
| `npm run verify` | 10 assertions across metrics, indexes, store, filters, hybrid, cache | nothing |
| `npm run demo` | Cosine matrix, four index results, filter, hybrid | nothing |
| `npm run bench` | Build time, memory, p50/p95, recall@10 | nothing |
| `npm run build` | Strict TypeScript → `dist/` | nothing |
| `npm run dev` | Watch-mode API on `:3000` | nothing |
| `npm start` | Run the compiled `dist/server.js` | `npm run build` |
| `npm run services:check` | Qdrant + pgvector connectivity | Docker services |
| `npm run seed:qdrant` | Create collection, indexes, upsert corpus, query | Qdrant |
| `npm run seed:pgvector` | Create extension/table/index, upsert corpus, query | pgvector |
| `npm run adapter:crud:*` | Upsert → update → filter → delete against a real DB | service |

---

## 8. Reading Order

Read the guide in numeric order if you want the full build. If you are here for one topic:

- **Embeddings / providers** → 01
- **Similarity / ranking** → 02
- **Exact KNN and recall** → 03
- **IVF** → 04
- **HNSW** → 05
- **PQ / compression** → 06
- **CRUD / filters / hybrid** → 07
- **Qdrant** → 08
- **pgvector** → 09
- **HTTP API / proof** → 10

**Next:** [Chapter 01 — Setup, Environment & Embedding Providers](./01_Setup_Environment_and_Embedding_Providers.md)



