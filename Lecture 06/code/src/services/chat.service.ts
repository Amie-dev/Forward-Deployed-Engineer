import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { jitter, nowMs, sleep } from '../lib/timing.js';
import { resolveProvider } from '../providers/index.js';
import { classifyProviderError, ProviderStreamError } from '../providers/provider.errors.js';
import { PreStreamError, StreamPump, type StreamOutcome } from '../stream/stream-pump.js';
import { conversationStore } from './conversation.store.js';
import { historyService, type HistoryBudgetMetrics } from './history.service.js';
import { streamRegistry } from './stream-registry.js';
import type {
  DeltaGranularity,
  ProviderStream,
  ProviderStreamRequest,
  SimulationOptions,
  StreamErrorCode,
  StreamProvider,
  StreamTransport,
  TokenUsage,
} from '../types/stream.types.js';

/**
 * ChatService — the orchestration layer.
 *
 * The rules it enforces, in order:
 *
 *   1. **Admission control first.** Concurrency caps and the per-conversation
 *      lock are checked BEFORE any bytes are written, so a busy conversation
 *      legitimately answers `409`, not a truncated 200 (§7.7).
 *   2. **Validate everything that can still fail.** Payload/token budgets are
 *      enforced here, again before the status line.
 *   3. **The provider call retries only before the first token.** After the first
 *      byte, a retry would duplicate fragments in the user's bubble.
 *   4. **Everything after the first byte is signalled in-band** by the pump.
 */

export interface StreamChatInput {
  conversationId: string;
  userId: string;
  message: string;
  transport: StreamTransport;
  granularity: DeltaGranularity;
  /** Simulator-only chaos knobs (see the `?chaos=` query parameters). */
  simulation?: SimulationOptions;
  /** `true` when the client is re-issuing a request it already aborted once. */
  isRetry?: boolean;
}

export interface BufferedChatInput {
  conversationId: string;
  userId: string;
  message: string;
  simulation?: SimulationOptions;
}

export interface ApiError {
  code: StreamErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type StreamChatResult = { ok: true; outcome: StreamOutcome } | { ok: false; status: number; error: ApiError };

export interface BufferedChatResult {
  reply: string;
  usage: TokenUsage | null;
  timings: { ttftMs: number; totalMs: number; chunks: number };
  history: HistoryBudgetMetrics;
  assistantMessageId: string;
}

export class ChatService {
  constructor(private readonly maxProviderAttempts = 3) {}

  // ==========================================================================
  // 1. The streaming path
  // ==========================================================================

  public async streamChat(res: Response, input: StreamChatInput): Promise<StreamChatResult> {
    const provider = resolveProvider();

    // --- Admission control (nothing written yet: real HTTP statuses apply) ---
    const admission = streamRegistry.acquire(input.conversationId);
    if (!admission.ok) {
      metrics.increment('stream_admission_rejected_total', { reason: admission.reason });
      return {
        ok: false,
        status: admission.reason === 'global_limit' ? 429 : 409,
        error: {
          code: admission.reason === 'global_limit' ? 'stream_concurrency_exceeded' : 'conversation_busy',
          message:
            admission.reason === 'global_limit'
              ? 'Server stream capacity reached. Retry shortly.'
              : 'This conversation already has a generation in flight. Stop it or open another conversation.',
          details: { inflight: admission.inflight, conversationInflight: admission.conversationInflight },
        },
      };
    }

    // --- Per-conversation serialisation (fail fast instead of queueing) ------
    const locked = await conversationStore.runExclusive(
      input.conversationId,
      async () => this.runStreamingTurn(res, input, provider),
      0
    );

    if (!locked.acquired) {
      metrics.increment('stream_admission_rejected_total', { reason: 'conversation_lock' });
      return {
        ok: false,
        status: 409,
        error: { code: 'conversation_busy', message: 'Another turn in this conversation is still running.' },
      };
    }

    return locked.value;
  }

