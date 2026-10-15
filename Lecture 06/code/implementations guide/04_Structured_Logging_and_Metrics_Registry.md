# Chapter 04: Observability Primitives: Structured Logging & Metrics Registry

> **Chapter Goal:** Produce one machine-parsable line per stream and the exact streaming histograms (server/client TTFT, the TTFT gap, ITL, chunk sizes) that detect buffering regressions.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/lib/logger.ts` | 134 lines |
| `src/lib/metrics.ts` | 329 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/lib/logger.ts` (133 lines)

```typescript
import { env } from '../config/env.js';

/**
 * Structured, single-line JSON logger.
 *
 * Why not `console.log("...")` strings? Because streaming failures are
 * *statistical* (p95 tails) and per-hop: §10.3 requires one machine-parsable
 * line per stream, carrying requestId, TTFT, chunk count, usage and finish
 * reason so that a log query can reconstruct the whole pipeline for one turn.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown>;

/**
 * Redaction at write time (§10.4.2): provider keys, bearer tokens and other
 * credentials must never appear in logs, and model output is truncated so that a
 * single log line never explodes in size.
 *
 * NOTE the deliberate precision: a naive /token/i match would also redact
 * `promptTokens` and `completionTokens` — the very fields the streaming telemetry
 * exists to record. Only credential-shaped keys are masked.
 */
const SECRET_KEY_EXACT = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'authorization',
  'auth',
  'apikey',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'cookie',
  'setcookie',
  'bearer',
  'credentials',
]);

const SECRET_KEY_PATTERN = /(secret|password|credential|api[_-]?key|authorization|bearer|cookie)/i;

const MAX_STRING_LENGTH = 512;

function isSecretKey(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  return SECRET_KEY_EXACT.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function sanitise(value: unknown, key: string, depth = 0): unknown {
  if (isSecretKey(key)) return '«redacted»';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…«truncated»` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  if (depth >= 3) return '«depth-limit»';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitise(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitise(v, k, depth + 1)])
    );
  }
  return String(value);
}

export class Logger {
  constructor(
    private readonly baseContext: LogContext = {},
    private readonly threshold: number = LEVEL_RANK[env.LOG_LEVEL]
  ) {}

  /** Derive a logger that always carries the given context (e.g. requestId). */
  public child(context: LogContext): Logger {
    return new Logger({ ...this.baseContext, ...context }, this.threshold);
  }

  public debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  /** Emit a whole record (used for the per-stream telemetry line). */
  public record(message: string, context: LogContext, level: LogLevel = 'info'): void {
    this.write(level, message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < this.threshold) return;

    const merged: LogContext = { ...this.baseContext, ...(context ?? {}) };
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...(sanitise(merged, 'root') as LogContext),
    });

    // Errors go to stderr so container platforms can split the two streams.
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

export const logger = new Logger();
export const createRequestLogger = (requestId: string, conversationId?: string): Logger =>
  logger.child(conversationId ? { requestId, conversationId } : { requestId });
```


### 📄 `src/lib/metrics.ts` (328 lines)

```typescript
import { env } from '../config/env.js';
import type { StreamTelemetry } from '../types/stream.types.js';

/**
 * A dependency-free metrics registry with the exact streaming-specific signals
 * from §10.3 — because a buffered endpoint and a broken-streaming endpoint look
 * *identical* on aggregate latency dashboards.
 *
 * Design notes
 * ------------
 * - Keyed by name + serialised labels (low cardinality by construction:
 *   transports, granularities, error codes, providers).
 * - Histograms keep a bounded ring of recent samples so the service can compute
 *   real p50/p95/p99 locally (for the TTFT-gap alert) without a backend.
 * - Two exposition formats: Prometheus text (`/metrics`) and JSON (`/metrics/json`).
 */

export type MetricLabels = Record<string, string | number | boolean>;

interface HistogramState {
  readonly help: string;
  readonly buckets: number[];
  count: number;
  sum: number;
  readonly samples: number[];
  readonly bucketCounts: number[];
}

