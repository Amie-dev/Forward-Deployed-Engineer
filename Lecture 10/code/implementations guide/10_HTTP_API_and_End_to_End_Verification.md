# Chapter 10: HTTP API & End-to-End Verification

> **Chapter Goal:** Expose the retrieval system over HTTP with validated inputs, correct status codes, honest errors and observable timing. Then prove the whole stack with a single `npm run verify`, a demo, a benchmark and a runnable request collection.

> **Lecture mapping:** integrates Notes Chapters 03–09; no new algorithm, only the operational surface.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/lib/errors.ts` | 29 | Errors that carry HTTP status and a stable code. |
| `src/lib/http.ts` | 10 | `asyncHandler` for rejected promises. |
| `src/routes/documents.routes.ts` | 103 | Upsert, batch, get, delete, list. |
| `src/routes/query.routes.ts` | 123 | Dense, raw-vector and hybrid query. |
| `src/routes/admin.routes.ts` | 99 | Stats, index build, seed, reset. |
| `src/app.ts` | 84 | Middleware, health, 404, error mapping. |
| `src/server.ts` | 67 | Boot, seed, eager index, graceful shutdown. |
| `src/scripts/verify.ts` | 211 | 10 assertions across the whole system. |
| `src/scripts/demo.ts` | 91 | Readable end-to-end demonstration. |
| `src/scripts/benchmark.ts` | 154 | Build, memory, p50/p95, recall table. |
| `test-requests.http` | 137 | Every endpoint with example bodies. |

---

## 1. Commands

```bash
npm run verify     # no server, no Docker
npm run build
npm run dev        # or: npm start
npm run demo
npm run bench
```

---

## 2. Errors and Async Plumbing

#### 📄 `src/lib/errors.ts`

```ts
/** Errors that carry an HTTP status, so routes never guess a status code. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, code = 'BAD_REQUEST') {
    super(message, 400, code);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, code = 'SERVICE_UNAVAILABLE') {
    super(message, 503, code);
  }
}
```

**Block by block:**

- **`HttpError`** — message, status and stable `code`. The route layer throws; the error middleware translates. Routes never write error JSON themselves.
- **`BadRequestError` (400)** — invalid input that Zod did not catch (dimension mismatch, unsupported filter operator).
- **`NotFoundError` (404)** — missing id.
- **`ServiceUnavailableError` (503)** — reserved for external dependencies; adapters can throw it when a database is down.

Stable `code` values (`NOT_FOUND`, `BAD_REQUEST`) are what clients branch on. Messages are for humans and may change.

#### 📄 `src/lib/http.ts`

```ts
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wrap async route handlers so rejected promises reach the error middleware. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
```

**Block by block:**

- **`asyncHandler`** — Express 4 does not catch rejected promises from async handlers. Without this wrapper, a thrown `NotFoundError` becomes an unhandled rejection and the request hangs. The wrapper converts the rejection into `next(error)`, which reaches the error middleware.

This is ten lines that prevent the most common Express bug.

---

## 3. Document Routes — `src/routes/documents.routes.ts`

#### 📄 `src/routes/documents.routes.ts`

```ts
import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';
import type { Filter } from '../types/vector.types.js';

const payloadSchema = z.record(z.unknown());
const documentSchema = z.object({
  id: z.string().min(1).max(256),
  text: z.string().min(1).max(20_000),
  payload: payloadSchema.default({}),
});
const singleSchema = documentSchema.omit({ id: true });
const batchSchema = z.object({ documents: z.array(documentSchema).min(1).max(128) });

/**
 * CRUD endpoints. This is where "embedding + storage" meets HTTP:
 * PUT /:id is an upsert (insert or update), DELETE removes, GET reads.
 */
export function createDocumentsRouter(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
): Router {
  const router = Router();

  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = z.string().min(1).max(256).parse(req.params.id);
      const body = singleSchema.parse(req.body);
      const existed = store.has(id);
      const [vector] = await embeddings.embedDocuments([body.text]);
      store.upsert([{ id, vector, payload: body.payload, text: body.text }]);
      res.status(existed ? 200 : 201).json({ id, created: !existed });
    }),
  );

  router.post(
    '/batch',
    asyncHandler(async (req, res) => {
      const body = batchSchema.parse(req.body);
      const vectors = await embeddings.embedDocuments(body.documents.map((document) => document.text));
      const result = store.upsert(
        body.documents.map((document, index) => ({
          id: document.id,
          vector: vectors[index],
          payload: document.payload,
          text: document.text,
        })),
      );
      res.status(201).json(result);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const includeVector = req.query.includeVector === 'true';
      const id = String(req.params.id);
      res.json(store.get(id, includeVector));
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const deleted = store.delete([id]);
      if (deleted === 0) throw new NotFoundError(`Record "${id}" does not exist.`);
      res.status(204).send();
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          tenant: z.string().optional(),
          category: z.string().optional(),
        })
        .parse(req.query);

      const filter: Filter = {};
      if (query.tenant) filter.tenant = query.tenant;
      if (query.category) filter.category = query.category;

      res.json(
        store.list({
          limit: query.limit,
          offset: query.offset,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
        }),
      );
    }),
  );

  return router;
}
```

**Block by block:**

- **Schemas** — id 1..256, text 1..20,000, payload object, batch 1..128. Validation happens before any embedding spend.
- **`singleSchema`** — omits `id` because the id comes from the path; accepting it in the body would allow a mismatch.
- **`PUT /:id`**:
  1. Validate the path id.
  2. Validate the body.
  3. `store.has(id)` decides 201 vs 200.
  4. Embed the document (`task = document`).
  5. Upsert.
  6. Return `{ id, created }`.
- **`POST /batch`**:
  1. Validate up to 128 documents.
  2. **One** `embedDocuments` call for all texts. The provider batches internally.
  3. One `store.upsert`.
  4. Return inserted/updated counts.
  - A batch is dramatically cheaper than 128 PUTs: one embedding call, one write, one response.
- **`GET /:id`** — `?includeVector=true` opts into the float array; default off.
- **`DELETE /:id`** — 204 on success, 404 if nothing was deleted. Both are meaningful; silently returning 204 for a missing id hides bugs.
- **`GET /`** — list with `limit`, `offset`, `tenant`, `category`. The filter is built only from present fields; an empty object would compile to "match everything", which is also correct but less explicit.

### Why PUT for upsert?

`PUT /resource/:id` means "make the resource at this id look like this body". It is idempotent: repeating the same request produces the same state. That matches upsert semantics better than `POST`.

### Why not return the vector by default?

At 1536 dimensions, one row is ~12 KB of JSON. A list of 200 rows would be 2.4 MB of floats the client almost never needs. Opt-in is the correct default.

---

## 4. Query Routes — `src/routes/query.routes.ts`

#### 📄 `src/routes/query.routes.ts`

```ts
import { Router } from 'express';
import { z } from 'zod';
import { Bm25Index, reciprocalRankFusion } from '../store/hybrid.js';
import { compileFilter } from '../store/filters.js';
import { asyncHandler } from '../lib/http.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';
import type { Filter } from '../types/vector.types.js';

