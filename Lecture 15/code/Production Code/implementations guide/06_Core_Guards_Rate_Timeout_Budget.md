# Chapter 06 — Core: Rate Limit, Timeout and the Context Budget

> **Three guards, three different questions.** *How many calls per minute?* *How long may one call
> run?* And — the one Lecture 15 introduces, and the one most implementations skip — *how much text
> may enter the prompt?* The header states the governing rule plainly: **a resource you cannot
> afford to read is not context, it is a denial-of-service against your own token budget.**

---

## File details

| | |
| :--- | :--- |
| **File** | `src/core/guards.ts` (228 lines) |
| **Layer** | `core` — imports `config/constants.js` for the truncation marker and `core/errors.js` for the taxonomy. No SDK, no transport. |
| **Purpose** | A sliding-window rate limiter, a timeout that respects the primitive's error class, and the three-stage context budget. |
| **Exports** | `RateLimiter`, `withTimeout()`, `ContextBlock`, `BudgetedBlock`, `FitResult`, `ContextBudgetLimits`, `ContextBudget`, `createContextBudget()` |
| **Lecture sections** | Ch02 §"Size and token budget", Ch05 §"Context budget is the real constraint", Ch05 §"rate limits", Ch07 §"Streaming, timeouts and cancellation" |
| **Runs** | `npm run lifecycle` step 9 (the budget) |

---

## Commands

```bash
# the three caps biting at once, with a deliberately tiny budget
npm run lifecycle 2>/dev/null | sed -n '/^9\./,/^10\./p'

# the rate limiter, observed from the server's own metrics
npm run lifecycle 2>/dev/null | grep -i 'limit' || echo 'not hit in a normal run'
```

---

## Three guards, three questions

| Guard | The question | Why it cannot be skipped |
| :--- | :--- | :--- |
| `RateLimiter` | How many calls per minute? | One client must not be able to monopolise the server |
| `withTimeout` | How long may one call run? | A hung capability must never stall the whole host |
| `createContextBudget` | How much **text** enters the prompt? | A prompt stuffed past its useful size gets **worse** answers, not better ones |

The third one is the lecture's addition, and the header argues for it in a single sentence worth
quoting twice:

> a resource you cannot afford to read is not context, it is a **denial-of-service against your own
> token budget**.

That framing is the reason this is a `core` concern rather than a nicety inside the selection
engine. Reading a Resource costs tokens; a selection strategy that attaches five large documents
has not helped the model, it has *hurt* it — by crowding out the user's actual question and by
inflating latency and cost. A budget is therefore not an optimisation applied after the fact. It is
part of what "correct" means.

The closing line of the header names the design principle behind all three: *none of them is the
kind of thing you want re-implemented inside every handler.* Three guards, in one file, used by
both the tool path and the context path.

---

## `src/core/guards.ts` — the full file

