# Chapter 07: HTTP API — Routes, App & Server

> **Chapter Goal:** Expose the recommendation engine over HTTP without letting transport concerns leak into the core. Validate inputs at the boundary, translate domain errors into status codes, and guarantee that the catalog is built *before* the port starts accepting traffic.

> **Lecture mapping:** Notes Chapters 04 (features) and 07 (complete system design).

> **Files covered:**

| File | Lines | Purpose |
| :--- | :--- | :--- |
| `src/routes/movie.routes.ts` | 118 | Endpoints, Zod request validation, error-to-status mapping |
| `src/app.ts` | 54 | Express app factory, middleware, health check, 404, global error handler |
| `src/server.ts` | 36 | Bootstrap order: build catalog → listen |

---

## 1. Complete Source Code

### 📄 `src/routes/movie.routes.ts` (118 lines)

```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { recommendationService, NotFoundError } from '../services/recommendation.service.js';
import { vectorStore } from '../services/vector.store.js';
import { env } from '../config/env.js';

export const movieRouter = Router();

// ─── Input Validation Schemas ─────────────────────────────────────────────────

const SearchSchema = z.object({
  query: z.string().min(3, 'Query must be at least 3 characters').max(500),
  topN: z.coerce.number().int().min(1).max(20).optional(),
});

const RecommendSchema = z.object({
  topN: z.coerce.number().int().min(1).max(20).optional(),
});

// ─── GET /api/movies ──────────────────────────────────────────────────────────

/**
 * List all movies in the catalog.
 * Useful for browsing — the UI would render these for the user to click on.
 */
movieRouter.get('/', (_req: Request, res: Response) => {
  const movies = recommendationService.getAllMovies();
  res.json({
    count: movies.length,
    movies,
  });
});

// ─── GET /api/movies/status ───────────────────────────────────────────────────

/**
 * Catalog readiness status — shows how many movies have been embedded.
 * Useful during startup to know when the store is ready to serve requests.
 */
movieRouter.get('/status', (_req: Request, res: Response) => {
  res.json(vectorStore.status());
});

// ─── POST /api/movies/search ──────────────────────────────────────────────────

/**
 * FEATURE 1: Semantic Movie Search
 *
 * The user describes what they want in natural language.
 * We embed the description and find the closest movies by cosine similarity.
 *
 * Body: { query: string, topN?: number }
 *
 * Example:
 *   POST /api/movies/search
 *   { "query": "astronaut stranded alone trying to survive in space" }
 */
movieRouter.post('/search', async (req: Request, res: Response) => {
  const parsed = SearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'ValidationError',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { query, topN = env.DEFAULT_TOP_N } = parsed.data;

  try {
    const result = await recommendationService.semanticSearch(query, topN);
    res.json(result);
  } catch (err: any) {
    console.error('[POST /movies/search] Error:', err.message);
    res.status(500).json({ error: 'InternalServerError', message: err.message });
  }
});

// ─── GET /api/movies/:id/similar ─────────────────────────────────────────────

/**
 * FEATURE 2: Similar Movie Recommendation
 *
 * The user is watching a movie and clicks "Show Similar Movies".
 * We use the movie's precomputed vector — no new embedding API call needed.
 *
 * Params:  id     — movie ID from the catalog
 * Query:   topN   — how many results to return (optional, default from env)
 *
 * Example:
 *   GET /api/movies/1/similar          → movies similar to Interstellar
 *   GET /api/movies/1/similar?topN=3   → top 3 similar to Interstellar
 */
movieRouter.get('/:id/similar', (req: Request, res: Response) => {
  const parsed = RecommendSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'ValidationError',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { topN = env.DEFAULT_TOP_N } = parsed.data;
  const movieId = String(req.params.id);

  try {
    const result = recommendationService.findSimilarMovies(movieId, topN);
    res.json(result);
  } catch (err: any) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'NotFound', message: err.message });
      return;
    }
    console.error('[GET /movies/:id/similar] Error:', err.message);
    res.status(500).json({ error: 'InternalServerError', message: err.message });
  }
});
```

---

### 📄 `src/app.ts` (54 lines)

