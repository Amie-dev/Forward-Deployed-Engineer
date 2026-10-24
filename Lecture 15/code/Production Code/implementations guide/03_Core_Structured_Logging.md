# Chapter 03 — Core: Structured Logging & Redaction

> **A server that speaks a protocol over stdout must never log to stdout.** That is rule one.
> Rule two is that tool and prompt arguments are user data, so values get masked and
> bounded before they are written. This file is 110 lines and it is the reason you can debug
> this system without ever corrupting it.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/core/logger.ts` (110 lines) |
| **Layer** | `core` — imports nothing from `config`, no SDK, no transport |
| **Purpose** | One JSON object per line to stderr, with recursive redaction and size bounds. |
| **Exports** | `LOG_LEVELS`, `LogLevel`, `Fields`, `Logger`, `redact()`, `createLogger()` |
| **Lecture sections** | Ch08 (production hardening / observability), Ch05 §"Observability: log the why", Ch04 §"Validate and constrain" |
| **Runs** | `MCP_LOG_LEVEL=debug npm run lifecycle` |

---

## Commands

```bash
# structured lines on stderr, protocol frames on stdout — the two never mix
MCP_LOG_LEVEL=debug npm run server 1>/tmp/protocol.txt 2>/tmp/log.txt

# count the log lines and confirm stdout got only protocol frames
wc -l < /tmp/log.txt
head -1 /tmp/protocol.txt

# see the level filter work
MCP_LOG_LEVEL=warn npm run lifecycle 2>&1 >/dev/null | head
```

---

## The two rules, and why they are rules

**Rule 1 — the log stream is never the protocol stream.**

On a **stdio** MCP binding, stdout *is* the JSON-RPC channel. The client reads it and parses
each line as a message. One `console.log("connecting…")` writes a non-JSON-RPC line into
that stream, and the client's parser either throws or — worse — desynchronises and
attributes the next real frame to the wrong request.

This project binds to **Streamable HTTP** (Chapter 18), where stdout is *not* the protocol
channel, so a stray `console.log` would be harmless. The discipline is kept anyway, and the
reason is in the file's own comment: diagnostics go to stderr so an operator can pipe them
without filtering protocol traffic out first. That matters here more than usual, because
`src/index.ts` is designed to be swapped to stdio in three lines (Chapter 18) — and code
that would be broken by that swap should not exist in the first place.

The enforcement is structural rather than conventional: **`Logger` has no method that can
write to stdout.** There is exactly one `process.stderr.write` in the whole project's
logging path (line 100), and no `console.*` call anywhere in `src/`. You cannot accidentally
do the wrong thing, because the API does not offer it.

**Rule 2 — arguments are user data.**

Tool arguments and prompt arguments routinely carry a name, an email, an address, a token.
They arrive as structured objects, which makes them *look* safe to log — they are just JSON,
after all — and they are exactly the fields you are most likely to be storing PII in. A log
line is the wrong place to discover that.

So `redact()` masks by **key name** (`SENSITIVE_KEY`) and bounds by **size**
(`MAX_STRING`, `MAX_ARRAY`, `MAX_DEPTH`) before anything is written. Two separate
protections against two separate problems, and the size bound is not just about log volume —
as the file notes, it is how a resource *body* accidentally ends up in the log instead of
the prompt.

---

## `src/core/logger.ts` — the full file

```ts
/**
 * Observability, and the two rules a server that talks a protocol must not break.
 *
 * **Rule 1 — the log stream is never the protocol stream.** On a stdio binding
 * stdout *is* the JSON-RPC channel, and a stray `console.log` there corrupts a
 * frame and kills the connection. On Streamable HTTP the same discipline still
 * pays: diagnostics go to stderr so an operator can pipe them without filtering
 * protocol traffic out first.
 *
 * **Rule 2 — arguments are user data.** Tool arguments and prompt arguments
 * routinely carry a name, an email or a token, so values are redacted and
 * truncated before they are written. A log line is not the place to discover you
 * have been storing PII.
 *
 * This module deliberately imports nothing from `config`, so `config/env.ts` can
 * import `LOG_LEVELS` from here without creating a cycle.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric severity, so `MCP_LOG_LEVEL=warn` can suppress the levels below it. */
