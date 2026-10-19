# Lecture 10 — Vector Databases & ANN Codebase

A learning-focused but production-shaped implementation of everything in the Lecture 10 notes:

**embed → store → index → query → filter → rescore → evaluate.**

It implements **no RAG generation**. Retrieval ends at ranked documents; the LLM answer layer belongs to Lecture 11.

---

## What is inside

| Layer | Implementation |
| :--- | :--- |
| Embeddings | Provider contract, deterministic offline mock, OpenAI SDK, Gemini REST, batch + LRU cache |
| Metrics | Cosine, dot, Euclidean, Manhattan, one higher-is-better score contract |
| Exact search | Full-scan KNN with a bounded top-K heap and 100% recall |
| IVF | k-means++ training, Voronoi lists, `nlist`/`nprobe`, tombstones, incremental add |
| HNSW | Level sampling, greedy descent, `efConstruction`/`efSearch`, diversity heuristic, degree pruning |
| PQ | Sub-space codebooks, 8-bit codes, ADC lookup tables, exact rescoring |
| Vector store | Upsert/get/delete/list/query, payload filters, lazy index rebuild, exact fallback |
| Hybrid | BM25 lexical index + reciprocal rank fusion |
| Real databases | Official Qdrant JS client and `pg`/pgvector adapters |
| API | Express + Zod CRUD, query, hybrid, admin index management |
| Proof | `verify.ts` (10 checks), `demo.ts`, `benchmark.ts`, Docker adapter CRUD |

---

## Quick start

```bash
cd "Lecture 10/code"
npm install
cp .env.example .env        # defaults to the free mock provider
npm run verify              # 10 checks, no network or Docker required
npm run demo                # cosine matrix, four indexes, filters, hybrid
npm run bench               # build time, p50/p95, recall@10
npm run dev                 # http://localhost:3000
```

The default configuration uses `EMBEDDING_PROVIDER=mock`, 128 dimensions, cosine, and a 24-document corpus embedded at boot. Nothing external is required.

### Use a real embedding model

```bash
# OpenAI
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=sk-... EMBEDDING_DIMENSIONS=1536 npm run dev

# Gemini
EMBEDDING_PROVIDER=gemini GEMINI_API_KEY=... EMBEDDING_DIMENSIONS=768 npm run dev
```

Changing the provider or dimensions changes the coordinate system. Recreate the collection/table; never mix models in one collection.

### Qdrant

```bash
npm run qdrant:up
npm run seed:qdrant
npm run adapter:crud:qdrant
```

### pgvector

```bash
# 5432 is often already taken; use 5433 locally
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5433:5432 pgvector/pgvector:pg17

DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres npm run seed:pgvector
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres npm run adapter:crud:pgvector
```

---

## API

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/health` | Provider, dimensions, metric, count |
| `PUT` | `/api/documents/:id` | Upsert one document (201 create / 200 update) |
| `POST` | `/api/documents/batch` | Batch upsert (≤128) |
| `GET` | `/api/documents/:id` | Read one; `?includeVector=true` |
| `DELETE` | `/api/documents/:id` | Delete (204 / 404) |
| `GET` | `/api/documents` | List with `limit`, `offset`, `tenant`, `category` |
| `POST` | `/api/query` | Dense or hybrid query; `index`, `filter`, `k`, tuning |
| `POST` | `/api/query/by-vector` | Query with a raw vector (debug / evaluation) |
| `GET` | `/api/admin/stats` | Store and index memory, provider info |
| `POST` | `/api/admin/index` | Build `flat`, `ivf`, `hnsw` or `pq` explicitly |
| `POST` | `/api/admin/seed` | Reload the demo corpus |
| `POST` | `/api/admin/reset` | Clear the in-memory store (non-production) |

Open [`test-requests.http`](./test-requests.http) in VS Code's REST Client, or use curl. See the [end-to-end walkthrough](./implementations%20guide/10_HTTP_API_and_End_to_End_Verification.md) for exact commands and outputs.

### Example

```bash
curl -s -X POST localhost:3000/api/query \
  -H 'content-type: application/json' \
  -d '{"query":"graph based nearest neighbour index","k":3,"index":"hnsw","efSearch":40}'
```

---

## Architecture

```text
HTTP (Express + Zod)
  └── routes: documents · query · admin
        ├── EmbeddingService ── provider: mock | openai | gemini
        ├── VectorStore
        │     ├── filters.ts        payload predicate compiler
        │     ├── flat              exactKnn
        │     ├── ivf               kmeans + inverted lists
        │     ├── hnsw              multi-layer graph
        │     ├── pq                codebooks + ADC + rescore
        │     └── hybrid.ts         BM25 + RRF
        └── adapters: QdrantAdapter · PgVectorAdapter
```

The in-memory indexes are **snapshots**: a write clears the cache and the next ANN query rebuilds lazily. That is deliberate for teaching. Qdrant and pgvector maintain their own indexes incrementally.

---

## Measured results

`npm run verify` on the bundled synthetic dataset (1,200 vectors, 32 dims):

```text
IVF recall@10  = 100.0%   nlist=24, nprobe=4
HNSW recall@10 = 100.0%   M=16, efConstruction=100, efSearch=64
PQ recall@10   = 96.4%    m=8, ksub=64, rescore=40
```

`npm run bench` uses harder queries between clusters (3,000 vectors, 48 dims):

| Index | Build (ms) | Index memory | p50 | Recall@10 |
| :--- | ---: | ---: | ---: | ---: |
| flat (exact) | 0 | 0 KB | ~1 ms | 100% |
| IVF (`nprobe=1`) | ~300 | 22 KB | ~0.3 ms | ~74% |
| HNSW (`efSearch=12`) | ~3,000 | 387 KB | ~0.07 ms | ~83% |
| PQ + rescore 20 | ~660 | 59 KB | ~0.3 ms | ~77% |

Exact numbers vary by machine. The point is the **shape**: ANN trades measurable recall for latency, and PQ trades precision for memory.

---

## Deliberate limitations

- The in-memory store is single-process and rebuilds indexes on writes.
- HNSW deletes are tombstones; compaction is not implemented.
- IVF does not re-train as the distribution drifts.
- PQ training is in-process and synchronous; production trains offline.
- BM25 is rebuilt per hybrid request; production keeps a persistent sparse index.
- No RAG, no LLM generation, no reranker model (Lecture 11).
- No authentication; add auth and tenant enforcement before exposing this API.

---

## Documentation

- 📘 **[Implementation Guide](./implementations%20guide/README.md)** — chapters 00 → 10, full source code and block-by-block explanations.
- 📚 **[Lecture 10 Notes](../notes/README.md)** — theory and diagrams.
- 🧾 **[Complete Notes](../notes/Lecture_10_Complete_Notes.md)** — one-document synthesis.
- 📄 **[Source PDF](../notes/Notes.pdf)** and **[Excalidraw](../notes/Excalidraw-Notes.svg)**.