const indexSchema = z.enum(['flat', 'ivf', 'hnsw', 'pq']);
const tuningSchema = {
  k: z.number().int().min(1).max(100).default(10),
  index: indexSchema.optional(),
  nprobe: z.number().int().min(1).max(4_096).optional(),
  efSearch: z.number().int().min(1).max(1_000).optional(),
  rescore: z.number().int().min(0).max(500).optional(),
};
const querySchema = z.object({
  query: z.string().min(1).max(4_000),
  filter: z.unknown().optional(),
  hybrid: z.boolean().default(false),
  ...tuningSchema,
});
const vectorQuerySchema = z.object({
  vector: z.array(z.number().finite()).min(1),
  filter: z.unknown().optional(),
  ...tuningSchema,
});

export function createQueryRouter(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = querySchema.parse(req.body);
      const started = performance.now();
      const vector = await embeddings.embedQuery(body.query);
      const filter = body.filter as Filter | undefined;
      const dense = store.query({
        vector,
        k: body.hybrid ? Math.min(100, body.k * 3) : body.k,
        filter,
        index: body.index,
        nprobe: body.nprobe,
        efSearch: body.efSearch,
        rescore: body.rescore,
      });

      if (!body.hybrid) {
        res.json({
          strategy: 'dense',
          query: body.query,
          index: dense.index,
          tookMs: Number((performance.now() - started).toFixed(2)),
          exactFallback: dense.exactFallback,
          hits: dense.hits,
        });
        return;
      }

      const predicate = compileFilter<Record<string, unknown>>(filter);
      const lexical = new Bm25Index(
        store
          .all()
          .filter((record) => record.text && predicate(record.payload))
          .map((record) => ({ id: record.id, text: record.text! })),
      ).search(body.query, Math.min(100, body.k * 3));

      const fused = reciprocalRankFusion(
        [dense.hits.map((hit) => ({ id: hit.id, score: hit.score })), lexical],
        { limit: body.k },
      );
      const byId = new Map(store.all().map((record) => [record.id, record]));

      res.json({
        strategy: 'hybrid',
        fusion: 'rrf',
        query: body.query,
        index: dense.index,
        tookMs: Number((performance.now() - started).toFixed(2)),
        exactFallback: dense.exactFallback,
        hits: fused.map((hit) => {
          const record = byId.get(hit.id)!;
          return {
            id: hit.id,
            score: Number(hit.score.toFixed(6)),
            payload: record.payload,
            text: record.text,
          };
        }),
      });
    }),
  );

  router.post(
    '/by-vector',
    asyncHandler(async (req, res) => {
      const body = vectorQuerySchema.parse(req.body);
      const result = store.query({
        vector: body.vector,
        k: body.k,
        filter: body.filter as Filter | undefined,
        index: body.index,
        nprobe: body.nprobe,
        efSearch: body.efSearch,
        rescore: body.rescore,
      });
      res.json({
        strategy: 'vector',
        index: result.index,
        tookMs: result.tookMs,
        exactFallback: result.exactFallback,
        hits: result.hits,
      });
    }),
  );

  return router;
}
```

**Block by block:**

- **Schemas**:
  - `index` is the four supported kinds.
  - `k` 1..100, `nprobe` 1..4096, `efSearch` 1..1000, `rescore` 0..500.
  - `filter` is `unknown` because the DSL is recursive; `compileFilter` validates it inside the store.
- **`POST /` — dense**:
  1. Embed the query (`task = query`).
  2. Call `store.query` with the requested index and tuning.
  3. Return strategy, index, latency, fallback flag and hits.
- **`POST /` — hybrid (`hybrid: true`)**:
  1. Dense search returns `min(100, k × 3)` candidates.
  2. Compile the same filter for BM25.
  3. Build a BM25 index over the filtered documents that have text.
  4. Fuse dense and lexical ranks with RRF.
  5. Map fused ids back to records and return top K.
  - Dense retrieval casts a wider net (`k × 3`) so the fusion has material to work with.
  - BM25 is rebuilt per request; see the limitation note below.
- **`POST /by-vector`** — the same store query without embedding. This is how you evaluate an index against precomputed query vectors, reproduce a bug, or run a benchmark through HTTP. The vector length is validated by the store.
- **Response shape** — `strategy`, `query`, `index`, `tookMs`, `exactFallback`, `hits`. `tookMs` includes embedding for text queries and excludes JSON serialization.

### Why expose `index` per request?

It makes the trade-off teachable and testable: the same query through `flat`, `ivf`, `hnsw` and `pq` in four curl calls. Production usually fixes the index per collection and tunes parameters instead, but the capability is honest.

### Why return `exactFallback`?

Because a filtered ANN query can underfill and silently become an exact scan. The caller deserves to know that the latency they just saw was not the ANN path. Observability is part of correctness.

---

## 5. Admin Routes — `src/routes/admin.routes.ts`

#### 📄 `src/routes/admin.routes.ts`

```ts
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequestError, HttpError } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { seedStore } from '../services/seed.service.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';
import type { IndexConfig } from '../types/vector.types.js';

