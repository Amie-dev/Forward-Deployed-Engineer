# Chapter 13: API Routing, Express Application & Stream-Aware Server Bootstrap

> **Chapter Goal:** Expose the three transports, the control endpoints and the observability surface, then configure Node so long streams are not killed by the platform.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/routes/chat.routes.ts` | 249 lines |
| `src/routes/conversation.routes.ts` | 107 lines |
| `src/routes/observability.routes.ts` | 95 lines |
| `src/app.ts` | 116 lines |
| `src/server.ts` | 75 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/routes/chat.routes.ts` (248 lines)

```typescript
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ChatService } from '../services/chat.service.js';
import { streamRegistry } from '../services/stream-registry.js';
import type { DeltaGranularity, SimulationOptions, StreamTransport } from '../types/stream.types.js';

/**
 * Chat router — three endpoints that differ ONLY in how the same generated text
 * is delivered:
 *
 *   POST /api/chat            → buffered JSON     (§3 — the anti-pattern baseline)
 *   POST /api/chat/stream     → text | ndjson | sse (query `?transport=`)
 *   POST /api/chat/events     → always SSE (named events + ids + heartbeats)
 *
 * The wire format is a *delivery* decision, and the API makes that visible.
 */

export const chatRouter = Router();
const chatService = new ChatService();

const ChaosSchema = z
  .object({
    ttftMs: z.number().int().min(0).max(60_000),
    itlMs: z.number().int().min(0).max(5_000),
    stallAfterDeltas: z.number().int().min(0).max(500),
    stallMs: z.number().int().min(0).max(120_000),
    failAfterDeltas: z.number().int().min(0).max(500),
    failCode: z.string().min(1).max(40),
    exceedTtftBudget: z.boolean(),
  })
  .partial();

const ChatRequestSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty').max(8_000),
  conversationId: z.string().min(1).max(80).optional(),
  userId: z.string().min(1).max(80).default('user_demo_001'),
  transport: z.enum(['text', 'ndjson', 'sse']).default('ndjson'),
  granularity: z.enum(['token', 'word', 'sentence', 'random']).default(env.STREAM_GRANULARITY),
  /** Simulator-only fault injection (Chapter 10.5 chaos levels). */
  chaos: ChaosSchema.optional(),
});

const CancelBodySchema = z.object({ reason: z.string().max(200).optional() });

function resolveTransport(req: Request, fallback: StreamTransport): StreamTransport {
  const fromQuery = typeof req.query.transport === 'string' ? req.query.transport : undefined;
  if (fromQuery === 'text' || fromQuery === 'ndjson' || fromQuery === 'sse') return fromQuery;
  return fallback;
}

function buildSimulation(
  chaos: z.infer<typeof ChaosSchema> | undefined,
  granularity: DeltaGranularity
): SimulationOptions | undefined {
  if (!chaos) return { granularity };
  return {
    granularity,
    ttftMs: chaos.ttftMs,
    itlMs: chaos.itlMs,
    stallAfterDeltas: chaos.stallAfterDeltas,
    stallMs: chaos.stallMs,
    failAfterDeltas: chaos.failAfterDeltas,
    failCode: chaos.failCode,
    exceedTtftBudget: chaos.exceedTtftBudget,
  };
}

function sendApiError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  // Only legal while no bytes have been written (see §7.7 — the "easy path").
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ ok: false, error: { code, message, details } });
}

// ============================================================================
// A. Buffered (non-streaming) completion — the comparison baseline
// ============================================================================

/**
 * POST /api/chat
 *
 * Returns ONE JSON body after the whole answer exists. The timings are included
 * deliberately: `ttftMs` is measured internally but the client still waits
 * `totalMs`, which is how the perceived-latency gap is demonstrated.
 */
chatRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendApiError(res, 400, 'invalid_request', 'Invalid request body.', parsed.error.issues);
    return;
  }

  const { message, userId, granularity, chaos } = parsed.data;
  const conversationId = parsed.data.conversationId ?? `conv_${randomUUID().slice(0, 8)}`;

  const result = await chatService.bufferedChat({
    conversationId,
    userId,
    message,
    simulation: buildSimulation(chaos, granularity),
  });

  if (!result.ok) {
    sendApiError(res, result.status, result.error.code, result.error.message, result.error.details);
    return;
  }

  res.status(200).json({
    ok: true,
    mode: 'buffered',
    conversationId,
    reply: result.result.reply,
    usage: result.result.usage,
    timings: result.result.timings,
    history: result.result.history,
    note: 'The body arrived as one piece: TTFT is internal only, the user waits for totalMs.',
  });
});

// ============================================================================
// B. Streaming completion — raw text, NDJSON or SSE
// ============================================================================

/**
 * POST /api/chat/stream?transport=text|ndjson|sse
 *
 * Headers, framing, heartbeats, backpressure and cancellation are handled by the
 * pump. This handler's only job is validate → delegate → map pre-stream errors.
 */
chatRouter.post('/stream', async (req: Request, res: Response): Promise<void> => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendApiError(res, 400, 'invalid_request', 'Invalid request body.', parsed.error.issues);
    return;
  }

  const { message, userId, granularity, chaos } = parsed.data;
  const conversationId = parsed.data.conversationId ?? `conv_${randomUUID().slice(0, 8)}`;
  const transport = resolveTransport(req, parsed.data.transport);

  const result = await chatService.streamChat(res, {
    conversationId,
    userId,
    message,
    transport,
    granularity,
    simulation: buildSimulation(chaos, granularity),
    isRetry: Boolean(req.header('x-stream-retry')),
  });

  if (!result.ok) {
    sendApiError(res, result.status, result.error.code, result.error.message, result.error.details);
  }
  // On success the response has already been written and closed by the pump.
});

/** POST /api/chat/events — an explicit SSE variant of the same pipeline. */
chatRouter.post('/events', async (req: Request, res: Response): Promise<void> => {
  const parsed = ChatRequestSchema.safeParse({ ...req.body, transport: 'sse' });
  if (!parsed.success) {
    sendApiError(res, 400, 'invalid_request', 'Invalid request body.', parsed.error.issues);
    return;
  }

  const { message, userId, granularity, chaos } = parsed.data;
  const conversationId = parsed.data.conversationId ?? `conv_${randomUUID().slice(0, 8)}`;

  const result = await chatService.streamChat(res, {
    conversationId,
    userId,
    message,
    transport: 'sse',
    granularity,
    simulation: buildSimulation(chaos, granularity),
  });

  if (!result.ok) {
    sendApiError(res, result.status, result.error.code, result.error.message, result.error.details);
  }
});

// ============================================================================
// C. Stream control: cancel, catch-up, in-flight inventory
// ============================================================================

/**
 * POST /api/chat/streams/:requestId/cancel
 *
 * Server-side cancellation. The client's own Stop button works by closing the
 * socket (which the pump detects); this endpoint exists for supervisors and for
 * clients whose socket died without a clean teardown.
 */
chatRouter.post('/streams/:requestId/cancel', (req: Request, res: Response): void => {
  const body = CancelBodySchema.safeParse(req.body ?? {});
  const requestId = req.params.requestId as string;
  const cancelled = chatService.cancel(requestId, body.success ? body.data.reason : undefined);

  if (!cancelled) {
    sendApiError(res, 404, 'not_found', `No in-flight stream with requestId "${requestId}".`);
    return;
  }
  res.status(202).json({ ok: true, requestId, cancelled: true });
});

/**
 * GET /api/chat/streams/:requestId/catch-up?fromSeq=N
 *
 * Cursor-based recovery: a client that lost its socket re-reads every frame it
 * missed using the highest sequence number it already applied. Frames are
 * returned verbatim as they were written to the wire, so the client re-uses the
 * exact same parser.
 */
chatRouter.get('/streams/:requestId/catch-up', (req: Request, res: Response): void => {
  const requestId = req.params.requestId as string;
  const fromSeq = Number.parseInt(String(req.query.fromSeq ?? '0'), 10);

  if (!Number.isFinite(fromSeq) || fromSeq < 0) {
    sendApiError(res, 400, 'invalid_request', 'fromSeq must be a non-negative integer.');
    return;
  }

  const entry = streamRegistry.get(requestId);
  const { frames, lastSeq } = chatService.catchUp(requestId, fromSeq);

  res.status(200).json({
    ok: true,
    requestId,
    inflight: Boolean(entry),
    fromSeq,
    lastSeq,
    frames: frames.map((frame) => ({ seq: frame.seq, type: frame.type, payload: frame.payload })),
  });
});

/** GET /api/chat/streams — live inventory (debugging, dashboards, load tests). */
chatRouter.get('/streams', (_req: Request, res: Response): void => {
  res.status(200).json({
    ok: true,
    inflight: streamRegistry.inflight(),
    maxGlobal: env.MAX_CONCURRENT_STREAMS_GLOBAL,
    maxPerConversation: env.MAX_CONCURRENT_STREAMS_PER_CONVERSATION,
    streams: streamRegistry.snapshot(),
  });
});
```


