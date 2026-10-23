# Chapter 03: Core — Structured Logging & Redaction

> **Chapter goal:** Give the server an observability channel that cannot corrupt
> the protocol, and make sure that channel can never become a place where user
> data quietly accumulates.

---

## 3.1 File details

| | |
| :--- | :--- |
| **Path** | `src/core/logger.ts` |
| **Layer** | core (imports nothing from this project) |
| **Purpose** | Emit one JSON object per line to **stderr**, filter by level, and redact/bound every value before it is written |
| **Imports** | none — Node globals only |
| **Exports** | `LOG_LEVELS`, `type LogLevel`, `type Fields`, `interface Logger`, `createLogger()`, `redact()` |
| **Consumed by** | `src/config/env.ts` (the level enum), `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/index.ts`, `src/host/policy.ts`, `src/host/audit.ts`, `src/host/client.ts` |
| **Lecture sections** | [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §"Observability" and §"Never log raw tokens or full tool arguments" |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# every log line, including debug
MCP_LOG_LEVEL=debug npm run host

# warnings and errors only
MCP_LOG_LEVEL=warn npm run host
```

> **Note:** the logger writes to **stderr**, so `npm run host 2>/dev/null` shows
> you the human-readable demo and hides the machine-readable log. That split is
> the point of the chapter.

---

## 3.2 Full file

```ts
/**
 * Chapter 08 — observability, and the one rule a stdio server cannot break.
 *
 * **stdout is the protocol channel.** The host spawned this process and is
 * reading JSON-RPC frames off `stdout`; a single `console.log` there corrupts
 * the stream and the connection dies. So every line this module writes goes to
 * `stderr`, and the host is free to pipe it anywhere.
 *
 * The second rule is quieter but just as load-bearing: **tool arguments are
 * user data.** They routinely carry a name, an email or a token, so values are
 * redacted and truncated before they are written — a log line is not a place
 * to discover you have been storing PII.
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
 * line becomes a 40 MB file, and how a context window gets filled by accident.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
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
 * The logger is a factory rather than a module-level singleton so a caller can
 * bind context once (`logger.child({ requestId })`) and so tests can inject a
 * quiet one.
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

## 3.3 Block-by-block explanation

### Block 1 — the two rules, stated where they are enforced

The header comment is the design document. Two constraints shape every line below:

1. **stdout is the protocol channel.** The host is reading JSON-RPC frames from
   this process's stdout. A `console.log` in a tool handler does not "just log" —
   it injects a non-JSON-RPC line into the frame stream and the client's parser
   dies. This is the single most common way a working stdio server breaks in
   production, and it breaks *silently at the transport layer*, far from the line
   of code that caused it.
2. **Tool arguments are user data.** A `create_task` call carries a title; a real
   `send_email` call carries an address and a body; an auth call carries a token.
   Logging "the arguments, for debugging" is how a log file becomes a compliance
   finding.

Everything below is machinery for those two sentences.

### Block 2 — `LOG_LEVELS`, the shared vocabulary

```ts
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
```

**What it does:** declares the four levels once, as a value *and* a type.
**How it works:** `as const` freezes the array into a readonly tuple of literal
types, so `(typeof LOG_LEVELS)[number]` resolves to the union
`"debug" | "info" | "warn" | "error"` rather than `string`.

The array exists so that `config/env.ts` can write `z.enum(LOG_LEVELS)` — and that
one line is why the environment validator and the logger can never disagree about
what a valid level is. Adding `"trace"` here updates the type, the schema and
`SEVERITY`'s exhaustiveness check together.

```ts
const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
```

**What it does:** maps each level to a number so levels can be compared.
**How it works:** the keys are typed `LogLevel`, so adding a fifth level to
`LOG_LEVELS` makes this object **fail to compile** until it is updated. That is
the compiler enforcing "every level has a severity", which is a much better
guarantee than a comment asking nicely. The spacing (10, 20, 30, 40) leaves room
for levels to be inserted later without renumbering.

### Block 3 — the redaction policy, as constants

```ts
const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|cookie|credential)/i;

const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;
```

**What they do:** name the policy so it is auditable in one place.
**How they work:**

- **`SENSITIVE_KEY`** is a case-insensitive substring match on the *key*. It is
  deliberately a deny-list of *names*, not of values — you cannot detect a secret
  by looking at it, but you can detect the field called `authorization`. The
  `api[_-]?key` alternation covers `apiKey`, `api_key` and `api-key`, which are
  the three spellings that actually appear in the wild.
- **`MAX_STRING = 200`** bounds any single string.
- **`MAX_ARRAY = 20`** bounds array length. This is the one people forget: an
  array is unbounded by nature, so `logger.info("tasks", { tasks })` on a
  10,000-task board writes 10,000 objects.
- **`MAX_DEPTH = 4`** bounds recursion. Without it, a circular reference
  (`a.b = a`) makes `redact` recurse until the stack overflows — a logging call
  that crashes the server. Four levels is deeper than any log line needs and
  shallow enough that the cost is bounded.

> **Bounding is a security control, not a tidiness one.** An unbounded log field is
> how a single `info` call becomes a 40 MB line, and how a disk fills up on a
> Friday night. `MAX_STRING` and `MAX_ARRAY` are the difference between
> observability and a denial of service.

### Block 4 — the `Logger` interface

```ts
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}
```

**What it does:** describes the contract callers depend on.
**How it works:** the first parameter is always an **event name**, never a
sentence. `logger.info("tool.call", { tool, ms })` — not
``logger.info(`called ${tool} in ${ms}ms`)``. The distinction is what makes logs
queryable: `event="tool.call"` is a field you can filter, group and alert on,
whereas an interpolated sentence is only greppable by regex.

`child(bindings)` returns a logger that stamps extra context on every line. In
`src/mcp/server.ts` the root logger is created as:

```ts
const logger = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME });
```

so `server: "task-mcp-server"` appears on every line without any call site
repeating it — which matters the moment two servers are piped into the same log
collector.

### Block 5 — `redact`, and why it recurses

```ts
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
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
```

**What it does:** returns a safe, bounded copy of any value.
**How it works:** four guards, in an order that matters.

1. **`typeof value === "string"`** — truncate and *say by how much*. The
   `…(+N chars)` suffix is deliberate: a bare `…` tells a reader the value was
   long but not whether it was 300 characters or 3 MB, and that difference changes
   what you investigate.
2. **`value === null || typeof value !== "object"`** — numbers, booleans,
   `undefined`, `null` and functions pass through untouched. Note that `null` must
   be checked explicitly: `typeof null === "object"`, so without this line a `null`
   would fall into the object branch and crash on `Object.entries(null)`.
3. **`depth >= MAX_DEPTH`** — the recursion stop. It returns the literal string
   `"[truncated]"` so the reader can see that something was elided rather than
   silently missing.
4. **Arrays and objects** are handled separately because their *keys* differ: an
   array's keys are indices (never sensitive), an object's keys are names
   (potentially sensitive). Only the object branch consults `SENSITIVE_KEY`.

**A deliberate design choice: `redact` returns a new structure rather than mutating
in place.** Mutating would be faster, but a logger that mutates its caller's
objects is a logger that changes program behaviour — the single worst property an
observability tool can have.

**And a deliberate limit: it is key-based, not value-based.** A token passed as
`{ note: "sk-live-abc123" }` is *not* redacted, because no name-based policy can
catch that. The honest mitigation is that tool arguments are never logged raw in
the first place — see `src/host/audit.ts` in Chapter 16, which stores a hash
instead of the values.

### Block 6 — `createLogger`, the closure that does the writing

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

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
```

**What it does:** builds a logger whose level filter and bindings are captured once.
**How it works:**

**`const threshold = SEVERITY[level]` is computed once, outside `emit`.** Every
call then does a single number comparison. Recomputing `SEVERITY[level]` inside
`emit` would be a map lookup on every log line — trivial, but the pattern of
"hoist the invariant out of the hot path" is worth internalising in a function
that runs on every tool call.

**`if (SEVERITY[severity] < threshold) return;`** — the filter is `<`, not `<=`.
With `MCP_LOG_LEVEL=warn`, `threshold` is 30, so `debug` (10) and `info` (20) are
dropped and `warn` (30) and `error` (40) pass. A level is a *floor*, not an exact
match.

**The object literal order is the output order.** `ts`, `level`, `event`, then
bindings, then per-call fields. Because it is a plain object spread, a per-call
field with the same name as a binding **overrides** it — which is the behaviour
you want: a specific line can refine the logger's context.

**`...(fields === undefined ? {} : (redact(fields) as Fields))`** — the ternary is
not decoration. Spreading `undefined` is legal in JavaScript (`{...undefined}` is
`{}`), but it is not obviously legal to a reader, and the explicit form documents
the intent: "no fields means no extra keys".

**`JSON.stringify(line)` — one object per line.** This is JSON Lines, and it is
chosen over pretty-printed JSON for a specific reason: it is *streamable*. A log
collector can read stderr line by line and parse each independently, without
waiting for a closing brace. It also makes `grep '^{"ts"'` and `jq -c` work
naturally.

**`process.stderr.write` rather than `console.error`.** They currently go to the
same place, but writing to stderr explicitly states the constraint at the call
site. A reader who does not know the STDIO rule learns it here; a reader who does
gets reassurance that nobody took a shortcut.

**`child` is recursive rather than mutable.** `child(extra)` builds a *new* logger
with merged bindings instead of mutating the parent. That matters when two callers
share a logger: `logger.child({ tool })` in one handler cannot leak `tool` into
another handler's lines.

**Why a factory instead of a module-level singleton?** Three reasons, in order of
importance:

1. **Testability.** A test can create a logger at `error` level and get silence. A
   singleton's level is fixed by `env` at import time.
2. **Composability.** `child()` requires a per-caller instance to bind context
   into.
3. **No import cycle.** `logger.ts` imports nothing, which is what lets
   `config/env.ts` import `LOG_LEVELS` from it without a cycle.

---

## 3.4 Run / verify

The demo prints to **stdout** and logs to **stderr**, so the two streams can be
separated. Keep only the log stream:

```bash
npm run host 1>/dev/null 2>/tmp/log.txt
head -5 /tmp/log.txt
```

```text
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":387010,"transport":"stdio","version":"1.0.0"}
{"ts":"…","level":"info","event":"server.ready","server":"task-mcp-server","version":"1.0.0","transport":"stdio","timeoutMs":5000,"rateLimitPerMinute":60,"maxTasks":1000}
{"ts":"…","level":"info","event":"tool.call","server":"task-mcp-server","tool":"create_task","ms":1}
{"ts":"…","level":"info","event":"audit","host":"task-host","at":"…","actor":"user:demo","tool":"create_task","decision":"auto","outcome":"ok","argsHash":"57036086e66b5396","durationMs":41}
```

Note what is **not** there: `title: "Record MCP Video"`. The audit line carries
`argsHash`, not the argument. That is `src/host/audit.ts` doing its job
(Chapter 16), and it is the reason the redaction policy in this file is a second
line of defence rather than the only one.

Now watch the level filter work. At `warn`, every `info` line disappears and only
the two `tool.failure` lines survive:

```bash
MCP_LOG_LEVEL=warn npm run host 1>/dev/null 2>/tmp/warn.txt
cat /tmp/warn.txt
```

```text
{"ts":"…","level":"warn","event":"tool.failure","server":"task-mcp-server","tool":"complete_task","code":"NOT_FOUND","retryable":false,"message":"No task with id 999."}
{"ts":"…","level":"warn","event":"tool.failure","server":"task-mcp-server","tool":"complete_task","code":"CONFLICT","retryable":false,"message":"Task #1 is already COMPLETED."}
```

That is 2 lines instead of 20 — the level filter, working on **both** processes.
Getting it to work on both took one non-obvious line in `src/host/client.ts`,
which Chapter 17 covers: the stdio transport does **not** inherit the parent's
environment, so the host forwards its `MCP_*` variables to the child explicitly.

And prove the stdout rule by looking at stdout alone:

```bash
npm run host 2>/dev/null | head -3
```

```text
1. connect     -> spawned the server over stdio
2. handshake   -> capabilities: completions, logging, prompts, resources, tools
   instructions: "Task server. Every mutation is keyed by the numeric task id, so call list_tasks first to read exact …"
```

Zero log lines on stdout. Every structured line went to stderr, which is why the
JSON-RPC stream stayed intact.

---

## 3.5 Checkpoint

1. **stdout is the protocol channel; logs go to stderr.** A `console.log` in a
   stdio server is a protocol corruption bug, not a style choice.
2. **Bounding is a security control.** `MAX_STRING`, `MAX_ARRAY` and `MAX_DEPTH`
   stop one log call from becoming a disk-filling, stack-overflowing event.
3. **Redaction is key-based and therefore incomplete by design.** It catches
   `authorization` and `apiKey`; it cannot catch a token hidden inside a `note`
   field. The real fix is not logging the values at all — which is exactly what
   the audit trail does with a hash.
4. **`LOG_LEVELS` is the single source of truth for the level vocabulary.** The
   env schema, the `LogLevel` type and the `SEVERITY` map all derive from it.
5. **The logger is a factory, not a singleton.** That is what makes `child()`
   possible, and what keeps `logger.ts` dependency-free.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 02 — Config: The Validated Environment](./02_Config_Validated_Environment.md)

**Next:** [Chapter 04 — Core: Metrics Without a Vendor](./04_Core_Metrics.md)



