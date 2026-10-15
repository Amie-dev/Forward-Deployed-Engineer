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