### 📄 `src/routes/conversation.routes.ts` (106 lines)

```typescript
import { Router, type Request, type Response } from 'express';
import { conversationStore } from '../services/conversation.store.js';
import { historyService } from '../services/history.service.js';

/**
 * Conversation router — the *reader* of the dual-written history.
 *
 * These endpoints make the central correctness claim of Chapter 08 inspectable:
 * one user turn + ONE assistant message per generation, with an explicit status
 * (`completed` | `interrupted`) and finish reason, even when the stream died.
 */

export const conversationRouter = Router();

/** GET /api/conversations — recent conversations (id, title, counters). */
conversationRouter.get('/', (_req: Request, res: Response): void => {
  const conversations = conversationStore.list().map((conversation) => ({
    id: conversation.id,
    userId: conversation.userId,
    title: conversation.title,
    messages: conversation.messages.length,
    interrupted: conversation.messages.filter((message) => message.status === 'interrupted').length,
    updatedAt: new Date(conversation.updatedAt).toISOString(),
    locked: conversationStore.isLocked(conversation.id),
  }));

  res.status(200).json({ ok: true, count: conversations.length, conversations });
});

/**
 * GET /api/conversations/:conversationId
 *
 * The transcript, including provenance per message: status, finish reason, token
 * usage and the two streaming timestamps (`createdAt`, `firstTokenAt`).
 */
conversationRouter.get('/:conversationId', (req: Request, res: Response): void => {
  const conversationId = req.params.conversationId as string;
  const conversation = conversationStore.get(conversationId);

  if (!conversation) {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: `Unknown conversation "${conversationId}".` } });
    return;
  }

  res.status(200).json({
    ok: true,
    conversation: {
      id: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      createdAt: new Date(conversation.createdAt).toISOString(),
      updatedAt: new Date(conversation.updatedAt).toISOString(),
      locked: conversationStore.isLocked(conversation.id),
      messages: conversation.messages.map((message) => ({
        id: message.id,
        ordinal: message.ordinal,
        role: message.role,
        content: message.content,
        status: message.status,
        finishReason: message.finishReason,
        usage: message.usage,
        createdAt: new Date(message.createdAt).toISOString(),
        firstTokenAt: message.firstTokenAt === null ? null : new Date(message.firstTokenAt).toISOString(),
        completedAt: message.completedAt === null ? null : new Date(message.completedAt).toISOString(),
      })),
    },
  });
});

/**
 * GET /api/conversations/:conversationId/budget
 *
 * Exactly what the next provider call would send, and why anything was dropped.
 * Prompt length drives TTFT, so this endpoint is a latency tool, not just a cost
 * tool (§3.4 / §8.6).
 */
conversationRouter.get('/:conversationId/budget', (req: Request, res: Response): void => {
  const conversation = conversationStore.get(req.params.conversationId as string);
  const { messages, metrics } = historyService.build(conversation);

  res.status(200).json({
    ok: true,
    metrics,
    messageCount: messages.length,
    // The system prompt is echoed for auditability; history is summarised by size.
    preview: messages.map((message) => ({
      role: message.role,
      characters: message.content.length,
      // Long enough to include the interruption annotation appended to partial
      // answers, so operators can see exactly what the model will be told.
      head: message.content.slice(0, 240),
    })),
  });
});

/** DELETE /api/conversations/:conversationId — right to be forgotten. */
conversationRouter.delete('/:conversationId', (req: Request, res: Response): void => {
  const conversationId = req.params.conversationId as string;
  const removed = conversationStore.delete(conversationId);

  if (!removed) {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: `Unknown conversation "${conversationId}".` } });
    return;
  }
  res.status(200).json({ ok: true, conversationId, purged: true });
});
```


