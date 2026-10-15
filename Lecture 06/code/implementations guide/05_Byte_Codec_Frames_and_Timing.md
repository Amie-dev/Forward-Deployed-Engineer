# Chapter 05: Byte/Frame Codec & Timing Utilities

> **Chapter Goal:** Make "token != provider delta != network chunk != decoded string" executable: byte accounting, hostile fragmentation, the three transport encoders, mandatory headers, a carry-buffer line splitter, and abortable timing.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/lib/text-codec.ts` | 194 lines |
| `src/lib/timing.ts` | 64 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/lib/text-codec.ts` (193 lines)

```typescript
import type { StreamFrame, StreamTransport } from '../types/stream.types.js';

/**
 * Byte-level and frame-level codec shared by the server, the CLI consumer and
 * the tests.
 *
 * This module is the concrete answer to §4 (four layers of granularity) and
 * §5.5 (raw text vs. `text/event-stream`):
 *
 *   LLM token  ≠  provider delta  ≠  network chunk  ≠  decoded string piece
 *
 * Everything here is expressed in BYTES when talking about transport, and in
 * CHARACTERS only when talking about what the UI appends.
 */

// ============================================================================
// 1. BYTE / CHARACTER ACCOUNTING
// ============================================================================

/** UTF-8 byte length of a string — never equal to `.length` for non-ASCII text. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export interface ChunkStats {
  chunks: number;
  chars: number;
  bytes: number;
  avgCharsPerChunk: number;
  avgBytesPerChunk: number;
  minCharsPerChunk: number;
  maxCharsPerChunk: number;
  /** chars/bytes ratio — a diagnostic for how much coalescing actually happened. */
  charsPerByte: number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summariseChunks(chunks: string[]): ChunkStats {
  const chars = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = chunks.reduce((total, chunk) => total + utf8ByteLength(chunk), 0);
  const sizes = chunks.map((chunk) => chunk.length);

  return {
    chunks: chunks.length,
    chars,
    bytes,
    avgCharsPerChunk: chunks.length ? round(chars / chunks.length) : 0,
    avgBytesPerChunk: chunks.length ? round(bytes / chunks.length) : 0,
    minCharsPerChunk: sizes.length ? Math.min(...sizes) : 0,
    maxCharsPerChunk: sizes.length ? Math.max(...sizes) : 0,
    charsPerByte: bytes ? round(chars / bytes, 4) : 0,
  };
}

// ============================================================================
// 2. HOSTILE FRAGMENTATION (Chapter 4.5 / Chapter 10.5 — torture test)
// ============================================================================

/**
 * Split a string into buffers of exactly `bytesPerChunk` bytes, deliberately
 * cutting multi-byte UTF-8 sequences in half whenever a boundary lands inside
 * one. This reproduces the worst case a real network can produce, and is what
 * the client-side `TextDecoder({ stream: true })` discipline must survive.
 */
export function fragmentStringByBytes(text: string, bytesPerChunk: number): Buffer[] {
  if (bytesPerChunk < 1) throw new Error('bytesPerChunk must be >= 1');

  const source = Buffer.from(text, 'utf8');
  const fragments: Buffer[] = [];

  for (let offset = 0; offset < source.length; offset += bytesPerChunk) {
    fragments.push(source.subarray(offset, Math.min(offset + bytesPerChunk, source.length)));
  }
  return fragments;
}

// ============================================================================
// 3. TRANSPORT-SPECIFIC FRAME ENCODING (Chapter 05.3.1)
// ============================================================================

/**
 * `text/plain` has no framing at all, so an in-band error cannot be expressed as
 * a field. We reserve a NUL-delimited sentinel: control characters cannot appear
 * in normal model output, and a client that does not understand it still shows
 * harmless text. This limitation is precisely why SSE exists (§5.5).
 */
export const TEXT_ERROR_SENTINEL = '\u0000\u0000STREAM_ERROR\u0000';

export function encodeTextError(code: string, message: string): string {
  return `${TEXT_ERROR_SENTINEL}${code}\u0000${message}\n`;
}

export const SSE_RETRY_HINT_MS = 3_000;

/**
 * Encode one frame for one transport.
 * Returns `null` when the frame has no representation on that transport
 * (e.g. heartbeats must never corrupt a raw `text/plain` body).
 */
export function encodeFrame(frame: StreamFrame, transport: StreamTransport): string | null {
  switch (transport) {
    case 'text': {
      if (frame.type === 'delta') return frame.text;
      // Raw text has no envelope: only catastrophic conditions emit a sentinel.
      if (frame.type === 'error') return encodeTextError(frame.code, frame.message);
      return null;
    }

    case 'ndjson':
      // Newline-delimited JSON: exactly one envelope per line, always.
      return `${JSON.stringify(frame)}\n`;

    case 'sse': {
      if (frame.type === 'heartbeat') return ': keep-alive\n\n';

      const lines: string[] = [];
      if (frame.type === 'start') lines.push(`retry: ${SSE_RETRY_HINT_MS}`);
      lines.push(`event: ${frame.type}`);
      // `id:` enables Last-Event-ID resume — the sequence number is the cursor.
      if (frame.type === 'delta') lines.push(`id: ${frame.seq}`);
      if (frame.type === 'done') lines.push(`id: ${frame.chunks}`);
      lines.push(`data: ${JSON.stringify(frame)}`);
      // The blank line DISPATCHES the event — omitting it is the classic
      // "events arrive but addEventListener never fires" bug.
      return `${lines.join('\n')}\n\n`;
    }

    default:
      return null;
  }
}

/** Mandatory response headers per transport (§5.3.2 / §5.6). */
export function streamResponseHeaders(transport: StreamTransport): Record<string, string> {
  const common: Record<string, string> = {
    // No Content-Length: the body is delivered progressively, so Node applies
    // HTTP/1.1 `Transfer-Encoding: chunked` automatically.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx honours this header; without it, streaming silently disappears.
    'X-Accel-Buffering': 'no',
    // Compression must never be applied to a progressive body — it re-buffers it.
    'Content-Encoding': 'identity',
  };

  switch (transport) {
    case 'sse':
      return { ...common, 'Content-Type': 'text/event-stream; charset=utf-8' };
    case 'ndjson':
      return { ...common, 'Content-Type': 'application/x-ndjson; charset=utf-8' };
    case 'text':
    default:
      return { ...common, 'Content-Type': 'text/plain; charset=utf-8' };
  }
}

// ============================================================================
// 4. INCREMENTAL LINE SPLITTER (the framing-buffer pattern)
// ============================================================================

/**
 * The correct way to consume a line-oriented streaming body: accumulate bytes,
 * split on the delimiter, and KEEP the trailing partial line for the next read.
 *
 * Doing `chunk.split("\n")` per read — the naive approach — corrupts any line a
 * network chunk happens to bisect. The CLI consumer and the NDJSON tests share
 * this single correct implementation.
 */
export class LineSplitter {
  private carry = '';

  constructor(private readonly delimiter = '\n') {}

  /** Feed decoded text; returns only complete lines. */
  public push(text: string): string[] {
    const combined = this.carry + text;
    const parts = combined.split(this.delimiter);
    this.carry = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  /** Flush the trailing partial line at end-of-stream. */
  public flush(): string[] {
    if (this.carry.length === 0) return [];
    const tail = this.carry;
    this.carry = '';
    return [tail];
  }
}
```


