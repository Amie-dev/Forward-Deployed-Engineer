# Chapter 04 — Core: Metrics Without a Vendor

> **93 lines, one `Map` of counters and one `Map` of timings.** No Prometheus client, no OTel
> exporter, no agent. The shape is deliberately the one every backend converges on, so the
> adapter you eventually write is a translation rather than a redesign — and in the meantime
> you can prove what the primitives did without a metrics vendor in the loop.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/core/metrics.ts` (93 lines) |
| **Layer** | `core` — no SDK, no transport, no `config` |
| **Purpose** | Counters and latency observations, cheap enough to call on every request, with a sorted snapshot you can print, scrape or assert on. |
| **Exports** | `Metrics` (interface), `createMetrics()` |
| **Lecture sections** | Ch05 §"Observability: log the why", Ch08 (production hardening) |
| **Runs** | `npm run lifecycle` step 13 · `GET /metrics` on the host |

---

## Commands

```bash
# the server's own numbers, printed at the end of the walkthrough
npm run lifecycle 2>/dev/null | sed -n '/^13\. metrics/,$p'

# the host's numbers, over HTTP
npm run server & npm run host & sleep 4
curl -s http://127.0.0.1:8080/metrics | head -30
```

---

## Why Lecture 15 needs its own metrics

A tool-only server (Lecture 14) needs to answer *how often was this tool called* and *how slow
was it*. Those are the classic two, and this file's `count` / `observe` / `time` cover them.

Lecture 15 adds a third question that the classic pair cannot express, and the file's header
comment names it:

> **the selection path needs its own numbers.** "Which resource did the application choose, by
> which strategy, and how many characters did that cost?" is a question you cannot answer from
> logs alone at volume, and it is the question Notes Ch05 §"Observability: log the why" says you
> will be asked at 2 a.m.

That is a genuinely different shape of question. A tool call is an *event*: it happened, at a
time, and it either worked or did not. A selection is a *decision*: several strategies ran,
candidates were considered, some were rejected by an ACL, a budget capped the result. Logging
that per request gives you a wall of text; a counter per strategy gives you a distribution.

So the registry is intentionally generic — `count(name)` and `observe(name, ms)` with a string
key — because the names are the API. `selection.strategy.state` and `selection.strategy.llm`
are two counters, and their ratio is the answer to "is the inference engine pulling its
weight, or is it always falling through to retrieval?" That question is answerable from a
dashboard and not from a log.

---

## `src/core/metrics.ts` — the full file

```ts
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
   *
   * It handles both shapes of `work`. A **synchronous** call is measured by its
   * own `return`; a **promise-returning** call is measured to settlement, which
   * is the only point at which the duration means anything. Measuring a promise
   * synchronously would record the time taken to *create* it — always
   * approximately zero for a network call, which is a latency metric that looks
   * healthy while measuring nothing.
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

    time<T>(name: string, work: () => T): T {
      const startedAt = performance.now();
      const done = (): void => observe(`${name}.ms`, performance.now() - startedAt);

      let result: T;

      try {
        result = work();
      } catch (error) {
        // A synchronous throw is a latency sample too.
        done();
        throw error;
      }

      /**
       * A promise settles *after* this function returns, so the sample has to be
       * attached to settlement rather than taken here. `Promise.resolve()`
       * assimilates any thenable, which is what gives us a real `.finally` even
       * for a bare `PromiseLike`.
       *
       * Both directions are covered: `.finally` runs on fulfilment and on
       * rejection, so a failed call is measured exactly like a successful one —
       * which is the case the manual `observe`-before-every-return pattern
       * always loses.
       */
      if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
        return Promise.resolve(result).finally(done) as unknown as T;
      }

      done();
      return result;
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
```

### Block-by-block

**Block 1 — the `Metrics` interface (lines 20–35).**

```ts
export interface Metrics {
  count(name: string, by?: number): void;
  observe(name: string, milliseconds: number): void;
  time<T>(name: string, work: () => T): T;
  snapshot(): Record<string, number>;
}
```

Four methods, and the interesting decision is the **third** one.

`count` and `observe` are the primitives: a monotonic counter and one latency sample. Note the
comment on `count` — *`by` is for batching, never for decrementing*. A counter that can go
down is not a counter, and a negative increment turns a rate calculation into nonsense. The
restriction is documented rather than enforced (a negative `by` would work), which is a
deliberate trade for a 93-line file: the type signature says `number`, the comment says what
the number means.

`time` is the one that earns its place. The alternative is the obvious one:

```ts
// the version this codebase deliberately does NOT use
const startedAt = performance.now();
const result = await doWork();
metrics.observe("thing.ms", performance.now() - startedAt);
return result;
```

and the comment above `time` says exactly why it is wrong:

> A wrapper rather than a pair of calls, because a manual `observe` before every early `return`
> is exactly the kind of bookkeeping that gets forgotten on the error path — and the error path
> is the one you need measured.

This is the whole argument, and it generalises: **any two things that must happen together
will eventually be separated by an early return.** The manual version measures the happy path
and silently stops measuring the moment something throws — which means your p50 latency looks
fine and your p99 is missing entirely, because slow failures never got recorded.

`time<T>(name, work): T` is generic in the return type, so it wraps any function without a
cast — and it accepts **both** shapes of work: a synchronous call, and a promise-returning one.

That second case is where the obvious implementation is wrong, and it is worth walking through
because the failure is silent. A promise settles *after* the function returns, so a synchronous
`finally` around `work()` measures only the time taken to *create* the promise — which for a
network call is always approximately zero. The result is a latency metric that reads `0` on
every line and looks perfectly healthy. Ten real HTTP round trips, before the fix:

```text
client.readResource.ms.avg               0
client.readResource.ms.max               0
```

So the implementation checks whether `work()` returned a thenable, and if it did, attaches the
observation to **settlement** instead:

```ts
if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
  return Promise.resolve(result).finally(done) as unknown as T;
}
```

`Promise.resolve()` is doing real work in that line: it assimilates any thenable — including a
bare `PromiseLike` with no `.finally` of its own — so the `.finally` that follows is always
available. And because `.finally` runs on fulfilment *and* on rejection, a failed call is
measured exactly like a successful one. The same ten reads, after:

```text
client.readResource.ms.avg               9
client.readResource.ms.max              11
```

Three paths are covered, and the third is the one the manual pattern always loses: a
synchronous success, a synchronous throw, and a rejected promise. The `catch` block above the
thenable check handles the synchronous throw — it observes and re-throws, so a failure still
produces a sample.

Note what this buys the lecture specifically. `host/client.ts` wraps every verb this way:

```ts
const result = await metrics.time("client.readResource", () => client.readResource({ uri }));
```

and that line now reports the true round-trip time of `resources/read` — the number you need
when a Resource renderer starts hitting a slow backend. The metric is only meaningful because
the measurement is attached to settlement rather than to promise construction.

**Block 2 — `Timing` and the closure state (lines 37–53).**

```ts
interface Timing {
  count: number;
  total: number;
  max: number;
}