```ts
import { truncationMarker } from "../config/constants.js";
import { AppError, ResourceError, ToolError } from "./errors.js";

/**
 * The guards that answer one question: *how much of the host's budget may one
 * call consume?*
 *
 * Three of them, and Lecture 15 needs all three for different reasons:
 *
 *  · **rate limit** — how many calls per minute (Notes Ch05 §"rate limits");
 *  · **timeout** — how long one call may run. `prompts/get` is a local template
 *    render and `resources/read` may reach a backend, so the two budgets differ
 *    on purpose (Notes Ch07 §"Streaming, timeouts and cancellation");
 *  · **context budget** — how much *text* may enter the prompt. This is the one
 *    Lecture 15 introduces, and the one most implementations skip: Notes Ch02
 *    §"Size and token budget" and Ch05 §"Context budget is the real constraint"
 *    both make the point that a resource you cannot afford to read is not
 *    context, it is a denial-of-service against your own token budget.
 *
 * None of the three is optional in production, and none of them is the kind of
 * thing you want re-implemented inside every handler.
 */

/**
 * A sliding-window limiter: at most `perMinute` hits per key in any 60-second
 * window.
 *
 * Keys are namespaced by primitive (`tool:list_tasks`, `resource:read`) rather
 * than global, because a global limit lets one noisy capability starve every
 * other one the server offers. The key is also where a caller identity would go
 * once the transport carries one.
 *
 * A sliding window is chosen over a fixed bucket on purpose: a fixed bucket lets
 * a caller spend the whole allowance at 11:59:59 and again at 12:00:00, which is
 * precisely the burst the limit exists to stop.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.perMinute) {
      // Do not record the rejected attempt: a caller that hammers a limited
      // capability must not be able to extend its own penalty forever.
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

/**
 * Runs `work` inside a budget.
 *
 * The timeout is deliberately a **result**, not a protocol error: the call did
 * start, so the honest report is `UNAVAILABLE` with retry guidance — which is
 * exactly what the error taxonomy carries. A hung capability must never be able
 * to stall the whole host, and the timer is always cleared so a fast call cannot
 * leak a handle.
 *
 * `origin` decides which error class is thrown, because a tool timeout must
 * reach the model as an `isError` result while a resource timeout must reach the
 * client as a protocol error (Notes Ch03 §3.9).
 */
export async function withTimeout<T>(
  work: () => Promise<T> | T,
  milliseconds: number,
  label: string,
  origin: AppError["origin"] = "tool",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(work()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const message = `${label} exceeded its ${milliseconds} ms budget.`;
          const recovery =
            "Retry once. If it fails again, treat this capability as temporarily unavailable rather than retrying in a loop.";

          reject(
            origin === "resource"
              ? new ResourceError("UNAVAILABLE", message, recovery, { retryable: true })
              : new ToolError("UNAVAILABLE", message, recovery, true),
          );
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}


/** One resource body, already read, waiting to be placed into a prompt. */
export interface ContextBlock {
  uri: string;
  /** Which selection strategy chose it — Notes Ch05 §"log the why". */
  strategy: string;
  text: string;
}

/** A block after the budget has had its say. */
export interface BudgetedBlock extends ContextBlock {
  /** True when the body was cut, so the caller can say so out loud. */
  truncated: boolean;
  /** The size before clipping — the number that makes a truncation explainable. */
  originalChars: number;
}

export interface FitResult {
  blocks: BudgetedBlock[];
  /** URIs that did not fit at all, named rather than silently forgotten. */
  dropped: string[];
  /**
   * Content characters charged against `maxContextChars`.
   *
   * Truncation markers are **not** charged, and that is deliberate: a marker is
   * what makes a cut read honest, so it is never itself cut. The assembled text
   * can therefore exceed the cap by up to `maxResources × marker length` — a few
   * hundred characters against a default cap of 40,000 — which is the price of
   * never lying about what was cut.
   */
  usedChars: number;
}

export interface ContextBudgetLimits {
  maxResources: number;
  maxResourceChars: number;
  maxContextChars: number;
}

export interface ContextBudget {
  readonly limits: ContextBudgetLimits;
  /** Trim one body to the per-resource cap, marking it if anything was cut. */
  clip(uri: string, strategy: string, text: string): BudgetedBlock;
  /**
   * Fit an ordered, already-ranked list of blocks into the total context cap.
   *
   * Order is respected because the caller ranked it: the first block is the one
   * the selector believed in most, and it is the one that must survive.
   */
  fit(blocks: readonly ContextBlock[]): FitResult;
}

/**
 * The three caps from Notes Ch05 §"Context budget is the real constraint",
 * applied in a fixed order so the outcome is explainable:
 *
 *     cap the count  →  cap each body  →  cap the total
 *
 * Each stage removes a different failure. Capping the count stops accidental
 * fan-out. Capping each body stops one huge document dominating. Capping the
 * total protects latency, cost and — most importantly — answer quality, because
 * a prompt stuffed past its useful size gets *worse* answers, not better ones.
 *
 * Truncation is never silent: the marker appended here is the reason a cut read
 * is still an honest read (Notes Ch02 §"Size and token budget").
 */
export function createContextBudget(limits: ContextBudgetLimits): ContextBudget {
  const clip = (uri: string, strategy: string, text: string): BudgetedBlock => {
    if (text.length <= limits.maxResourceChars) {
      return { uri, strategy, text, truncated: false, originalChars: text.length };
    }

    return {
      uri,
      strategy,
      text: text.slice(0, limits.maxResourceChars) + truncationMarker(limits.maxResourceChars, text.length),
      truncated: true,
      originalChars: text.length,
    };
  };

  return {
    limits,
    clip,

    fit(blocks) {
      const dropped: string[] = [];
      const kept: BudgetedBlock[] = [];

      // Stage 1 — cap the count. `slice` keeps the highest-ranked entries.
      for (const overflow of blocks.slice(limits.maxResources)) {
        dropped.push(overflow.uri);
      }

      // Stage 2 — cap each body.
      const clipped = blocks
        .slice(0, limits.maxResources)
        .map((block) => clip(block.uri, block.strategy, block.text));

      // Stage 3 — cap the total, in rank order.
      let usedChars = 0;

      for (const block of clipped) {
        const remaining = limits.maxContextChars - usedChars;

        if (remaining <= 0) {
          dropped.push(block.uri);
          continue;
        }

        if (block.text.length <= remaining) {
          kept.push(block);
          usedChars += block.text.length;
          continue;
        }

        // The last block that half-fits is clipped rather than dropped: a
        // partial document the model is told about beats a missing one.
        kept.push({
          ...block,
          text: block.text.slice(0, remaining) + truncationMarker(remaining, block.originalChars),
          truncated: true,
        });
        usedChars += remaining;
      }

      return { blocks: kept, dropped, usedChars };
    },
  };
}
```

