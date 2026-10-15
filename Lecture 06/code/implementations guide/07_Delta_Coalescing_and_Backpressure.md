# Chapter 07: Delta Coalescing & Backpressure-Aware Writing

> **Chapter Goal:** Turn provider deltas into application chunks with three independent flush triggers, and write to the socket in a way that stalls instead of overflowing.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/stream/delta-coalescer.ts` | 90 lines |
| `src/stream/backpressure.ts` | 135 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/stream/delta-coalescer.ts` (89 lines)

```typescript
import { env } from '../config/env.js';

/**
 * Delta coalescer — the second granularity transition of §4.1:
 *
 *     provider deltas  ➔  application chunks  (what we write to the socket)
 *
 * The notes are explicit that these are different things, and this class shows
 * why the difference is *useful* rather than accidental: coalescing gives us
 *
 *   1. fewer TCP writes (syscall amortisation),
 *   2. chunks that end on natural boundaries, so streamed markdown renders
 *      progressively instead of flashing broken syntax, and
 *   3. a hard upper bound on chunk size, which bounds memory and adds a natural
 *      latency ceiling on top of the time window.
 *
 * Three independent flush triggers, whichever fires first:
 *   - BOUNDARY: the buffer ends a sentence / line (good for the UI),
 *   - SIZE:     the buffer reached `maxChunkChars` (bounded work per write),
 *   - TIME:     `flushMs` elapsed since the previous flush (bounded latency).
 */
export interface DeltaCoalescerOptions {
  /** Time window in ms before a partial chunk is force-flushed. */
  flushMs?: number;
  /** Maximum characters per emitted chunk. */
  maxChunkChars?: number;
}

const BOUNDARY_PATTERN = /(\n|[.!?…:]["')\]]?\s*)$/;

export class DeltaCoalescer {
  private buffer = '';
  private windowStartedAt = 0;
  private readonly flushMs: number;
  private readonly maxChunkChars: number;

  constructor(options: DeltaCoalescerOptions = {}) {
    this.flushMs = options.flushMs ?? env.STREAM_FLUSH_MS;
    this.maxChunkChars = options.maxChunkChars ?? env.STREAM_MAX_CHUNK_CHARS;
  }

  public get hasPending(): boolean {
    return this.buffer.length > 0;
  }

  public get pendingChars(): number {
    return this.buffer.length;
  }

  /**
   * Feed one provider delta and receive the chunks that must be written NOW.
   * An empty array means "the delta was absorbed into the pending buffer".
   */
  public push(text: string, atMs: number): string[] {
    if (text.length === 0) return [];

    if (this.buffer.length === 0) this.windowStartedAt = atMs;
    this.buffer += text;

    // 1. Size trigger — bounds the work performed per write.
    if (this.buffer.length >= this.maxChunkChars) return this.flush();

    // 2. Boundary trigger — nicer rendering, no extra latency.
    if (BOUNDARY_PATTERN.test(this.buffer)) return this.flush();

    // 3. Time trigger — not yet; the pump's tick will decide.
    return [];
  }

  /**
   * Timer-driven check: emit the pending buffer if the time window expired.
   * Returning `[]` means "keep waiting"; the pump uses `hasPending` to know
   * whether a timer is even needed.
   */
  public tick(atMs: number): string[] {
    if (this.buffer.length === 0) return [];
    if (atMs - this.windowStartedAt < this.flushMs) return [];
    return this.flush();
  }

  /** End of stream: emit whatever is left, even mid-word. */
  public flush(): string[] {
    if (this.buffer.length === 0) return [];
    const chunk = this.buffer;
    this.buffer = '';
    this.windowStartedAt = 0;
    return [chunk];
  }
}
```


### 📄 `src/stream/backpressure.ts` (134 lines)