const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Anything whose key looks like this is replaced, never logged. */
const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|cookie|credential)/i;

const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** A logger that stamps every subsequent line with `bindings`. */
  child(bindings: Fields): Logger;
}

/**
 * Recursively masks secrets and bounds the size of what gets written.
 *
 * Bounding matters as much as masking: an unbounded field is how a single log
 * line becomes a 40 MB file, and — in a system whose whole job is assembling
 * context — how a resource body accidentally ends up in the log instead of the
 * prompt.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)`
      : value;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…(+${value.length - MAX_ARRAY} more)`] : head;
  }

  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    masked[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return masked;
}

/**
 * One JSON object per line — greppable, parseable, and cheap to write.
 *
 * A factory rather than a module-level singleton, so a caller can bind context
 * once (`logger.child({ requestId })`) and so tests can inject a quiet one.
 */
export function createLogger(level: LogLevel, bindings: Fields = {}): Logger {
  const threshold = SEVERITY[level];

  const emit = (severity: LogLevel, event: string, fields?: Fields): void => {
    if (SEVERITY[severity] < threshold) {
      return;
    }

    const line = {
      ts: new Date().toISOString(),
      level: severity,
      event,
      ...(redact(bindings) as Fields),
      ...(fields === undefined ? {} : (redact(fields) as Fields)),
    };

    process.stderr.write(`${JSON.stringify(line)}\n`);
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
```

### Block-by-block

**Block 1 — the levels and the severity map (lines 19–23).**

```ts
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
```

`LOG_LEVELS` is a frozen tuple, and it is exported because **`config/env.ts` imports it**
(Chapter 02, line 3). That is what makes `MCP_LOG_LEVEL: z.enum(LOG_LEVELS)` possible: the
set of legal log levels is defined once, in the logger, and the config schema derives its
enum from it. A fifth level added here becomes a legal config value automatically, and a
typo in `.env` is rejected at boot with a message listing the real options.

The comment at the top of the file explains the import direction: *this module deliberately
imports nothing from `config`, so `config/env.ts` can import `LOG_LEVELS` from here without
creating a cycle.* That is the whole reason the dependency goes this way. `config` is
normally the bottom layer (Chapter 01), and this is the one place where a `core` file is
imported *by* `config` — which is only safe because `logger.ts` imports nothing back.

Gaps of 10 in `SEVERITY` rather than 1, 2, 3, 4 are conventional and useful: a future
`trace` level slots in at 5, and a `fatal` at 50, without renumbering. The comparison is
`SEVERITY[severity] < threshold` (line 88) — numeric, so the filter is a single integer
compare per line rather than an array `indexOf`.

**Block 2 — the redaction constants (lines 25–30).**

```ts
const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|cookie|credential)/i;

const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;
```

The regex is a **substring** match, case-insensitive, so it catches `accessToken`,
`x-api-key`, `API_KEY`, `user_password`, `Authorization` and `sessionCookie` without
eight separate patterns. `api[_-]?key` covers the three spellings `apikey`, `api_key` and
`api-key`, which is the shape this actually appears in.

It is a heuristic and it is honest about being one — the alternative (an allowlist of
fields that may be logged) is stricter and needs maintenance every time a handler adds a
field. For a codebase whose job is to demonstrate the shape of production code, a
denylist with a stated purpose is the right trade. The audit trail in Chapter 22 takes the
stronger position for the data that actually matters: it hashes arguments rather than
logging them at all.

The three size bounds are separate numbers because they bound different things: one long
string, a long list, and deep nesting. `MAX_DEPTH = 4` is what stops a cyclic or
pathologically nested object from recursing forever — a real risk when logging a value that
came off the wire.

**Block 3 — the `Logger` interface (lines 32–41).**

```ts
export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}
```

Note the signature: **`(event, fields)`** — a stable event *name* first, then structured
data. Not `info("fetched task 2 for user 123")`. This is the difference between a log you can
aggregate and a log you can only read:

```json
{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"resource.read","requestId":"…","uri":"task://backlog","ms":0}
```

Because `event` is a separate field, `grep '"event":"resource.read"'` finds every resource
read, and `jq` can group by `uri`. An interpolated message cannot be grouped by anything.

`child(bindings)` returns a logger that stamps every subsequent line. The use is one call at
the edge of a request (Chapter 24's middleware):

```ts
const log = logger.child({ requestId, actor: session.actor });
```

After that, every line from that request carries `requestId` and `actor` **without any call
site remembering to pass them**. That is what makes it possible to follow one request through
the whole pipeline — which is precisely what Chapter 21's "log the why" requires.

**Block 4 — `redact()` (lines 43–76).**

```ts
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)`
      : value;
  }
  ...
}
```