### 📄 `src/routes/observability.routes.ts` (94 lines)

```typescript
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { metrics } from '../lib/metrics.js';
import { describeProvider } from '../providers/index.js';
import { conversationStore } from '../services/conversation.store.js';
import { streamRegistry } from '../services/stream-registry.js';

/**
 * Observability router.
 *
 * The health endpoint answers a question aggregate dashboards cannot: *is the
 * pipeline actually streaming right now?* It reports the p50/p95 of server TTFT,
 * chunk counts and the client-vs-server TTFT gap, plus the single alert rule that
 * catches buffering regressions (§10.3).
 */

export const observabilityRouter = Router();

const ClientTtftSchema = z.object({
  requestId: z.string().min(1).max(80).optional(),
  /** `startedAt` from the `start` frame / the moment the user pressed send. */
  serverTtftMs: z.number().nonnegative().optional(),
  clientTtftMs: z.number().nonnegative(),
});

/** GET /api/observability — streaming health, latency and alerts. */
observabilityRouter.get('/', (_req: Request, res: Response): void => {
  res.status(200).json({
    ok: true,
    service: 'Lecture 06 — AI Streaming Microservice',
    provider: describeProvider(),
    transportKnobs: {
      defaultGranularity: env.STREAM_GRANULARITY,
      coalesceFlushMs: env.STREAM_FLUSH_MS,
      maxChunkChars: env.STREAM_MAX_CHUNK_CHARS,
      heartbeatMs: env.STREAM_HEARTBEAT_MS,
      ttftBudgetMs: env.STREAM_TTFT_BUDGET_MS,
      idleTimeoutMs: env.STREAM_IDLE_TIMEOUT_MS,
      totalTimeoutMs: env.STREAM_TOTAL_TIMEOUT_MS,
      maxClientQueueBytes: env.STREAM_MAX_CLIENT_QUEUE_BYTES,
    },
    inflight: streamRegistry.snapshot(),
    store: conversationStore.stats(),
    latency: metrics.streamLatencySummary(),
    alerts: metrics.alerts(),
  });
});

/**
 * POST /api/observability/client-ttft
 *
 * The client reports the TTFT it *felt*. `clientTTFT − serverTTFT` is the one
 * number that exposes proxy buffering, a buffering middleware, compression on
 * `text/event-stream`, or a frontend that collapsed to `response.text()`.
 */
observabilityRouter.post('/client-ttft', (req: Request, res: Response): void => {
  const parsed = ClientTtftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: { code: 'invalid_request', details: parsed.error.issues } });
    return;
  }

  const { requestId, serverTtftMs, clientTtftMs } = parsed.data;
  const gapMs = metrics.recordClientTtft(serverTtftMs ?? null, clientTtftMs);
  const alerts = metrics.alerts();

  res.status(200).json({
    ok: true,
    requestId,
    clientTtftMs,
    serverTtftMs: serverTtftMs ?? null,
    gapMs,
    threshold: env.TTFT_GAP_ALERT_MS,
    alerts: alerts.map((alert) => alert.name),
  });
});

/**
 * POST /api/observability/reset — test/support endpoint.
 * Disabled in production so a stray call can never wipe the telemetry of a live
 * deployment.
 */
observabilityRouter.post('/reset', (_req: Request, res: Response): void => {
  if (env.NODE_ENV === 'production') {
    res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'Reset is disabled in production.' } });
    return;
  }

  metrics.reset();
  conversationStore.reset();
  streamRegistry.reset();
  res.status(200).json({ ok: true, reset: ['metrics', 'conversations', 'stream-registry'] });
});
```


