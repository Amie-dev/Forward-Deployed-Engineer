# Chapter 03: Data Contracts: Provider Interface, Wire Frames & Store Records

> **Chapter Goal:** Define the three contract families the whole system shares: the provider AsyncIterable contract, the wire-frame taxonomy, and the persisted conversation records.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/types/stream.types.ts` | 297 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/types/stream.types.ts` (296 lines)

```typescript
import { z } from 'zod';

// ============================================================================
// 1. TRANSPORT & GRANULARITY (Chapter 05 / Chapter 10.1)
// ============================================================================

/**
 * The three progressive-delivery transports this service implements.
 *
 *  - `text`   → `text/plain` raw progressive body (the PDF's Tomato-chatbot
 *               pattern: streaming does NOT require SSE).
 *  - `ndjson` → `application/x-ndjson`: one JSON envelope per `\n`-terminated line.
 *  - `sse`    → `text/event-stream`: named events, `id:` for resume, heartbeats.
 */
export const StreamTransportSchema = z.enum(['text', 'ndjson', 'sse']);
export type StreamTransport = z.infer<typeof StreamTransportSchema>;

/**
 * How aggressively provider deltas are coalesced before hitting the socket.
 * `token` keeps the provider cadence, `sentence` builds natural bubbles,
 * `random` deliberately fragments bytes to prove the client contract holds.
 */
export const DeltaGranularitySchema = z.enum(['token', 'word', 'sentence', 'random']);
export type DeltaGranularity = z.infer<typeof DeltaGranularitySchema>;

// ============================================================================
// 2. PROVIDER LAYER — the `Flux<String>` / AsyncIterable contract (Ch. 07)
// ============================================================================

/** Roles permitted on the provider wire. Authority is never mixed (Ch. 04). */
export const ProviderRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ProviderRole = z.infer<typeof ProviderRoleSchema>;

export interface ProviderMessage {
  role: ProviderRole;
  content: string;
}

/**
 * Usage is always reported by the provider, NEVER derived from chunk counts.
 * (Anti-pattern #14: "the chunk-as-token counter".)
 */
export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * The terminal state of one assistant turn. `interrupted` states are first-class:
 * §8.5 requires that anything the user already read is persisted, not discarded.
 */
export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'content_filter',
  'client_abort',
  'provider_error',
  'upstream_stall',
  'total_timeout',
  'client_slow',
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const MessageStatusSchema = z.enum(['completed', 'interrupted']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/**
 * ONE provider delta. Deliberately distinct from an LLM token and from a
 * network chunk (Ch. 04): the provider may batch several tokens into one delta
 * and TCP may split one delta across several reads.
 */
export interface ProviderDelta {
  /** Raw text exactly as the provider exposed it. */
  text: string;
  /** Monotonic index of this delta inside the generation. */
  index: number;
  /** Provider usage, usually only on the final chunk of a streamed call. */
  usage?: TokenUsage;
  /** Provider-reported finish reason, present on the last chunk. */
  finishReason?: string;
}

/**
 * Fault-injection knobs for the offline simulator: every chaos test in
 * Chapter 10.5 (stalls, aborts, mid-stream failures) is driven from here.
 */
export interface SimulationOptions {
  granularity?: DeltaGranularity;
  /** Simulated provider queue + prefill delay before the first delta. */
  ttftMs?: number;
  /** Simulated inter-token latency. */
  itlMs?: number;
  /** Emit a silent stall (no bytes) after N deltas — the idle watchdog case. */
  stallAfterDeltas?: number;
  stallMs?: number;
  /** Fail mid-stream after N deltas — the in-band error case. */
  failAfterDeltas?: number;
  failCode?: string;
  /** Force a TTFT breach to exercise the TTFT budget path. */
  exceedTtftBudget?: boolean;
  /** Final text override (used by deterministic tests). */
  answerOverride?: string;
}

/** A streamed generation, as seen by the service layer. */
export type ProviderStream = AsyncIterable<ProviderDelta>;

export interface ProviderStreamRequest {
  conversationId: string;
  requestId: string;
  messages: ProviderMessage[];
  model: string;
  temperature: number;
  maxOutputTokens: number;
  /** Propagation of client cancellation all the way to the provider (Ch. 6.6). */
  abortSignal: AbortSignal;
  simulation?: SimulationOptions;
}

/** Every provider (live or simulated) satisfies this contract. */
export interface StreamProvider {
  readonly name: string;
  stream(request: ProviderStreamRequest): Promise<ProviderStream>;
}


// ============================================================================
// 3. WIRE FRAMES (Chapter 05.3.1 / Chapter 07.7)
// ============================================================================

/**
 * The in-band error protocol. Once `200 OK` and the first byte have left the
 * server, the HTTP status is immutable — anything that happens afterwards must
 * be signalled *inside* the stream.
 */
export const StreamErrorCodeSchema = z.enum([
  'invalid_request',
  'conversation_busy',
  'stream_concurrency_exceeded',
  'provider_error',
  'provider_timeout',
  'upstream_stall',
  'client_slow',
  'client_aborted',
  'total_timeout',
  'internal_error',
]);
export type StreamErrorCode = z.infer<typeof StreamErrorCodeSchema>;

export const StartFrameSchema = z.object({
  type: z.literal('start'),
  requestId: z.string(),
  conversationId: z.string(),
  assistantMessageId: z.string(),
  model: z.string(),
  provider: z.string(),
  transport: StreamTransportSchema,
  granularity: DeltaGranularitySchema,
  ttftBudgetMs: z.number().int().nonnegative(),
  idleTimeoutMs: z.number().int().nonnegative(),
  heartbeatMs: z.number().int().nonnegative(),
  startedAt: z.number().int(),
});

export const DeltaFrameSchema = z.object({
  type: z.literal('delta'),
  /** Monotonic sequence, mirrored into the SSE `id:` field for resume. */
  seq: z.number().int().nonnegative(),
  text: z.string(),
  /** Character count (not bytes) — what the UI appends. */
  chars: z.number().int().nonnegative(),
  /** UTF-8 byte count — proves chars ≠ bytes for multi-byte text. */
  bytes: z.number().int().nonnegative(),
  at: z.number().int(),
});

/** SSE-only keep-alive comment; in NDJSON it is an explicit frame. */
export const HeartbeatFrameSchema = z.object({
  type: z.literal('heartbeat'),
  at: z.number().int(),
});

export const UsageFrameSchema = z.object({
  type: z.literal('usage'),
  usage: TokenUsageSchema,
});

export const ErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: StreamErrorCodeSchema,
  message: z.string(),
  /** `true` when a retry (with a new requestId) can be attempted. */
  recoverable: z.boolean(),
  /** `true` when partial text was already delivered to the client. */
  partial: z.boolean(),
});

export const DoneFrameSchema = z.object({
  type: z.literal('done'),
  requestId: z.string(),
  status: MessageStatusSchema,
  finishReason: FinishReasonSchema,
  chunks: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
  usage: TokenUsageSchema.nullable(),
  timings: z.object({
    queueMs: z.number().nonnegative(),
    ttftMs: z.number().nonnegative(),
    generationMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
    avgItlMs: z.number().nonnegative(),
    maxItlMs: z.number().nonnegative(),
    tps: z.number().nonnegative(),
  }),
});

export const StreamFrameSchema = z.discriminatedUnion('type', [
  StartFrameSchema,
  DeltaFrameSchema,
  HeartbeatFrameSchema,
  UsageFrameSchema,
  ErrorFrameSchema,
  DoneFrameSchema,
]);
export type StreamFrame = z.infer<typeof StreamFrameSchema>;

export type StartFrame = z.infer<typeof StartFrameSchema>;
export type DeltaFrame = z.infer<typeof DeltaFrameSchema>;
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;
export type DoneFrame = z.infer<typeof DoneFrameSchema>;
export type UsageFrame = z.infer<typeof UsageFrameSchema>;
export type HeartbeatFrame = z.infer<typeof HeartbeatFrameSchema>;

// ============================================================================
// 4. CONVERSATION STORE RECORDS (Chapter 08.7)
// ============================================================================

export const ConversationMessageSchema = z.object({
  /** Pre-generated BEFORE streaming ⇒ idempotent upsert on retry. */
  id: z.string(),
  conversationId: z.string(),
  ordinal: z.number().int().nonnegative(),
  role: ProviderRoleSchema,
  /** The reconstructed message — never a transport fragment. */
  content: z.string(),
  status: MessageStatusSchema,
  finishReason: FinishReasonSchema.nullable(),
  usage: TokenUsageSchema.nullable(),
  createdAt: z.number().int(),
  firstTokenAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  messages: z.array(ConversationMessageSchema),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * Per-stream telemetry — exactly the structured log line required by §10.3.
 * One of these is emitted per stream, including TTFT and finish reason.
 */
export interface StreamTelemetry {
  event: 'stream.completed' | 'stream.failed' | 'stream.aborted';
  requestId: string;
  conversationId: string;
  transport: StreamTransport;
  granularity: DeltaGranularity;
  provider: string;
  model: string;
  ttftMs: number | null;
  totalMs: number;
  generationMs: number;
  chunks: number;
  chars: number;
  bytes: number;
  avgChunkBytes: number;
  avgItlMs: number;
  maxItlMs: number;
  tps: number;
  /** clientDuration − serverDuration: large positive ⇒ the client kept reading after we stopped. */
  promptTokens: number;
  completionTokens: number;
  finishReason: FinishReason | 'in_progress';
  clientAborted: boolean;
  errorCode?: StreamErrorCode;
}
```