const counters = new Map<string, number>();
const timings = new Map<string, Timing>();
```

Two maps, and the `Timing` shape is the classic **count / total / max** triple. Why those three
and not, say, a list of every sample:

| Field | Answers | Why not the alternative |
| :--- | :--- | :--- |
| `count` | how often | Needed for the average and for rates |
| `total` | — (used for the mean) | Storing `avg` directly loses precision on every update |
| `max` | the worst case | A mean hides the one request that took 4 seconds |

Storing `total` rather than a running `avg` is a small but real decision: an average updated
incrementally accumulates rounding error, and `total / count` at read time does not. And `max`
is the field that matters operationally — a p50 of 2 ms with a max of 4000 ms is a different
system from one with a max of 5 ms, and the average cannot distinguish them.

The `?? { count: 0, total: 0, max: 0 }` in `observe` is the lazy-initialisation idiom:

```ts
const timing = timings.get(name) ?? { count: 0, total: 0, max: 0 };
```

A brand-new metric name starts at zero, so callers never have to declare a metric before
using it. That is what makes `count` and `observe` safe to call from anywhere without a
registration step — which is what makes them cheap enough to leave in a hot path.

**Block 3 — `count`, `observe` and `time` (lines 55–71).**

```ts
count(name, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
},
```

The default `by = 1` makes the common case a bare `metrics.count("tool.call")`. The `?? 0` is
the same lazy-init, and the whole method is one `Map` get and one `Map` set.

```ts
time(name, work) {
  const startedAt = performance.now();

  try {
    return work();
  } finally {
    // `finally`, not a happy-path call: a failure is a latency sample too.
    observe(`${name}.ms`, performance.now() - startedAt);
  }
},
```

Three details:

- **`try/finally` with the `return` inside `try`.** The value flows straight out — no
  intermediate variable — and the `finally` still runs. This is the correct way to time
  something and return it, and it is why the manual version is worse: the manual version has
  to store the result, observe, and then return, which is three lines a caller can get wrong.
- **`performance.now()`, not `Date.now()`.** `Date.now()` is wall-clock and jumps backwards on
  an NTP correction, which can produce a *negative* duration. `performance.now()` is monotonic,
  so a duration can never be negative regardless of clock adjustments.
- **The `${name}.ms` suffix.** The name passed in is the *operation* (`client.readResource`);
  the `.ms` namespace keeps timings from colliding with counters of the same name. It is a
  convention enforced by `snapshot()` below, which emits `.count` / `.avg` / `.max` for the
  same base name.

Note there is no `await` anywhere in this file, which is consistent with the synchronous
`work: () => T` signature.

**Block 4 — `snapshot()` (lines 73–92).**

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

  return Object.fromEntries(Object.entries(out).sort(([left], [right]) => left.localeCompare(right)));
},
```

