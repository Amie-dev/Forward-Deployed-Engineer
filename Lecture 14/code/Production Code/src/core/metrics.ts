/**
 * Chapter 08 — the numbers you cannot reconstruct after the fact.
 *
 * A counter answers *how often*, a latency observation answers *how slow*, and
 * both are only useful if they are cheap enough to call on every request. This
 * registry is deliberately in-process and allocation-light: it exists so the
 * tool layer can prove what it did without a metrics vendor in the loop.
 *
 * The shape is the one every backend eventually converges on — a monotonic
 * counter plus count/avg/max per operation — which is also exactly what the
 * `Prometheus` or `OTel` adapter would scrape.
 */

export interface Metrics {
  /** Increment a counter. `by` is for batching, never for decrementing. */
  count(name: string, by?: number): void;
  /** Record one latency sample, in milliseconds. */
  observe(name: string, milliseconds: number): void;
  /** A flat snapshot — the thing you print, scrape or assert on in a test. */
  snapshot(): Record<string, number>;
}

interface Timing {
  count: number;
  total: number;
  max: number;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const timings = new Map<string, Timing>();

  return {
    count(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },

    observe(name, milliseconds) {
      const timing = timings.get(name) ?? { count: 0, total: 0, max: 0 };
      timing.count += 1;
      timing.total += milliseconds;
      timing.max = Math.max(timing.max, milliseconds);
      timings.set(name, timing);
    },

    snapshot() {
      const out: Record<string, number> = {};

      for (const [name, value] of counters) {
        out[name] = value;
      }

      for (const [name, timing] of timings) {
        // Average is rounded to a whole millisecond: sub-millisecond precision
        // in a counter is noise, and noise makes dashboards lie.
        out[`${name}.count`] = timing.count;
        out[`${name}.avg`] = Math.round(timing.total / timing.count);
        out[`${name}.max`] = Math.round(timing.max);
      }

      return out;
    },
  };
}
