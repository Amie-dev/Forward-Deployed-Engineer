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
// __APPEND__