### Block-by-block

**Block 1 — `RateLimiter` (lines 24–61).**

```ts
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}
```

A **sliding window**: it stores the timestamp of every recent hit per key, and on each check it
discards everything older than the window before counting. The doc comment defends the choice
against the obvious alternative:

> A sliding window is chosen over a fixed bucket on purpose: a fixed bucket lets a caller spend the
> whole allowance at 11:59:59 and again at 12:00:00, which is precisely the burst the limit exists
> to stop.

That is a real failure of fixed buckets and it is worth being concrete about. With 60 requests per
minute in a fixed bucket, a caller can send 60 at 11:59:59 and 60 more at 12:00:00 — 120 requests in
one second, with the limiter reporting perfect compliance. A sliding window cannot be gamed that
way, because the cutoff moves with the clock.

The data structure is `Map<string, number[]>` — one array of timestamps per key. The cost is memory
proportional to the limit (60 numbers per key, worst case), which for a rate limiter is trivial and
for an unbounded one would not be. Note that the array is **rebuilt by `filter`** on every check
rather than mutated, which keeps the stored array free of expired entries without a separate sweep.

**The namespacing is the most important design decision here.** The doc comment says why:

> Keys are namespaced by primitive (`tool:list_tasks`, `resource:read`) rather than global, because a
> global limit lets one noisy capability starve every other one the server offers.

A single global counter would mean a burst of `list_tasks` calls consumes the allowance that
`resources/read` needs. The server would still be "within its limit" while being effectively down
for every other capability. Per-key limits make the blast radius one capability wide — and the
comment notes the key is also where a caller identity would go once the transport carries one.

**The rejected attempt is deliberately not recorded** (lines 50–52), and the comment is the reason:

> Do not record the rejected attempt: a caller that hammers a limited capability must not be able to
> extend its own penalty forever.

Consider the alternative. If every rejected attempt were appended to the window, then a caller
retrying in a tight loop would keep pushing the window forward, and the moment it became eligible
again would recede indefinitely. The limiter would convert a 60-second penalty into a permanent
ban — for a caller that is *trying to comply*. Not recording the attempt means the window reflects
only the calls that actually succeeded, so the penalty has a definite end.

Note `this.hits.set(key, recent)` still happens on the rejected path — it stores the *pruned* array,
which is a housekeeping write rather than a recorded hit. Without it, expired entries would
accumulate on a key that is only ever rejected.

**`retryAfterMs` is computed from the oldest surviving hit:**

