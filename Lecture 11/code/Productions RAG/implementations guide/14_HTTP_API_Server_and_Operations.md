# Chapter 14: HTTP API, Server and Operations

> **Chapter Goal:** Expose the pipeline over HTTP with validation at the edge, prove every endpoint, and know what to do when a provider is down. This chapter is where "it works on my machine" becomes "it can be operated".

> **Lecture mapping:** Notes Chapter 09 — the API contract, security boundary, degradation paths, latency budget and the runbook.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/app.ts` | 118 | Express app: routes, validation, error mapping, request logging. |
| `src/server.ts` | 40 | Boot, auto-ingest, listen, graceful shutdown. |
| `test-requests.http` | 60 | Every endpoint with example bodies. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run dev                      # watch mode on :3000
# or: npm run build && npm start

curl -s localhost:3000/health | jq
curl -s -X POST localhost:3000/api/query -H 'content-type: application/json' \
  -d '{"question":"How much does express delivery cost?"}' | jq '.answer, .citations'
```

---

## 2. The App — `src/app.ts`

#### 📄 `src/app.ts`

```ts
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';

import type { EmbeddingProvider } from './embeddings/provider.js';
import type { GenerationProvider } from './generation/provider.js';
import { HttpError } from './lib/errors.js';
import type { RagService } from './rag.service.js';
import type { VectorStore } from './store/vector-store.js';

export interface AppDependencies {
  service: RagService;
  store: VectorStore;
  embeddings: EmbeddingProvider;
  generator: GenerationProvider;
}

const querySchema = z.object({
  question: z.string().trim().min(2).max(2000),
  sessionId: z.string().trim().min(1).max(120).optional(),
});

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    res.on('finish', () => {
      const ms = (performance.now() - started).toFixed(1);
      console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  app.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        status: 'healthy',
        service: 'Lecture 11 — RAG API',
        embedding: {
          provider: deps.embeddings.name,
          model: deps.embeddings.model,
          dimensions: deps.embeddings.dimensions,
        },
        generation: { provider: deps.generator.name, model: deps.generator.model },
        store: { kind: deps.store.name, chunks: await deps.store.count() },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  /** The whole product in one endpoint: answer + citations + trace. */
  app.post('/api/query', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = querySchema.parse(req.body);
      res.json(await deps.service.ask(body));
    } catch (error) {
      next(error);
    }
  });

  /** Re-index after the documents change. Slow, idempotent, safe to retry. */
  app.post('/api/ingest', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await deps.service.ingest());
    } catch (error) {
      next(error);
    }
  });

  /** Deleting a conversation is one call: history, memory and caches go together. */
  app.delete('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const deleted = deps.service.resetSession(String(req.params.sessionId));
    res.status(deleted ? 200 : 404).json({ deleted });
  });

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

- **`AppDependencies`** — the app receives `service`, `store`, `embeddings` and `generator`; it builds nothing. A test can pass a fake service without booting providers.
- **`querySchema`** — `question` trimmed, 2–2000 characters; `sessionId` optional, ≤ 120. Validation at the edge means the service never defends against `undefined`.
- **`cors()`** — permissive here because the demo client runs on another port. In production this is an allowlist, not a wildcard.
- **`express.json({ limit: '1mb' })`** — a body limit is a denial-of-service guard. A RAG endpoint has no legitimate reason to receive a megabyte of JSON.
- **The request logger** — `res.on('finish')` with `performance.now()`. It logs status and duration for every request, including 404s and 500s, which is where incidents actually start.
- **`GET /health`** — providers, dimensions, model names, store kind **and the live chunk count**. A health check that does not prove the index is non-empty is decorative.
- **`POST /api/query`** — parse, then `service.ask(body)`. The response is the full `RagAnswer`: answer, citations, refused, sessionId, trace. The API does not hide the trace — it is the product's explainability.
- **`POST /api/ingest`** — re-index on demand. Idempotent, safe to retry, and the only endpoint that can be slow. In production this belongs behind an internal-only route or a job queue.
- **`DELETE /api/sessions/:sessionId`** — 200 when something was deleted, 404 when nothing was. Honest status codes beat cheerful ones.
- **The 404 handler** — after all routes, a JSON body rather than Express's HTML default.
- **The error handler** — three branches:
  - `ZodError` → 400 with `issues[]` (field and message). The client learns exactly what was wrong.
  - `HttpError` → its own status and code.
  - anything else → log the real error, return a generic 500. Stack traces are for logs, not for customers.
- **`if (res.headersSent) return next(error)`** — the guard that prevents `ERR_HTTP_HEADERS_SENT` when a streaming response fails halfway.

**What is deliberately absent**

Authentication. In a real deployment every route behind `/api` sits after an auth middleware, and `sessionId` ownership is checked on load — a session id identifies a record, the token authorises access, and conflating them is an IDOR. The code keeps that boundary visible by never accepting history from the client.

---

## 3. The Server — `src/server.ts`

#### 📄 `src/server.ts`

```ts
import { createApp } from './app.js';
import { createContainer } from './container.js';