### 📄 `src/app.ts` (115 lines)

```typescript
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env, isLiveProviderConfigured } from './config/env.js';
import { logger } from './lib/logger.js';
import { metrics } from './lib/metrics.js';
import { chatRouter } from './routes/chat.routes.js';
import { conversationRouter } from './routes/conversation.routes.js';
import { observabilityRouter } from './routes/observability.routes.js';

/**
 * Express application factory.
 *
 * Kept separate from `server.ts` so integration tests can boot the app on an
 * ephemeral port with no side effects — the same pattern used in every streaming
 * test script in `src/scripts/`.
 *
 * Middleware ordering matters for streaming:
 *
 *   1. CORS, so SSE/NDJSON from a browser on another origin is allowed.
 *   2. A request logger that records the *end* of the response — for a stream
 *      that is when the last byte was flushed, not when the handler returned.
 *   3. Static assets (the browser half of this lecture).
 *   4. Routers. NOTE: no compression middleware is registered anywhere, because
 *      gzip on a progressive body re-introduces buffering (hardening #2).
 */

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ exposedHeaders: ['X-Request-Id'] }));
  app.use(express.json({ limit: '256kb' }));

  // Per-request id so one stream can be correlated across logs and metrics.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.header('x-request-id') ?? `http_${randomUUID().slice(0, 8)}`;
    res.setHeader('X-Request-Id', requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
      // For a streaming response `finish` fires when the body is complete: the
      // number below is the TRUE stream duration, not time-to-first-byte.
      logger.debug('HTTP response finished.', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        bytes: res.getHeader('content-length') ?? 'streamed',
      });
    });

    next();
  });

  // The browser client for this lecture (fetch + ReadableStream + TextDecoder).
  app.use(express.static(path.resolve(process.cwd(), 'public'), { etag: false, maxAge: 0 }));

  // ---------------------------------------------------------------------------
  // Health (liveness + config snapshot)
  // ---------------------------------------------------------------------------
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      service: 'lecture-06-ai-streaming',
      model: env.AI_MODEL,
      provider: isLiveProviderConfigured() ? 'openai' : 'simulator',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Prometheus exposition — scrape this to plot TTFT/ITL/chunk distributions.
  app.get('/metrics', (_req: Request, res: Response) => {
    res.status(200).type('text/plain; version=0.0.4; charset=utf-8').send(metrics.renderPrometheus());
  });

  // ---------------------------------------------------------------------------
  // API surface
  // ---------------------------------------------------------------------------
  app.use('/api/chat', chatRouter);
  app.use('/api/conversations', conversationRouter);
  app.use('/api/observability', observabilityRouter);

  // 404 for anything unmatched.
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      ok: false,
      error: { code: 'not_found', message: `Route ${req.method} ${req.originalUrl} does not exist.` },
    });
  });

  // Central error boundary. Streaming errors are handled inside the pump; this
  // catches synchronous/validation failures from the routers.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled request failure.', { error });

    if (res.headersSent) {
      // Headers are gone: the only honest signal left is truncation.
      res.end();
      return;
    }
    res.status(500).json({
      ok: false,
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unexpected server error.',
      },
    });
  });

  return app;
}
```