### 📄 `src/lib/timing.ts` (63 lines)

```typescript
/**
 * Time-related helpers.
 *
 * Streaming correctness is *temporal*: TTFT, ITL, stall detection and timeouts
 * all depend on measuring and waiting precisely. These primitives are
 * deliberately tiny and dependency-free.
 */

/** Milliseconds since process start — monotonic, unaffected by wall-clock drift. */
export function nowMs(): number {
  return performance.now();
}

/**
 * Abortable sleep. Every wait on the streaming path MUST be interruptible,
 * otherwise a cancelled request keeps a provider call (and its token spend)
 * alive until the timer fires — the "zombie generation" anti-pattern.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAbortError(message = 'The operation was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError');
}

/** Round-trip millisecond duration with sub-millisecond precision. */
export function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 100) / 100;
}

/** Introduce bounded jitter so parallel streams do not resonate in lockstep. */
export function jitter(base: number, spreadRatio = 0.3): number {
  const spread = base * spreadRatio;
  return Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
}
```


---

## 3. Block-by-Block Explanation

### Part A: `text-codec.ts` — where "token ≠ chunk ≠ byte" becomes code

#### Block 1: Byte accounting

```typescript
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function summariseChunks(chunks: string[]): ChunkStats {
  const chars = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = chunks.reduce((total, chunk) => total + utf8ByteLength(chunk), 0);
  /* … avg/min/max chars per chunk, charsPerByte … */
}
```

