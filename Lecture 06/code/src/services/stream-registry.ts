import { env } from '../config/env.js';
import { metrics } from '../lib/metrics.js';
import type { StreamErrorCode, StreamFrame, StreamTransport } from '../types/stream.types.js';

/**
 * In-flight stream registry (Chapter 06.6 + hardening items #11–#14).
 *
 * Three jobs:
 *  1. **Concurrency control.** Caps per conversation and globally, so one user
 *     (or one retry storm) cannot saturate the provider quota.
 *  2. **Explicit cancellation.** `POST /api/chat/streams/:requestId/cancel`
 *     reaches the pump — which is what actually stops token spend.
 *  3. **Catch-up/replay.** Every emitted frame is retained in a bounded ring so a
 *     client that lost its socket can re-read what it missed using the sequence
 *     numbers it already has (Cursor/Last-Event-ID style recovery).
 *
 * NOTE: the ring is per-process. A multi-instance deployment puts the same
 * interface in front of Redis pub/sub; nothing else in the pipeline changes.
 */

export interface ReplayFrame {
  seq: number;
  type: StreamFrame['type'];
  payload: string;
  at: number;
}

export interface ActiveStreamEntry {
  requestId: string;
  conversationId: string;
  transport: StreamTransport;
  startedAt: number;
  abort: (code: StreamErrorCode, message: string) => void;
}

export type AcquireResult =
  | { ok: true; inflight: number; conversationInflight: number }
  | { ok: false; reason: 'conversation_busy' | 'global_limit'; inflight: number; conversationInflight: number };

interface RegistryRecord extends ActiveStreamEntry {
  frames: ReplayFrame[];
  /** Highest delta sequence emitted so far — the catch-up cursor. */
  lastSeq: number;
}

export class StreamRegistry {
  private readonly active = new Map<string, RegistryRecord>();

  /** Admission control: called BEFORE any response headers are written. */
  public acquire(conversationId: string): AcquireResult {
    const conversationInflight = this.countForConversation(conversationId);
    const inflight = this.active.size;

    if (conversationInflight >= env.MAX_CONCURRENT_STREAMS_PER_CONVERSATION) {
      return { ok: false, reason: 'conversation_busy', inflight, conversationInflight };
    }
    if (inflight >= env.MAX_CONCURRENT_STREAMS_GLOBAL) {
      return { ok: false, reason: 'global_limit', inflight, conversationInflight };
    }
    return { ok: true, inflight: inflight + 1, conversationInflight: conversationInflight + 1 };
  }

  public register(entry: ActiveStreamEntry): void {
    this.active.set(entry.requestId, { ...entry, frames: [], lastSeq: 0 });
    metrics.setGauge('inflight_streams', this.active.size, {}, 'currently streaming generations');
  }

  public release(requestId: string): void {
    this.active.delete(requestId);
    metrics.setGauge('inflight_streams', this.active.size, {}, 'currently streaming generations');
  }

  /** Retain a frame for catch-up. Bounded by STREAM_REPLAY_BUFFER_FRAMES. */
  public recordFrame(requestId: string, frame: StreamFrame, payload: string): void {
    const record = this.active.get(requestId);
    if (!record) return;

    // Only delta frames advance the cursor; status frames inherit the latest one
    // so a client can resume from "everything up to and including seq N".
    if (frame.type === 'delta') record.lastSeq = Math.max(record.lastSeq, frame.seq);
    record.frames.push({ seq: record.lastSeq, type: frame.type, payload, at: Date.now() });

    const limit = env.STREAM_REPLAY_BUFFER_FRAMES;
    if (limit > 0 && record.frames.length > limit) {
      record.frames.splice(0, record.frames.length - limit);
    }
  }

  /** Frames the client has not seen yet, given the last sequence number it holds. */
  public replay(requestId: string, fromSeq: number): ReplayFrame[] {
    const record = this.active.get(requestId);
    if (!record) return [];
    return record.frames.filter((frame) => frame.seq > fromSeq);
  }

  public get(requestId: string): ActiveStreamEntry | undefined {
    const record = this.active.get(requestId);
    if (!record) return undefined;
    const { frames: _frames, ...entry } = record;
    return entry;
  }

  public cancel(requestId: string, code: StreamErrorCode = 'client_aborted', message = 'Cancelled by API request.'): boolean {
    const record = this.active.get(requestId);
    if (!record) return false;
    record.abort(code, message);
    metrics.increment('stream_cancel_requests_total', { source: 'api' });
    return true;
  }

  public countForConversation(conversationId: string): number {
    let count = 0;
    for (const record of this.active.values()) {
      if (record.conversationId === conversationId) count += 1;
    }
    return count;
  }

  public inflight(): number {
    return this.active.size;
  }

  public snapshot(): Array<{
    requestId: string;
    conversationId: string;
    transport: StreamTransport;
    startedAt: number;
    frames: number;
    lastSeq: number;
    ageMs: number;
  }> {
    const now = Date.now();
    return [...this.active.values()].map((record) => ({
      requestId: record.requestId,
      conversationId: record.conversationId,
      transport: record.transport,
      startedAt: record.startedAt,
      frames: record.frames.length,
      lastSeq: record.lastSeq,
      ageMs: now - record.startedAt,
    }));
  }

  public reset(): void {
    this.active.clear();
    metrics.setGauge('inflight_streams', 0, {}, 'currently streaming generations');
  }
}

export const streamRegistry = new StreamRegistry();