### 📄 `src/server.ts` (74 lines)

```typescript
import { createApp } from './app.js';
import { env, isLiveProviderConfigured } from './config/env.js';
import { logger } from './lib/logger.js';
import { streamRegistry } from './services/stream-registry.js';

/**
 * Server bootstrap.
 *
 * Two Node-level details decide whether long streams survive in production:
 *
 *  - `requestTimeout` (default 300 s in modern Node) terminates ANY request that
 *    takes longer, including a perfectly healthy long stream. It is raised here
 *    to the generation ceiling plus a margin instead of being disabled.
 *  - `keepAliveTimeout` / `headersTimeout` are aligned ABOVE the proxy's idle
 *    timeout so the proxy does not see a half-closed connection while a stream is
 *    still open (hardening #3).
 */

async function bootstrap(): Promise<void> {
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.record('service.started', {
      mode: isLiveProviderConfigured() ? 'LIVE PROVIDER' : 'SIMULATOR (no API key)',
      model: env.AI_MODEL,
      port: env.PORT,
      defaultGranularity: env.STREAM_GRANULARITY,
      ttftBudgetMs: env.STREAM_TTFT_BUDGET_MS,
      idleTimeoutMs: env.STREAM_IDLE_TIMEOUT_MS,
      heartbeatMs: env.STREAM_HEARTBEAT_MS,
      ui: `http://localhost:${env.PORT}/`,
      streamEndpoint: `POST http://localhost:${env.PORT}/api/chat/stream?transport=sse`,
    });
  });

  // Allow a stream to live as long as the configured ceiling (+ margin), while
  // still refusing genuinely hung requests.
  server.requestTimeout = env.STREAM_TOTAL_TIMEOUT_MS + 30_000;
  server.headersTimeout = server.requestTimeout + 5_000;
  server.keepAliveTimeout = 65_000;

  /**
   * Graceful shutdown with stream awareness.
   *
   * On SIGTERM/SIGINT: stop accepting connections, signal every in-flight stream
   * so it flushes an in-band error and persists its partial turn, then exit.
   * Without this, a deploy produces N "vanishing turns" — the exact class of bug
   * §8.5 is about.
   */
  const shutdown = (signal: string): void => {
    logger.record('service.shutdown', { signal, inflight: streamRegistry.inflight() });

    const inflight = streamRegistry.snapshot();
    for (const stream of inflight) {
      streamRegistry.cancel(stream.requestId, 'internal_error', `Server ${signal} shutdown.`);
    }

    server.close(() => {
      logger.record('service.stopped', { drainedStreams: inflight.length });
      process.exit(0);
    });

    // Hard deadline: do not hang forever on a wedged socket.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.error('Fatal bootstrap failure.', { error });
  process.exit(1);
});
```


---

## 3. Block-by-Block Explanation

### Part A: `chat.routes.ts` — three transports, one pipeline

#### Block 1: Validation happens before anything is written

```typescript
const ChatRequestSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty').max(8_000),
  conversationId: z.string().min(1).max(80).optional(),
  userId: z.string().min(1).max(80).default('user_demo_001'),
  transport: z.enum(['text', 'ndjson', 'sse']).default('ndjson'),
  granularity: z.enum(['token', 'word', 'sentence', 'random']).default(env.STREAM_GRANULARITY),
  chaos: ChaosSchema.optional(),
});