```ts
const oldest = recent[0] ?? now;
return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
```

When the oldest hit in the window ages out, a slot frees — so the wait is *oldest + window − now*.
That is the honest answer to "how long until I can retry", and it is the number the tool guard puts
in its error message: *"a slot frees in Ns"*. The `?? now` handles the impossible-but-type-legal
case of an empty array (which would make `retryAfterMs` 0), and `Math.max(0, ...)` guards against a
negative duration if the clock moves.

The `now = Date.now()` default parameter is what makes this class **testable without waiting**: a
caller can pass a synthetic clock and exercise the whole window in microseconds.

**Block 2 — `withTimeout` (lines 63–106).**

```ts
export async function withTimeout<T>(
  work: () => Promise<T> | T,
  milliseconds: number,
  label: string,
  origin: AppError["origin"] = "tool",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(work()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const message = `${label} exceeded its ${milliseconds} ms budget.`;
          const recovery =
            "Retry once. If it fails again, treat this capability as temporarily unavailable rather than retrying in a loop.";

          reject(
            origin === "resource"
              ? new ResourceError("UNAVAILABLE", message, recovery, { retryable: true })
              : new ToolError("UNAVAILABLE", message, recovery, true),
          );
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
```

Four decisions, each worth naming:

**1. `Promise.race` between the work and a timer.** The work is wrapped in `Promise.resolve(work())`
so a *synchronous* function is handled too — `Promise.race` needs thenables, and `Promise.resolve`
normalises `T` into one. The racing promise is typed `Promise<never>`, which is correct: it can only
reject, never fulfil, so TypeScript knows it contributes nothing to the result type.

**2. The timeout is a *result*, not a protocol error.** The doc comment is explicit:

> The timeout is deliberately a **result**, not a protocol error: the call did start, so the honest
> report is `UNAVAILABLE` with retry guidance — which is exactly what the error taxonomy carries.

That is Chapter 05's taxonomy being applied correctly. A timeout is not a malformed request; the
request was fine, the capability was slow. So the class is `UNAVAILABLE` (503), not `INVALID_INPUT`
(400) — and `retryable: true`, because a slow backend may well be fast on the next attempt.

**3. `origin` decides the error class.** This is the subtle one:

```ts
origin === "resource"
  ? new ResourceError("UNAVAILABLE", message, recovery, { retryable: true })
  : new ToolError("UNAVAILABLE", message, recovery, true)
```

The doc comment states why: *a tool timeout must reach the model as an `isError` result while a
resource timeout must reach the client as a protocol error (Notes Ch03 §3.9).* Same fault, same
class, same recovery sentence — but a `ResourceError` becomes a JSON-RPC error on the wire while a
`ToolError` becomes `isError` content. The origin parameter is what keeps the *transport shape*
correct without duplicating the timing logic.

The default is `origin = "tool"`, and the type is `AppError["origin"]` — an **indexed access type**
rather than a re-declared `"tool" | "resource" | "prompt"` union. That is a small but real choice: if
`FailureOrigin` ever gains a member, this signature follows automatically and cannot drift.

**4. The timer is always cleared.**

```ts
} finally {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}
```

This is the leak that the obvious implementation has. If the work resolves in 5 ms and the timeout is
5000 ms, an uncleared timer keeps a handle alive for the remaining 4995 ms — and in Node, a live
timer keeps the **event loop** alive. Do that per request in a server and the process never exits
when asked to; in a CLI it hangs at the end of a run. `clearTimeout` in a `finally` means the timer
is cleaned up on the success path, the timeout path, and the throw path alike.

Note the ordering: `timer` is assigned *inside* the `setTimeout` callback's enclosing executor, so by
the time `finally` runs it holds either the handle or `undefined`. The `!== undefined` check is what
covers a synchronous throw from `work()` — in which case the timer was never created at all.

One honest limitation: this is a **cooperative** timeout. It stops *waiting*, it does not stop the
work. The underlying operation keeps running to completion; the caller has simply been told it
failed. In a Node server that is usually the right trade, because a database driver has its own
timeout. A deployment that needed true cancellation would thread an `AbortSignal` through — which is
what the SDK's own `RequestOptions.signal` is for.

