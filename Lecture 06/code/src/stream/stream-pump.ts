import type { Response } from 'express';
import { env } from '../config/env.js';
import { logger, type Logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { encodeFrame, streamResponseHeaders, utf8ByteLength } from '../lib/text-codec.js';
import { elapsedMs, nowMs } from '../lib/timing.js';
import { BackpressureWriter } from './backpressure.js';
import { DeltaCoalescer } from './delta-coalescer.js';
import { classifyProviderError, ProviderStreamError } from '../providers/provider.errors.js';
import type {
  DeltaGranularity,
  FinishReason,
  MessageStatus,
  ProviderDelta,
  ProviderStream,
  StreamErrorCode,
  StreamFrame,
  StreamTelemetry,
  StreamTransport,
  TokenUsage,
} from '../types/stream.types.js';

/**
 * ============================================================================
 * THE STREAM PUMP — one generation, one request, one socket.
 * ============================================================================
 *
 * This class is the reference implementation of the seven pipeline invariants
 * from §6.3. Every other module exists to support it:
 *
 *   1. Forward, never accumulate     → we write each coalesced chunk immediately;
 *                                      the ONLY buffer is the dual-write history one.
 *   2. Flush per chunk               → `flushHeaders()` + one `write()` per chunk.
 *   3. Intermediaries must not buffer→ `X-Accel-Buffering: no`, no compression.
 *   4. The connection must not idle  → heartbeat timer + idle watchdog.
 *   5. The client must read chunks   → nothing here; enforced client-side (§9).
 *   6. Append, don't replace         → the `delta` frame contract (append-only).
 *   7. Cancellation must propagate   → AbortController → provider signal.
 *
 * Error philosophy (§7.7):
 *   - failures BEFORE the status line is written are thrown to the caller so a
 *     real HTTP status can be returned (`PreStreamError`);
 *   - failures AFTER it are reported in-band and the partial text is persisted.
 */

export interface StreamPumpOptions {
  res: Response;
  transport: StreamTransport;
  granularity: DeltaGranularity;
  conversationId: string;
  requestId: string;
  /** Generated BEFORE the stream starts ⇒ the later upsert is idempotent. */
  assistantMessageId: string;
  model: string;
  providerName: string;
  /** Observe every frame (the registry keeps them for catch-up/replay). */
  onFrame?: (frame: StreamFrame, payload: string) => void;
  /** Dual-write persistence hook — invoked EXACTLY once, after the stream ends. */
  onPersist?: (outcome: StreamOutcome) => Promise<void> | void;
}

export interface StreamOutcome {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
  status: MessageStatus;
  finishReason: FinishReason;
  errorCode?: StreamErrorCode;
  /** The reconstructed assistant message (never the fragments). */
  content: string;
  usage: TokenUsage | null;
  firstTokenAt: number | null;
  completedAt: number | null;
  aborted: boolean;
  telemetry: StreamTelemetry;
}

/** Thrown when the provider failed before a single byte reached the client. */
export class PreStreamError extends Error {
  constructor(public readonly providerError: ProviderStreamError) {
    super(providerError.message);
    this.name = 'PreStreamError';
  }
}

interface Termination {
  code: StreamErrorCode;
  message: string;
  recoverable: boolean;
}

const CLIENT_SLOW_DRAIN_TIMEOUT_MS = 15_000;

export class StreamPump {
  private readonly writer: BackpressureWriter;
  private readonly coalescer = new DeltaCoalescer();
  private readonly abortController = new AbortController();
  private readonly log: Logger;
  private readonly startedAt = nowMs();

  /** Serialises ALL socket writes so frame order (and `seq`) stays monotonic. */
  private writeChain: Promise<void> = Promise.resolve();

  /** Dual-write buffer: stream out, keep in memory, persist once (§8.2). */
  private readonly chunks: string[] = [];

  private seq = 0;
  private chars = 0;
  private firstDeltaAt: number | null = null;
  private lastDeltaAt = 0;
  private lastWriteAt = 0;
  private usage: TokenUsage | null = null;
  private finishReason: FinishReason = 'stop';
  private termination: Termination | null = null;
  private headersWritten = false;
  private ticker: NodeJS.Timeout | null = null;
  private readonly itlSamples: number[] = [];

  constructor(private readonly options: StreamPumpOptions) {
    this.writer = new BackpressureWriter(options.res, env.STREAM_MAX_CLIENT_QUEUE_BYTES);
    this.log = logger.child({
      requestId: options.requestId,
      conversationId: options.conversationId,
      transport: options.transport,
    });

    // Client socket closed (tab closed, network drop, Stop pressed):
    // propagate the cancellation upstream instead of paying for a zombie answer.
    options.res.on('close', () => {
      if (!options.res.writableEnded) this.abort('client_aborted', 'Client disconnected mid-stream.');
    });
  }

  // --------------------------------------------------------------------------
  // Public surface
  // --------------------------------------------------------------------------

  /** Hand this to the provider: it is how cancellation reaches the token stream. */
  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public get id(): string {
    return this.options.requestId;
  }

  /** Used by `POST /api/chat/streams/:requestId/cancel`. */
  public abort(code: StreamErrorCode, message: string, recoverable = false): void {
    if (this.termination) return;
    this.termination = { code, message, recoverable };
    this.abortController.abort();
  }

  /**
   * Run one generation end-to-end.
   *
   * `openStream` is a FACTORY rather than a stream so that provider failures
   * raised while establishing the call can still produce a real HTTP status.
   */
  public async run(openStream: (signal: AbortSignal) => Promise<ProviderStream>): Promise<StreamOutcome> {
    let stream: ProviderStream;

    try {
      stream = await openStream(this.abortController.signal);
    } catch (error) {
      // Nothing has been written yet ⇒ the caller may retry or reply 4xx/5xx.
      throw new PreStreamError(classifyProviderError(error));
    }

    // From here on the status line is frozen at 200 OK.
    this.openResponse();
    this.startTicker();

    try {
      for await (const delta of stream) {
        if (this.abortController.signal.aborted) break;
        await this.enqueue(() => this.handleDelta(delta));
        if (this.termination) break;
      }
    } catch (error) {
      if (this.abortController.signal.aborted) {
        // Expected: watchdog or client abort unwound the provider iteration.
        this.log.debug('Provider iteration unwound by cancellation.', { code: this.termination?.code ?? 'aborted' });
      } else {
        const providerError = classifyProviderError(error);
        this.termination ??= {
          code: providerError.code,
          message: providerError.message,
          recoverable: providerError.retryable && this.chars === 0,
        };
        this.log.warn('Provider stream failed mid-flight.', { code: providerError.code, chars: this.chars });
      }
    } finally {
      this.stopTicker();
    }

    // Flush the coalescer tail, then emit the terminal frames in order.
    await this.enqueue(async () => {
      await this.emitChunks(this.coalescer.flush());
    });

    const outcome = await this.finalise();
    return outcome;
  }

  // --------------------------------------------------------------------------
  // Response opening
  // --------------------------------------------------------------------------

  private openResponse(): void {
    const { res, transport } = this.options;

    res.writeHead(200, streamResponseHeaders(transport));
    // Flush the headers immediately: `await fetch()` resolves HERE, long before
    // the body finishes (§9.3). Without this, express may hold the response.
    this.writer.flushHeaders();
    this.headersWritten = true;

    this.enqueue(async () => {
      await this.writeFrame({
        type: 'start',
        requestId: this.options.requestId,
        conversationId: this.options.conversationId,
        assistantMessageId: this.options.assistantMessageId,
        model: this.options.model,
        provider: this.options.providerName,
        transport,
        granularity: this.options.granularity,
        ttftBudgetMs: env.STREAM_TTFT_BUDGET_MS,
        idleTimeoutMs: env.STREAM_IDLE_TIMEOUT_MS,
        heartbeatMs: env.STREAM_HEARTBEAT_MS,
        startedAt: Math.round(this.startedAt),
      });
    });
  }

  public get hasWrittenHeaders(): boolean {
    return this.headersWritten;
  }

  // --------------------------------------------------------------------------
  // Delta intake — the dual-write pattern (§8.2)
  // --------------------------------------------------------------------------

  private async handleDelta(delta: ProviderDelta): Promise<void> {
    // A text-less delta is a carrier for usage/finish reason (the OpenAI
    // `include_usage` chunk has an empty `choices` array).
    if (delta.usage) {
      this.usage = delta.usage;
      await this.writeFrame({ type: 'usage', usage: delta.usage });
    }
    if (delta.finishReason) this.finishReason = toFinishReason(delta.finishReason);
    if (delta.text.length === 0) return;

    const at = nowMs();
    if (this.firstDeltaAt === null) {
      // Server TTFT is measured at the FIRST provider delta (§10.3), which is
      // what lets us separate provider latency from our own pipeline latency.
      this.firstDeltaAt = at;
      this.log.debug('First provider delta received.', { ttftMs: elapsedMs(this.startedAt) });
    } else {
      this.itlSamples.push(at - this.lastDeltaAt);
    }
    this.lastDeltaAt = at;

    const ready = this.coalescer.push(delta.text, at);
    await this.emitChunks(ready);
  }

  /** ONE chunk performs two jobs: sent to the browser, appended to the buffer. */
  private async emitChunks(chunks: string[]): Promise<void> {
    for (const text of chunks) {
      if (text.length === 0) continue;

      this.seq += 1;
      this.chars += text.length;
      this.chunks.push(text); // ← the "buffer in" half of the dual write

      await this.writeFrame({
        type: 'delta',
        seq: this.seq,
        text,
        chars: text.length,
        bytes: utf8ByteLength(text),
        at: Math.round(nowMs()),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Socket writing (backpressure-aware)
  // --------------------------------------------------------------------------

  private async writeFrame(frame: StreamFrame): Promise<void> {
    const payload = encodeFrame(frame, this.options.transport);
    if (payload === null) return; // e.g. heartbeats have no raw-text representation

    if (this.writer.isClosed) {
      this.abort('client_aborted', 'Socket closed while writing.');
      return;
    }
    if (this.writer.isOverBudget) {
      this.abort('client_slow', 'Client socket backlog exceeded the configured limit.');
      return;
    }

    const { accepted } = this.writer.write(payload);
    this.lastWriteAt = nowMs();
    this.options.onFrame?.(frame, payload);

    if (accepted) return;

    // Backpressure: stop writing until the socket drains, then give up after a
    // bounded wait so a frozen client cannot pin a connection forever.
    const drainOutcome = await this.writer.drain(CLIENT_SLOW_DRAIN_TIMEOUT_MS, this.abortController.signal);
    if (drainOutcome === 'timeout') this.abort('client_slow', 'Client stopped reading (drain timeout).');
    else if (drainOutcome === 'closed') this.abort('client_aborted', 'Socket closed while draining.');
  }

  /** Serialised write queue: guarantees monotonic `seq` and frame order. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(task)
      .catch((error: unknown) => {
        this.log.error('Write task failed.', { error });
        this.abort('internal_error', 'Internal write failure.');
      });
    return this.writeChain;
  }

  // --------------------------------------------------------------------------
  // Ticker: coalescing window, heartbeats, watchdogs
  // --------------------------------------------------------------------------

  private startTicker(): void {
    // One timer does three jobs so the stream never depends on a provider delta
    // arriving in order to make progress.
    const tickMs = Math.max(100, Math.min(env.STREAM_HEARTBEAT_MS || 1_000, 500));
    this.ticker = setInterval(() => {
      void this.onTick();
    }, tickMs);
    // Keep the process alive only while a stream is running.
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  private onTick(): void {
    if (this.termination) return;
    const at = nowMs();

    // 1. Time window: emit whatever the coalescer is holding so ITL stays bounded.
    const due = this.coalescer.tick(at);
    if (due.length > 0) void this.enqueue(() => this.emitChunks(due));

    // 2. Heartbeat: proxies, load balancers and clients all have idle timeouts
    //    shorter than a long answer. A comment line costs almost nothing.
    if (env.STREAM_HEARTBEAT_MS > 0 && at - this.lastWriteAt >= env.STREAM_HEARTBEAT_MS) {
      void this.enqueue(() => this.writeFrame({ type: 'heartbeat', at: Math.round(at) }));
    }

    // 3. Watchdogs — the three timeouts that make streaming survivable.
    const sinceStart = at - this.startedAt;
    const silence = at - (this.lastDeltaAt || this.startedAt);

    if (this.firstDeltaAt === null && sinceStart > env.STREAM_TTFT_BUDGET_MS) {
      this.abort('provider_timeout', `No first token within ${env.STREAM_TTFT_BUDGET_MS} ms.`, true);
      return;
    }
    if (this.firstDeltaAt !== null && silence > env.STREAM_IDLE_TIMEOUT_MS) {
      this.abort('upstream_stall', `Provider went silent for ${Math.round(silence)} ms.`, true);
      return;
    }
    if (sinceStart > env.STREAM_TOTAL_TIMEOUT_MS) {
      this.abort('total_timeout', `Generation exceeded ${env.STREAM_TOTAL_TIMEOUT_MS} ms.`);
    }
  }

  // --------------------------------------------------------------------------
  // Termination & telemetry
  // --------------------------------------------------------------------------

  private async finalise(): Promise<StreamOutcome> {
    const completedAt = nowMs();
    const termination = this.termination;
    const clientGone = this.writer.isClosed;

    if (termination) {
      this.finishReason = toFinishReasonFromErrorCode(termination.code);
    }

    const status: MessageStatus = termination ? 'interrupted' : 'completed';
    const timings = this.buildTimings(completedAt);

    if (termination && !clientGone && termination.code !== 'client_aborted') {
      // In-band error protocol: `200 OK` is already on the wire, so the failure
      // must be expressed as a field of the stream, never as an HTTP status.
      await this.writeFrame({
        type: 'error',
        code: termination.code,
        message: termination.message,
        recoverable: termination.recoverable,
        partial: this.chars > 0,
      });
    }

    if (!clientGone) {
      await this.writeFrame({
        type: 'done',
        requestId: this.options.requestId,
        status,
        finishReason: this.finishReason,
        chunks: this.seq,
        chars: this.chars,
        usage: this.usage,
        timings,
      });
      this.writer.end();
    }

    const content = this.chunks.join('');
    const telemetry = this.buildTelemetry({ termination, timings });

    // One structured line per stream (§10.3) + the streaming metrics.
    metrics.recordStream(telemetry);
    logger.record(telemetry.event, { ...telemetry });

    const outcome: StreamOutcome = {
      requestId: this.options.requestId,
      conversationId: this.options.conversationId,
      assistantMessageId: this.options.assistantMessageId,
      status,
      finishReason: this.finishReason,
      errorCode: termination?.code,
      content,
      usage: this.usage,
      firstTokenAt: this.firstDeltaAt === null ? null : Math.round(this.firstDeltaAt),
      completedAt: Math.round(completedAt),
      aborted: termination?.code === 'client_aborted',
      telemetry,
    };

    // Dual-write step 2: persist exactly ONE assistant message, once, off the
    // hot path — and even when the turn was interrupted (§8.5).
    try {
      await this.options.onPersist?.(outcome);
    } catch (error) {
      this.log.error('Dual-write persistence failed.', { error });
    }

    return outcome;
  }

  private buildTimings(completedAt: number): {
    queueMs: number;
    ttftMs: number;
    generationMs: number;
    totalMs: number;
    avgItlMs: number;
    maxItlMs: number;
    tps: number;
  } {
    const round2 = (value: number): number => Math.round(value * 100) / 100;

    const totalMs = round2(completedAt - this.startedAt);
    const ttftMs = this.firstDeltaAt === null ? 0 : round2(this.firstDeltaAt - this.startedAt);
    const generationMs = this.firstDeltaAt === null ? 0 : round2(completedAt - this.firstDeltaAt);

    const avgItlMs = this.itlSamples.length
      ? round2(this.itlSamples.reduce((sum, value) => sum + value, 0) / this.itlSamples.length)
      : 0;
    const maxItlMs = this.itlSamples.length ? round2(Math.max(...this.itlSamples)) : 0;

    // Reading speed is the yardstick (§3.3): below ~15–20 chars/s the reader
    // out-runs the model and perceived streaming collapses.
    const tps = generationMs > 0 ? round2(this.chars / (generationMs / 1_000)) : 0;

    return { queueMs: ttftMs, ttftMs, generationMs, totalMs, avgItlMs, maxItlMs, tps };
  }

  private buildTelemetry(args: {
    termination: Termination | null;
    timings: ReturnType<StreamPump['buildTimings']>;
  }): StreamTelemetry {
    const writerStats = this.writer.toStats();
    const clientAborted = args.termination?.code === 'client_aborted';

    const event: StreamTelemetry['event'] = clientAborted
      ? 'stream.aborted'
      : args.termination
        ? 'stream.failed'
        : 'stream.completed';

    return {
      event,
      requestId: this.options.requestId,
      conversationId: this.options.conversationId,
      transport: this.options.transport,
      granularity: this.options.granularity,
      provider: this.options.providerName,
      model: this.options.model,
      ttftMs: this.firstDeltaAt === null ? null : args.timings.ttftMs,
      totalMs: args.timings.totalMs,
      generationMs: args.timings.generationMs,
      chunks: this.seq,
      chars: this.chars,
      bytes: writerStats.bytes,
      avgChunkBytes: writerStats.avgBytesPerChunk,
      avgItlMs: args.timings.avgItlMs,
      maxItlMs: args.timings.maxItlMs,
      tps: args.timings.tps,
      promptTokens: this.usage?.promptTokens ?? 0,
      completionTokens: this.usage?.completionTokens ?? 0,
      finishReason: this.finishReason,
      clientAborted,
      errorCode: args.termination?.code,
    };
  }
}

// ============================================================================
// Mapping helpers
// ============================================================================

function toFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Terminal state taxonomy for interruptions (§8.5). These values are persisted
 * with the partial message so the UI and the next prompt both know WHY the
 * answer stops where it does.
 */
function toFinishReasonFromErrorCode(code: StreamErrorCode): FinishReason {
  switch (code) {
    case 'client_aborted':
      return 'client_abort';
    case 'upstream_stall':
      return 'upstream_stall';
    case 'total_timeout':
      return 'total_timeout';
    case 'client_slow':
      return 'client_slow';
    case 'provider_timeout':
    case 'provider_error':
      return 'provider_error';
    default:
      return 'provider_error';
  }
}