function sendApiError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  if (res.headersSent) { res.end(); return; }     // ← the status is already gone
  res.status(status).json({ ok: false, error: { code, message, details } });
}
```

- **What it does:** rejects malformed requests and oversized payloads before a single byte is streamed.
- **How it works:** `max(8_000)` bounds the input and the `chaos` object is the fault-injection surface. `sendApiError`'s `headersSent` guard is the one-line expression of the lecture's rule: a real status is only possible *before* the first byte, so after that the only honest option is to end the response (the in-band error frame has already been written by the pump).

#### Block 2: The buffered endpoint

```typescript
const result = await chatService.bufferedChat({ conversationId, userId, message, simulation });
if (!result.ok) { sendApiError(res, result.status, result.error.code, result.error.message, result.error.details); return; }

res.status(200).json({ ok: true, mode: 'buffered', reply: result.result.reply, usage: …, timings: …, history: …,
  note: 'The body arrived as one piece: TTFT is internal only, the user waits for totalMs.' });
```

- **What it does:** is the comparison baseline, with the comparison baked into the response.
- **How it works:** returning the *internal* `ttftMs` alongside `totalMs` lets any client prove the difference: the model produced its first token at `ttftMs`, but the caller received nothing until `totalMs`. This endpoint is what the CI suite uses as a negative control.

#### Block 3: The streaming endpoints

```typescript
chatRouter.post('/stream', async (req, res) => {
  /* … parse … */
  const transport = resolveTransport(req, parsed.data.transport);   // ?transport= wins over the body
  const result = await chatService.streamChat(res, { conversationId, userId, message, transport, granularity, simulation });
  if (!result.ok) sendApiError(res, result.status, result.error.code, result.error.message, result.error.details);
  // On success the response has already been written and closed by the pump.
});
```

- **What it does:** exposes the same pipeline over three wire formats.
- **How it works:** the route does **nothing** with the response body — the pump owns it. `?transport=` takes precedence over the JSON body so a browser can switch transports without rebuilding the payload. The comment on the success path matters: a route that tries to `res.json()` after streaming has already happened is a classic bug, and the code says so explicitly.

#### Block 4: Control and recovery endpoints

```typescript
chatRouter.post('/streams/:requestId/cancel', (req, res) => { … chatService.cancel(requestId, reason) … });

