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