A recursive walk with four rules, applied in a deliberate order. Reading the order is the
way to understand it, because each check must come before the ones it would otherwise break:

| Order | Check | Why it must be here |
| :--- | :--- | :--- |
| 1 | `typeof value === "string"` | The truncation rule. A string is the only thing that can be 40 MB |
| 2 | `null` / not an object | The recursion base case. Must come *after* the string check, because `typeof null` is `"object"` but a string is not |
| 3 | `depth >= MAX_DEPTH` | Cycle/DoS guard. Must come *before* the recursion, or a deeply nested object recurses until the stack dies |
| 4 | `Array.isArray` | Arrays need index-wise mapping and a length bound; objects need key-wise masking |

Then the object case (lines 71–75) is the one that does the security work:

```ts
for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
  masked[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
}
```

The test is on the **key**, not the value — which is the only workable choice, because a
token has no shape. `"sk-live-abc123"` and a task title look identical to any pattern you
could write. The key is where the intent lives: something called `apiKey` is a secret, and
something called `title` is not.

The `depth + 1` on every recursion is what makes `MAX_DEPTH` meaningful — each level of
nesting increments, and at 4 the walk returns the string `"[truncated]"` rather than
continuing. Note that it returns a *string* at that point, not an object, which means the
consumer gets a legible marker in place of the subtree rather than an empty object that
looks like real (missing) data.

Arrays get a different treatment (lines 66–69): the first `MAX_ARRAY` items are redacted and
a marker is appended for the remainder.

```ts
return value.length > MAX_ARRAY ? [...head, `…(+${value.length - MAX_ARRAY} more)`] : head;
```

So a 500-element task list logs as 20 elements plus `…(+480 more)` — enough to see the shape
and the first few values, without writing 500 objects to a log line. The marker is a string
in an array position, which is deliberately obvious: a reader can see at a glance that the
array is incomplete.

`redact` is **exported** rather than kept private, and that is not incidental. Chapter 22's
audit trail and the debug paths in the selection engine both need to log a bounded version
of something without going through the full logger. Exporting the one function that knows
the rules is how you avoid a second, subtly different implementation of "make this safe to
write".

**Block 5 — `createLogger` and `emit` (lines 78–109).**

```ts
export function createLogger(level: LogLevel, bindings: Fields = {}): Logger {
  const threshold = SEVERITY[level];

  const emit = (severity: LogLevel, event: string, fields?: Fields): void => {
    if (SEVERITY[severity] < threshold) {
      return;
    }

    const line = {
      ts: new Date().toISOString(),
      level: severity,
      event,
      ...(redact(bindings) as Fields),
      ...(fields === undefined ? {} : (redact(fields) as Fields)),
    };

    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
  ...
}
```

Five things are happening here and each is a decision:

**1. `threshold` is captured, not looked up.** `SEVERITY[level]` is read once when the logger
is created, so `emit` does a single integer compare per line. A logger that resolved its own
level on every call would be doing a map lookup per log line for a value that never changes.