```typescript
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { movieRouter } from './routes/movie.routes.js';
import { env } from './config/env.js';

export function createApp(): Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  // ── Health Check ──────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'Lecture 08 — Movie Recommendation Engine',
      embeddingModel: env.EMBEDDING_MODEL,
      timestamp: new Date().toISOString(),
    });
  });

  // ── API Routes ────────────────────────────────────────────────────────────
  app.use('/api/movies', movieRouter);

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'NotFound',
      message: `${req.method} ${req.originalUrl} does not exist.`,
    });
  });

  // ── Global Error Handler ──────────────────────────────────────────────────
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[UnhandledError]', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: err.message ?? 'An unexpected error occurred.',
    });
  });

  return app;
}
```

### 📄 `src/server.ts` (36 lines)

```typescript
import { createApp } from './app.js';
import { vectorStore } from './services/vector.store.js';
import { env, isLiveOpenAIEnabled } from './config/env.js';

async function bootstrap() {
  // ── Phase 1: Build the catalog ─────────────────────────────────────────────
  // Precompute embeddings for every movie description.
  // This runs ONCE on startup — all subsequent queries are pure vector math.
  await vectorStore.build();

  // ── Phase 2: Start the HTTP server ─────────────────────────────────────────
  const app = createApp();

  app.listen(env.PORT, () => {
    console.log(`
========================================================================
🎬 LECTURE 08: MOVIE RECOMMENDATION ENGINE (Embeddings + Cosine Sim)
========================================================================
📡 Server:          http://localhost:${env.PORT}
🏥 Health:          GET  http://localhost:${env.PORT}/health
🔍 Semantic Search: POST http://localhost:${env.PORT}/api/movies/search
🎞️  All Movies:      GET  http://localhost:${env.PORT}/api/movies
🎯 Similar Movies:  GET  http://localhost:${env.PORT}/api/movies/:id/similar
📊 Catalog Status:  GET  http://localhost:${env.PORT}/api/movies/status
------------------------------------------------------------------------
🤖 Embedding Model: ${env.EMBEDDING_MODEL}
🔑 OpenAI Live:     ${isLiveOpenAIEnabled() ? 'ENABLED ✅' : 'MOCK MODE ⚠️  (set OPENAI_API_KEY for real embeddings)'}
========================================================================
`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap failure:', err);
  process.exit(1);
});
```

---

## 2. Block-by-Block Explanation

### Part A: `src/routes/movie.routes.ts`

#### Block 1: Router and validation schemas

```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { recommendationService, NotFoundError } from '../services/recommendation.service.js';
import { vectorStore } from '../services/vector.store.js';
import { env } from '../config/env.js';

export const movieRouter = Router();

const SearchSchema = z.object({
  query: z.string().min(3, 'Query must be at least 3 characters').max(500),
  topN: z.coerce.number().int().min(1).max(20).optional(),
});

const RecommendSchema = z.object({
  topN: z.coerce.number().int().min(1).max(20).optional(),
});
```

- `Router()` creates a mini-application that `app.ts` mounts at `/api/movies`.
- `SearchSchema` validates the POST body:
  - `query` must be a string of 3–500 characters. The lower bound rejects empty/meaningless input; the upper bound prevents an enormous string from being sent to the embeddings API.
  - `topN` is optional, but when present it is coerced to an integer and clamped to 1–20. `z.coerce.number()` handles the query-string case, where every value is a string.
- `RecommendSchema` validates only `topN` because the movie ID comes from the path and is always a string.

The custom message on `min(3)` is what the client sees in `details`, which makes validation errors actionable.

#### Block 2: `GET /` — list the catalog

```typescript
movieRouter.get('/', (_req: Request, res: Response) => {
  const movies = recommendationService.getAllMovies();
  res.json({
    count: movies.length,
    movies,
  });
});
```

Returns every movie without vectors. The `count` field is redundant with `movies.length`, but it makes health checks and UI badges trivial.

The handler is synchronous because the catalog is already in memory.

#### Block 3: Route ordering — `/status` before `/:id/similar`

```typescript
movieRouter.get('/status', (_req: Request, res: Response) => {
  res.json(vectorStore.status());
});
```

