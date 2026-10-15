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