The flattening step: one `Timing` becomes three flat numeric keys, so the whole snapshot is
`Record<string, number>` — a shape that maps directly onto a Prometheus gauge, a CloudWatch
metric, or a JSON response body with no translation layer.

Two decisions worth naming:

**The `Math.round`.** The comment says why: *sub-millisecond precision in a counter is noise,
and noise makes dashboards lie.* A metric reading `1.7000000000000002` invites you to compare
digits that mean nothing. Rounding to whole milliseconds makes the number honest about its own
resolution.

**The sort.** The comment is the argument: *sorted so two runs are diffable — an unstable key
order makes a snapshot useless for the one thing it is good at: comparing runs.*

That is a sharper point than it looks. `Object.keys()` order for string keys is insertion
order, and insertion order depends on which metric was first touched — which depends on the
request path. So an unsorted snapshot would print in a different order between two runs of the
same code, and `diff before.json after.json` would be all noise. Sorting by name makes the
snapshot **stable output**, which is what makes it usable as a regression check: run the
lifecycle, save the snapshot, change something, diff.

---

## Run / verify

### 1. The server's numbers, printed by the walkthrough

```bash
npm run lifecycle 2>/dev/null | sed -n '/^13\. metrics/,$p'
```

```text
13. metrics    -> the numbers a dashboard would scrape
   client.callTool.ms.avg                   64
   client.callTool.ms.count                 1
   client.callTool.ms.max                   64
   client.getPrompt.ms.avg                  8
   client.getPrompt.ms.count                1
   client.getPrompt.ms.max                  8
   client.listPrompts.ms.avg                15
   client.listPrompts.ms.count              1
   client.listPrompts.ms.max                15
   client.listResources.ms.avg              11
   client.listResources.ms.count            1
   client.listResources.ms.max              11
   client.listResourceTemplates.ms.avg      10
   client.listResourceTemplates.ms.count    1
   client.listResourceTemplates.ms.max      10
   client.listTools.ms.avg                  40
   client.listTools.ms.count                1
   client.listTools.ms.max                  40
   client.readResource.ms.avg               9
   client.readResource.ms.count             10
   client.readResource.ms.max              12
   context.assembled                        1
   context.chars.avg                        635
   context.chars.count                      1
   context.chars.max                        635
   model.skipped                            1
```

Read four things out of that:

**The counters and the timings live in the same namespace.** `context.assembled` (a count) sits
next to `context.chars.*` (a timing family) — because a count and a duration are both just
numbers with a name, and forcing them into two registries would double the code for no gain.

**`client.readResource.ms.count` is 10 while everything else is 1.** That is the shape of the
walkthrough: it lists each catalogue once, but reads ten Resources (the ACL probes, the three
resource shapes in step 5, the deliberate failure in step 6, and the three reads that
`assembleContext` performs in step 11). A count field is what makes that visible without
reading the script.

**`avg` and `max` disagree where it matters.** `readResource` averages 9 ms with a max of 12 ms
— tight. `callTool` is a single sample so its avg equals its max. Where they diverge sharply
in a real deployment, that gap is your signal: a healthy mean with a bad max is a tail problem.

**`context.chars.avg` is 635.** This is the metric Lecture 15 exists to add. It is the number
of characters of Resource content that actually went into the prompt — and it is the one you
watch when someone asks "why is the token bill up?" A rising `context.chars.avg` with a flat
request rate is the answer, and it is not visible in any log line.

### 2. The host's numbers, over HTTP

```bash
npm run server & npm run host & sleep 6
curl -s 'http://127.0.0.1:8080/read?uri=task://summary' > /dev/null
curl -s 'http://127.0.0.1:8080/plan?hours=4' > /dev/null
curl -s http://127.0.0.1:8080/metrics
```

