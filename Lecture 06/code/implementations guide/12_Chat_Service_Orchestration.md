# Chapter 12: ChatService: Orchestration, Retry Discipline & the Buffered Baseline

> **Chapter Goal:** Validate and admit before writing any bytes, retry the provider only before the first token, wire the dual-write hook, and keep a buffered path for comparison.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/services/chat.service.ts` | 384 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/services/chat.service.ts` (383 lines)

```typescript
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
```


---

## 3. Block-by-Block Explanation

### Part A: Admission and the orchestration entry point

#### Block 1: Everything that can still fail, fails here

```typescript
public async streamChat(res: Response, input: StreamChatInput): Promise<StreamChatResult> {
  const provider = resolveProvider();

  const admission = streamRegistry.acquire(input.conversationId);
  if (!admission.ok) {
    return { ok: false, status: admission.reason === 'global_limit' ? 429 : 409, error: { code: …, message: …, details: … } };
  }

  const locked = await conversationStore.runExclusive(
    input.conversationId,
    async () => this.runStreamingTurn(res, input, provider),
    0                                     // ← fail fast, do not queue
  );

  if (!locked.acquired) {
    return { ok: false, status: 409, error: { code: 'conversation_busy', message: 'Another turn in this conversation is still running.' } };
  }
  return locked.value;
}
```

- **What it does:** performs *all* pre-flight checks before the response body exists.
- **How it works:** this ordering is the design rule from §7.7 — validate, authorise and confirm capacity *before* flushing headers, because after the first byte the status is immutable. Every failure here is a real HTTP status with a machine-readable code, and the return type (`ok: true | false`) forces the route to handle both shapes rather than forgetting one.

#### Block 2: Building the turn

```typescript
const requestId = `req_${randomUUID()}`;
const assistantMessageId = `msg_${randomUUID()}`;      // generated BEFORE streaming

conversationStore.appendUserMessage(input.conversationId, input.userId, input.message);

const { messages, metrics: historyMetrics } = historyService.build(conversationStore.get(input.conversationId));
if (historyMetrics.overBudget) {
  return { ok: false, status: 413, error: { code: 'invalid_request', message: `… ${historyMetrics.budgetTokens}-token context budget …` } };
}
```

- **What it does:** records the user turn, assembles the budgeted prompt, and rejects an oversized request before spending a token.
- **How it works:** the assistant `messageId` is generated here — before the stream exists — which is what makes the later upsert idempotent. Enforcing the token budget at this point turns a provider error (expensive, mid-flight, confusing) into a `413` with an explanation (cheap, immediate, actionable).

#### Block 3: Wiring the pump and the dual-write hook

```typescript
const pump = new StreamPump({
  res, transport, granularity, conversationId, requestId, assistantMessageId,
  model: env.AI_MODEL, providerName: provider.name,
  onFrame: (frame, payload) => streamRegistry.recordFrame(requestId, frame, payload),
  onPersist: async (outcome) => {
    conversationStore.upsertAssistantMessage({
      conversationId: outcome.conversationId, messageId: outcome.assistantMessageId,
      content: outcome.content, status: outcome.status, finishReason: outcome.finishReason,
      usage: outcome.usage, firstTokenAt: outcome.firstTokenAt, completedAt: outcome.completedAt,
    });
  },
});

streamRegistry.register({ requestId, conversationId, transport, startedAt: Date.now(),
  abort: (code, message) => pump.abort(code, message) });
```

- **What it does:** connects the four collaborators with the smallest possible surface.
- **How it works:** `onFrame` feeds the replay ring; `onPersist` is the *second half of the dual write*, and it receives the reconstructed content and the terminal state — never fragments. The registry entry is registered before `run()`, so a cancel request arriving one millisecond after the first byte still finds the pump.

---

### Part B: Retry discipline

#### Block 4: Retry only before the first token

```typescript
private async openProviderStream(provider, request, _isRetry): Promise<ProviderStream> {
  let attempt = 0;
  while (attempt < this.maxProviderAttempts) {
    attempt += 1;
    try {
      return await provider.stream(request);
    } catch (error) {
      const classified = classifyProviderError(error);
      const canRetry = classified.retryable && attempt < this.maxProviderAttempts && !request.abortSignal.aborted;
      if (!canRetry) throw classified;

      metrics.increment('provider_retries_total', { code: classified.code });
      await sleep(jitter(250 * attempt), request.abortSignal);     // jittered backoff
    }
  }
  throw lastError ?? new ProviderStreamError('provider_error', 'Provider unavailable.');
}
```

- **What it does:** retries transient provider failures, and only while a retry is still safe.
- **How it works:** this helper is invoked from inside the `openStream` factory — i.e. **before** `writeHead`. That is the whole trick: no bytes have been written, so no fragment can be duplicated (anti-pattern #10, "the mid-stream retry"). `jitter(250 * attempt)` spreads retries across clients; `!request.abortSignal.aborted` prevents a cancelled request from being retried at all.

---

### Part C: The buffered baseline

#### Block 5: Same provider, same store — different consumer

```typescript
for await (const delta of stream) {
  if (delta.usage) usage = delta.usage;
  if (delta.text.length === 0) continue;
  if (firstDeltaAt === null) firstDeltaAt = nowMs();
  parts.push(delta.text);                       // ← THE BUFFERING LINE
}

const result: BufferedChatResult = {
  reply: parts.join(''), usage,
  timings: { ttftMs: …, totalMs: …, chunks: parts.length }, history: historyMetrics, assistantMessageId,
};
conversationStore.upsertAssistantMessage({ /* status: 'completed' … */ });
```

- **What it does:** drains the *same* provider stream into a single string, so the two delivery modes can be compared honestly.
- **How it works:** this is the `.call()` of §7.1 expressed as a consumer. Because the provider, the history assembly, the persistence and the metrics are shared, any difference in the numbers is attributable to the **delivery path alone** — which is exactly what the CI assertion and the UI's "anti-pattern mode" demonstrate: the model streamed, the client still waited for `totalMs`.

#### Block 6: Cancellation and catch-up facades

```typescript
public cancel(requestId: string, reason = 'Cancelled by API request.'): boolean {
  return streamRegistry.cancel(requestId, 'client_aborted', reason);
}

public catchUp(requestId: string, fromSeq: number) {
  const frames = streamRegistry.replay(requestId, fromSeq);
  const lastSeq = frames.length ? frames[frames.length - 1]!.seq : fromSeq;
  return { frames, lastSeq };
}
```

- **What it does:** gives the routes a domain-level API instead of exposing the registry directly.
- **How it works:** keeping the registry an implementation detail means the transport layer never learns how replay is stored. `lastSeq` is returned so a client can persist its cursor without parsing every frame.

---

### ✅ Chapter 12 verification

```bash
npm run test:invariants    # buffered-vs-streaming contrast, 409 admission, in-band errors
npm run test:cancel        # abort/retry interplay and partial persistence
```



---

**Previous:**  · **Next:** 