Express matches routes **in declaration order**. `/status` is declared before `/:id/similar` for clarity, although the two patterns do not actually collide: `/status` has one segment, while `/:id/similar` has two. The important ordering fact is that `/status` must not be written as `/:id`, which *would* capture it.

Status reads directly from the store rather than through the recommendation service, because it is an infrastructure concern, not a recommendation feature.

#### Block 4: `POST /search` — validation then orchestration

```typescript
movieRouter.post('/search', async (req: Request, res: Response) => {
  const parsed = SearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'ValidationError',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { query, topN = env.DEFAULT_TOP_N } = parsed.data;

  try {
    const result = await recommendationService.semanticSearch(query, topN);
    res.json(result);
  } catch (err: any) {
    console.error('[POST /movies/search] Error:', err.message);
    res.status(500).json({ error: 'InternalServerError', message: err.message });
  }
});
```

Sequence:

1. **Validate** — `safeParse` never throws; it returns a result object.
2. **Reject with 400** — `parsed.error.flatten().fieldErrors` produces `{ query: ["Query must be at least 3 characters"] }`, which is far more useful than a generic “bad request”.
3. **Destructure with default** — `topN` is `undefined` when omitted, so the default from `env` applies.
4. **Await the service** — this is the only network-dependent endpoint in live mode.
5. **Translate errors** — any failure becomes `500` with the message. No stack trace is leaked.

Because `app.use(express.json())` runs first, `req.body` is already parsed. If the body is missing or malformed JSON, Express rejects it before this handler runs.

#### Block 5: `GET /:id/similar` — path param plus query validation

```typescript
movieRouter.get('/:id/similar', (req: Request, res: Response) => {
  const parsed = RecommendSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'ValidationError',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { topN = env.DEFAULT_TOP_N } = parsed.data;
  const movieId = String(req.params.id);

  try {
    const result = recommendationService.findSimilarMovies(movieId, topN);
    res.json(result);
  } catch (err: any) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'NotFound', message: err.message });
      return;
    }
    console.error('[GET /movies/:id/similar] Error:', err.message);
    res.status(500).json({ error: 'InternalServerError', message: err.message });
  }
});
```

- **`req.query`** holds `?topN=3` as strings; `z.coerce.number()` converts and validates it.
- **`String(req.params.id)`** normalises the path parameter to a string. Express types it as `string`, but `String()` makes the intent explicit and protects against future router changes.
- **No `await`** — the service is synchronous because no embedding call is needed. The absence of `async` is a useful signal in code review: this endpoint performs only local math.
- **`instanceof NotFoundError`** maps missing movies to `404`; every other error maps to `500`.

#### Block 6: Why no `next(err)`?

The handlers catch their own errors and respond directly. This is intentional and explicit. An alternative is to wrap async handlers and forward to the global error handler, but that requires a wrapper helper (Express 4 does not catch rejected promises automatically). For two endpoints, local `try/catch` is clearer and has no extra abstraction.

---

### Part B: `src/app.ts`

#### Block 1: App factory

```typescript
export function createApp(): Express {
  const app = express();
  ...
  return app;
}
```

A **factory** rather than a module-level `const app` has two benefits:

- Tests can create a fresh app per test suite without shared middleware state.
- `server.ts` controls *when* the app is created — after the catalog is ready.

#### Block 2: Middleware order

```typescript
app.use(cors());
app.use(express.json());
```

Order matters:

1. **`cors()`** adds permissive CORS headers so a browser UI on another port can call the API. In production this should be restricted to known origins.
2. **`express.json()`** parses `Content-Type: application/json` bodies into `req.body`. Without it, `req.body` would be `undefined` and every search request would fail validation.

#### Block 3: Request logger

```typescript
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});
```

The timer starts before the route runs and logs on the response's `finish` event. This captures the full handler duration, including the embedding call, and works for both success and error responses.

`next()` is essential; forgetting it would leave every request hanging.

#### Block 4: Health check

```typescript
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'Lecture 08 — Movie Recommendation Engine',
    embeddingModel: env.EMBEDDING_MODEL,
    timestamp: new Date().toISOString(),
  });
});
```

A liveness endpoint that does not touch the vector store. It reports the configured model so operators can confirm which embedding space the instance is using.

#### Block 5: Router mount

```typescript
app.use('/api/movies', movieRouter);
```