chatRouter.get('/streams/:requestId/catch-up', (req, res) => {
  const fromSeq = Number.parseInt(String(req.query.fromSeq ?? '0'), 10);
  const { frames, lastSeq } = chatService.catchUp(requestId, fromSeq);
  res.status(200).json({ ok: true, requestId, inflight: Boolean(entry), fromSeq, lastSeq,
    frames: frames.map((frame) => ({ seq: frame.seq, type: frame.type, payload: frame.payload })) });
});
```

- **What it does:** completes the lifecycle: cancel a running stream, recover a broken socket, inspect what is live.
- **How it works:** `cancel` answers `202 Accepted` when the stream exists and `404` when it does not — honest status codes, because these routes have not written a body yet. `catch-up` returns frames **verbatim**, so the client re-uses the exact parser it already has (demonstrated by the UI's "Drop & recover" button).

---

### Part B: `conversation.routes.ts` — reading the dual write

#### Block 5: The transcript with provenance

```typescript
messages: conversation.messages.map((message) => ({
  id: message.id, ordinal: message.ordinal, role: message.role, content: message.content,
  status: message.status, finishReason: message.finishReason, usage: message.usage,
  createdAt: new Date(message.createdAt).toISOString(),
  firstTokenAt: message.firstTokenAt === null ? null : new Date(message.firstTokenAt).toISOString(),
  completedAt: message.completedAt === null ? null : new Date(message.completedAt).toISOString(),
}))
```

- **What it does:** exposes the record that proves the central claim of Chapter 08 — one message per turn, with status.
- **How it works:** `status` and `finishReason` are returned per message so the UI can badge a partial answer, and `firstTokenAt` makes historical TTFT auditable after the fact. This is the endpoint the cancellation test uses to assert "one message, flagged `interrupted`, byte-for-byte what the user saw".

#### Block 6: The budget inspector

```typescript
conversationRouter.get('/:conversationId/budget', (req, res) => {
  const { messages, metrics } = historyService.build(conversationStore.get(req.params.conversationId as string));
  res.status(200).json({ ok: true, metrics, messageCount: messages.length,
    preview: messages.map((message) => ({ role: message.role, characters: message.content.length, head: message.content.slice(0, 240) })) });
});
```

- **What it does:** answers "what will the next prompt actually contain?" without calling a provider.
- **How it works:** the 240-character head is long enough to include the interruption annotation appended to partial answers, which is how the test verifies that the model is told a previous answer was cut off. Prompt length drives TTFT, so this is a latency tool as much as a debugging tool.

---

### Part C: `observability.routes.ts` — the streaming dashboard

#### Block 7: Health, latency and alerts in one payload

```typescript
observabilityRouter.get('/', (_req, res) => {
  res.status(200).json({
    ok: true, service: 'Lecture 06 — AI Streaming Microservice', provider: describeProvider(),
    transportKnobs: { defaultGranularity, coalesceFlushMs, maxChunkChars, heartbeatMs, ttftBudgetMs, idleTimeoutMs, totalTimeoutMs, maxClientQueueBytes },
    inflight: streamRegistry.snapshot(), store: conversationStore.stats(),
    latency: metrics.streamLatencySummary(), alerts: metrics.alerts(),
  });
});
```

- **What it does:** answers the question aggregate dashboards cannot: *is the pipeline actually streaming right now, and how is it configured?*
- **How it works:** the response pairs the *policy* (the knobs in force) with the *outcome* (p50/p95 of server and client TTFT, the gap, ITL, chunks per response, TPS) and the alert state. When a streaming regression is reported, this single call shows whether the configuration or the runtime changed.

#### Block 8: Client TTFT reporting — the gap alert's input

```typescript
const gapMs = metrics.recordClientTtft(serverTtftMs ?? null, clientTtftMs);
res.status(200).json({ ok: true, requestId, clientTtftMs, serverTtftMs: serverTtftMs ?? null, gapMs,
  threshold: env.TTFT_GAP_ALERT_MS, alerts: metrics.alerts().map((alert) => alert.name) });
```

- **What it does:** accepts the one number only the client can measure, and turns it into the alert rule.
- **How it works:** the browser posts the TTFT it felt together with the server TTFT it received in the `done` frame; the registry computes the gap and evaluates `p95 > threshold`. The endpoint returns the gap and the alert names immediately, so the UI's telemetry panel can display the diagnosis at the moment it happens.

#### Block 9: The guarded reset

```typescript
if (env.NODE_ENV === 'production') { res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'Reset is disabled in production.' } }); return; }
metrics.reset(); conversationStore.reset(); streamRegistry.reset();
```

- **What it does:** gives tests and demos a clean slate, and refuses to do so in production.
- **How it works:** a support endpoint that can wipe telemetry is a liability in production, so it is gated on `NODE_ENV`. Because it is guarded, the verification scripts can rely on a deterministic starting state without any test-only build.

---

### Part D: `app.ts` — the Express factory

#### Block 10: Middleware order, and the middleware that is deliberately absent

```typescript
app.disable('x-powered-by');
app.use(cors({ exposedHeaders: ['X-Request-Id'] }));
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  const requestId = req.header('x-request-id') ?? `http_${randomUUID().slice(0, 8)}`;
  res.setHeader('X-Request-Id', requestId);
  const startedAt = Date.now();
  res.on('finish', () => logger.debug('HTTP response finished.', { requestId, method: req.method, path: req.originalUrl, status: res.statusCode, durationMs: Date.now() - startedAt, bytes: res.getHeader('content-length') ?? 'streamed' }));
  next();
});