export interface AlertRecord {
  name: string;
  severity: 'warning' | 'critical';
  value: number;
  threshold: number;
  message: string;
}

const MAX_SAMPLES_PER_SERIES = 2_048;

const DEFAULT_BUCKETS = [1, 2, 5, 10, 20, 40, 60, 100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800];
const BYTE_BUCKETS = [16, 64, 256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576];
const CHUNK_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 2_048];

function labelKey(labels?: MetricLabels): string {
  if (!labels) return '';
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}="${String(labels[key])}"`)
    .join(',');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, { help: string; values: Map<string, number> }>();
  private readonly gauges = new Map<string, { help: string; values: Map<string, number> }>();
  private readonly histograms = new Map<string, HistogramState>();

  // --------------------------------------------------------------------------
  // Counters
  // --------------------------------------------------------------------------
  public increment(name: string, labels?: MetricLabels, help = 'counter', delta = 1): void {
    if (!env.METRICS_ENABLED) return;
    let entry = this.counters.get(name);
    if (!entry) {
      entry = { help, values: new Map() };
      this.counters.set(name, entry);
    }
    const key = labelKey(labels);
    entry.values.set(key, (entry.values.get(key) ?? 0) + delta);
  }

  // --------------------------------------------------------------------------
  // Gauges
  // --------------------------------------------------------------------------
  public setGauge(name: string, value: number, labels?: MetricLabels, help = 'gauge'): void {
    if (!env.METRICS_ENABLED) return;
    let entry = this.gauges.get(name);
    if (!entry) {
      entry = { help, values: new Map() };
      this.gauges.set(name, entry);
    }
    entry.values.set(labelKey(labels), value);
  }

  public incrementGauge(name: string, labels?: MetricLabels, delta = 1): void {
    const key = labelKey(labels);
    const current = this.gauges.get(name)?.values.get(key) ?? 0;
    this.setGauge(name, current + delta, labels);
  }

  // --------------------------------------------------------------------------
  // Histograms
  // --------------------------------------------------------------------------
  public observe(
    name: string,
    value: number,
    labels?: MetricLabels,
    help = 'histogram',
    buckets: number[] = DEFAULT_BUCKETS
  ): void {
    if (!env.METRICS_ENABLED || !Number.isFinite(value)) return;

    const key = `${name}|${labelKey(labels)}`;
    let state = this.histograms.get(key);
    if (!state) {
      state = { help, buckets, count: 0, sum: 0, samples: [], bucketCounts: new Array(buckets.length).fill(0) };
      this.histograms.set(key, state);
    }

    state.count += 1;
    state.sum += value;

    // Bounded ring: keep the most recent samples for percentile estimation.
    if (state.samples.length >= MAX_SAMPLES_PER_SERIES) state.samples.shift();
    state.samples.push(value);

    for (let i = 0; i < buckets.length; i += 1) {
      if (value <= (buckets[i] as number)) {
        state.bucketCounts[i] = (state.bucketCounts[i] as number) + 1;
      }
    }
  }

  public percentileOf(name: string, labels: MetricLabels | undefined, p: number): number {
    const state = this.histograms.get(`${name}|${labelKey(labels)}`);
    if (!state || state.samples.length === 0) return 0;
    const sorted = [...state.samples].sort((a, b) => a - b);
    return percentile(sorted, p);
  }

  /**
   * Percentile summary for one metric.
   *
   * With `labels` omitted, every labelled series of that metric is AGGREGATED —
   * which is what a dashboard or alert actually asks for ("p95 server TTFT across
   * all providers", not one provider's series).
   */
  public histogramSummary(
    name: string,
    labels?: MetricLabels
  ): { count: number; p50: number; p95: number; p99: number; max: number; mean: number } {
    const target = labels === undefined ? null : `${name}|${labelKey(labels)}`;
    let count = 0;
    let sum = 0;
    const samples: number[] = [];

    for (const [key, state] of this.histograms) {
      const matches = target === null ? key.split('|')[0] === name : key === target;
      if (!matches) continue;

      count += state.count;
      sum += state.sum;
      if (samples.length < MAX_SAMPLES_PER_SERIES) {
        samples.push(...state.samples.slice(0, MAX_SAMPLES_PER_SERIES - samples.length));
      }
    }

    if (count === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };

    const sorted = samples.sort((a, b) => a - b);
    return {
      count,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted[sorted.length - 1] as number),
      mean: round(sum / count),
    };
  }

  // --------------------------------------------------------------------------
  // Stream telemetry → metrics (one call per finished stream)
  // --------------------------------------------------------------------------
  public recordStream(telemetry: StreamTelemetry): void {
    const outcome = telemetry.errorCode ? 'error' : telemetry.clientAborted ? 'aborted' : 'completed';
    this.increment('stream_requests_total', {
      transport: telemetry.transport,
      granularity: telemetry.granularity,
      outcome,
    });
    this.increment('stream_chunks_total', { transport: telemetry.transport }, 'total chunks written', telemetry.chunks);
    this.increment('stream_bytes_total', { transport: telemetry.transport }, 'total bytes written', telemetry.bytes);

    if (telemetry.ttftMs !== null) {
      this.observe('server_ttft_ms', telemetry.ttftMs, { provider: telemetry.provider }, 'request received → first delta');
    }
    this.observe('stream_total_ms', telemetry.totalMs, { transport: telemetry.transport }, 'full stream duration');
    this.observe('stream_chunks_forwarded', telemetry.chunks, {}, 'chunks per response', CHUNK_BUCKETS);
    this.observe('stream_chunk_bytes', telemetry.avgChunkBytes, {}, 'mean bytes per chunk', BYTE_BUCKETS);
    this.observe('stream_avg_itl_ms', telemetry.avgItlMs, { provider: telemetry.provider }, 'mean inter-chunk gap');
    this.observe('stream_max_itl_ms', telemetry.maxItlMs, { provider: telemetry.provider }, 'worst inter-chunk gap');
    this.observe('stream_tps', telemetry.tps, { provider: telemetry.provider }, 'characters per second');

    if (telemetry.clientAborted) this.increment('stream_aborts_total', { transport: telemetry.transport });
    if (telemetry.errorCode) this.increment('stream_inband_errors_total', { code: telemetry.errorCode });
  }

  /**
   * Client-reported TTFT ⇒ the one signal that detects proxy buffering, a
   * buffering middleware, compression re-enabled on SSE, or a frontend refactor
   * that reintroduced `await response.text()`.
   */
  public recordClientTtft(serverTtftMs: number | null, clientTtftMs: number): number | null {
    this.observe('client_ttft_ms', clientTtftMs, {}, 'click → first painted character');
    if (serverTtftMs === null || serverTtftMs <= 0) return null;
    const gap = Math.max(0, clientTtftMs - serverTtftMs);
    this.observe('ttft_gap_ms', gap, {}, 'client TTFT − server TTFT');
    return round(gap);
  }

  // --------------------------------------------------------------------------
  // Alerts
  // --------------------------------------------------------------------------
  public alerts(): AlertRecord[] {
    const alerts: AlertRecord[] = [];
    const gap = this.histogramSummary('ttft_gap_ms');

    // A minimum sample size keeps a single slow tab from paging anyone.
    if (gap.count >= 20 && gap.p95 > env.TTFT_GAP_ALERT_MS) {
      alerts.push({
        name: 'streaming_ttft_gap_high',
        severity: 'critical',
        value: gap.p95,
        threshold: env.TTFT_GAP_ALERT_MS,
        message:
          'p95(clientTTFT − serverTTFT) is high: suspect proxy buffering, compression on SSE, ' +
          'a buffering middleware, or a client that collapsed to response.text().',
      });
    }
    return alerts;
  }

  // --------------------------------------------------------------------------
  // Exposition
  // --------------------------------------------------------------------------
  public renderPrometheus(): string {
    const lines: string[] = [];

    for (const [name, entry] of this.counters) {
      lines.push(`# HELP ${name} ${entry.help}`, `# TYPE ${name} counter`);
      for (const [labels, value] of entry.values) lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    }

    for (const [name, entry] of this.gauges) {
      lines.push(`# HELP ${name} ${entry.help}`, `# TYPE ${name} gauge`);
      for (const [labels, value] of entry.values) lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    }

    for (const [key, state] of this.histograms) {
      const [name, labels] = key.split('|') as [string, string];
      const labelSuffix = labels ? `${labels},` : '';
      lines.push(`# HELP ${name} ${state.help}`, `# TYPE ${name} histogram`);
      for (let i = 0; i < state.buckets.length; i += 1) {
        lines.push(`${name}_bucket{${labelSuffix}le="${state.buckets[i]}"} ${state.bucketCounts[i]}`);
      }
      lines.push(`${name}_bucket{${labelSuffix}le="+Inf"} ${state.count}`);
      lines.push(`${name}_sum${labels ? `{${labels}}` : ''} ${round(state.sum, 3)}`);
      lines.push(`${name}_count${labels ? `{${labels}}` : ''} ${state.count}`);
    }

    for (const alert of this.alerts()) {
      lines.push(`# ALERT ${alert.name} severity=${alert.severity} value=${alert.value} threshold=${alert.threshold}`);
    }
    return `${lines.join('\n')}\n`;
  }

  public snapshot(): Record<string, unknown> {
    const counters: Record<string, unknown> = {};
    for (const [name, entry] of this.counters) counters[name] = Object.fromEntries(entry.values);

    const gauges: Record<string, unknown> = {};
    for (const [name, entry] of this.gauges) gauges[name] = Object.fromEntries(entry.values);

    const histograms: Record<string, unknown> = {};
    for (const [key, state] of this.histograms) {
      const [name, labels] = key.split('|') as [string, string];
      const sorted = [...state.samples].sort((a, b) => a - b);
      histograms[`${name}${labels ? `{${labels}}` : ''}`] = {
        count: state.count,
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        p99: round(percentile(sorted, 99)),
        max: round(sorted[sorted.length - 1] ?? 0),
        mean: state.count ? round(state.sum / state.count) : 0,
      };
    }

    return {
      enabled: env.METRICS_ENABLED,
      counters,
      gauges,
      histograms,
      alerts: this.alerts(),
    };
  }

  /** Convenience helpers for the JSON dashboard / health endpoint. */
  public streamLatencySummary(): Record<string, unknown> {
    return {
      serverTtftMs: this.histogramSummary('server_ttft_ms'),
      clientTtftMs: this.histogramSummary('client_ttft_ms'),
      ttftGapMs: this.histogramSummary('ttft_gap_ms'),
      totalMs: this.histogramSummary('stream_total_ms'),
      avgItlMs: this.histogramSummary('stream_avg_itl_ms'),
      maxItlMs: this.histogramSummary('stream_max_itl_ms'),
      chunksPerResponse: this.histogramSummary('stream_chunks_forwarded'),
      avgChunkBytes: this.histogramSummary('stream_chunk_bytes'),
      tps: this.histogramSummary('stream_tps'),
    };
  }

  public reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export const metrics = new MetricsRegistry();