Every route in `movie.routes.ts` is prefixed automatically:

| Router path | Effective path |
| :--- | :--- |
| `/` | `/api/movies` |
| `/status` | `/api/movies/status` |
| `/search` | `/api/movies/search` |
| `/:id/similar` | `/api/movies/:id/similar` |

#### Block 6: 404 and global error handler

```typescript
app.use((req, res) => {
  res.status(404).json({
    error: 'NotFound',
    message: `${req.method} ${req.originalUrl} does not exist.`,
  });
});

app.use((err, _req, res, _next) => {
  console.error('[UnhandledError]', err);
  res.status(500).json({
    error: 'InternalServerError',
    message: err.message ?? 'An unexpected error occurred.',
  });
});
```

The 404 middleware must come **after** all routes. Any request that reaches it matched nothing.

The error handler is identified by its **four parameters** — Express treats a middleware with `(err, req, res, next)` as an error handler. It catches errors thrown synchronously in other middleware or passed to `next(err)`. The route-level `try/catch` handles the async cases explicitly.

---

### Part C: `src/server.ts`

#### Block 1: Bootstrap ordering

```typescript
async function bootstrap() {
  await vectorStore.build();

  const app = createApp();

  app.listen(env.PORT, () => { ... });
}
```

The order is the design:

1. **Build first** — embed every movie and set `isReady = true`.
2. **Create the app** — mount routes only after data exists.
3. **Listen last** — the port opens only when the service can actually answer.

If `build()` throws (bad API key, network failure, dimension mismatch), `app.listen` is never reached. Clients get a connection refusal instead of a `500` on a half-initialised service.

#### Block 2: Startup banner

The `console.log` template prints every endpoint plus the mode. It is intentionally verbose: a developer starting the project immediately sees whether they are in mock or live mode.

#### Block 3: Fatal bootstrap handling

```typescript
bootstrap().catch((err) => {
  console.error('Fatal bootstrap failure:', err);
  process.exit(1);
});
```

Because `bootstrap()` is async, a rejected promise would otherwise become an unhandled rejection. The `.catch` logs the cause and exits with a non-zero code so process managers and CI detect the failure.

---

## 3. Endpoint Summary

| Method | Path | Handler | Embedding call? | Success | Failure |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `GET` | `/health` | `app.ts` | No | `200` | — |
| `GET` | `/api/movies` | `GET /` | No | `200` | — |
| `GET` | `/api/movies/status` | `GET /status` | No | `200` | — |
| `POST` | `/api/movies/search` | `POST /search` | Yes (live) | `200` | `400`, `500` |
| `GET` | `/api/movies/:id/similar` | `GET /:id/similar` | No | `200` | `400`, `404`, `500` |

---

## 4. Verification

### Build and start

```bash
npm run build
npm run dev
```

Expected startup log:

```text
[VectorStore] Building catalog: 18 movies...
[EmbeddingService] MOCK MODE — returning stub vectors for batch
[VectorStore] ✅ Catalog ready — 18 movies embedded.
```

Then the banner with `MOCK MODE ⚠️`.

### Health

```bash
curl http://localhost:3008/health
```

Expected: `200` with `status`, `service`, `embeddingModel`, and `timestamp`.

### List

```bash
curl http://localhost:3008/api/movies
```

Expected: `{ "count": 18, "movies": [...] }`, and no movie contains a `vector` key.

### Validation failure

```bash
curl -i -X POST http://localhost:3008/api/movies/search \
  -H "Content-Type: application/json" \
  -d '{"query":"ab"}'
```

Expected:

```text
HTTP/1.1 400 Bad Request
{"error":"ValidationError","details":{"query":["Query must be at least 3 characters"]}}
```

### Invalid `topN`

```bash
curl -i "http://localhost:3008/api/movies/1/similar?topN=999"
```

Expected: `400` with `details.topN` explaining the 20 maximum.

### Unknown route

```bash
curl -i http://localhost:3008/api/nope
```

Expected:

```text
HTTP/1.1 404 Not Found
{"error":"NotFound","message":"GET /api/nope does not exist."}
```

---

**Next:** [Chapter 08 — End-to-End Verification & Production Notes](./08_End_to_End_Verification.md)