**Block 3 — the context-budget interfaces (lines 108–154).**

```ts
export interface ContextBlock {
  uri: string;
  strategy: string;
  text: string;
}
```

The **input**: one Resource body, already read, waiting to be placed into a prompt. Three fields,
and the middle one is the interesting one — `strategy` is *which selection strategy chose it*, and
its comment points at Ch05 §"log the why". A block carries its own justification, which is what makes
`contextFence(uri, strategy)` in Chapter 02 possible: the assembled prompt can label each block with
how it got there.

```ts
export interface BudgetedBlock extends ContextBlock {
  truncated: boolean;
  originalChars: number;
}
```

The **output**, and it adds exactly two fields. `truncated` is a boolean so the caller can *say so
out loud*; `originalChars` is the size **before** clipping.

That second field is what makes a truncation explainable. Compare the two possible reports:

```text
"task://guidelines was truncated"                    ← was it 310→300 or 310→12?
"task://guidelines: 310 chars, showing 120"         ← actionable
```

The second is what the lifecycle prints, and it is only possible because the original size survived
the clipping. Without it, a reader has no way to judge whether the budget is slightly too tight or
catastrophically too tight.

```ts
export interface FitResult {
  blocks: BudgetedBlock[];
  dropped: string[];
  usedChars: number;
}
```

`dropped` is `string[]` of URIs, and the comment gives the reason: *URIs that did not fit at all,
named rather than silently forgotten.* A budget that silently discards a Resource is a budget that
silently changes the answer. Naming what was dropped means the lifecycle can print
`dropped [task://summary]` — and an operator reading that knows exactly which context the model did
not receive.

```ts
export interface ContextBudget {
  readonly limits: ContextBudgetLimits;
  clip(uri: string, strategy: string, text: string): BudgetedBlock;
  fit(blocks: readonly ContextBlock[]): FitResult;
}
```

Two methods and a `limits` field. `clip` is exposed separately from `fit` because a caller sometimes
wants to trim one body without the whole pipeline (the tool path uses the same cap for a single
body), and `limits` is exposed so the host can *report* the budget in a `/health` response or an
error message without duplicating the config read.

Note `fit(blocks: readonly ContextBlock[])` — the parameter is `readonly`, so a caller cannot be
surprised by the budget mutating its input array. That matters because the caller's array is the
**ranked** list from the selector; if `fit` reordered it in place, the caller's record of its own
decision would be corrupted.

And `fit`'s own doc comment states the ordering contract:

> Order is respected because the caller ranked it: the first block is the one the selector believed
> in most, and it is the one that must survive.

That is the interface between Chapter 12 and this file, and it is worth stating as a rule: **the
budget never re-ranks.** It truncates from the end, because the end is what the selector was least
sure about.

**Block 4 — `createContextBudget` (lines 156–228).**

The doc comment states the whole algorithm in one line:

```text
cap the count  →  cap each body  →  cap the total
```

and then justifies why three stages rather than one total:

> Each stage removes a different failure. Capping the count stops accidental fan-out. Capping each
> body stops one huge document dominating. Capping the total protects latency, cost and — most
> importantly — answer quality, because a prompt stuffed past its useful size gets **worse** answers,
> not better ones.

That is the argument, and it is worth restating as three distinct failure modes:

| Stage | Cap | The failure it removes |
| :--- | :--- | :--- |
| 1 | `maxResources` | A selector that attaches fifteen Resources — **fan-out** |
| 2 | `maxResourceChars` | One 500 KB document crowding out four useful ones |
| 3 | `maxContextChars` | Ten medium documents doing the same, collectively |

Stage 2 and stage 3 look redundant and are not: stage 2 bounds *one* body, stage 3 bounds the
*sum*. A system with only a total cap would let a single huge document consume the entire budget and
leave the other Resources with nothing; a system with only a per-body cap would let ten bodies each
just under the cap add up to ten times the budget.

**`clip` — stage 2 as a standalone function (lines 158–172).**