app.use(express.static(path.resolve(process.cwd(), 'public'), { etag: false, maxAge: 0 }));
```

- **What it does:** wires CORS, body parsing, correlation ids and the browser client.
- **How it works:** **no compression middleware is registered** — gzip on a progressive body re-buffers it and silently destroys streaming, so its absence is a design decision (hardening #2). The logger hooks `finish`, which for a streaming response fires when the last byte is flushed, so `durationMs` is the true stream duration rather than time-to-first-byte. `etag: false` and `maxAge: 0` stop the browser client being cached during a lecture.

#### Block 11: Routes, 404 and the error boundary

```typescript
app.get('/metrics', (_req, res) => { res.status(200).type('text/plain; version=0.0.4; charset=utf-8').send(metrics.renderPrometheus()); });
app.use('/api/chat', chatRouter);
app.use('/api/conversations', conversationRouter);
app.use('/api/observability', observabilityRouter);

app.use((req, res) => { res.status(404).json({ ok: false, error: { code: 'not_found', message: `Route ${req.method} ${req.originalUrl} does not exist.` } }); });

app.use((error, _req, res, _next) => {
  logger.error('Unhandled request failure.', { error });
  if (res.headersSent) { res.end(); return; }     // headers gone: truncation is the only signal left
  res.status(500).json({ ok: false, error: { code: 'internal_error', message: … } });
});
```

- **What it does:** mounts the three routers and guarantees every response ends deliberately.
- **How it works:** `createApp()` is a *factory*, which is what allows every script to boot the app on an ephemeral port in-process. The error boundary checks `headersSent` first: for a stream that already started, the only honest action is to end the response and let the pump's in-band error frame do the explaining.

---

### Part E: `server.ts` — surviving the platform

#### Block 12: Node's own timeouts are a streaming hazard

```typescript
const server = app.listen(env.PORT, () => { logger.record('service.started', { mode: isLiveProviderConfigured() ? 'LIVE PROVIDER' : 'SIMULATOR (no API key)', … }); });

server.requestTimeout = env.STREAM_TOTAL_TIMEOUT_MS + 30_000;
server.headersTimeout = server.requestTimeout + 5_000;
server.keepAliveTimeout = 65_000;
```

- **What it does:** aligns the runtime's timeouts with the streaming policy.
- **How it works:** Node's default `requestTimeout` (300 s) terminates **any** request that takes longer — including a healthy long stream. Raising it to the generation ceiling plus a margin keeps genuinely hung requests bounded while never killing a legitimate answer. `keepAliveTimeout` is set above the typical 60 s proxy idle timeout so the proxy never sees a half-closed connection while a stream is open (hardening #3).

#### Block 13: Stream-aware graceful shutdown

```typescript
const shutdown = (signal: string): void => {
  logger.record('service.shutdown', { signal, inflight: streamRegistry.inflight() });
  const inflight = streamRegistry.snapshot();
  for (const stream of inflight) {
    streamRegistry.cancel(stream.requestId, 'internal_error', `Server ${signal} shutdown.`);
  }
  server.close(() => { logger.record('service.stopped', { drainedStreams: inflight.length }); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();   // hard deadline
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

- **What it does:** shuts down without producing "vanishing turns".
- **How it works:** instead of dropping in-flight generations, every registered stream is cancelled with an explicit reason, which makes each pump write its in-band error, persist its partial answer and release its lock *before* the process exits. That is precisely the class of bug §8.5 is about — a deploy must not lose what users were reading. The 10-second hard deadline prevents a wedged socket from blocking a rollout forever.

---

### ✅ Chapter 13 verification

```bash
npm run dev
curl -s localhost:8090/health
curl -s localhost:8090/ | grep -o '<title>.*</title>'
curl -sD - -o /dev/null -X POST 'localhost:8090/api/chat/stream?transport=ndjson' \
  -H 'Content-Type: application/json' -d '{"message":"hi"}' | grep -i transfer-encoding
```




---

**Previous:**  · **Next:** 