- **What it does:** measures the difference between what the UI appends (characters) and what the socket carries (bytes).
- **How it works:** `'🚀'.length === 2` but `Buffer.byteLength('🚀') === 4` — those two numbers are the basis of the whole granularity chapter. `charsPerByte` is a diagnostic: near 1.0 means mostly ASCII, well below 1.0 means heavy multi-byte content.

#### Block 2: Hostile fragmentation (the torture test's generator)

```typescript
export function fragmentStringByBytes(text: string, bytesPerChunk: number): Buffer[] {
  const source = Buffer.from(text, 'utf8');
  const fragments: Buffer[] = [];
  for (let offset = 0; offset < source.length; offset += bytesPerChunk) {
    fragments.push(source.subarray(offset, Math.min(offset + bytesPerChunk, source.length)));
  }
  return fragments;
}
```

- **What it does:** slices a UTF-8 string into fixed-size **byte** pieces, deliberately cutting multi-byte characters in half.
- **How it works:** a real network does exactly this — TCP, proxies and compression re-frame the stream at byte boundaries you do not control. Generating the worst case on purpose is how `test-utf8-fragmentation.ts` proves that incremental decoding is boundary-agnostic.

#### Block 3: The raw-text limitation, made explicit

```typescript
export const TEXT_ERROR_SENTINEL = '\u0000\u0000STREAM_ERROR\u0000';

export function encodeTextError(code: string, message: string): string {
  return `${TEXT_ERROR_SENTINEL}${code}\u0000${message}\n`;
}
```

- **What it does:** gives `text/plain` *some* way to signal a mid-stream failure.
- **How it works:** raw text has no fields, so there is nowhere to put an `event: error`. A NUL-delimited sentinel is the compromise: control characters never appear in normal model output, and a client that does not understand it still renders harmless text. This block exists to make the lecture's point concrete — that awkwardness is exactly why SSE and NDJSON exist.

#### Block 4: One encoder, three wire formats

```typescript
export function encodeFrame(frame: StreamFrame, transport: StreamTransport): string | null {
  switch (transport) {
    case 'text':
      if (frame.type === 'delta') return frame.text;
      if (frame.type === 'error') return encodeTextError(frame.code, frame.message);
      return null;                      // heartbeats would corrupt a raw body

    case 'ndjson':
      return `${JSON.stringify(frame)}\n`;

    case 'sse': {
      if (frame.type === 'heartbeat') return ': keep-alive\n\n';
      const lines: string[] = [];
      if (frame.type === 'start') lines.push(`retry: ${SSE_RETRY_HINT_MS}`);
      lines.push(`event: ${frame.type}`);
      if (frame.type === 'delta') lines.push(`id: ${frame.seq}`);
      lines.push(`data: ${JSON.stringify(frame)}`);
      return `${lines.join('\n')}\n\n`;
    }
  }
}
```