**2. The early return, not a conditional write.** `if (SEVERITY[severity] < threshold) return;`
— the suppressed path does no object construction and no `JSON.stringify`. This matters for
the `debug` calls in hot paths: they are cheap to *leave in* precisely because they cost a
compare when the level is `info`.

**3. `bindings` first, `fields` second.** The spread order is the merge order, so a field
passed at the call site **overrides** a binding of the same name. That is the right way
round: `logger.child({ uri: "default" }).info("x", { uri: "actual" })` should report
`actual`, because the more specific value wins.

**4. `fields === undefined ? {} : ...`** rather than `...(fields ?? {})`. Same result, and it
avoids constructing an empty object on the (common) no-fields path. This is the kind of
thing that matters in a logger and nowhere else — but a logger is exactly where it matters.

**5. `process.stderr.write`, with a trailing `\n`.** One JSON object per line — the shape
that makes `grep`, `jq` and every log shipper work. `JSON.stringify` on a flat object cannot
emit a newline inside itself (the redaction has already turned any nested string into a
single-line value), so one `write` really is one line.

**Block 6 — `child` (line 108).**

```ts
child: (extra) => createLogger(level, { ...bindings, ...extra }),
```

A one-liner that recurses through the factory, and the reason the factory exists at all
rather than a module-level singleton. `child` returns a *new* logger whose `bindings` are the
parent's plus the extra fields. The parent is untouched, so two concurrent requests each get
their own child from the same root:

```ts
const log = root.child({ requestId: "abc" });   // root is unchanged
const other = root.child({ requestId: "def" }); // no leakage between them
```

That immutability is what makes it safe to use per-request context in a concurrent server.
If `child` mutated `bindings` in place, the second request's `requestId` would overwrite the
first's mid-flight, and the logs of two interleaved requests would be unattributable — the
exact failure mode `requestId` exists to prevent.

---

## Run / verify

### 1. Structured lines, and the level filter

```bash
MCP_LOG_LEVEL=debug npx tsx src/host/lifecycle.ts 2>&1 >/dev/null | head -5
```

```text
{"ts":"2026-10-23T19:11:32.472Z","level":"info","event":"server.ready","server":"task-mcp-server","version":"1.0.0","resources":6,"templates":3,"prompts":3,"allowedSchemes":["task","user"],"toolTimeoutMs":5000,"resourceTimeoutMs":2000,"maxResourcesPerRequest":3,"maxContextChars":40000,"resourceCacheTtlMs":30000}
{"ts":"2026-10-23T19:11:32.482Z","level":"info","event":"server.listening","server":"task-mcp-server","pid":937584,"transport":"streamable-http","url":"http://127.0.0.1:8081/mcp","version":"1.0.0"}
{"ts":"2026-10-23T19:11:32.852Z","level":"info","event":"client.connected","host":"lifecycle","url":"http://127.0.0.1:8081/mcp"}
{"ts":"2026-10-23T19:11:32.946Z","level":"info","event":"tool.call","server":"task-mcp-server","tool":"list_tasks","ms":2}
{"ts":"2026-10-23T19:11:32.965Z","level":"info","event":"resource.read","server":"task-mcp-server","uri":"task://backlog","name":"backlog","kind":"dynamic","source":"cache","chars":191}
```

Five lines, five observations:

- **`server.ready` comes before `server.listening`.** The module-scope state in
  `mcp/server.ts` is built when the module is imported, which happens before
  `httpServer.listen()` runs. So the capability provider is ready before the socket is.
  That ordering is not an accident of timing — it is the dependency order.
- **`"server":"task-mcp-server"` is on every line from the server, `"host":"lifecycle"` on
  every line from the host.** Neither call site passes it. That is `child`/`bindings` doing
  its job — and in a two-process system it is what makes `grep '"host":"lifecycle"'`
  possible.
