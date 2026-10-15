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
