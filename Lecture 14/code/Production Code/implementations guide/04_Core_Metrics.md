# Chapter 04: Core — Metrics Without a Vendor

> **Chapter goal:** Make the server able to answer two questions with numbers
> rather than adjectives — *how often did this happen?* and *how slow was it?* —
> without pulling a metrics vendor into a learning codebase.

---

## 4.1 File details

| | |
| :--- | :--- |
| **Path** | `src/core/metrics.ts` |
| **Layer** | core (imports nothing) |
| **Purpose** | A tiny in-process counter + latency registry, with a flat `snapshot()` you can print, scrape or assert on |
| **Imports** | none |
| **Exports** | `interface Metrics`, `createMetrics()` |
| **Consumed by** | `src/mcp/server.ts` (creates it), `src/mcp/tools.ts` (records into it via `ServerDeps`) |
| **Lecture sections** | [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §"Observability" and §"Rate limits and quotas" |

### Commands

```bash
cd "Lecture 14/code/Production Code"
npm run host      # metrics are recorded on every call
```

> There is no `npm run metrics` because this server has no HTTP surface to scrape
> — which is itself the lesson of the chapter. The registry is a *data structure*;
> how it leaves the process is a separate, swappable decision.

---

## 4.2 Full file

```ts
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
```

## 4.3 Block-by-block explanation

### Block 1 — the `Metrics` interface, and why it is three methods

```ts
export interface Metrics {
  count(name: string, by?: number): void;
  observe(name: string, milliseconds: number): void;
  snapshot(): Record<string, number>;
}
```

**What it does:** defines the smallest useful metrics surface: increment, observe,
read.
**How it works:** each method maps to one of the two metric *types* every backend
converges on.

| Method | Metric type | Question it answers |
| :--- | :--- | :--- |
| `count(name)` | **Counter** — monotonic, never decreases | *How often?* |
| `observe(name, ms)` | **Histogram** (summarised) | *How slow?* |
| `snapshot()` | — | *Show me everything now* |

**`by?: number` on `count` is for batching, and the doc comment says so
explicitly.** A counter that can be decremented is not a counter — it is a gauge,
and a gauge that goes down after an incident is how you lose the ability to
answer "did this ever happen?". The `by` parameter exists for the case where you
already have a number (`count("items.processed", batch.length)`); it is not an
invitation to subtract.

**`snapshot(): Record<string, number>` returns a flat map.** Not a nested object,
not a class instance — a flat `Record<string, number>`. That shape is chosen
because it is exactly what a Prometheus text exposition or an OTel gauge set
serialises to, and because it makes assertions trivial:

```ts
expect(metrics.snapshot()["tool.ok.create_task"]).toBe(2);
```

A nested structure would need a serialiser per backend. A flat map needs a `for`
loop.

### Block 2 — the internal `Timing` record

```ts
interface Timing {
  count: number;
  total: number;
  max: number;
}
```

**What it does:** holds the three numbers needed to summarise a latency stream.
**How it works:** this is the classic **three-value summary** — a running count, a
running sum, and a running maximum.

Why these three, and not a full histogram? Because storing every sample is a
memory leak with a friendly name, and because these three answer the two
questions that actually get asked during an incident:

- `total / count` → the **average**, which is what a dashboard shows.
- `max` → the **worst case**, which is what a user complained about.

The average alone is a trap: a service that takes 5 ms for 99 % of calls and 30 s
for the other 1 % has a lovely 300 ms average. `max` is what keeps the average
honest, and it is the reason this record has three fields instead of two.

**Note the absence of `min`.** The minimum is almost always the same number (the
fastest possible path) and it never prompts an investigation. Adding it would be
one more field to maintain for a number nobody reads.

### Block 3 — two maps, one per metric type

```ts
const counters = new Map<string, number>();
const timings = new Map<string, Timing>();
```

**What they do:** store the two metric types separately.
**How they work:** `Map` rather than a plain object, for three reasons:

1. **Insertion order is preserved** — `snapshot()` emits keys in the order they
   were first recorded, which makes output stable and diffable between runs. A
   plain object would order integer-like keys numerically first, giving you a
   different order depending on your metric names.
2. **No prototype pollution.** A metric named `"constructor"` or `"__proto__"` is
   a key in an object's prototype chain but an ordinary key in a `Map`. Metric
   names are derived from tool names, which come from a server — treat them as
   untrusted.
3. **O(1) with no hidden-class churn** — a `Map` does not have to re-shape an
   object when a new key appears, which matters when you record on every request.

The two maps are separate rather than one `Map<string, number | Timing>` because
the `snapshot()` logic for each is different, and mixing them would force a type
check on every read.

### Block 4 — `count`, in one line

```ts
count(name, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
},
```

**What it does:** increments a counter, creating it at `by` if it does not exist.
**How it works:** `counters.get(name) ?? 0` is the entire idiom. `Map.get` returns
`undefined` for a missing key, and `?? 0` turns that into the counter's identity
element. Then `.set()` writes it back.

The `by = 1` default is what makes the common case read as
`metrics.count("tool.ok.create_task")` — one argument, no noise.

> **A note on `??` versus `||`.** `counters.get(name) || 0` would look equivalent
> and would work here, because a counter never legitimately holds `0`. The `??` is
> still the right choice: it states "replace only `undefined`", which is true
> regardless of what the values turn out to be. Reaching for `||` when you mean
> `??` is how a legitimate `0` or `""` gets silently replaced by a default.

### Block 5 — `observe`, the three-value update

```ts
observe(name, milliseconds) {
  const timing = timings.get(name) ?? { count: 0, total: 0, max: 0 };
  timing.count += 1;
  timing.total += milliseconds;
  timing.max = Math.max(timing.max, milliseconds);
  timings.set(name, timing);
},
```

**What it does:** folds one latency sample into the running summary.
**How it works:** it is a **reduction** — the same pattern as
`Array.prototype.reduce`, applied incrementally instead of over a stored array.

1. **`timings.get(name) ?? { count: 0, total: 0, max: 0 }`** — read the existing
   summary, or start a fresh one. The literal here must match the `Timing` shape;
   TypeScript enforces that.
2. **`timing.count += 1`** — one more sample.
3. **`timing.total += milliseconds`** — accumulate the raw sum. Note it stores the
   **sum, not the average**. You cannot correctly update a running average by
   averaging averages — that is a well-known statistical error, and it appears in
   production dashboards constantly. Keeping the sum makes `total / count` exact
   at read time.
4. **`timing.max = Math.max(timing.max, milliseconds)`** — the worst case.
5. **`timings.set(name, timing)`** — write it back.

**Why mutate the object rather than replace it?** Because `timings.get(name)`
returned a *reference* to the object already in the map, so steps 2–4 have already
updated it. The `.set()` on the last line is therefore redundant **on the happy
path** — but it is required on the first call for a name, where the object came
from the `??` fallback and is not yet in the map. Keeping it unconditional is
simpler and correct in both cases; removing it as an "optimisation" is a bug.

**This is the one place in `core/` that mutates.** Everywhere else (the logger,
`redact`, the audit trail) returns fresh structures. The difference is ownership:
this object was created by and belongs to the registry, so mutating it is internal
bookkeeping, not a change to a caller's data.

### Block 6 — `snapshot`, flattening two shapes into one

```ts
snapshot() {
  const out: Record<string, number> = {};

  for (const [name, value] of counters) {
    out[name] = value;
  }

  for (const [name, timing] of timings) {
    out[`${name}.count`] = timing.count;
    out[`${name}.avg`] = Math.round(timing.total / timing.count);
    out[`${name}.max`] = Math.round(timing.max);
  }

  return out;
},
```

**What it does:** produces a flat `Record<string, number>` of every metric.
**How it works:**

**Counters pass through unchanged** — their name is already the full metric name.

**Timings are exploded into three derived keys** with a dotted suffix:

```text
tool.latency_ms.create_task.count   3
tool.latency_ms.create_task.avg     17
tool.latency_ms.create_task.max     41
```

The `recordedName + "." + suffix` convention is what Prometheus, StatsD and OTel
all use, and it exists because most metric backends only accept a flat
`name → number` map. Keeping the flattening here means the *caller* never has to
know how the summary is stored.

**`Math.round(timing.total / timing.count)`** — the average is computed at read
time, for the reason given in Block 5, and rounded. The rounding is deliberate:

- **Sub-millisecond precision in a latency metric is noise.** A call that takes
  0.4127 ms and one that takes 0.4001 ms are the same call; printing the
  difference invites someone to "optimise" it.
- **It keeps the snapshot stable across runs**, which is what makes it usable in a
  test assertion or a diff.

**A snapshot is a *copy*.** Nothing in the returned object aliases the internal
maps, so a caller cannot corrupt the registry by mutating the result. That is the
same ownership discipline as `taskStore.list()` returning `[...tasks.values()]`
(Chapter 07).

**No reset, and no timestamps.** `snapshot()` is a read, not a drain. Metrics here
are process-lifetime counters, which is the correct semantic for a server spawned
per host session — when the process dies, the counters die with it. Adding a
`reset()` would invite a scrape loop that silently loses data between scrapes.

---

## 4.4 Run / verify

The metrics are recorded on every tool call. They are wired into the tool layer
through `ServerDeps` (Chapter 09) and written by `guard()` (Chapter 10): every
successful call does `deps.metrics.count(\`tool.ok.${tool}\`)`, every failure
`deps.metrics.count(\`tool.error.${tool}\`)`, and the `finally` block always does
`deps.metrics.observe(\`tool.latency_ms.${tool}\`, …)`.

The demo never calls `snapshot()`, so the honest way to verify the registry is to
exercise it directly:

```bash
npx tsx -e '
import { createMetrics } from "./src/core/metrics.ts";
const metrics = createMetrics();
metrics.count("tool.ok.create_task");
metrics.count("tool.ok.create_task");
metrics.count("tool.error.complete_task");
metrics.observe("tool.latency_ms.create_task", 41);
metrics.observe("tool.latency_ms.create_task", 2);
metrics.observe("tool.latency_ms.create_task", 8);
console.log(JSON.stringify(metrics.snapshot(), null, 2));
'
```

```json
{
  "tool.ok.create_task": 2,
  "tool.error.complete_task": 1,
  "tool.latency_ms.create_task.count": 3,
  "tool.latency_ms.create_task.avg": 17,
  "tool.latency_ms.create_task.max": 41
}
```

Read the last three lines as the story of the chapter: three calls happened, the
average was 17 ms, and the worst was 41 ms. **The average alone would have hidden
that 41.**

Check the arithmetic: `(41 + 2 + 8) / 3 = 17`. Now confirm the running-sum design
by feeding the same three samples in a different order — the result must be
identical, because the summary is order-independent:

```bash
npx tsx -e '
import { createMetrics } from "./src/core/metrics.ts";
const metrics = createMetrics();
for (const ms of [2, 41, 8]) metrics.observe("tool.latency_ms.create_task", ms);
console.log(metrics.snapshot()["tool.latency_ms.create_task.avg"]);
'
```

```text
17
```

> **Why `snapshot()` is not printed by the demo:** the server is a child process,
> so its in-memory registry is invisible to the host. Making the numbers leave the
> process means either `sendLoggingMessage` over the protocol or an HTTP scrape
> endpoint — both real options, neither needed to teach the data structure.
> Chapter 13 mentions the `logging` capability that makes the first one possible.

---

## 4.5 Checkpoint

1. **Two metric types cover almost everything: a counter and a latency summary.**
   Counters answer *how often*; count/sum/max answers *how slow*.
2. **Store the sum, not the average.** Averaging averages is a statistical error
   and the classic dashboard bug. Computing the average at read time is what makes
   the summary order-independent.
3. **`max` is what keeps the average honest.** A mean with no worst case hides the
   tail that users actually complain about.
4. **`snapshot()` returns a flat `Record<string, number>`** — the shape every
   metrics backend serialises to, and the shape that makes a test assertion a
   one-liner.
5. **The registry owns its `Timing` objects and mutates them in place; everything
   it returns is a copy.** Ownership decides whether mutation is allowed.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 03 — Core: Structured Logging & Redaction](./03_Core_Structured_Logging.md)

**Next:** [Chapter 05 — Core: The Error Taxonomy](./05_Core_Error_Taxonomy.md)


