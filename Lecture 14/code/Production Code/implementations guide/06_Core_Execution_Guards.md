# Chapter 06: Core — Execution Guards

> **Chapter goal:** Bound what one call may consume. A rate limiter stops an agent
> loop from spending 400 calls in a minute; a timeout stops one hung capability
> from stalling the whole host. Both live here because they answer the same
> question.

---

## 6.1 File details

| | |
| :--- | :--- |
| **Path** | `src/core/guards.ts` |
| **Layer** | core (imports only `./errors.js`) |
| **Purpose** | Two budget guards — a sliding-window `RateLimiter` and a `withTimeout` wrapper — that every tool handler runs inside |
| **Imports** | `ToolError` from `./errors.js` |
| **Exports** | `class RateLimiter`, `withTimeout()` |
| **Consumed by** | `src/mcp/server.ts` (constructs the limiter), `src/mcp/tools.ts` (calls both inside `guard()`) |
| **Lecture sections** | [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §"Timeouts, retries and circuit breaking" and §"Rate limits and quotas" |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the limiter, made visible: one call per minute means the second is refused
MCP_RATE_LIMIT_PER_MINUTE=1 npm run host

# the timeout, made visible: a 100 ms budget is too small for the spawn
MCP_TOOL_TIMEOUT_MS=100 npm run host
```

---

## 6.2 Full file

```ts
import { ToolError } from "./errors.js";

/**
 * Chapter 08 §"Timeouts, retries and circuit breaking" and §"Rate limits".
 *
 * Both guards answer the same question — *how much of the host's budget may one
 * call consume?* — which is why they live together. Neither is optional in
 * production, and neither is the kind of thing you want re-implemented inside
 * every tool handler.
 */

/**
 * A sliding-window limiter: at most `perMinute` hits per key in any 60-second
 * window.
 *
 * Keys are per tool rather than global, because a global limit lets one noisy
 * tool starve every other capability the server offers. The key is also where a
 * caller identity would go once the transport carries one.
 *
 * A sliding window is chosen over a fixed bucket on purpose: a fixed bucket
 * lets a caller spend the whole allowance at 11:59:59 and again at 12:00:00,
 * which is precisely the burst the limit exists to stop.
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
      // tool must not be able to extend its own penalty forever.
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
 * exactly what `ToolError` carries. A hung capability must never be able to
 * stall the whole host, and the timer is always cleared so a fast call cannot
 * leak a handle.
 */
export async function withTimeout<T>(work: () => Promise<T> | T, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(work()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError(
              "UNAVAILABLE",
              `${label} exceeded its ${milliseconds} ms budget.`,
              "Retry once. If it fails again, treat this capability as temporarily unavailable rather than retrying in a loop.",
              true,
            ),
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

## 6.3 Block-by-block explanation

### Block 1 — why these two live together

The header comment states the organising idea:

> Both guards answer the same question — *how much of the host's budget may one
> call consume?*

They are two dimensions of one budget. The rate limiter bounds **how many** calls;
the timeout bounds **how long** each may take. A server with only one of them is
still open to the other failure mode: an unbounded rate of fast calls, or a single
call that never returns.

The second sentence of the comment is the design rationale for the file's
existence:

> Neither is optional in production, and neither is the kind of thing you want
> re-implemented inside every tool handler.

This is the *why* of `guard()` (Chapter 10). Because both guards are functions
here, the tool layer calls them in exactly one place, and a fifth tool inherits
them for free.

### Block 2 — `RateLimiter`: the state, and the key choice

```ts
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly windowMs = 60_000,
  ) {}
```

**What it does:** holds one bucket of timestamps per key.
**How it works:** `Map<string, number[]>` — the key is a bucket name, and the value
is the list of *recent* hit timestamps in milliseconds since the epoch.

**Keys are per tool, not global.** The comment gives the reason: *"a global limit
lets one noisy tool starve every other capability the server offers."* Concretely —
if a server exposes both `search_web` (called 50 times a turn by an eager agent)
and `delete_task` (called once), a global limit means the agent's searching
exhausts the budget and the user's deletion is refused. Per-tool keys keep one
tool's noise from becoming another tool's outage.

The key is also the natural extension point. Today `guard()` calls
`deps.limiter.check(tool)`. The moment the transport carries a caller identity,
that becomes `check(\`${caller}:${tool}\`)` and the limit becomes per-caller-per-tool
— without touching this class. That is why `check` takes the key as an argument
rather than deriving it from something internal.

**`windowMs` is a constructor parameter with a default.** 60 000 ms is right for a
per-minute limit, but exposing it means a future "10 calls per hour" limit needs no
new class. The `perMinute` name is therefore slightly ahead of the generalisation —
an honest trade for a name that reads well at the call site
(`new RateLimiter(env.MCP_RATE_LIMIT_PER_MINUTE)`).

**`private readonly hits`** — `private` keeps the bucket out of the public API;
`readonly` prevents the *reference* from being reassigned (the Map's contents are
still mutable, which is what `check` needs). Two different guarantees from two
keywords, and both matter: `readonly` alone would still let a caller call
`.clear()` on it if it were public.

**Why timestamps rather than a counter plus a reset timer?** Because a counter with
a timer has a whole class of bugs this design does not have: timers drift, timers
leak if the object is discarded, and a process that sleeps does not fire its timer
on schedule. Storing timestamps makes the window *derived at read time* from the
clock, so a suspended process resumes with a correct window.

### Block 3 — `check()`: the sliding window

```ts
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
```

**What it does:** decides whether a hit is allowed, and reports how long to wait if
it is not.
**How it works:** prune, test, record or refuse.

**1 · `const cutoff = now - this.windowMs`.** The window is *[now − 60s, now]*. Any
timestamp at or before the cutoff has aged out.

**2 · `.filter((at) => at > cutoff)`.** This is the sliding window, and it is the
line that distinguishes this implementation from a fixed bucket. Every check
re-derives the recent set from the clock, so the window is continuous rather than
aligned to wall-clock minutes.

**3 · `if (recent.length >= this.perMinute)`** — the limit test. `>=` not `>`: with
`perMinute = 1`, the first call pushes one timestamp; the second sees
`recent.length === 1` and is refused. So "1 per minute" means exactly one call
allowed per window.

**4 · `this.hits.set(key, recent)` *before* refusing.** This line looks redundant —
`recent` came from the map — but it is the *pruned* list being written back, so
stale timestamps are discarded even on the refusal path. Without it, a key that is
hammered and then abandoned would keep a growing array of dead timestamps in memory.

**5 · `const oldest = recent[0] ?? now;`** — the earliest surviving hit. Note the
`?? now`: `noUncheckedIndexedAccess` types `recent[0]` as `number | undefined`. In
practice `recent.length >= perMinute` and `perMinute >= 1` (enforced by the config
schema), so `recent[0]` is always defined — but the compiler does not know that, and
the fallback is correct anyway: if there were somehow no timestamps, waiting zero
extra time is the right answer.

**6 · `retryAfterMs: Math.max(0, oldest + this.windowMs - now)`** — arithmetic worth
reading slowly. `oldest + windowMs` is the instant the earliest hit expires; subtract
`now` and you get how long until a slot frees. `Math.max(0, …)` guards against a
negative result, which would be a lie: you cannot wait a negative amount of time.

**Why is the refused attempt *not* recorded?** The comment says it: *"a caller that
hammers a limited tool must not be able to extend its own penalty forever."* If
refusals were recorded, a client retrying in a tight loop would keep the window full
with its own rejected attempts, and the earliest real hit would never age out — a
permanent lockout caused by a temporary burst. Refusing without recording is what
makes the limit *recoverable*.

**The return value is a pair, not a boolean.** `{ allowed, retryAfterMs }` means the
caller has everything it needs to write a recovery message — and Chapter 10 does
exactly that:

```ts
throw new ToolError(
  "LIMIT_EXCEEDED",
  `Rate limit reached for ${tool}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
  "Wait for the window to pass, or stop retrying and report the current state to the user.",
  true,
);
```

A boolean would have forced the caller to invent a wait time, and invented wait times
are how a model ends up retrying immediately.

**`now = Date.now()` as a default parameter** is the testability hook. A test can
pass a synthetic clock:

```ts
limiter.check("create_task", 1_000_000);            // allowed
limiter.check("create_task", 1_000_000 + 30_000);   // refused — same window
limiter.check("create_task", 1_000_000 + 61_000);   // allowed — window moved
```

No `setTimeout`, no fake timers, no sleeping test. The clock is an argument.

### Block 4 — `withTimeout`: a thunk, a race, and a cleared timer

```ts
export async function withTimeout<T>(work: () => Promise<T> | T, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(work()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError(
              "UNAVAILABLE",
              `${label} exceeded its ${milliseconds} ms budget.`,
              "Retry once. If it fails again, treat this capability as temporarily unavailable rather than retrying in a loop.",
              true,
            ),
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

**What it does:** runs `work` and fails with a retryable `ToolError` if it exceeds
`milliseconds`.
**How it works:** five details, each deliberate.

**1 · The parameter is `() => Promise<T> | T`, a thunk — not `Promise<T>`.** This is
the most important design decision in the function. If the signature took a promise,
the work would already have started before the call, and the timer would start
*after* the work — so the measured budget would silently exclude whatever ran before
the call. Taking a thunk starts the timer and the work at the same instant. The `| T`
union also means a synchronous handler needs no `async` wrapper.

**2 · `Promise.race([...])`** — settles with whichever promise settles first. The
work and the timer are created in the same array literal, so there is no gap between
them.

**3 · `new Promise<never>`** — the timer promise is typed `never` because it *cannot
resolve*; it only ever rejects. Typing it `never` tells TypeScript that
`Promise.race`'s result is driven by the work promise, so `withTimeout<T>` returns
`T` rather than `T | never`. (They are the same type — `never` is absorbed by any
union — but the annotation states the intent.)

**4 · `_resolve` is underscore-prefixed** because the executor signature requires two
parameters and only `reject` is used. The prefix is the convention for "required by
the signature, intentionally unused", and with `strict` on, TypeScript would
otherwise flag the unused parameter.

**5 · The `finally` block clears the timer.** This is the leak the comment mentions:
without it, a fast call would leave a 5-second timer pending, keeping the event loop
alive. In a server handling thousands of calls that is thousands of pending timers —
memory that grows with traffic and delays process shutdown. `finally` runs on **both**
paths, so the timer is cleared whether the work won or the clock won.

**The timeout is a `ToolError`, not a bare `Error`.** That is the whole point: the
call *did* start, so the honest report is a tool execution error with `isError: true`
and a recovery sentence — not a protocol error that makes the host believe nothing
happened. The `retryable: true` is also correct here in a way it is not for most
errors: a timeout means the operation did not complete *in time*, and for an
idempotent operation a single retry is legitimate. The recovery sentence still caps
it: *"rather than retrying in a loop."*

**Why `UNAVAILABLE` and not a dedicated `TIMEOUT` code?** Because the model's
decision is identical either way — wait and try once, or report unavailability — and
Chapter 05's taxonomy is deliberately small. A sixth code would add a distinction the
model cannot act on differently.

---

## 6.4 Run / verify

### The rate limiter, made visible

Set the limit to one call per minute and run the demo. The **first** `create_task`
succeeds; every call after it is refused:

```bash
MCP_RATE_LIMIT_PER_MINUTE=1 npm run host 2>/dev/null | sed -n '17,30p'
```

```text
5. selection   -> (stand-in for the model) create_task
   tools/call create_task            -> Task #1 created: Record MCP Video (PENDING).
   tools/call create_task (same key) -> Rate limit reached for create_task; a slot frees in 60s. Wait for the window to pass, or stop retrying and report the current state to the user.

6. failures    -> tool execution errors (`isError: true`)
   complete_task id=999 -> isError=true No task with id 999. Call list_tasks to read the exact ids, then retry.
   complete_task id=1   -> Rate limit reached for complete_task; a slot frees in 60s. Wait for the window to pass, or stop retrying and report the current state to the user.
   complete_task id=1   -> isError=true Rate limit reached for complete_task; a slot frees in 60s. Wait for the window to pass, or stop retrying and report the current state to the user.
```

Four things are worth reading out of that run:

1. **The refusal is a tool execution error, not a crash.** `LIMIT_EXCEEDED` arrives
   as `isError: true` with a recovery sentence — the model is told what to do.
2. **The wait time is real, not invented.** `a slot frees in 60s` comes from
   `Math.ceil(limit.retryAfterMs / 1000)` — the limiter's own arithmetic.
3. **The rate limit fires *before* the idempotency check.** The second `create_task`
   is refused even though its `idempotencyKey` would have made it a free replay. The
   guard runs first, by design — a limiter that could be bypassed by reusing a key
   would not be a limiter. The consequence is visible later in the run:
   `delete_task id=2 -> No task with id 2`, because task #2 was never created.
4. **The demo degrades honestly.** Nothing crashes, and every error message is
   accurate about the state that actually exists.

> **This is why the default is 60 per minute.** At the default, the demo completes;
> at 1, it demonstrates the limiter. Neither setting is a bug.

### The timeout, made visible

The four built-in tools are in-memory operations that complete in about a
millisecond, so the default 5-second budget never trips. The honest way to see the
guard work is to call it directly with work that is deliberately slow:

```bash
npx tsx -e '
import { withTimeout } from "./src/core/guards.ts";
(async () => {
  try {
    await withTimeout(() => new Promise((r) => setTimeout(r, 500)), 100, "slow_tool");
  } catch (error) {
    console.log(error.name, "|", error.code, "|", error.message, "| retryable=" + error.retryable);
    console.log("recovery: " + error.recovery);
  }
  console.log("fast returned: " + (await withTimeout(() => 42, 1000, "fast_tool")));
})();
'
```

```text
ToolError | UNAVAILABLE | slow_tool exceeded its 100 ms budget. | retryable=true
recovery: Retry once. If it fails again, treat this capability as temporarily unavailable rather than retrying in a loop.
fast returned: 42
```

Line 1 confirms the failure is a **`ToolError`** with code `UNAVAILABLE` and
`retryable=true` — the shape Chapter 05 defines for a failure the model can act on.
Line 3 confirms the happy path is untouched: a 1000 ms budget on instant work returns
`42` and, critically, **the process exits immediately** — proof that the `finally`
block cleared the pending timer rather than leaving the event loop alive for a
second.

> **The two guards are wired but not exercised by the default demo.** They run on
> every single call inside `guard()` (Chapter 10), but a four-call demo never trips a
> 60-per-minute limit or a 5-second budget. That is stated in the README's "Honest
> limits" section rather than glossed over.

---

## 6.5 Checkpoint

1. **Both guards bound one budget: how many calls, and how long each may take.**
   Neither is optional, and neither belongs inside a tool handler.
2. **A sliding window is derived from the clock at read time**, so a suspended
   process resumes correct — unlike a counter plus a reset timer.
3. **Refused attempts are not recorded.** Otherwise a hammering client would extend
   its own penalty forever and lock itself out permanently.
4. **`withTimeout` takes a thunk, not a promise.** Otherwise the timer starts after
   the work and the budget silently excludes it.
5. **The timer is always cleared in `finally`.** A pending timer keeps the event loop
   alive; in a busy server that is memory that grows with traffic.
6. **A timeout is a retryable `UNAVAILABLE` result, not a protocol error.** The call
   started, so the model is owed a result it can act on.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 05 — Core: The Error Taxonomy](./05_Core_Error_Taxonomy.md)

**Next:** [Chapter 07 — Domain: The Task Store & Idempotency](./07_Domain_Task_Store.md)