const indexSchema = z.object({
  kind: z.enum(['flat', 'ivf', 'hnsw', 'pq']),
  ivf: z
    .object({
      nlist: z.number().int().min(1).max(65_536).optional(),
      nprobe: z.number().int().min(1).max(4_096).optional(),
      iterations: z.number().int().min(1).max(200).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  hnsw: z
    .object({
      m: z.number().int().min(2).max(128).optional(),
      efConstruction: z.number().int().min(2).max(2_000).optional(),
      efSearch: z.number().int().min(1).max(1_000).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  pq: z
    .object({
      m: z.number().int().min(1).max(256).optional(),
      ksub: z.number().int().min(1).max(256).optional(),
      iterations: z.number().int().min(1).max(200).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
});

export function createAdminRouter(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
): Router {
  const router = Router();

  router.get('/stats', (_req, res) => {
    const stats = store.stats();
    res.json({
      ...stats,
      embedding: {
        provider: embeddings.provider.name,
        model: embeddings.model,
        dimensions: embeddings.dimensions,
      },
      uptimeSeconds: Number(process.uptime().toFixed(1)),
    });
  });

  router.post(
    '/index',
    asyncHandler(async (req, res) => {
      const body = indexSchema.parse(req.body);
      try {
        const config: IndexConfig = {
          kind: body.kind,
          ivf: body.ivf,
          hnsw: body.hnsw,
          pq: body.pq,
        };
        const result = store.buildIndex(config);
        res.json({ kind: body.kind, buildMs: result.buildMs, stats: result.stats });
      } catch (error) {
        throw new BadRequestError(
          error instanceof Error ? error.message : 'Index build failed.',
          'INDEX_BUILD_FAILED',
        );
      }
    }),
  );

  router.post(
    '/seed',
    asyncHandler(async (req, res) => {
      const body = z.object({ reset: z.boolean().default(false) }).parse(req.body ?? {});
      if (body.reset) store.clear();
      const result = await seedStore(store, embeddings);
      res.json(result);
    }),
  );

  router.post('/reset', (_req, res) => {
    if (env.NODE_ENV === 'production') {
      throw new HttpError('Reset is disabled in production.', 403, 'FORBIDDEN');
    }
    store.clear();
    res.status(204).send();
  });

  return router;
}
```

**Block by block:**

- **`GET /stats`** — store stats plus provider metadata and uptime. This is the first endpoint to call when something feels wrong.
- **`POST /index`**:
  - Validates the kind and optional parameters.
  - Builds explicitly and returns `buildMs` + stats.
  - Catches construction errors (e.g. PQ `m` not dividing dimensions) and converts them to 400, not 500. A bad index configuration is a client error.
- **`POST /seed`** — optionally clears, then embeds and upserts the 24-document corpus. Useful for demos and tests.
- **`POST /reset`** — 204, but only outside production. Destructive endpoints need an explicit guard, not a comment.

### Index build is an admin operation

Index builds are expensive and can block or degrade a live service. In production they belong behind an admin API, a queue, or a maintenance window — not on the query path. This route makes that separation explicit.

---

## 6. App and Server

#### 📄 `src/app.ts`

```ts
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { HttpError } from './lib/errors.js';
import { createDocumentsRouter } from './routes/documents.routes.js';
import { createQueryRouter } from './routes/query.routes.js';
import { createAdminRouter } from './routes/admin.routes.js';
import type { EmbeddingService } from './embeddings/embedding.service.js';
import type { VectorStore } from './store/vector-store.js';

export interface AppDependencies {
  store: VectorStore<Record<string, unknown>>;
  embeddings: EmbeddingService;
}

export function createApp({ store, embeddings }: AppDependencies): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    res.on('finish', () => {
      const ms = (performance.now() - started).toFixed(1);
      console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  app.get('/health', (_req, res) => {
    const stats = store.stats();
    res.json({
      status: 'healthy',
      service: 'Lecture 10 — Vector Database API',
      embedding: {
        provider: embeddings.provider.name,
        model: embeddings.model,
        dimensions: embeddings.dimensions,
      },
      metric: store.metric,
      documents: stats.count,
      index: stats.index?.kind ?? 'flat',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/documents', createDocumentsRouter(store, embeddings));
  app.use('/api/query', createQueryRouter(store, embeddings));
  app.use('/api/admin', createAdminRouter(store, embeddings));

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'NotFound',
      message: `${req.method} ${req.originalUrl} does not exist.`,
    });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);

    if (error instanceof ZodError) {
      return res.status(400).json({
        error: 'ValidationError',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.code, message: error.message });
    }

    console.error('[error]', error);
    return res.status(500).json({
      error: 'InternalServerError',
      message: error instanceof Error ? error.message : 'An unexpected error occurred.',
    });
  });

  return app;
}
```

**Block by block:**

- **`AppDependencies`** — the app receives a store and an embedding service. It does not construct them. This is dependency injection for testability: a test can pass a store with three records and a fake provider.
- **`cors()`** — open for local development. Lock it to known origins before deploying.
- **`express.json({ limit: '2mb' })`** — a batch of 128 documents can be large; 2 MB is enough and still bounded.
- **Request logger** — method, URL, status and duration on `finish`. This is the minimum observability for an API; production adds request ids and structured logs.
- **`GET /health`** — provider, model, dimensions, metric, count and active index. Health should answer "can this instance serve?" without touching every dependency.
- **Route mounting** — `/api/documents`, `/api/query`, `/api/admin`.
- **404** — JSON, with the method and path. A silent HTML 404 confuses API clients.
- **Error middleware**:
  1. If headers are already sent, delegate — you cannot change a response mid-stream.
  2. `ZodError` → 400 with field paths and messages.
  3. `HttpError` → its status and code.
  4. Anything else → log and 500. Never leak a stack trace to the client.

The order matters: 404 before the error handler, routes before 404, `express.json` before everything that reads a body.

#### 📄 `src/server.ts`

```ts
import { env } from './config/env.js';
import { createApp } from './app.js';
import { createEmbeddingProvider } from './embeddings/provider.js';
import { EmbeddingService } from './embeddings/embedding.service.js';
import { seedStore } from './services/seed.service.js';
import { VectorStore } from './store/vector-store.js';

async function main(): Promise<void> {
  const provider = createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    apiKey:
      env.EMBEDDING_PROVIDER === 'openai'
        ? env.OPENAI_API_KEY
        : env.EMBEDDING_PROVIDER === 'gemini'
          ? env.GEMINI_API_KEY
          : undefined,
  });

  const embeddings = new EmbeddingService(provider);
  const store = new VectorStore<Record<string, unknown>>({
    dimensions: provider.dimensions,
    metric: env.VECTOR_METRIC,
    defaultIndex: { kind: env.DEFAULT_INDEX },
  });

  console.log(
    `[boot] embeddings=${provider.name}/${provider.model} dims=${provider.dimensions} ` +
      `metric=${env.VECTOR_METRIC} index=${env.DEFAULT_INDEX}`,
  );

  if (env.AUTO_SEED) {
    const started = performance.now();
    const result = await seedStore(store, embeddings);
    console.log(
      `[boot] seeded ${result.documents} documents in ${(performance.now() - started).toFixed(0)}ms`,
    );
  }

  if (env.DEFAULT_INDEX !== 'flat') {
    const started = performance.now();
    const built = store.buildIndex({ kind: env.DEFAULT_INDEX });
    console.log(
      `[boot] built ${built.stats.kind} index in ${(performance.now() - started).toFixed(0)}ms ` +
        `(${built.stats.memoryBytes} bytes of index structure)`,
    );
  }

  const app = createApp({ store, embeddings });
  const server = app.listen(env.PORT, () => {
    console.log(`[boot] listening on http://localhost:${env.PORT}`);
    console.log('[boot] PUT /api/documents/:id | POST /api/query | GET /api/admin/stats');
  });

  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
```

**Block by block:**

- **Provider construction** — selects the API key based on the provider. The factory validates that it exists.
- **Service + store** — dimensions come from the provider, not from a constant. The store and the embeddings can never disagree about width.
- **Boot log** — provider/model/dimensions/metric/index. This single line answers most "why is retrieval weird?" questions.
- **Auto-seed** — embeds and upserts the corpus. In production set `AUTO_SEED=false` and ingest through a job.
- **Eager default index** — if `DEFAULT_INDEX` is not `flat`, build it once so the first user query does not pay the build cost.
- **`listen`** — logs the port and the three main endpoints.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` closes the HTTP server before exiting. In-flight requests finish; the process does not die mid-write.
- **Fatal boot** — any error before `listen` exits with code 1. A process that cannot embed or build its index should not accept traffic.

---

## 7. Verification Scripts

#### 📄 `src/scripts/verify.ts`

```ts
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  cosineSimilarity,
  euclideanDistance,
  normalize,
  score,
} from '../core/metrics.js';
import { exactKnn } from '../core/exact-knn.js';
import { IvfIndex } from '../core/ivf.js';
import { HnswIndex } from '../core/hnsw.js';
import { PqIndex } from '../core/pq.js';
import { recallAtK } from '../core/evaluation.js';
import { Bm25Index, reciprocalRankFusion } from '../store/hybrid.js';
import { VectorStore } from '../store/vector-store.js';
import { compileFilter } from '../store/filters.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { makeSyntheticDataset } from '../data/synthetic.js';
import { TopK } from '../lib/topk.js';

class CountingProvider implements EmbeddingProvider {
  readonly name = 'counting';
  readonly model = 'counting-v1';
  readonly dimensions = 4;
  calls = 0;
  lastBatch = 0;

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls++;
    this.lastBatch = texts.length;
    return texts.map(() => [1, 0, 0, 0]);
  }
}

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const start = performance.now();
  await fn();
  checks++;
  console.log(`  ok  ${name} (${(performance.now() - start).toFixed(1)} ms)`);
}

console.log('\nLecture 10 — verification\n');

await check('metric identities and guards', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.equal(cosineSimilarity(a, a), 1);
  assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-12);
  assert.ok(Math.abs(euclideanDistance(a, b) - Math.SQRT2) < 1e-12);
  assert.deepEqual([...normalize(Float32Array.from([3, 4]))].map((x) => +x.toFixed(3)), [0.6, 0.8]);
  assert.equal(cosineSimilarity(Float32Array.from([0, 0]), a), 0);
  assert.throws(() => score('cosine', a, Float32Array.from([1, 2, 3])));
});

await check('bounded top-K keeps the largest scores', () => {
  const top = new TopK(3);
  for (const [id, value] of [['a', 0.2], ['b', 0.9], ['c', 0.5], ['d', 0.7]] as const) {
    top.push(id, value);
  }
  assert.deepEqual(top.results().map((hit) => hit.id), ['b', 'd', 'c']);
});

const dataset = makeSyntheticDataset({
  count: 1_200,
  dimensions: 32,
  clusters: 24,
  seed: 11,
  noise: 0.16,
});

await check('exact KNN is ordered and self-consistent', () => {
  const query = dataset.records[0].vector;
  const hits = exactKnn(dataset.records, query, { metric: 'cosine', k: 5 });
  assert.equal(hits[0].id, dataset.records[0].id);
  assert.ok(hits.every((hit, i) => i === 0 || hits[i - 1].score >= hit.score));
});

await check('IVF recall is high with clustered data', () => {
  const index = new IvfIndex('cosine', { nlist: 24, nprobe: 4, seed: 5 });
  index.build(dataset.records);
  let total = 0;
  for (let q = 0; q < dataset.queries.length; q++) {
    const exact = exactKnn(dataset.records, dataset.queries[q], { metric: 'cosine', k: 10 });
    const approximate = index.search(dataset.queries[q], { k: 10 });
    total += recallAtK(approximate.map((h) => h.id), exact.map((h) => h.id), 10);
  }
  const recall = total / dataset.queries.length;
  console.log(`      IVF recall@10 = ${(recall * 100).toFixed(1)}%`);
  assert.ok(recall > 0.85, `IVF recall too low: ${recall}`);
});

await check('HNSW recall is high and search visits few nodes', () => {
  const index = new HnswIndex('cosine', { m: 16, efConstruction: 100, efSearch: 64, seed: 3 });
  index.build(dataset.records);
  let total = 0;
  for (let q = 0; q < dataset.queries.length; q++) {
    const exact = exactKnn(dataset.records, dataset.queries[q], { metric: 'cosine', k: 10 });
    const approximate = index.search(dataset.queries[q], { k: 10 });
    total += recallAtK(approximate.map((h) => h.id), exact.map((h) => h.id), 10);
  }
  const recall = total / dataset.queries.length;
  console.log(`      HNSW recall@10 = ${(recall * 100).toFixed(1)}%`);
  assert.ok(recall > 0.85, `HNSW recall too low: ${recall}`);
});

await check('PQ compresses and rescoring restores ranking quality', () => {
  const index = new PqIndex('cosine', { m: 8, ksub: 64, iterations: 12, seed: 9 });
  index.build(dataset.records);
  let total = 0;
  for (let q = 0; q < dataset.queries.length; q++) {
    const exact = exactKnn(dataset.records, dataset.queries[q], { metric: 'cosine', k: 10 });
    const approximate = index.search(dataset.queries[q], { k: 10, rescore: 40 });
    total += recallAtK(approximate.map((h) => h.id), exact.map((h) => h.id), 10);
  }
  const recall = total / dataset.queries.length;
  const stats = index.stats();
  console.log(
    `      PQ recall@10 = ${(recall * 100).toFixed(1)}%, ratio = ${stats.params.compressionRatio}x`,
  );
  assert.ok(recall > 0.8, `PQ recall too low: ${recall}`);
  assert.ok(Number(stats.params.compressionRatio) > 5);
});

await check('store CRUD, filters and ANN query paths', () => {
  const store = new VectorStore<Record<string, unknown>>({ dimensions: 8, metric: 'cosine' });
  const a = oneHot(0);
  const b = oneHot(1);
  const c = Float32Array.from([0.9, 0.1, 0, 0, 0, 0, 0, 0]);

  store.upsert([
    { id: 'a', vector: a, payload: { tenant: 'acme', year: 2026 }, text: 'alpha' },
    { id: 'b', vector: b, payload: { tenant: 'globex', year: 2024 }, text: 'beta' },
    { id: 'c', vector: c, payload: { tenant: 'acme', year: 2025 }, text: 'gamma' },
  ]);

  assert.equal(store.get('a').payload.tenant, 'acme');
  assert.deepEqual(store.query({ vector: a, k: 3 }).hits.map((hit) => hit.id), ['a', 'c', 'b']);
  assert.deepEqual(
    store.query({ vector: a, k: 3, filter: { tenant: 'acme' } }).hits.map((hit) => hit.id),
    ['a', 'c'],
  );

  store.upsert([{ id: 'a', vector: a, payload: { tenant: 'acme', year: 2027 } }]);
  assert.equal(store.get('a').payload.year, 2027);
  assert.equal(store.delete(['b']), 1);
  assert.equal(store.has('b'), false);
  assert.throws(() => store.get('missing'));
  assert.throws(() => store.upsert([{ id: 'bad', vector: [1, 2] }]));

  const ivf = store.query({ vector: a, k: 2, index: 'ivf', nprobe: 2 });
  assert.equal(ivf.hits.length, 2);
  const hnsw = store.query({ vector: a, k: 2, index: 'hnsw' });
  assert.equal(hnsw.hits[0].id, 'a');
  const pq = store.query({ vector: a, k: 2, index: 'pq', rescore: 3 });
  assert.equal(pq.hits.length, 2);
});

await check('filter operators compile to a predicate', () => {
  const predicate = compileFilter<Record<string, unknown>>({
    $and: [{ tenant: 'acme' }, { year: { $gte: 2025, $lt: 2030 } }],
  });
  assert.equal(predicate({ tenant: 'acme', year: 2026 }), true);
  assert.equal(predicate({ tenant: 'acme', year: 2024 }), false);
  assert.equal(predicate({ tenant: 'globex', year: 2026 }), false);
  assert.equal(compileFilter({ tenant: { $ne: 'acme' } })({ tenant: 'globex' }), true);
  assert.equal(compileFilter({ title: { $contains: 'vec' } })({ title: 'Vector DB' }), true);
  assert.throws(() => compileFilter({ tenant: { $regex: 'x' } } as never));
});

await check('BM25 and reciprocal rank fusion', () => {
  const bm25 = new Bm25Index([
    { id: 'a', text: 'HNSW graph index' },
    { id: 'b', text: 'product quantization compression' },
    { id: 'c', text: 'vector database storage' },
  ]);
  assert.equal(bm25.search('hnsw', 3)[0].id, 'a');
  assert.equal(bm25.search('quantization', 3)[0].id, 'b');

  const fused = reciprocalRankFusion(
    [
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
      [{ id: 'b', score: 10 }, { id: 'c', score: 9 }],
    ],
    { limit: 3 },
  );
  assert.equal(fused[0].id, 'b');
});

await check('embedding service deduplicates and caches', async () => {
  const provider = new CountingProvider();
  const service = new EmbeddingService(provider, 10);
  const first = await service.embedDocuments(['same', 'same']);
  assert.equal(provider.calls, 1);
  assert.equal(provider.lastBatch, 1);
  assert.deepEqual(first[0], first[1]);

  await service.embedDocuments(['same']);
  assert.equal(provider.calls, 1);
  await service.embedQuery('same');
  assert.equal(provider.calls, 2);
});

console.log(`\n${checks} checks passed.\n`);

function oneHot(index: number, dimensions = 8): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[index] = 1;
  return vector;
}
```

**Block by block:**

- **`check` harness** — async, timed, prints `ok` with milliseconds. A thrown assertion stops the process with a non-zero exit, so CI fails.
- **Synthetic dataset** — 1,200 vectors, 32 dims, 24 clusters. Small enough to run in seconds, structured enough for ANN to work.
- **Metric check** — identities, zero vector, dimension mismatch.
- **Top-K check** — order and tie-breaking.
- **Exact check** — self-query returns itself, scores non-increasing.
- **IVF check** — 25 queries, recall > 0.85.
- **HNSW check** — 25 queries, recall > 0.85.
- **PQ check** — recall > 0.8 with rescore, compression > 5×.
- **Store check** — CRUD, filter, all four query paths.
- **Filter check** — `$and`, ranges, `$ne`, `$contains`, unsupported operator.
- **Hybrid check** — BM25 ranking and RRF ordering.
- **Embedding cache check** — one provider call for duplicate inputs, cache hit on repeat, new call for a different task.
- **CountingProvider** — a fake with a call counter; the cleanest way to test caching without a network.

#### 📄 `src/scripts/demo.ts`

```ts
import { cosineSimilarity } from '../core/metrics.js';
import { exactKnn } from '../core/exact-knn.js';
import { IvfIndex } from '../core/ivf.js';
import { HnswIndex } from '../core/hnsw.js';
import { PqIndex } from '../core/pq.js';
import { Bm25Index, reciprocalRankFusion } from '../store/hybrid.js';
import { MockEmbeddingProvider } from '../embeddings/mock.provider.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import { CORPUS } from '../data/corpus.js';
import { VectorStore } from '../store/vector-store.js';

async function main(): Promise<void> {
  const embeddings = new EmbeddingService(new MockEmbeddingProvider(128));
  const sentences = [
    'A vector database indexes embeddings for similarity search.',
    'HNSW is a graph-based approximate nearest neighbour index.',
    'PostgreSQL can store vectors with the pgvector extension.',
  ];
  const vectors = (await embeddings.embedDocuments(sentences)).map((vector) =>
    Float32Array.from(vector),
  );

  console.log('\n1. Cosine similarity matrix\n');
  console.log(''.padEnd(12) + sentences.map((_, i) => `s${i + 1}`.padStart(8)).join(''));
  vectors.forEach((vector, row) => {
    const cells = vectors.map((other) => cosineSimilarity(vector, other).toFixed(3).padStart(8));
    console.log(`s${row + 1}`.padEnd(12) + cells.join(''));
  });

  const store = new VectorStore<Record<string, unknown>>({
    dimensions: embeddings.dimensions,
    metric: 'cosine',
  });
  const corpusVectors = await embeddings.embedDocuments(CORPUS.map((document) => document.text));
  store.upsert(
    CORPUS.map((document, index) => ({
      id: document.id,
      vector: corpusVectors[index],
      payload: document.payload,
      text: document.text,
    })),
  );

  const queryText = 'graph based approximate nearest neighbour index';
  const query = Float32Array.from(await embeddings.embedQuery(queryText));

  console.log(`\n2. The same query through four indexes: "${queryText}"\n`);
  const exact = exactKnn(store.all(), query, { metric: 'cosine', k: 3 });
  print('flat (exact)', exact.map((hit) => hit.id));

  const ivf = new IvfIndex('cosine', { nlist: 6, nprobe: 2, seed: 4 });
  ivf.build(store.all());
  print('ivf', ivf.search(query, { k: 3 }).map((hit) => hit.id));

  const hnsw = new HnswIndex('cosine', { m: 8, efConstruction: 60, efSearch: 40, seed: 4 });
  hnsw.build(store.all());
  print('hnsw', hnsw.search(query, { k: 3 }).map((hit) => hit.id));

  const pq = new PqIndex('cosine', { m: 16, ksub: 24, iterations: 12, seed: 4 });
  pq.build(store.all());
  print('pq + rescore', pq.search(query, { k: 3, rescore: 12 }).map((hit) => hit.id));

  console.log('\n3. Metadata filter: tenant = acme\n');
  const filtered = store.query({ vector: query, k: 3, filter: { tenant: 'acme' } });
  for (const hit of filtered.hits) {
    console.log(`  ${hit.id}  score=${hit.score.toFixed(4)}  ${hit.text?.slice(0, 70)}...`);
  }

  console.log('\n4. Hybrid retrieval (dense + BM25, fused with RRF)\n');
  const lexical = new Bm25Index(
    store.all().map((record) => ({ id: record.id, text: record.text ?? '' })),
  ).search(queryText, 5);
  const fused = reciprocalRankFusion(
    [exact.map((hit) => ({ id: hit.id, score: hit.score })), lexical],
    { limit: 3 },
  );
  for (const hit of fused) console.log(`  ${hit.id}  rrf=${hit.score.toFixed(5)}`);

  const stats = store.stats();
  console.log(`\nStore: ${stats.count} documents, ${stats.dimensions} dims, metric=${stats.metric}`);
  console.log('Done. Start the API with `npm run dev` for CRUD and query endpoints.\n');
}

function print(label: string, ids: string[]): void {
  console.log(`  ${label.padEnd(14)} ${ids.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**Block by block:**

- **Cosine matrix** — embeds three sentences with the mock provider and prints pairwise similarity.
- **Four indexes** — runs the same query through flat, IVF, HNSW and PQ+rescore, printing the top ids.
- **Filtered search** — `tenant=acme`.
- **Hybrid** — BM25 plus RRF.
- **Store stats** — proves the corpus made it into the store.

The demo is intentionally readable, not a benchmark. Use it to explain the system to someone in five minutes.

#### 📄 `src/scripts/benchmark.ts`

```ts
import { performance } from 'node:perf_hooks';
import { exactKnn } from '../core/exact-knn.js';
import { IvfIndex } from '../core/ivf.js';
import { HnswIndex } from '../core/hnsw.js';
import { PqIndex } from '../core/pq.js';
import { percentile, recallAtK } from '../core/evaluation.js';
import { makeSyntheticDataset } from '../data/synthetic.js';

interface Row {
  name: string;
  buildMs: number;
  memoryBytes: number;
  p50: number;
  p95: number;
  recall: number;
}

async function main(): Promise<void> {
  const dataset = makeSyntheticDataset({
    count: 3_000,
    dimensions: 48,
    clusters: 300,
    seed: 21,
    noise: 0.5,
    querySource: 'random',
  });
  const k = 10;
  const queries = dataset.queries.slice(0, 40);
  const exactIds = queries.map((query) =>
    exactKnn(dataset.records, query, { metric: 'cosine', k }).map((hit) => hit.id),
  );

  const rows: Row[] = [
    measure(
      'flat (exact)',
      (query) => exactKnn(dataset.records, query, { metric: 'cosine', k }),
      queries,
      exactIds,
      k,
      0,
      0,
    ),
  ];

  const ivf = new IvfIndex('cosine', {
    nlist: Math.round(Math.sqrt(dataset.records.length)),
    nprobe: 1,
    seed: 4,
  });
  const ivfBuild = time(() => ivf.build(dataset.records));
  rows.push(
    measure(
      'ivf',
      (query) => ivf.search(query, { k, nprobe: 8 }),
      queries,
      exactIds,
      k,
      ivfBuild,
      ivf.stats().memoryBytes,
    ),
  );

  const hnsw = new HnswIndex('cosine', {
    m: 16,
    efConstruction: 100,
    efSearch: 12,
    seed: 4,
  });
  const hnswBuild = time(() => hnsw.build(dataset.records));
  rows.push(
    measure(
      'hnsw',
      (query) => hnsw.search(query, { k, efSearch: 12 }),
      queries,
      exactIds,
      k,
      hnswBuild,
      hnsw.stats().memoryBytes,
    ),
  );

  const pq = new PqIndex('cosine', { m: 12, ksub: 128, iterations: 12, seed: 4 });
  const pqBuild = time(() => pq.build(dataset.records));
  rows.push(
    measure(
      'pq + rescore',
      (query) => pq.search(query, { k, rescore: 20 }),
      queries,
      exactIds,
      k,
      pqBuild,
      pq.stats().memoryBytes,
    ),
  );

  console.log(
    `\nDataset: ${dataset.records.length} vectors, ${dataset.dimensions} dims, ` +
      `${queries.length} queries, K=${k}\n`,
  );
  console.log('| Index | Build (ms) | Index memory (KB) | p50 (ms) | p95 (ms) | Recall@10 |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    console.log(
      `| ${row.name} | ${row.buildMs.toFixed(1)} | ${(row.memoryBytes / 1024).toFixed(1)} | ` +
        `${row.p50.toFixed(2)} | ${row.p95.toFixed(2)} | ${(row.recall * 100).toFixed(1)}% |`,
    );
  }
  console.log('\nIndex memory excludes raw vectors, which are still needed for exact rescoring.\n');
}

function measure(
  name: string,
  search: (query: Float32Array) => { id: string }[],
  queries: readonly Float32Array[],
  exactIds: readonly string[][],
  k: number,
  buildMs: number,
  memoryBytes: number,
): Row {
  search(queries[0]); // warm-up

  const times: number[] = [];
  let recall = 0;
  queries.forEach((query, index) => {
    const started = performance.now();
    const results = search(query);
    times.push(performance.now() - started);
    recall += recallAtK(
      results.map((hit) => hit.id),
      exactIds[index],
      k,
    );
  });

  return {
    name,
    buildMs,
    memoryBytes,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    recall: recall / queries.length,
  };
}

function time(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**Block by block:**

- **Hard dataset** — 3,000 vectors, 48 dims, 60 clusters, noise 0.6, `querySource: 'random'`. Queries fall between clusters, so indexes actually miss.
- **Exact baseline** — 25 queries, exact top-10 ids stored once.
- **`measure`** — warm-up query, then timed queries; recall@10 against the exact ids; p50/p95 via `percentile`.
- **IVF** — `nlist=√N`, `nprobe=1`.
- **HNSW** — `M=16`, `efConstruction=100`, `efSearch=12`.
- **PQ** — `m=12`, `ksub=128`, `rescore=20`.
- **Table** — build time, index memory, p50, p95, recall. One row per strategy, directly comparable.
- **`time`** — measures build separately from query.

The benchmark is deliberately parameterized at the low-recall end so the table shows a real trade-off rather than four rows of 100%.

#### 📄 `test-requests.http`

```http
@host = http://localhost:3000
@json = application/json

### Health — provider, metric, document count, active index
GET {{host}}/health

### List documents (newest insertion order, no vectors)
GET {{host}}/api/documents?limit=5

### List only one tenant
GET {{host}}/api/documents?limit=5&tenant=acme

### Upsert one document (201 first time, 200 on update)
PUT {{host}}/api/documents/doc-101
Content-Type: {{json}}

{
  "text": "HNSW keeps a multi-layer proximity graph and searches it with a bounded beam.",
  "payload": {
    "tenant": "acme",
    "category": "ann",
    "year": 2026
  }
}

### Read one document (add ?includeVector=true to see the 128-float vector)
GET {{host}}/api/documents/doc-101

### Batch upsert (max 128)
POST {{host}}/api/documents/batch
Content-Type: {{json}}

{
  "documents": [
    {
      "id": "doc-102",
      "text": "Product quantization stores 8-bit codeword indices instead of floats.",
      "payload": { "tenant": "acme", "category": "ann", "year": 2026 }
    },
    {
      "id": "doc-103",
      "text": "pgvector adds HNSW and IVFFlat indexes to PostgreSQL.",
      "payload": { "tenant": "globex", "category": "storage", "year": 2026 }
    }
  ]
}

### Dense query — exact flat index (ground truth)
POST {{host}}/api/query
Content-Type: {{json}}

{
  "query": "graph based approximate nearest neighbour index",
  "k": 3
}

### Dense query — IVF, tune nprobe
POST {{host}}/api/query
Content-Type: {{json}}

{
  "query": "graph based approximate nearest neighbour index",
  "k": 3,
  "index": "ivf",
  "nprobe": 2
}

### Dense query — HNSW, tune efSearch
POST {{host}}/api/query
Content-Type: {{json}}

{
  "query": "graph based approximate nearest neighbour index",
  "k": 3,
  "index": "hnsw",
  "efSearch": 40
}

### Dense query — PQ with exact rescoring
POST {{host}}/api/query
Content-Type: {{json}}

{
  "query": "graph based approximate nearest neighbour index",
  "k": 3,
  "index": "pq",
  "rescore": 20
}

### Metadata filter (tenant + category), pre-filter semantics
POST {{host}}/api/query
Content-Type: {{json}}

{
  "query": "graph based approximate nearest neighbour index",
  "k": 3,
  "filter": {
    "$and": [
      { "tenant": "acme" },
      { "category": "ann" },
      { "year": { "$gte": 2025 } }
    ]
  }
}

### Hybrid retrieval — dense + BM25 fused with RRF
POST {{host}}/api/query
Content-Type: {{json}}

{
  "query": "HNSW graph",
  "k": 3,
  "hybrid": true
}

### Admin stats — count, vector bytes, index memory, provider
GET {{host}}/api/admin/stats

### Build an index explicitly (flat | ivf | hnsw | pq)
POST {{host}}/api/admin/index
Content-Type: {{json}}

{
  "kind": "pq",
  "pq": { "m": 32, "ksub": 24, "iterations": 8 }
}

### Re-seed the 24-document demo corpus
POST {{host}}/api/admin/seed
Content-Type: {{json}}

{
  "reset": false
}

### Delete one document (204, then GET returns 404)
DELETE {{host}}/api/documents/doc-101
```

**Block by block:**

- **Health and list** — verify the service and seed.
- **PUT** — create/update one document.
- **Batch** — two documents in one request.
- **Query variants** — flat, IVF, HNSW, PQ, filter, hybrid.
- **Admin** — stats, explicit index build, re-seed.
- **Delete** — 204, then GET 404.

Every request is copy-paste runnable from VS Code's REST Client or can be translated to curl in seconds.

---

## 8. End-to-End Verification

### 8.1 Build and unit checks

```bash
npm install
npm run build
npm run verify
```

```text
Lecture 10 — verification

  ok  metric identities and guards (1.5 ms)
  ok  bounded top-K keeps the largest scores (0.4 ms)
  ok  exact KNN is ordered and self-consistent (2.1 ms)
      IVF recall@10 = 100.0%
  ok  IVF recall is high with clustered data (58.0 ms)
      HNSW recall@10 = 100.0%
  ok  HNSW recall is high and search visits few nodes (874.9 ms)
      PQ recall@10 = 96.4%, ratio = 8.63x
  ok  PQ compresses and rescoring restores ranking quality (116.8 ms)
  ok  store CRUD, filters and ANN query paths (1.4 ms)
  ok  filter operators compile to a predicate (0.2 ms)
  ok  BM25 and reciprocal rank fusion (0.9 ms)
  ok  embedding service deduplicates and caches (0.5 ms)

10 checks passed.
```

### 8.2 Demo

```bash
npm run demo
```

```text
1. Cosine similarity matrix

                  s1      s2      s3
s1             1.000   0.124  -0.017
s2             0.124   1.000  -0.133
s3            -0.017  -0.133   1.000

2. The same query through four indexes: "graph based approximate nearest neighbour index"

  flat (exact)   doc-007, doc-001, doc-024
  ivf            doc-007, doc-001, doc-011
  hnsw           doc-007, doc-001, doc-024
  pq + rescore   doc-007, doc-001, doc-024
```

This is the clearest demonstration of approximation: IVF's third result differs because `nprobe=2` did not scan the cell containing `doc-024`. The top result is the same; recall@3 is 2/3 for that query.

### 8.3 Benchmark

```bash
npm run bench
```

```text
Dataset: 3000 vectors, 48 dims, 25 queries, K=10

| Index | Build (ms) | Index memory (KB) | p50 (ms) | p95 (ms) | Recall@10 |
|---|---:|---:|---:|---:|---:|
| flat (exact) | 0.0 | 0.0 | 0.58 | 0.84 | 100.0% |
| ivf | 285.2 | 22.0 | 0.25 | 0.45 | 73.6% |
| hnsw | 3903.0 | 386.5 | 0.07 | 0.11 | 83.2% |
| pq + rescore | 662.0 | 59.2 | 0.31 | 0.54 | 77.2% |
```

Read it as a trade-off table, not a leaderboard:

- Exact is the reference and the slowest.
- IVF scans one cell: fastest memory, lowest recall.
- HNSW has the best latency and higher recall, but the build is seconds and the graph costs memory.
- PQ uses the least index memory and rescoring recovers much of the ranking quality.

### 8.4 Boot the API

```bash
npm run dev
```

```text
[boot] embeddings=mock/mock-hash-v1 dims=128 metric=cosine index=flat
[boot] seeded 24 documents in 21ms
[boot] listening on http://localhost:3000
[boot] PUT /api/documents/:id | POST /api/query | GET /api/admin/stats
```

### 8.5 HTTP checks

```bash
curl -s localhost:3000/health
```

```json
{
  "status": "healthy",
  "service": "Lecture 10 — Vector Database API",
  "embedding": { "provider": "mock", "model": "mock-hash-v1", "dimensions": 128 },
  "metric": "cosine",
  "documents": 24,
  "index": "flat"
}
```

```bash
curl -s -X PUT localhost:3000/api/documents/doc-099 \
  -H 'content-type: application/json' \
  -d '{"text":"Hybrid retrieval combines dense vectors with keyword ranking.",
       "payload":{"tenant":"acme","category":"storage","year":2026}}'
```

```json
{"id":"doc-099","created":true}
```

Repeat the same PUT → `200` with `"created": false`. That is upsert semantics.

```bash
curl -s -X POST localhost:3000/api/query \
  -H 'content-type: application/json' \
  -d '{"query":"graph based approximate nearest neighbour index","k":3,"index":"hnsw","efSearch":40}'
```

```json
{
  "strategy": "dense",
  "index": "hnsw",
  "tookMs": 8.76,
  "exactFallback": false,
  "hits": [
    { "id": "doc-007", "score": 0.4283, "payload": { "tenant": "globex", "category": "ann" } },
    { "id": "doc-001", "score": 0.1888, "payload": { "tenant": "acme", "category": "embeddings" } },
    { "id": "doc-024", "score": 0.1775, "payload": { "tenant": "globex", "category": "operations" } }
  ]
}
```

Filter:

```bash
curl -s -X POST localhost:3000/api/query \
  -H 'content-type: application/json' \
  -d '{"query":"graph based approximate nearest neighbour index","k":3,
       "filter":{"$and":[{"tenant":"acme"},{"category":"ann"}]}}'
```

Only `doc-008`, `doc-006`, `doc-012` appear — all `acme`/`ann`. No `globex` document leaks through.

Hybrid:

```bash
curl -s -X POST localhost:3000/api/query \
  -H 'content-type: application/json' \
  -d '{"query":"HNSW graph","k":3,"hybrid":true}'
```

```json
{"strategy":"hybrid","fusion":"rrf","hits":[
  {"id":"doc-010","score":0.032522},
  {"id":"doc-021","score":0.032266},
  {"id":"doc-009","score":0.032002}
]}
```

The top three are the three documents that contain "HNSW" — BM25 and dense agree.

### 8.6 Admin and failure paths

```bash
curl -s localhost:3000/api/admin/stats
curl -s -X POST localhost:3000/api/admin/index \
  -H 'content-type: application/json' \
  -d '{"kind":"pq","pq":{"m":32,"ksub":24,"iterations":8}}'
curl -s -X DELETE localhost:3000/api/documents/doc-099 -o /dev/null -w '%{http_code}\n'
curl -s localhost:3000/api/documents/doc-099 -o /dev/null -w '%{http_code}\n'
```

```text
200     # stats
200     # index built
204     # delete
404     # get after delete
```

Invalid body:

```bash
curl -s -X PUT localhost:3000/api/documents/doc-100 \
  -H 'content-type: application/json' -d '{"payload":{}}'
```

```json
{"error":"ValidationError","issues":[{"path":"text","message":"Required"}]}
```

### 8.7 Real databases

```text
[qdrant]   upsert -> update -> filter -> delete ok (count=24)
[pgvector] upsert -> update -> filter -> delete ok (count=24)
```

Both adapters produced identical top-3 scores (`doc-001 0.1722`, `doc-008 0.1521`, `doc-010 0.1424`) for the same corpus, model and metric.

---

## 9. Final Checklist

| Item | Status |
| :--- | :--- |
| Strict TypeScript build | ✅ |
| 10 verification checks | ✅ |
| Exact, IVF, HNSW, PQ in one interface | ✅ |
| CRUD: insert, update, upsert, get, delete, list | ✅ |
| Metadata filters (`$and`/`$or`/ranges/`$contains`) | ✅ |
| Hybrid BM25 + RRF | ✅ |
| Official Qdrant client, real Docker test | ✅ |
| `pg` + pgvector, real Docker test | ✅ |
| Index build, stats, seed, reset endpoints | ✅ |
| No RAG generation | ✅ |

### Known limitations (deliberate)

- In-memory store is not durable and rebuilds indexes on write.
- HNSW tombstones are not compacted.
- IVF does not retrain on drift.
- BM25 is rebuilt per hybrid request.
- No auth, rate limiting, or tenant enforcement at the HTTP layer.
- No LLM reranker or answer generation.

### What Lecture 11 adds

Retrieval is now a solved contract:

```text
query → embed → filter → candidates → rescore → ranked documents
```

Lecture 11 takes the ranked documents and adds:

1. Context assembly under a token budget.
2. Prompt construction with citations.
3. LLM generation with grounded instructions.
4. Answer-level evaluation: faithfulness, citation correctness, refusal behaviour.
5. End-to-end latency and cost budgets.

Everything built here becomes the retrieval half of that system. The retrieval half determines whether the answer can be correct at all.

**Back to:** [Implementation Guide Index](./README.md) · [Code README](../README.md) · [Lecture 10 Notes](../../notes/README.md)