async function main(): Promise<void> {
  const container = await createContainer();
  const { env, store, embeddings, generator, service } = container;

  console.log(
    `[boot] embedding=${embeddings.name}/${embeddings.model} dims=${embeddings.dimensions} ` +
      `generation=${generator.name}/${generator.model} store=${store.name}`,
  );

  const chunkCount = await store.count();

  if (chunkCount === 0 && env.AUTO_INGEST) {
    const report = await service.ingest();
    console.log(
      `[boot] ingested ${report.chunks} chunks from ${report.documents} documents ` +
        `in ${report.durationMs}ms`,
    );
  } else {
    console.log(`[boot] ${chunkCount} chunks already indexed`);
  }

  const app = createApp({ service, store, embeddings, generator });
  const server = app.listen(env.PORT, () => {
    console.log(`[boot] listening on http://localhost:${env.PORT}`);
    console.log('[boot] POST /api/query | POST /api/ingest | GET /health');
  });

  const shutdown = (signal: string): void => {
    console.log(`[shutdown] ${signal} received`);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
```

**Block by block:**

- **`createContainer()`** — the only wiring call. Everything below receives objects.
- **The boot log** — `embedding=… dims=… generation=… store=…`. One line that makes a misconfigured deployment obvious before the first request.
- **`await store.count()`** — the decision point for auto-ingest.
- **`if (chunkCount === 0 && env.AUTO_INGEST)`** — index only when there is nothing to serve. Re-ingesting on every boot would add seconds to every deploy and risk serving a partially written index.
- **The ingest log** — chunks, documents, duration. If this line reports `0 chunks`, the process should not have started (chapter 12 throws instead).
- **`server.listen`** — logs the port and the three routes.
- **`shutdown`** — `server.close()` then exit. In-flight requests finish; new connections are refused.
- **`SIGINT` / `SIGTERM`** — the two signals a container runtime actually sends.
- **`main().catch(...)`** — sets `process.exitCode = 1` rather than calling `process.exit(1)` immediately, so buffered logs flush before the process dies. Missing startup logs are the most common reason a failed deploy is undebuggable.

---

## 4. The Request Collection — `test-requests.http`

#### 📄 `test-requests.http`

```http
@host = http://localhost:3000
@json = application/json

### Health — providers, dimensions, chunk count
GET {{host}}/health

### Ask an answerable question
POST {{host}}/api/query
Content-Type: {{json}}

{
  "question": "What is the refund window for apparel?"
}

### The response carries the full trace:
#   answer          grounded text with [n] markers
#   citations[]     label -> source/section, valid=true only when it was in the prompt
#   refused         true when retrieval found nothing above the score floor
#   trace.matches[] what was retrieved and at which score

### Ask for something the documents do not contain (expect the refusal sentence)
POST {{host}}/api/query
Content-Type: {{json}}

{
  "question": "Can I pay with Bitcoin?"
}

### Multi-turn: send the same sessionId, then a follow-up
POST {{host}}/api/query
Content-Type: {{json}}

{
  "question": "What is the refund window for apparel?",
  "sessionId": "demo-session"
}

###
POST {{host}}/api/query
Content-Type: {{json}}

{
  "question": "And for shoes?",
  "sessionId": "demo-session"
}

### Re-index after the documents change (idempotent)
POST {{host}}/api/ingest

### Delete a conversation (history, memory, caches)
DELETE {{host}}/api/sessions/demo-session

### Validation: question too short -> 400 ValidationError
POST {{host}}/api/query
Content-Type: {{json}}

{
  "question": ""
}
```

Each block is a runnable request in VS Code's REST Client or JetBrains' HTTP client. The comments explain what to look for in the response, so the file doubles as documentation.

---

## 5. End-to-End Verification

Real output from the compiled server (`npm run build && PORT=3111 node dist/server.js`).

**Health:**

```json
{"status":"healthy","service":"Lecture 11 — RAG API",
 "embedding":{"provider":"mock","model":"mock-hash-v1","dimensions":1024},
 "generation":{"provider":"extractive","model":"extractive-v1"},
 "store":{"kind":"memory","chunks":19},"timestamp":"2026-10-21T07:09:24.216Z"}
```

**Query:**

```json
{"answer":"- Standard delivery: 3 to 5 business days, 4.99 USD, free for orders over 75 USD. … [1]",
 "citations":[{"label":1,"source":"shipping-policy.md","section":"Delivery options","score":0.3141,"valid":true}],
 "refused":false,"sessionId":"380056e1-…","trace":{…}}
```

**Ingest:**

```json
{"documents":3,"chunks":19,"tokens":895,"skipped":[],"staleSourcesRemoved":[],"durationMs":27,"store":"memory"}
```

**Validation and 404:**

```json
{"error":"ValidationError","issues":[{"path":"question","message":"String must contain at least 2 character(s)"}]}
{"error":"NotFound","message":"GET /nope does not exist."}
```

Four responses that prove the edge is working: valid input succeeds, invalid input is rejected with a field path, unknown routes return JSON, and the health check can prove the index is populated.

---

## 6. Operating It

### Targets worth writing down

| Requirement | Target | Where it comes from |
| :--- | :--- | :--- |
| Faithfulness | ≥ 0.90 | evaluation harness (chapter 13) |
| Invalid citation rate | 0 | `trace.invalidCitations` |
| Refusal accuracy | 12/12 | golden set |
| Recall@4 | ≥ 0.85 | golden set |
| p95 latency | ≤ 3 s end to end | `trace.latencyMs.total` |
| Index freshness | ≤ 15 min after a document change | ingest schedule |
| Cost per question | ≤ $0.002 | `trace` token counts × price |

The mock stack completes in single-digit milliseconds; a real embedding call adds ~50–150 ms and generation dominates at 500 ms–2 s. That is why the refusal path — which skips generation entirely — is the cheapest and fastest thing the system does.

### Degradation paths

| Failure | What the code does today | What production should add |
| :--- | :--- | :--- |
| Embedding provider down | Throws; request fails | Cached query vectors, then 503 with a handoff message |
| Retrieval empty | Refuses, no model call | Same — already correct |
| Generation provider down | Request fails | Fallback model, then a cached answer, then handoff |
| Rate limited | `withRetry` backs off, then throws | Per-tenant quota + jittered queue |
| Index empty at boot | Auto-ingest, or throw if ingestion yields nothing | Alert on `chunks == 0` |
| Stale index after a doc edit | `deleteBySource` + upsert on next ingest | Scheduled ingest + `corpusVersion` in cache keys |

### The runbook

| Symptom | First check | Likely cause |
| :--- | :--- | :--- |
| Everything is refused | `trace.matches` empty? | `MIN_SCORE` too high, or index empty |
| Right source, wrong answer | `trace.contextTokens` | Budget cut the evidence, or prompt order changed |
| Fabricated citation | `trace.invalidCitations` | Prompt edited; label map not rebuilt |
| Answer ignores a follow-up | `trace.searchQuery` | Rewriter disabled or heuristic missed |
| Scores near zero across the board | `trace.providers.embedding` | Query embedded with a different model than the index |
| Duplicate/contradictory facts | `SELECT source, count(*)` in the store | Chunks not replaced on re-ingest |
| Slow under load | `trace.latencyMs` per stage | Generation, not retrieval — the usual culprit |

Each row is one field of the trace. That is the argument for returning the trace from the API: it turns an incident into a lookup.

---

## 7. What Production Needs That This Does Not Have

| Missing | Why it matters | Where it goes |
| :--- | :--- | :--- |
| Authentication + session ownership check | A session id is not a credential | Middleware before `/api` |
| Per-tenant filters inside the query | Filtering after retrieval leaks forbidden text into the prompt | `VectorFilter` + store-side filter |
| Reranker | Precision on noisy corpora | Between retrieval and context assembly |
| Response cache keyed by `corpusVersion` | Most support questions repeat | In front of `ask()` |
| Streaming | Perceived latency for long answers | `generate()` → async iterator |
| Scheduled ingest + blue/green index | Freshness without downtime | A worker, not the request path |
| Token/cost accounting per tenant | The bill is an engineering metric | Trace already has the counts |
| Prompt and corpus version pinning | Reproducing a bad answer | Add both to the trace |

None of them require redesigning the interfaces. That is the test of whether the boundaries were drawn in the right places.

---

## 8. Full Verification Checklist

Run these in order; each one proves a chapter.

```bash
npx tsc --noEmit                 # 01–14 compile under strict mode
npm run ingest                   # 03, 04, 12 — 19 chunks, 3 documents
npm run demo                     # everything, offline, end to end
npm run ask -- "Can I pay with Bitcoin?"   # 07, 09, 12 — refusal, no model call
npm run eval                     # 13 — 12/12 across four metrics
npm run build && npm start       # 14 — health, query, ingest, 404
```

| Check | Expected |
| :--- | :--- |
| `tsc --noEmit` | no output |
| `npm run ingest` | `documents=3 chunks=19` |
| `npm run demo` | seven sections, `invalid=0`, refusal with `generate=0ms` |
| `npm run eval` | `recall@4 1.00`, `citations 12/12`, `refusals 12/12`, `facts 12/12` |
| `/health` | `chunks: 19`, provider names, dimensions |
| `POST /api/query` | answer + citations + trace |

---

## 9. Where to Go Next

1. **Add a reranker.** Retrieve 30, cross-encode, keep 4. It is ~40 lines and one API call, and it is the highest-value upgrade on a noisy corpus.
2. **Replace the heuristic rewriter.** You already have the LLM path — it activates whenever `LLM_PROVIDER=openai`.
3. **Add per-tenant filtering.** Extend `VectorFilter`, pass it through `Retriever`, and put an authorisation check in `app.ts`. Do it before you have two tenants.
4. **Stream the answer.** Change `GenerationProvider.generate` to return an async iterable and pipe it to the response. The trace can still be emitted last.
5. **Add a judge.** Score faithfulness per sentence against the cited chunk, and watch `invalidCitations` become `unsupportedClaims`.

Each of these is an addition to a boundary, not a rewrite of one. That is what the last fourteen chapters were for.

**Back to:** [Implementation Guide Index](./README.md) · **Codebase:** [`../README.md`](../README.md) · **Lecture notes:** [`../../notes/README.md`](../../notes/README.md)
