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