- **`"event":"tool.call"` carries `"tool":"list_tasks"` and `"ms":2`.** Group by `tool`, or
  average `ms` per tool, without parsing a sentence.
- **`"source":"cache"`** on the `resource.read` line. The second read of `task://backlog`
  hit the shared TTL cache. (Chapter 10 covers the cache; Chapter 17 explains why it has to
  be process-scoped for this line to ever say anything but `"miss"`.)
- **Nothing on stdout.** Redirect stdout to a file and it holds the walkthrough's printed
  steps only — not one log line.

### 2. Which events a full run emits

```bash
MCP_LOG_LEVEL=debug npx tsx src/host/lifecycle.ts 2>&1 >/dev/null \
  | sed -E 's/.*"event":"([^"]+)".*/\1/' | sort | uniq -c | sort -rn
```

```text
      7 resource.read
      5 audit
      1 tool.call
      1 server.shutdown
      1 server.ready
      1 server.listening
      1 resource.failure
      1 prompt.get
      1 model.skipped
      1 context.assembled
      1 client.connected
      1 client.closed
```

A small, closed vocabulary — and that is the point of naming events instead of writing
sentences. Twelve distinct events describe an entire 13-step run. Note `server.ready` is
**1**, not one per request: the state is built once per process, and the per-request factory
stays quiet (Chapter 17).

### 3. The level filter actually filters

```bash
MCP_LOG_LEVEL=warn npx tsx src/host/lifecycle.ts 2>&1 >/dev/null
```

```text
{"ts":"2026-10-23T19:11:38.585Z","level":"warn","event":"resource.failure","server":"task-mcp-server","uri":"task://tasks/999","code":"NOT_FOUND","message":"No task with id 999."}
```

One line out of twelve events. Everything below `warn` is suppressed by the integer compare,
and the surviving line is a real event: the walkthrough deliberately reads a task that does
not exist (step 6) to show what a Resource failure looks like. The `code` field is the
taxonomy's code from Chapter 05 — which is what lets an operator filter *failures by class*
rather than by message text.

### 4. The two streams never mix

```bash
npx tsx src/host/lifecycle.ts 1>/tmp/stdout.txt 2>/tmp/stderr.txt
wc -l < /tmp/stderr.txt   # structured log lines
grep -c '"event"' /tmp/stdout.txt   # 0 — the walkthrough never logs to stdout
```

`stdout` holds the numbered walkthrough steps; `stderr` holds the JSON. Splitting them this
way is what makes the same code safe under a stdio binding, where `stdout` would be the
protocol channel.

---

## Checkpoint

1. **What breaks if the logger writes to stdout?**
   Under a stdio MCP binding, stdout *is* the JSON-RPC channel — a stray line corrupts a
   frame and the client's parser desynchronises. This project binds to HTTP, where it would
   be harmless, and keeps the discipline anyway so the binding stays swappable.

2. **Why is the sensitive-value test on the key and not the value?**
   Because a secret has no shape. A token and a task title are both just strings; only the
   key tells you which is which. So `SENSITIVE_KEY` matches `apiKey`, `accessToken`,
   `Authorization`, and leaves `title` alone.

3. **What does `child()` buy, and what would break if it mutated in place?**
   It stamps every subsequent line with shared context (`requestId`, `actor`) so no call site
   has to remember to pass it. If it mutated, two concurrent requests would overwrite each
   other's bindings and the logs of interleaved requests would be unattributable.

4. **Why is `redact` exported?**
   So that the audit trail and debug paths can bound and mask a value without a second
   implementation of the rules — one function knows what is safe to write.

5. **What is the `MAX_DEPTH` check for?**
   It is the recursion terminator. Without it, a deeply nested or cyclic object — which is
   exactly what arrives off the wire — recurses until the stack overflows, so logging a
   hostile value would crash the server.

---

**[← Chapter 02: Config](./02_Config_Validated_Environment_and_Constants.md)** · **[Chapter 04: Metrics →](./04_Core_Metrics.md)**