```typescript
import type { Response } from 'express';
import { utf8ByteLength } from '../lib/text-codec.js';

/**
 * Backpressure-aware response writer (Chapter 06.5).
 *
 * The reality of flow control is REVEALED BY `res.write()`:
 *
 *   - `true`  ⇒ the chunk was accepted; the socket buffer has room.
 *   - `false` ⇒ Node's internal buffer is full; you MUST stop writing until the
 *               `'drain'` event fires. Continuing blindly converts backpressure
 *               into unbounded memory growth in the server process.
 *
 * Production streaming therefore *stalls* instead of overflowing — and a stall
 * must be distinguishable from a provider stall, because the remedies differ
 * (`client_slow` ⇒ terminate; `upstream_stall` ⇒ retry/report).
 */

export type DrainOutcome = 'drained' | 'timeout' | 'closed';

export interface WriteResult {
  /** `false` ⇒ the caller must await `drain()` before the next write. */
  accepted: boolean;
  /** Bytes currently buffered by the socket / Node writable stream. */
  queuedBytes: number;
}

export class BackpressureWriter {
  private bytesWritten = 0;
  private chunksWritten = 0;

  constructor(
    private readonly res: Response,
    private readonly maxQueueBytes: number
  ) {}

  public get totalBytes(): number {
    return this.bytesWritten;
  }

  public get totalChunks(): number {
    return this.chunksWritten;
  }

  /** Bytes sitting unflushed in the server-side socket buffer. */
  public get queuedBytes(): number {
    return this.res.writableLength ?? 0;
  }

  /** A client that cannot keep up is a *terminatable* condition, not a retry. */
  public get isOverBudget(): boolean {
    return this.queuedBytes > this.maxQueueBytes;
  }

  public get isClosed(): boolean {
    return this.res.writableEnded || this.res.destroyed;
  }

  public write(payload: string): WriteResult {
    // Encode to a Buffer once: byte accounting (telemetry) and the socket write
    // then use the exact same representation.
    const buffer = Buffer.from(payload, 'utf8');
    this.bytesWritten += buffer.byteLength;
    this.chunksWritten += 1;

    const accepted = this.res.write(buffer);
    return { accepted, queuedBytes: this.queuedBytes };
  }

  /**
   * Wait for the socket to drain. Resolves with a reason instead of throwing so
   * the caller can translate it into the correct in-band error code.
   */
  public drain(timeoutMs: number, signal?: AbortSignal): Promise<DrainOutcome> {
    return new Promise<DrainOutcome>((resolve) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        this.res.off('drain', onDrain);
        this.res.off('close', onClose);
        this.res.off('error', onClose);
        signal?.removeEventListener('abort', onAbort);
      };

      const settle = (outcome: DrainOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      const onDrain = (): void => settle('drained');
      const onClose = (): void => settle('closed');
      const onAbort = (): void => settle('closed');

      // Fast path: nothing is buffered any more.
      if (this.queuedBytes === 0 && !this.isClosed) {
        settle('drained');
        return;
      }

      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      this.res.once('drain', onDrain);
      this.res.once('close', onClose);
      this.res.once('error', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Flush HTTP headers immediately so the client's `fetch()` can resolve. */
  public flushHeaders(): void {
    this.res.flushHeaders?.();
  }

  public end(payload?: string): void {
    if (this.isClosed) return;
    if (payload) this.write(payload);
    this.res.end();
  }

  public toStats(): { bytes: number; chunks: number; avgBytesPerChunk: number } {
    return {
      bytes: this.bytesWritten,
      chunks: this.chunksWritten,
      avgBytesPerChunk: this.chunksWritten ? Math.round(this.bytesWritten / this.chunksWritten) : 0,
    };
  }
}

/** Utility for payload-size diagnostics in tests and telemetry. */
export function payloadBytes(payload: string): number {
  return utf8ByteLength(payload);
}
```


---

## 3. Block-by-Block Explanation

### Part A: `delta-coalescer.ts` — the second granularity transition

#### Block 1: Three independent flush triggers

```typescript
const BOUNDARY_PATTERN = /(\n|[.!?…:]["')\]]?\s*)$/;

public push(text: string, atMs: number): string[] {
  if (this.buffer.length === 0) this.windowStartedAt = atMs;
  this.buffer += text;

  if (this.buffer.length >= this.maxChunkChars) return this.flush();   // 1. SIZE
  if (BOUNDARY_PATTERN.test(this.buffer)) return this.flush();         // 2. BOUNDARY
  return [];                                                          // 3. TIME (via tick)
}
```

