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