```json
{"uptimeSeconds":4,"metrics":{"client.getPrompt.ms.avg":30,"client.getPrompt.ms.count":1,"client.getPrompt.ms.max":30,"client.readResource.ms.avg":20,"client.readResource.ms.count":3,"client.readResource.ms.max":24,"context.assembled":1,"context.chars.avg":501,"context.chars.count":1,"context.chars.max":501,"http.latency_ms.avg":46,"http.latency_ms.count":2,"http.latency_ms.max":73,"http.status.200":2,"model.skipped":1,"plan.latency_ms.avg":72,"plan.latency_ms.count":1,"plan.latency_ms.max":72,"plan.ok":1}}
```

Four families, and the naming is doing the work:

| Family | Example | Answers |
| :--- | :--- | :--- |
| `client.*` | `client.readResource.ms.avg` | How slow is the *MCP server*? (measured by the host, across the wire) |
| `http.*` | `http.latency_ms.max`, `http.status.200` | How slow is *this host* to a browser? |
| `plan.*` | `plan.latency_ms.avg`, `plan.ok` | How slow is the *lecture's end-to-end request*? |
| `context.*` | `context.chars.max` | How big was the assembled context? |

The separation of `client.*` from `http.*` is the useful part. If `client.readResource.ms` climbs
while `http.latency_ms` is flat, the MCP server is the problem. If both climb together, the host
is the problem. That diagnosis is impossible if you record one number for "request time".

Note `http.status.200: 2` — a *labelled* counter, built by appending the status to the metric
name. That is the cheap version of metric labels, and it is honest about its cost: a status
code with unbounded cardinality (say, a full path) would explode the key space, so only the
class is appended.

### 3. The snapshot is stable, so it is diffable

The claim is about **key order**, so strip the values and compare only the names:

```bash
for run in a b; do
  npm run lifecycle 2>/dev/null | sed -n '/^13\. metrics/,$p' | grep '^   ' \
    | sed -E 's/ +[0-9]+$//' > "/tmp/$run.names"
done

diff /tmp/a.names /tmp/b.names && echo 'IDENTICAL KEY ORDER'
```

```text
IDENTICAL KEY ORDER
name lines: 26
```

26 metric names, in the same order, across two independent runs. The *values* differ between
them — latencies are latencies — but the shape does not, and that is what the `localeCompare`
sort in `snapshot()` guarantees.

It matters more than it looks. `Object.keys()` order for string keys is insertion order, and
insertion order follows the request path — so without the sort, two runs of identical code would
print in different orders and `diff` would be a wall of reordering noise that hides the one line
that actually moved. With the sort, `diff` becomes a regression check: snapshot a run, change
something, diff, and every line that moves is a real change.

### 4. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

The generic `time<T>(name, work): T` plus the `as unknown as T` cast in the thenable branch is
the only place in this project that needs a cast, and it is worth noting why: `Promise.resolve()`
necessarily widens to `Promise<unknown>`, and the function has already checked that `T` is a
thenable, so narrowing back is sound — but TypeScript cannot express "`T` is a promise here"
without the assertion. One cast, in one place, with the reason written above it.

---

## Checkpoint

1. **Why does `time()` need to know about promises?**
   Because a promise settles after the function returns. A synchronous `finally` records the
time to *create* the promise — about 0 ms for a network call — so every latency line would read
`0` while looking perfectly healthy.

2. **What does `Promise.resolve(result)` contribute, given `result` is already a thenable?**
   It assimilates it into a real `Promise`, which guarantees a `.finally` method even for a bare
   `PromiseLike` that lacks one.

3. **Why store `total` rather than a running average?**
   An incrementally updated average accumulates rounding error on every sample; `total / count`
at read time does not. And `max` is stored alongside because a mean hides the single slow request
that matters most.

4. **Why is `snapshot()` sorted?**
   Because `Object.keys()` order follows insertion, which follows the request path — so two runs
   of the same code would print in different orders and `diff` would be useless. A stable
   snapshot is what makes it usable as a regression check.

5. **Why `performance.now()` instead of `Date.now()`?**
   `Date.now()` is wall-clock and can jump backwards on an NTP correction, producing a negative
   duration. `performance.now()` is monotonic.

6. **What is the Lecture-15-specific metric, and why can a log not replace it?**
   `context.chars` — how much Resource content actually reached the prompt. At volume, a log line
   per selection is a wall of text; a counter plus an average answers "is the context growing?"
   as a single number you can watch.

---

**[← Chapter 03: Logging](./03_Core_Structured_Logging.md)** · **[Chapter 05: Error Taxonomy →](./05_Core_Error_Taxonomy_and_Wire_Adapter.md)**