```


---

## 3. Block-by-Block Explanation

### Part A: `logger.ts` — structured, redacting, level-aware

#### Block 1: Level ranking

```typescript
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
```

- **What it does:** converts level names into comparable numbers.
- **How it works:** a single numeric comparison (`LEVEL_RANK[level] < this.threshold`) decides whether a line is emitted, so the check costs nothing on the hot path and the level can be changed by environment alone.

#### Block 2: Precise redaction (the subtle part)

```typescript
const SECRET_KEY_EXACT = new Set(['token', 'accesstoken', 'refreshtoken', 'authorization',
  'apikey', 'secret', 'password', 'cookie', 'bearer', 'credentials', /* … */]);
const SECRET_KEY_PATTERN = /(secret|password|credential|api[_-]?key|authorization|bearer|cookie)/i;

function isSecretKey(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  return SECRET_KEY_EXACT.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}
```

- **What it does:** masks credential-shaped keys while leaving legitimate telemetry fields intact.
- **How it works:** a naive `/token/i` test would also mask `promptTokens` and `completionTokens` — the very fields the streaming telemetry exists to record. This is a real bug that was caught during development of this codebase (the first run printed `"promptTokens":"«redacted»"`), and the fix is the two-tier check: an exact-match set plus a pattern restricted to genuinely secret words.
- **Also:** `MAX_STRING_LENGTH = 512` truncates long values, so one log line can never explode because a model produced a 40 KB answer.

#### Block 3: Depth-limited sanitisation

```typescript
function sanitise(value: unknown, key: string, depth = 0): unknown {
  if (isSecretKey(key)) return '«redacted»';
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…«truncated»` : value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 4).join(' | ') };
  if (depth >= 3) return '«depth-limit»';
  /* arrays sliced to 50 items, objects recursed */
}
```

- **What it does:** makes any object safe to log, at a bounded cost.
- **How it works:** `Error` objects are special-cased because `JSON.stringify(new Error('x'))` produces `{}` — the single most common logging mistake. The depth limit and array slice protect the logger from a self-referential or enormous payload.

#### Block 4: The write path

```typescript
const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...(sanitise(merged, 'root') as LogContext) });
if (level === 'error') process.stderr.write(`${line}\n`);
else process.stdout.write(`${line}\n`);
```

- **What it does:** emits exactly one JSON object per line, on one of two streams.
- **How it works:** single-line JSON is what makes the output directly ingestible by Loki/CloudWatch/Datadog without a multiline parser. Errors go to stderr so container platforms can split the streams and alert on them independently.

#### Block 5: Child loggers and the telemetry record

```typescript
export const createRequestLogger = (requestId: string, conversationId?: string): Logger =>
  logger.child(conversationId ? { requestId, conversationId } : { requestId });

public record(message: string, context: LogContext, level: LogLevel = 'info'): void
```

- **What it does:** lets every log line inside one stream carry `requestId` and `conversationId` automatically.
- **How it works:** `child()` creates a new logger with a merged base context, so the pump writes `this.log.warn('Provider stream failed mid-flight.', { code })` and the correlation ids appear without being passed around. `record()` is the entry point used for the full per-stream telemetry object.

---

### Part B: `metrics.ts` — the streaming-specific registry

#### Block 6: Label serialisation (and cardinality control)

```typescript
function labelKey(labels?: MetricLabels): string {
  if (!labels) return '';
  return Object.keys(labels).sort()
    .map((key) => `${key}="${String(labels[key])}"`).join(',');
}
```

- **What it does:** turns a label object into a stable series key (`transport="sse",granularity="token"`).
- **How it works:** sorting the keys makes `{a,b}` and `{b,a}` the same series. Cardinality is bounded *by design*: the labels used here are transports, granularities, providers, error codes and outcomes — never a requestId or conversationId (which would create one series per request and destroy the registry).

#### Block 7: Counters and gauges

```typescript
public increment(name: string, labels?: MetricLabels, help = 'counter', delta = 1): void
public setGauge(name: string, value: number, labels?: MetricLabels, help = 'gauge'): void
public incrementGauge(name: string, labels?: MetricLabels, delta = 1): void
```

- **What it does:** provides the monotonic and instantaneous instruments.
- **How it works:** `incrementGauge` reads the current value and writes it back — used for `inflight_streams`, the most useful gauge for capacity planning and for detecting leaked streams.

#### Block 8: Histograms with a bounded sample ring

```typescript
if (state.samples.length >= MAX_SAMPLES_PER_SERIES) state.samples.shift();
state.samples.push(value);

for (let i = 0; i < buckets.length; i += 1) {
  if (value <= (buckets[i] as number)) state.bucketCounts[i] = (state.bucketCounts[i] as number) + 1;
}
```

- **What it does:** records every observation twice — in Prometheus-style cumulative buckets *and* in a bounded ring of raw samples.
- **How it works:** the buckets give scrape-compatible histograms; the ring (2,048 most recent values) gives real p50/p95/p99 **inside the process**, which is what makes the TTFT-gap alert possible with no metrics backend. `MAX_SAMPLES_PER_SERIES` bounds memory: a long-running service cannot grow without limit.

#### Block 9: Stream telemetry → metrics

```typescript
public recordStream(telemetry: StreamTelemetry): void {
  const outcome = telemetry.errorCode ? 'error' : telemetry.clientAborted ? 'aborted' : 'completed';
  this.increment('stream_requests_total', { transport, granularity, outcome });
  this.increment('stream_chunks_total', { transport }, 'total chunks written', telemetry.chunks);
  if (telemetry.ttftMs !== null) this.observe('server_ttft_ms', telemetry.ttftMs, { provider });
  this.observe('stream_chunks_forwarded', telemetry.chunks, {}, 'chunks per response', CHUNK_BUCKETS);
  this.observe('stream_chunk_bytes', telemetry.avgChunkBytes, {}, 'mean bytes per chunk', BYTE_BUCKETS);
  this.observe('stream_avg_itl_ms', telemetry.avgItlMs, { provider });
  this.observe('stream_max_itl_ms', telemetry.maxItlMs, { provider });
  if (telemetry.clientAborted) this.increment('stream_aborts_total', { transport });
  if (telemetry.errorCode) this.increment('stream_inband_errors_total', { code: telemetry.errorCode });
}
```

- **What it does:** converts one finished stream into every signal §10.3 asks for, in a single call.
- **How it works:** `stream_chunks_forwarded` with `CHUNK_BUCKETS` is the buffering detector — a distribution collapsed onto "1 chunk" means something on the path accumulated. `stream_inband_errors_total` makes mid-stream failures visible, because they never appear in HTTP status metrics.

#### Block 10: The TTFT gap — the one alert that matters

```typescript
const gap = Math.max(0, clientTtftMs - serverTtftMs);
this.observe('ttft_gap_ms', gap, {}, 'client TTFT − server TTFT');

// alerts()
if (gap.count >= 20 && gap.p95 > env.TTFT_GAP_ALERT_MS) { /* streaming_ttft_gap_high */ }
```

- **What it does:** measures the difference between the TTFT the server produced and the TTFT the user felt, and raises a single high-value alert on it.
- **How it works:** the server knows when it wrote the first chunk; only the client knows when it painted it. `p95(clientTTFT − serverTTFT) > 500 ms` catches — in one rule — proxy buffering, a buffering middleware, compression re-enabled on SSE, a CDN misconfiguration, and a frontend that collapsed to `await response.text()`. The `count >= 20` guard stops a single slow tab from paging anyone.

#### Block 11: Exposition

```typescript
public renderPrometheus(): string        // # HELP / # TYPE / _bucket / _sum / _count + # ALERT
public snapshot(): Record<string, unknown>
public streamLatencySummary(): Record<string, unknown>
public reset(): void                     // test/support only (guarded in the route)
```

- **What it does:** exposes the same data in three shapes: Prometheus text, a JSON snapshot, and a purpose-built latency summary.
- **How it works:** `histogramSummary` with no labels **aggregates across every labelled series** of a metric, which is what a dashboard actually asks ("p95 server TTFT across all providers"). Alert lines are appended to the Prometheus text so a scrape carries its own alert state.

---

### ✅ Chapter 04 verification

```bash
npm run test:invariants    # asserts the histograms and counters are exposed and populated
curl -s localhost:8090/metrics | grep -E 'server_ttft_ms|stream_chunks_forwarded|ALERT'
curl -s localhost:8090/api/observability | head -40
```



---

**Previous:**  · **Next:** 