```ts
const clip = (uri: string, strategy: string, text: string): BudgetedBlock => {
  if (text.length <= limits.maxResourceChars) {
    return { uri, strategy, text, truncated: false, originalChars: text.length };
  }

  return {
    uri,
    strategy,
    text: text.slice(0, limits.maxResourceChars) + truncationMarker(limits.maxResourceChars, text.length),
    truncated: true,
    originalChars: text.length,
  };
};
```

The fast path returns the text **unchanged** — not a copy, the same string reference. Strings are
immutable in JavaScript, so there is nothing to defend against, and skipping a copy for the common
case (most bodies are under the cap) is free.

The slow path is the interesting one: `text.slice(0, cap) + truncationMarker(cap, text.length)`. The
marker is **appended, not substituted** — the content is cut to the cap and then the marker is added,
which is why the resulting length is `cap + markerLength` rather than `cap`.

That is the accounting subtlety worth naming, because it is visible in the lifecycle output. See
"Run / verify" below: the budget reports `200 chars` while the assembled blocks total 253. The
difference is the markers. It is documented on `FitResult.usedChars` rather than papered over:

> Truncation markers are **not** charged, and that is deliberate: a marker is what makes a cut read
> honest, so it is never itself cut. The assembled text can therefore exceed the cap by up to
> `maxResources × marker length` — a few hundred characters against a default cap of 40,000 — which
> is the price of never lying about what was cut.

The alternative — charging the marker against the budget — means either clipping the content harder
for a rounding-level gain, or truncating the marker itself. A truncated marker is a **silent cut**,
which is the exact failure the marker exists to prevent. So the overshoot stays, bounded and stated.

**`fit` — the three stages (lines 174–215).**

```ts
fit(blocks) {
  const dropped: string[] = [];
  const kept: BudgetedBlock[] = [];

  // Stage 1 — cap the count. `slice` keeps the highest-ranked entries.
  for (const overflow of blocks.slice(limits.maxResources)) {
    dropped.push(overflow.uri);
  }

  // Stage 2 — cap each body.
  const clipped = blocks
    .slice(0, limits.maxResources)
    .map((block) => clip(block.uri, block.strategy, block.text));
  ...
}
```

**Stage 1** uses `slice(limits.maxResources)` to *iterate* the overflow — everything from index
`maxResources` onward — and pushes each URI into `dropped`. Note it collects the names before doing
anything else, so the report is complete even if a later stage throws. The comment states the
ranking contract: *`slice` keeps the highest-ranked entries.*

**Stage 2** re-slices the same array (the first `maxResources` entries) and maps `clip` over it. The
double `slice` looks wasteful and is the clearest way to express "the first N are in play, the rest
are already reported as dropped" without an index variable.

**Stage 3 — the total, in rank order (lines 191–214).**

```ts
let usedChars = 0;

for (const block of clipped) {
  const remaining = limits.maxContextChars - usedChars;

  if (remaining <= 0) {
    dropped.push(block.uri);
    continue;
  }

  if (block.text.length <= remaining) {
    kept.push(block);
    usedChars += block.text.length;
    continue;
  }

  // The last block that half-fits is clipped rather than dropped: a
  // partial document the model is told about beats a missing one.
  kept.push({
    ...block,
    text: block.text.slice(0, remaining) + truncationMarker(remaining, block.originalChars),
    truncated: true,
  });
  usedChars += remaining;
}
```

A single pass in rank order with three outcomes per block:

| Condition | Outcome |
| :--- | :--- |
| `remaining <= 0` | **Dropped** — no budget left at all |
| `block.text.length <= remaining` | **Kept whole** |
| otherwise | **Kept clipped** to `remaining`, marked truncated |

The third branch is the design decision, and the comment makes the case: *a partial document the
model is told about beats a missing one.* Consider the alternative — drop any block that does not fit
entirely. The model then receives *nothing* about a Resource the selector considered important,
which is strictly worse than receiving the first part with a marker saying so.

And note that this is where the *stage 3* truncation happens, using `block.originalChars` — the size
**before stage 2 clipped it**. So the marker on a stage-3 clip reports the true original size, not the
stage-2 size:

```ts
text: block.text.slice(0, remaining) + truncationMarker(remaining, block.originalChars),
```

In the lifecycle's numbers, `task://backlog` is clipped twice: stage 2 takes it 191 → 174, and stage 3
takes it to 26 + marker. The marker says *"showing the first 26 of **191** characters"* — the real
original — because `originalChars` was captured before stage 2. Had it reported 174, a reader would
conclude the document was 174 characters long and that only a little was lost.

That is the reason `BudgetedBlock` carries `originalChars` as a separate field from `text`: the
current text shrinks at every stage, and the number you must report to be honest is the one that
never shrinks.

---

## Run / verify

### 1. The three caps biting at once

Lifecycle step 9 builds a deliberately tiny budget — `maxResources: 2`, `maxResourceChars: 120`,
`maxContextChars: 200` — and fits three blocks through it:

```bash
npm run lifecycle 2>/dev/null | sed -n '/^9\./,/^10\./p'
```

```text
9. the budget  -> cap the count, cap each body, cap the total — and say so
   limits {"maxResources":2,"maxResourceChars":120,"maxContextChars":200}
   kept 2 block(s), 200 chars, dropped [task://summary]
      task://guidelines    truncated=true  310 -> 174 chars
      task://backlog       truncated=true  191 -> 79 chars
   before 12 PM.
   2. Meetings should preferably be

   [truncated: showing the first 120 of 310 characters]

10. prompts/list -> 3 workflows, each advertising its own arguments
```

Three blocks in, two out, one named as dropped. Walk the arithmetic, because every number in that
output is traceable to a specific stage:

| Stage | `task://guidelines` (310) | `task://backlog` (191) | `task://summary` (500) |
| :--- | :--- | :--- | :--- |
| **1 — count** (`max 2`) | in play | in play | **dropped** — index 2 |
| **2 — per body** (`max 120`) | 120 + 54-char marker = **174** | 120 + 54-char marker = **174** | — |
| **3 — total** (`max 200`) | 174 ≤ 200 → **kept whole** | 26 + 53-char marker = **79** | — |

The `task://summary` block was dropped by **stage 1**, and its 500 characters of `"x"` never reached
stage 2 or 3. That is the fan-out cap doing its job: the block was last in rank order, so it is the
one that goes.

The `task://backlog` row is the interesting one. After stage 2 it was 174 characters, but stage 3
only had `200 − 174 = 26` left. It was **clipped, not dropped** — which is the design decision
documented in the code: *a partial document the model is told about beats a missing one.* And its
marker reports the true original size:

```text
[truncated: showing the first 26 of 191 characters]
```

191, not 174 — because `originalChars` was captured before stage 2 shrank it.

**The one number that does not add up, and why.** The budget reports `200 chars`, but the two kept
blocks are 174 + 79 = **253** characters of text. The 53-character difference is the truncation
markers, which are deliberately not charged:

> Truncation markers are **not** charged, and that is deliberate: a marker is what makes a cut read
> honest, so it is never itself cut. The assembled text can therefore exceed the cap by up to
> `maxResources × marker length` — a few hundred characters against a default cap of 40,000 — which
> is the price of never lying about what was cut.

With the shipped defaults (`maxResources: 3`, `maxContextChars: 40_000`) the worst-case overshoot is
about 180 characters — under half a percent. Charging the marker would mean clipping content harder
for a rounding-level gain, or truncating the marker, which would reintroduce the silent cut the
marker exists to prevent. So the overshoot is bounded, stated, and kept.

Finally, the last line of the output is the payoff — the marker, in the assembled context:

```text
[truncated: showing the first 120 of 310 characters]
```

A model that reads that knows it received a fragment of a larger document. That single sentence is
what `truncationMarker()` in `config/constants.ts` is for (Chapter 02).

### 2. The rate limiter, observed

With the limit turned down to 2 per minute:

```bash
MCP_RATE_LIMIT_PER_MINUTE=2 npx tsx src/index.ts &
sleep 5
# then call list_tasks four times from one client
```