- **What it does:** is the only place in the codebase that knows how each transport is written on the wire.
- **How it works:** returning `null` for unrepresentable frames is the mechanism that keeps heartbeats out of raw text (the test suite asserts 0 heartbeat bytes in a `text/plain` body). The SSE branch implements the exact grammar: `retry:` on the first event, `event:` always, `id:` on deltas for `Last-Event-ID` resume, `data:` as JSON, and the **blank line that dispatches the event** — omitting it is the classic "events arrive but `addEventListener` never fires" bug.

#### Block 5: The mandatory headers

```typescript
export function streamResponseHeaders(transport: StreamTransport): Record<string, string> {
  const common = {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity',
  };
  switch (transport) {
    case 'sse':    return { ...common, 'Content-Type': 'text/event-stream; charset=utf-8' };
    case 'ndjson': return { ...common, 'Content-Type': 'application/x-ndjson; charset=utf-8' };
    default:       return { ...common, 'Content-Type': 'text/plain; charset=utf-8' };
  }
}
```

- **What it does:** encodes hardening items #1, #2 and #5 as headers.
- **How it works:** there is deliberately **no `Content-Length`** — that absence is what makes Node use `Transfer-Encoding: chunked` and deliver the body progressively. `X-Accel-Buffering: no` disables Nginx response buffering; `no-transform` stops intermediaries rewriting the body; `Content-Encoding: identity` asserts compression (which re-buffers) is not applied. Verified in Chapter 16 with `curl -sD -`.

#### Block 6: The incremental line splitter

```typescript
export class LineSplitter {
  private carry = '';
  public push(text: string): string[] {
    const combined = this.carry + text;
    const parts = combined.split(this.delimiter);
    this.carry = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }
  public flush(): string[] { /* emit the trailing partial line at end-of-stream */ }
}
```

- **What it does:** is the *correct* way to consume a line-oriented streaming body.
- **How it works:** `parts.pop()` keeps the last (possibly incomplete) line for the next read. Doing `chunk.split("\n")` per read — the naive approach — corrupts any line the network happens to bisect. One shared implementation is used by the CLI consumer, the NDJSON harness and the tests, so the bug cannot be reintroduced in one place while fixed in another.

---

### Part B: `timing.ts` — abortable time

#### Block 7: Abortable sleep

```typescript
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(createAbortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(createAbortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- **What it does:** waits, but is interrupted the instant the request is cancelled.
- **How it works:** every wait on the streaming path must be interruptible. Without this, a cancelled request keeps a provider call (and its token spend) alive until the timer fires — the "zombie generation" anti-pattern. The listener is registered `once` and removed on the happy path, so a long generation cannot accumulate listeners.

#### Block 8: Monotonic clock, jitter and abort detection

```typescript
export function nowMs(): number { return performance.now(); }
export function jitter(base: number, spreadRatio = 0.3): number { /* ±30% */ }
export function isAbortError(error: unknown): boolean { /* AbortError | APIUserAbortError */ }
export function elapsedMs(startedAt: number): number { /* sub-millisecond precision */ }
```

- **What it does:** provides the timing vocabulary used by TTFT/ITL measurement and the retry policy.
- **How it works:** `performance.now()` is monotonic, so TTFT is not corrupted by a wall-clock adjustment mid-stream. `jitter` exists because deterministic backoff makes every client retry in lockstep — the worst possible load pattern for a recovering provider. `isAbortError` covers both the DOMException from `AbortController` and the OpenAI SDK's `APIUserAbortError`.

---

### ✅ Chapter 05 verification

```bash
npm run test:utf8     # 42 fragmentation combinations + the naive-bug control
curl -sD - -o /dev/null -X POST 'localhost:8090/api/chat/stream?transport=ndjson' \
  -H 'Content-Type: application/json' -d '{"message":"hi"}' \
  | grep -iE 'content-type|transfer-encoding|x-accel|cache-control'
```



---

**Previous:**  · **Next:** 