- **What it does:** accumulates provider deltas and decides when to release them as one application chunk.
- **How it works:** the three triggers answer three different problems. **SIZE** bounds the work per write (and therefore memory). **BOUNDARY** makes chunks end on a sentence or newline, which is what lets streamed markdown render progressively instead of flashing broken syntax. **TIME** (checked by `tick()`, called from the pump's ticker) bounds latency: without it, `word` granularity with no punctuation would hold text indefinitely.

#### Block 2: The time-window check

```typescript
public tick(atMs: number): string[] {
  if (this.buffer.length === 0) return [];
  if (atMs - this.windowStartedAt < this.flushMs) return [];
  return this.flush();
}

public get hasPending(): boolean { return this.buffer.length > 0; }
```

- **What it does:** is the timer-driven half of the coalescing policy.
- **How it works:** it returns `[]` while the window is still open, and the pump uses `hasPending` to know whether a flush is even possible. `flush()` at end-of-stream emits whatever is left — even mid-word — so nothing is ever lost.

---

### Part B: `backpressure.ts` — stalling instead of overflowing

#### Block 3: Writing and measuring

```typescript
public write(payload: string): WriteResult {
  const buffer = Buffer.from(payload, 'utf8');
  this.bytesWritten += buffer.byteLength;
  this.chunksWritten += 1;
  const accepted = this.res.write(buffer);
  return { accepted, queuedBytes: this.queuedBytes };
}

public get queuedBytes(): number { return this.res.writableLength ?? 0; }
public get isOverBudget(): boolean { return this.queuedBytes > this.maxQueueBytes; }
```

- **What it does:** writes one chunk and reports whether the caller must stop.
- **How it works:** `res.write()` returning `false` is Node telling you its internal buffer is full; `writableLength` is the number of bytes still queued. Encoding to a `Buffer` once means the byte count used for telemetry and the bytes handed to the socket are the same representation. `isOverBudget` turns an unbounded backlog into a terminatable condition (`client_slow`).

#### Block 4: Draining with a bounded wait

```typescript
public drain(timeoutMs: number, signal?: AbortSignal): Promise<DrainOutcome> {
  return new Promise<DrainOutcome>((resolve) => {
    const onDrain = () => settle('drained');
    const onClose = () => settle('closed');
    const onAbort = () => settle('closed');
    if (this.queuedBytes === 0 && !this.isClosed) { settle('drained'); return; }   // fast path
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    this.res.once('drain', onDrain);
    this.res.once('close', onClose);
    this.res.once('error', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- **What it does:** waits for the socket to catch up, and resolves with a *reason* rather than throwing.
- **How it works:** resolving with `'drained' | 'timeout' | 'closed'` lets the pump map the outcome onto the right in-band error (`client_slow` vs `client_aborted`) instead of guessing. Every listener is removed in `cleanup()`, so a long stream cannot leak handlers; the fast path avoids registering anything when the buffer is already empty.

#### Block 5: Lifecycle helpers

```typescript
public flushHeaders(): void { this.res.flushHeaders?.(); }
public end(payload?: string): void { if (this.isClosed) return; if (payload) this.write(payload); this.res.end(); }
public toStats(): { bytes: number; chunks: number; avgBytesPerChunk: number }
```

- **What it does:** completes the small surface the pump needs.
- **How it works:** `flushHeaders()` is what makes `await fetch()` resolve early on the client — without it, Express may hold the response. `end()` is idempotent (`isClosed` guard) so a cancellation and a normal completion cannot double-close the socket.

---

### ✅ Chapter 07 verification

```bash
npm run stream:cli -- --granularity=token      # many small chunks (size/boundary rarely fire)
npm run stream:cli -- --granularity=sentence   # chunks end on sentence boundaries
npm run bench:latency                          # compare ITL and chunks-per-response across granularities
```


---

**Previous:**  · **Next:** 
