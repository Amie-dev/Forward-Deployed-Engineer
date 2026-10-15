# Chapter 11: In-Flight Stream Registry: Admission Control, Cancellation & Catch-Up

> **Chapter Goal:** Know what is streaming right now, cap concurrency, cancel by requestId, and retain a bounded replay ring so a client that lost its socket can recover missed frames.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/services/stream-registry.ts` | 151 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/services/stream-registry.ts` (150 lines)

```typescript
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
```


---

## 3. Block-by-Block Explanation

### Part A: Admission control

#### Block 1: Check, don't reserve

```typescript
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
```

- **What it does:** decides whether a new stream may start, and returns the *reason* if it may not.
- **How it works:** it is a pure check (no state mutation), which means it can be called before any bytes are written and its failure can become a real HTTP `409`/`429` — the "easy path" of §7.7. The two limits protect different resources: the per-conversation cap protects transcript integrity, the global cap protects the provider quota. A `429` with a reason is far more useful than a silently queued request that eventually times out.

---

### Part B: Registration, cancellation and the replay ring

#### Block 2: Register and release

```typescript
public register(entry: ActiveStreamEntry): void {
  this.active.set(entry.requestId, { ...entry, frames: [], lastSeq: 0 });
  metrics.setGauge('inflight_streams', this.active.size, {}, 'currently streaming generations');
}

public release(requestId: string): void {
  this.active.delete(requestId);
  metrics.setGauge('inflight_streams', this.active.size, {}, 'currently streaming generations');
}
```

- **What it does:** makes a running generation a first-class, addressable object with an `abort` handle.
- **How it works:** the entry carries `abort: (code, message) => pump.abort(code, message)`, which is how `POST /api/chat/streams/:requestId/cancel` reaches the pump and therefore the provider. The gauge is updated on both transitions, so a leak (a stream that never releases) is immediately visible as a non-zero `inflight_streams` at idle — asserted in the test suite.

#### Block 3: The bounded replay ring

```typescript
public recordFrame(requestId: string, frame: StreamFrame, payload: string): void {
  const record = this.active.get(requestId);
  if (!record) return;
  if (frame.type === 'delta') record.lastSeq = Math.max(record.lastSeq, frame.seq);
  record.frames.push({ seq: record.lastSeq, type: frame.type, payload, at: Date.now() });

  const limit = env.STREAM_REPLAY_BUFFER_FRAMES;
  if (limit > 0 && record.frames.length > limit) record.frames.splice(0, record.frames.length - limit);
}
```

- **What it does:** retains the frames that were actually written, verbatim, so a client can re-read what it missed.
- **How it works:** frames are stored **as written** (the exact NDJSON line or SSE block), so the client re-uses the same parser — no second serialisation path that could disagree. Only delta frames advance `lastSeq`; status frames inherit the current cursor so a client can resume from "everything up to and including seq N". The ring is bounded by `STREAM_REPLAY_BUFFER_FRAMES`, which caps memory per stream. In a multi-instance deployment this same interface would sit in front of Redis pub/sub.

#### Block 4: Replay, lookup and cancellation

```typescript
public replay(requestId: string, fromSeq: number): ReplayFrame[] {
  const record = this.active.get(requestId);
  if (!record) return [];
  return record.frames.filter((frame) => frame.seq > fromSeq);
}

public cancel(requestId: string, code: StreamErrorCode = 'client_aborted', message = '…'): boolean {
  const record = this.active.get(requestId);
  if (!record) return false;
  record.abort(code, message);
  metrics.increment('stream_cancel_requests_total', { source: 'api' });
  return true;
}

public snapshot(): Array<{ requestId; conversationId; transport; startedAt; frames; lastSeq; ageMs }>
```

- **What it does:** implements cursor-based recovery, explicit cancellation and introspection.
- **How it works:** `replay` is a filter on a monotonically increasing cursor — the client sends the highest `seq` it applied and receives exactly the frames after it. `cancel` returning a boolean is what lets the route answer `404` honestly for an unknown requestId instead of pretending. `snapshot()` powers `GET /api/chat/streams` and the graceful-shutdown drain in `server.ts`.

---

### ✅ Chapter 11 verification

```bash
npm run test:invariants    # section 8 (409 on concurrency) and section 10 (registry drained)
curl -s localhost:8090/api/chat/streams
curl -s 'localhost:8090/api/chat/streams/req_xxx/catch-up?fromSeq=0'
```


---

**Previous:**  · **Next:** 
