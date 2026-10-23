/**
 * The numbers you cannot reconstruct after the fact.
 *
 * A counter answers *how often*, a latency observation answers *how slow*, and
 * both are only useful if they are cheap enough to call on every request. This
 * registry is deliberately in-process and allocation-light: it exists so the
 * primitive layers can prove what they did without a metrics vendor in the loop.
 *
 * Lecture 15 adds one requirement the tool-only version did not have — the
 * **selection** path needs its own numbers. "Which resource did the application
 * choose, by which strategy, and how many characters did that cost?" is a
 * question you cannot answer from logs alone at volume, and it is the question
 * Notes Ch05 §"Observability: log the why" says you will be asked at 2 a.m.
 *
 * The shape is the one every backend eventually converges on — a monotonic
 * counter plus count/avg/max per operation — which is also exactly what a
 * `Prometheus` or `OTel` adapter would scrape.
 */

export interface Metrics {
  /** Increment a counter. `by` is for batching, never for decrementing. */
  count(name: string, by?: number): void;
  /** Record one latency sample, in milliseconds. */
  observe(name: string, milliseconds: number): void;
  /**
   * Time `work` and record the result under `<name>.ms`.
   *
   * A wrapper rather than a pair of calls, because a manual `observe` before
   * every early `return` is exactly the kind of bookkeeping that gets forgotten
   * on the error path — and the error path is the one you need measured.
   */
  time<T>(name: string, work: () => T): T;
  /** A flat, sorted snapshot — the thing you print, scrape or assert on. */
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

  const observe = (name: string, milliseconds: number): void => {
    const timing = timings.get(name) ?? { count: 0, total: 0, max: 0 };
    timing.count += 1;
    timing.total += milliseconds;
    timing.max = Math.max(timing.max, milliseconds);
    timings.set(name, timing);
  };

  return {
    count(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },

    observe,

    time(name, work) {
      const startedAt = performance.now();

      try {
        return work();
      } finally {
        // `finally`, not a happy-path call: a failure is a latency sample too.
        observe(`${name}.ms`, performance.now() - startedAt);
      }
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

      // Sorted so two runs are diffable — an unstable key order makes a
      // snapshot useless for the one thing it is good at: comparing runs.
      return Object.fromEntries(Object.entries(out).sort(([left], [right]) => left.localeCompare(right)));
    },
  };
}
