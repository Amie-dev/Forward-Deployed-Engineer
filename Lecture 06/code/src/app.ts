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