---

## 3. Block-by-Block Explanation

### Part A: Transport & granularity vocabulary

#### Block 1: The three transports

```typescript
export const StreamTransportSchema = z.enum(['text', 'ndjson', 'sse']);
export type StreamTransport = z.infer<typeof StreamTransportSchema>;
```

- **What it does:** names the delivery mechanisms as a closed set, so an invalid transport is a validation error, not a runtime surprise.
- **How it works:** the type is *inferred from the schema*, so the validator and the TypeScript type can never disagree — the pattern used for every contract in this file.

#### Block 2: Granularity as a first-class concept

```typescript
export const DeltaGranularitySchema = z.enum(['token', 'word', 'sentence', 'random']);
```

- **What it does:** makes the *coalescing policy* a request-time parameter rather than a hidden constant.
- **How it works:** `random` exists specifically to generate hostile 1–3 character fragments, which is how the fragmentation-invariance assertion in the CI suite is produced.

---

### Part B: The provider layer (the `Flux<String>` contract)

#### Block 3: Usage and finish reasons

```typescript
export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
```

- **What it does:** models token usage as provider-reported data only.
- **How it works:** it is never derived from chunk counts (anti-pattern #14). The `.nonnegative()` guard catches a malformed provider payload at the boundary instead of corrupting a billing dashboard.

#### Block 4: The terminal-state taxonomy

```typescript
export const FinishReasonSchema = z.enum([
  'stop', 'length', 'content_filter',
  'client_abort', 'provider_error', 'upstream_stall', 'total_timeout', 'client_slow',
]);
export const MessageStatusSchema = z.enum(['completed', 'interrupted']);
```

- **What it does:** separates *why* a turn ended from *whether* it completed.
- **How it works:** `status` answers "should the UI show a partial badge?" while `finishReason` answers "what exactly happened?" — the distinction §8.5 requires, because a partial answer must be persisted with enough context for both the UI and the next prompt.

#### Block 5: One provider delta

```typescript
export interface ProviderDelta {
  text: string;
  index: number;
  usage?: TokenUsage;
  finishReason?: string;
}
```

- **What it does:** defines the only thing a provider may emit.
- **How it works:** `text` may be empty — that is the "usage carrier" case (OpenAI's `include_usage` chunk has an empty `choices` array), which is why the pump records `usage` *before* it checks `text.length`.

#### Block 6: Chaos-injection knobs

```typescript
export interface SimulationOptions {
  granularity?: DeltaGranularity;
  ttftMs?: number;
  itlMs?: number;
  stallAfterDeltas?: number;
  stallMs?: number;
  failAfterDeltas?: number;
  failCode?: string;
  exceedTtftBudget?: boolean;
  answerOverride?: string;
}
```

- **What it does:** declares every temporal failure mode as data that can be requested over HTTP (`chaos: { … }` in the request body).
- **How it works:** the simulator reads these; the live provider ignores them. This is what turns "the idle watchdog works" from a claim into `npm run test:invariants`.

#### Block 7: The provider contract

```typescript
export type ProviderStream = AsyncIterable<ProviderDelta>;

export interface StreamProvider {
  readonly name: string;
  stream(request: ProviderStreamRequest): Promise<ProviderStream>;
}
```

- **What it does:** is the architectural centre of the whole codebase.
- **How it works:** `stream()` returns a **stream type**, not `Promise<string>`. As Chapter 07.2 of the notes puts it, the important change is not the method name but the return type: `String` is a box (one value, after completion); `AsyncIterable` is a conveyor belt (zero, one or many values over time). Because the type is a stream, no layer above it *can* buffer without visibly choosing to.

---

### Part C: Wire frames

#### Block 8: The in-band error protocol

```typescript
export const StreamErrorCodeSchema = z.enum([
  'invalid_request', 'conversation_busy', 'stream_concurrency_exceeded',
  'provider_error', 'provider_timeout', 'upstream_stall', 'client_slow',
  'client_aborted', 'total_timeout', 'internal_error',
]);
```

- **What it does:** enumerates every failure the client may receive *after* `200 OK` has been sent.
- **How it works:** the HTTP status is immutable once the first byte leaves the server, so the failure must be a machine-readable field inside the stream. The codes are deliberately specific: `upstream_stall` (provider went silent), `provider_timeout` (never started) and `client_slow` (socket backlog) have completely different remedies.

#### Block 9: The delta frame

```typescript
export const DeltaFrameSchema = z.object({
  type: z.literal('delta'),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  chars: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  at: z.number().int(),
});
```

- **What it does:** defines the append-only contract between server and UI.
- **How it works:** `seq` is mirrored into the SSE `id:` field and becomes the client's recovery cursor; `chars` **and** `bytes` are both reported so the UI can demonstrate that characters ≠ bytes for multi-byte text.

#### Block 10: The discriminated union

```typescript
export const StreamFrameSchema = z.discriminatedUnion('type', [
  StartFrameSchema, DeltaFrameSchema, HeartbeatFrameSchema,
  UsageFrameSchema, ErrorFrameSchema, DoneFrameSchema,
]);
export type StreamFrame = z.infer<typeof StreamFrameSchema>;
```

- **What it does:** turns six frame shapes into one exhaustive, type-narrowing union.
- **How it works:** `switch (frame.type)` in the pump and in the browser client is checked by the compiler for exhaustiveness. Adding a frame type makes every handler that forgot about it a type error — the cheapest way to keep a wire protocol honest.

---

### Part D: Persisted records and telemetry

#### Block 11: The conversation message record

```typescript
export const ConversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  ordinal: z.number().int().nonnegative(),
  role: ProviderRoleSchema,
  content: z.string(),
  status: MessageStatusSchema,
  finishReason: FinishReasonSchema.nullable(),
  usage: TokenUsageSchema.nullable(),
  createdAt: z.number().int(),
  firstTokenAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
});
```

- **What it does:** is the record written once per turn, and the answer to "what do we store when the answer arrived as 214 fragments?".
- **How it works:** `id` is generated **before** streaming starts, which makes the write idempotent (§8.7). `content` holds the *reconstructed* message, never a fragment. `firstTokenAt` and `completedAt` are the two timestamps that make TTFT and generation duration auditable after the fact.

#### Block 12: The per-stream telemetry line

```typescript
export interface StreamTelemetry {
  event: 'stream.completed' | 'stream.failed' | 'stream.aborted';
  ttftMs: number | null;
  totalMs: number;
  generationMs: number;
  chunks: number;
  chars: number;
  bytes: number;
  avgChunkBytes: number;
  avgItlMs: number;
  maxItlMs: number;
  tps: number;
  promptTokens: number;
  completionTokens: number;
  finishReason: FinishReason | 'in_progress';
  clientAborted: boolean;
  errorCode?: StreamErrorCode;
}
```

- **What it does:** is the exact shape of the single structured log line emitted per stream (§10.3).
- **How it works:** it carries everything needed to answer the statistical questions — `ttftMs` (provider + pipeline latency), `chunks` and `avgChunkBytes` (did coalescing or buffering happen?), `avgItlMs`/`maxItlMs` (stalls), `clientAborted` (cost saved) and `finishReason` (did it really complete?). One line, no joins, queryable.

---

### ✅ Chapter 03 verification

```bash
npm run build     # the discriminated union is exhaustively handled everywhere
npm run test:invariants   # every frame type is exercised over the wire
```



---

**Previous:**  · **Next:** 