  private async runStreamingTurn(
    res: Response,
    input: StreamChatInput,
    provider: ReturnType<typeof resolveProvider>
  ): Promise<StreamChatResult> {
    const requestId = `req_${randomUUID()}`;
    // Generated BEFORE the stream starts ⇒ the later persistence call is idempotent.
    const assistantMessageId = `msg_${randomUUID()}`;

    // 1. Record the user's turn (the only write on the hot path).
    conversationStore.appendUserMessage(input.conversationId, input.userId, input.message);

    // 2. Assemble budgeted context — prompt length drives TTFT (§3.4).
    const conversation = conversationStore.get(input.conversationId);
    const { messages, metrics: historyMetrics } = historyService.build(conversation);

    if (historyMetrics.overBudget) {
      metrics.increment('stream_admission_rejected_total', { reason: 'payload_too_large' });
      return {
        ok: false,
        status: 413,
        error: {
          code: 'invalid_request',
          message: `The message exceeds the ${historyMetrics.budgetTokens}-token context budget. Shorten it or start a new conversation.`,
          details: { ...historyMetrics },
        },
      };
    }

    // 3. One pump per request. No mutable state is shared between requests.
    const pump = new StreamPump({
      res,
      transport: input.transport,
      granularity: input.granularity,
      conversationId: input.conversationId,
      requestId,
      assistantMessageId,
      model: env.AI_MODEL,
      providerName: provider.name,
      onFrame: (frame, payload) => streamRegistry.recordFrame(requestId, frame, payload),
      // Dual-write step 2: exactly ONE assistant message, upserted by stable id.
      onPersist: async (outcome) => {
        conversationStore.upsertAssistantMessage({
          conversationId: outcome.conversationId,
          messageId: outcome.assistantMessageId,
          content: outcome.content,
          status: outcome.status,
          finishReason: outcome.finishReason,
          usage: outcome.usage,
          firstTokenAt: outcome.firstTokenAt,
          completedAt: outcome.completedAt,
        });
      },
    });

    streamRegistry.register({
      requestId,
      conversationId: input.conversationId,
      transport: input.transport,
      startedAt: Date.now(),
      abort: (code, message) => pump.abort(code, message),
    });

    const providerRequest: ProviderStreamRequest = {
      conversationId: input.conversationId,
      requestId,
      messages,
      model: env.AI_MODEL,
      temperature: env.AI_TEMPERATURE,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      abortSignal: pump.signal,
      simulation: input.simulation,
    };

    try {
      const outcome = await pump.run((signal) =>
        this.openProviderStream(provider, { ...providerRequest, abortSignal: signal }, input.isRetry ?? false)
      );
      return { ok: true, outcome };
    } catch (error) {
      if (error instanceof PreStreamError) {
        // The provider refused the call and NOTHING was written: map it to a real
        // HTTP status — the "easy path" of §7.7.
        logger.warn('Provider call failed before streaming started.', {
          requestId,
          code: error.providerError.code,
        });
        return {
          ok: false,
          status: error.providerError.code === 'provider_timeout' ? 504 : 502,
          error: {
            code: error.providerError.code,
            message: error.providerError.retryable
              ? 'The AI provider is temporarily unavailable. Please retry.'
              : error.providerError.message,
          },
        };
      }

      logger.error('Unexpected failure while streaming.', { requestId, error });
      if (!res.headersSent) {
        return { ok: false, status: 500, error: { code: 'internal_error', message: 'Unexpected streaming failure.' } };
      }
      res.end();
      return { ok: false, status: 500, error: { code: 'internal_error', message: 'Unexpected streaming failure.' } };
    } finally {
      streamRegistry.release(requestId);
    }
  }

  // ==========================================================================
  // 2. Provider retry — ONLY before the first token
  // ==========================================================================

  private async openProviderStream(
    provider: StreamProvider,
    request: ProviderStreamRequest,
    _isRetry: boolean
  ): Promise<ProviderStream> {
    let attempt = 0;
    let lastError: ProviderStreamError | null = null;

    while (attempt < this.maxProviderAttempts) {
      attempt += 1;
      try {
        return await provider.stream(request);
      } catch (error) {
        const classified = classifyProviderError(error);
        lastError = classified;

        // This helper runs BEFORE `writeHead`, i.e. while a retry is still safe:
        // no bytes have been written, so no fragment can be duplicated.
        const canRetry =
          classified.retryable && attempt < this.maxProviderAttempts && !request.abortSignal.aborted;

        if (!canRetry) throw classified;

        metrics.increment('provider_retries_total', { code: classified.code });
        // Jittered backoff: deterministic backoff makes every client retry in
        // lockstep, which is exactly what a recovering provider does not need.
        await sleep(jitter(250 * attempt), request.abortSignal);
        logger.debug('Retrying provider call before the first token.', { attempt, code: classified.code });
      }
    }

    throw lastError ?? new ProviderStreamError('provider_error', 'Provider unavailable.');
  }

