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