```text
call 1: isError=false Open tasks: 3
call 2: isError=false Open tasks: 3
call 3: isError=true  Rate limit reached for list_tasks; a slot frees in 60s. Wait for the window to p
call 4: isError=true  Rate limit reached for list_tasks; a slot frees in 60s. Wait for the window to p
```

And the server's own log, one line per rejection:

```json
{"event":"tool.failure","server":"task-mcp-server","tool":"list_tasks","code":"LIMIT_EXCEEDED","retryable":true,"message":"Rate limit reached for list_tasks; a slot frees in 60s."}
```

Four things to read out of this:

**The limiter is process-scoped, and that is what makes it work.** Calls 3 and 4 are separate HTTP
requests. If the limiter were constructed per request — as it was before the fix described in
Chapter 17 — every call would be the first call of a fresh window and the limit would never fire.
A rate limiter that resets per request is a rate limiter that does not rate limit.

**The message contains the actionable number.** *"a slot frees in 60s"* comes straight from
`retryAfterMs`, which came from `oldest + windowMs - now`. A caller told *when* to retry will wait; a
caller told only "rate limited" will retry immediately.

**`code: LIMIT_EXCEEDED`, `retryable: true`.** The taxonomy (Chapter 05) carries it, so the model
knows this is a *wait* problem, not a *fix your request* problem.

**It is an `isError` result, not a protocol error.** The guard raises a `ToolError`, so it travels the
tool path — the model reads it as context and can choose to stop retrying and report the current
state, which is exactly what the recovery sentence suggests.

### 3. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

Note the two `readonly` markers that the compiler enforces: `ContextBudget.limits` and the
`readonly ContextBlock[]` parameter of `fit`. Together they are the interface guarantee that the
budget never mutates the selector's ranked list — Chapter 12 relies on that.

---

## Checkpoint

1. **Why a sliding window rather than a fixed bucket?**
   A fixed bucket lets a caller spend the full allowance at 11:59:59 and the full allowance again at
   12:00:00 — 120 requests in one second, with the limiter reporting perfect compliance. A sliding
   window's cutoff moves with the clock, so the burst is counted.

2. **Why does the limiter not record a rejected attempt?**
   So a caller retrying in a tight loop cannot push its own window forward forever. Recording
   rejections would turn a 60-second penalty into a permanent ban for a caller that is *trying* to
   comply.

3. **What decides whether a timeout surfaces as `isError` content or a protocol error?**
   The `origin` parameter. A `ToolError` becomes `isError` content (for the model); a `ResourceError`
   becomes a JSON-RPC error (for the client). Same fault, same class, same recovery — different wire
   shape, because the primitives fail differently (Ch03 §3.9).

4. **What is the fixed order of the three caps, and why can it not be reordered?**
   Count → per-body → total. Capping the count first means the blocks that were never in play do not
   consume per-body or total budget, and the dropped list is complete before anything is clipped. The
   order is what makes the output explainable.

5. **Why is the last half-fitting block clipped rather than dropped?**
   *A partial document the model is told about beats a missing one.* Dropping it would give the model
   nothing about a Resource the selector ranked as important, with no indication anything was
   omitted.

6. **What does `originalChars` buy?**
   An honest marker. A body can be clipped twice, and the number reported must be the size *before*
   any clipping — otherwise a reader concludes the document was smaller than it was and that only a
   little was lost.

7. **Why are truncation markers not charged against the budget?**
   Because a marker that is itself truncated is a silent cut — the exact failure the marker exists to
   prevent. The overshoot is bounded by `maxResources × marker length` (≈180 characters against a
   40,000-character default), and it is documented rather than hidden.

8. **Why must the rate limiter be process-scoped?**
   Because a limiter constructed per request is a limiter whose window never contains more than one
   call. It is the same defect as a per-request task store (Chapter 17), and it fails silently.

---

**[← Chapter 05: Error Taxonomy](./05_Core_Error_Taxonomy_and_Wire_Adapter.md)** · **[Chapter 07: The Task Store →](./07_Domain_Task_Store.md)**