  // ==========================================================================
  // 3. The buffered path — same provider, different consumer
  // ==========================================================================

  /**
   * Non-streaming chat, kept deliberately in the same class to make the lecture's
   * central comparison executable:
   *
   *   Same model. Same provider. Same history. Same persistence.
   *   Only the CONSUMER changes: `.call()` drains the stream into one value.
   *
   * The returned timings show TTFT ≈ total, which is exactly the diagnostic that
   * catches a buffering regression in CI (§10.5).
   */
  public async bufferedChat(
    input: BufferedChatInput
  ): Promise<{ ok: true; result: BufferedChatResult } | { ok: false; status: number; error: ApiError }> {
    const provider = resolveProvider();
    const startedAt = nowMs();

    conversationStore.appendUserMessage(input.conversationId, input.userId, input.message);

    const { messages, metrics: historyMetrics } = historyService.build(conversationStore.get(input.conversationId));
    if (historyMetrics.overBudget) {
      return {
        ok: false,
        status: 413,
        error: { code: 'invalid_request', message: 'Message exceeds the context budget.', details: { ...historyMetrics } },
      };
    }

    const controller = new AbortController();
    const assistantMessageId = `msg_${randomUUID()}`;

    let stream: ProviderStream;
    try {
      stream = await this.openProviderStream(
        provider,
        {
          conversationId: input.conversationId,
          requestId: `req_${randomUUID()}`,
          messages,
          model: env.AI_MODEL,
          temperature: env.AI_TEMPERATURE,
          maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
          abortSignal: controller.signal,
          simulation: input.simulation,
        },
        false
      );
    } catch (error) {
      const classified = classifyProviderError(error);
      return { ok: false, status: classified.code === 'provider_timeout' ? 504 : 502, error: { code: classified.code, message: classified.message } };
    }

    const parts: string[] = [];
    let firstDeltaAt: number | null = null;
    let usage: TokenUsage | null = null;

    // ⚠️ THE BUFFERING LINE. In streaming mode this loop writes to the socket;
    // here it accumulates — the "collector operator" that must never appear on a
    // streaming path (hardening checklist #7).
    for await (const delta of stream) {
      if (delta.usage) usage = delta.usage;
      if (delta.text.length === 0) continue;
      if (firstDeltaAt === null) firstDeltaAt = nowMs();
      parts.push(delta.text);
    }

    const completedAt = nowMs();
    const content = parts.join('');
    const result: BufferedChatResult = {
      reply: content,
      usage,
      timings: {
        ttftMs: firstDeltaAt === null ? 0 : Math.round(firstDeltaAt - startedAt),
        totalMs: Math.round(completedAt - startedAt),
        chunks: parts.length,
      },
      history: historyMetrics,
      assistantMessageId,
    };

    conversationStore.upsertAssistantMessage({
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      content,
      status: 'completed',
      finishReason: 'stop',
      usage,
      firstTokenAt: firstDeltaAt === null ? null : Math.round(firstDeltaAt),
      completedAt: Math.round(completedAt),
    });

    metrics.observe('buffered_total_ms', result.timings.totalMs, {}, 'non-streaming response duration');
    return { ok: true, result };
  }

  // ==========================================================================
  // 4. Explicit cancellation
  // ==========================================================================

  public cancel(requestId: string, reason = 'Cancelled by API request.'): boolean {
    const cancelled = streamRegistry.cancel(requestId, 'client_aborted', reason);
    logger.info('Stream cancellation requested.', { requestId, cancelled });
    return cancelled;
  }

  /** Frames the client has not seen yet — used after a socket loss. */
  public catchUp(requestId: string, fromSeq: number): { frames: ReturnType<typeof streamRegistry.replay>; lastSeq: number } {
    const frames = streamRegistry.replay(requestId, fromSeq);
    const lastSeq = frames.length ? (frames[frames.length - 1] as { seq: number }).seq : fromSeq;
    return { frames, lastSeq };
  }
}
