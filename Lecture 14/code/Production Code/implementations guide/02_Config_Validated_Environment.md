# Chapter 02: Config — The Validated Environment

> **Chapter goal:** Give the server a single, typed, validated source of truth for
> every knob it has — and make a bad value stop the process at boot instead of
> surfacing three turns into a conversation.

---

## 2.1 File details

| | |
| :--- | :--- |
| **Path** | `src/config/env.ts` |
| **Layer** | config (the leaf — nothing in the project is imported *by* it except a constants list) |
| **Purpose** | Parse and validate `process.env` once, export a frozen, fully-typed `env` object, plus the resource URI scheme |
| **Imports** | `dotenv/config` (side effect), `zod/v4`, `LOG_LEVELS` from `../core/logger.js` |
| **Exports** | `env: Env`, `type Env`, `URI_SCHEME` |
| **Consumed by** | `src/mcp/server.ts`, `src/mcp/resources.ts`, `src/host/client.ts`, `src/index.ts` |
| **Lecture sections** | [02 — What MCP is](../../../notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md) (server identity), [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §8.5 (versioning, configuration) |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# happy path
npm run server

# the guard: a bad value must stop the process at boot
MCP_TOOL_TIMEOUT_MS=abc npm run server

# the enum guard: an unknown log level must also stop it
MCP_LOG_LEVEL=verbose npm run server
```

---

## 2.2 Full file

```ts
import "dotenv/config";
import * as z from "zod/v4";
import { LOG_LEVELS } from "../core/logger.js";

/**
 * Chapter 08 §8.5 — configuration.
 *
 * Every knob this server has is declared once, validated once and typed once.
 * A malformed value must stop the process at boot: a bad timeout discovered
 * three turns into a conversation is an incident, not a typo.
 *
 * The schema is also the documentation — there is no second list of environment
 * variables to keep in sync with this one.
 */

/**
 * `z.coerce.boolean()` would be a trap here, because `Boolean("false")` is
 * `true`. Parsing the two literal strings is the only honest coercion for an
 * environment variable.
 */
const booleanFromEnv = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");

const envSchema = z.object({
  // Identity — Chapter 02: everything a client learns about this server at
  // `initialize`, and the fields a host uses to decide whether to trust it.
  MCP_SERVER_NAME: z.string().min(1).max(64).default("task-mcp-server"),
  MCP_SERVER_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver, e.g. 1.0.0").default("1.0.0"),
  MCP_TRANSPORT: z.enum(["stdio"]).default("stdio"),

  // Observability — Chapter 08.
  MCP_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  // Execution guards — Chapter 08 §"Timeouts, retries and circuit breaking".
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  MCP_MAX_TASKS: z.coerce.number().int().min(1).max(1_000_000).default(1_000),

  // Host policy — Chapter 08 §8.1: discovery is an inventory, not a grant.
  MCP_HOST_ALLOW_DESTRUCTIVE: booleanFromEnv(true),
  MCP_HOST_REQUIRE_CONSENT: booleanFromEnv(true),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Chapter 06 §6.2 — a Resource is *addressable* context, so it needs a scheme.
 *
 * `https://` would only be honest if the client could fetch the URI itself;
 * it cannot. A private scheme keeps the address truthful and stops a host from
 * trying to dereference something it has no business reading.
 */
export const URI_SCHEME = "company";

function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    // Fail fast, fail loudly, and name the exact variable. Written straight to
    // stderr because a stdio server may not have a working stdout yet.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    process.stderr.write(`[config] refusing to start — invalid environment:\n${problems}\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv(process.env);
```

## 2.3 Block-by-block explanation

### Block 1 — the side-effect import

```ts
import "dotenv/config";
```

**What it does:** loads `.env` into `process.env` before anything reads it.
**How it works:** this is an import with no binding — you are not importing a
value, you are importing the *effect* of the module running. Because ES module
imports are hoisted and evaluated in order, putting it first guarantees `.env` is
merged before the schema is built.

Two consequences worth knowing:

- dotenv **never overwrites** an existing `process.env` key. A shell variable wins
  over the file. That is why `MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host` works
  without editing anything.
- `dotenv/config` never throws if `.env` is missing. A missing file is treated as
  "no overrides", which is exactly right for a container where the environment is
  injected instead.

### Block 2 — `booleanFromEnv`, and the `Boolean("false")` trap

```ts
const booleanFromEnv = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");
```

**What it does:** turns the *string* `"true"` or `"false"` into a real boolean, and
rejects anything else.
**How it works:** the pipeline is `enum → default → transform`, applied left to
right.

1. `z.enum(["true", "false"])` — the input must be exactly one of two strings. If
   someone writes `MCP_HOST_REQUIRE_CONSENT=yes`, validation fails with a named
   error rather than silently picking a branch.
2. `.default(...)` — runs **only when the input is `undefined`** (the variable is
   unset). Because the default is the string `"true"` or `"false"`, it flows into
   the next stage as a valid enum member.
3. `.transform(...)` — converts the validated string to a boolean. Note the
   comparison is `=== "true"`: the string `"false"` becomes `false`, not `true`.

**Why not `z.coerce.boolean()`?** Because `Boolean("false")` is `true` — every
non-empty string is truthy in JavaScript:

```ts
z.coerce.boolean().parse("false");    // true   ← wrong, silently
booleanFromEnv(false).parse("false"); // false  ← correct
```

This is worth dwelling on because the failure mode is invisible: an operator sets
`MCP_HOST_ALLOW_DESTRUCTIVE=false`, the config parser reports success, and
destructive tools stay enabled. The bug does not crash — it *authorises*.

**A helper returning a schema, not a value.** `booleanFromEnv(true)` is called once
per variable and each call builds a fresh schema. That matters because Zod schemas
are stateful objects (they carry the default), and sharing one instance across two
fields invites a subtle aliasing bug. Building per call is cheap and unambiguous.

### Block 3 — the schema, grouped by concern

```ts
const envSchema = z.object({
  MCP_SERVER_NAME: z.string().min(1).max(64).default("task-mcp-server"),
  MCP_SERVER_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver, e.g. 1.0.0").default("1.0.0"),
  MCP_TRANSPORT: z.enum(["stdio"]).default("stdio"),

  MCP_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  MCP_MAX_TASKS: z.coerce.number().int().min(1).max(1_000_000).default(1_000),

  MCP_HOST_ALLOW_DESTRUCTIVE: booleanFromEnv(true),
  MCP_HOST_REQUIRE_CONSENT: booleanFromEnv(true),
});
```

**What it does:** declares the server's entire configuration surface, with a
default, a bound and a type for each entry. It is simultaneously the validator and
the documentation.
**How it works:** each field is its own mini-pipeline.

**Identity (three fields).** `min(1).max(64)` on the name bounds what appears in
`serverInfo` and in every log line. The semver regex on the version is not
pedantry: Chapter 08's versioning table makes `serverInfo.version` a *published
contract* that hosts use to reason about compatibility, so `v1` or `1.0` should not
be able to reach the wire.

**`z.enum(["stdio"])` for the transport.** A one-value enum looks pointless until
you try `MCP_TRANSPORT=http` and get a boot failure instead of a server that
quietly ignores the setting. When the Streamable HTTP binding is added, this enum
gains a member and every existing deployment is already validated.

**`z.enum(LOG_LEVELS)` — a single source of truth.** `LOG_LEVELS` is exported from
`core/logger.ts` and imported here:

```ts
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
```

Because the array is `as const`, `z.enum(LOG_LEVELS)` produces the union type
`"debug" | "info" | "warn" | "error"` — the *same* type `createLogger` takes. Add a
level to the array and the env schema, the logger's `SEVERITY` map and the type all
update together. There is no second list to forget.

**The three numeric guards.** `z.coerce.number()` is correct *here* — unlike
booleans, `Number("5000")` is genuinely `5000` and `Number("abc")` is `NaN`, which
`.int()` rejects. Each then gets both a floor and a ceiling:

| Variable | Floor | Ceiling | Why the ceiling matters |
| :--- | :--- | :--- | :--- |
| `MCP_TOOL_TIMEOUT_MS` | 100 | 60 000 | A 10-minute "timeout" is not a timeout; it is a hung host |
| `MCP_RATE_LIMIT_PER_MINUTE` | 1 | 10 000 | A limit above the plausible call rate is decoration |
| `MCP_MAX_TASKS` | 1 | 1 000 000 | An in-memory board with a billion slots is a memory leak with a nice name |

The floors matter just as much. `MCP_TOOL_TIMEOUT_MS=0` would mean "every call times
out instantly", and a configuration that makes the server useless is a
configuration bug that deserves to be caught at boot.

**The two policy switches** are grouped last, under a comment naming Chapter 08
§8.1. They are consumed by the **host**, not the server — see Chapter 17.

### Block 4 — `Env`, derived rather than written

```ts
export type Env = z.infer<typeof envSchema>;
```

**What it does:** produces the TypeScript type of the parsed configuration.
**How it works:** `z.infer` reads the schema's *output* type. Note the difference
between input and output here: `MCP_HOST_ALLOW_DESTRUCTIVE` accepts the string
`"true" | "false"` and produces `boolean`. `z.infer` gives you the output — which
is what the rest of the codebase sees.

The important consequence is that **the type can never drift from the validator.**
There is no hand-written `interface Env` to keep in sync; adding a field to the
schema adds it to the type, and forgetting to add a field is a compile error at
every use site.

### Block 5 — the URI scheme constant

```ts
export const URI_SCHEME = "company";
```

**What it does:** defines the scheme for every resource URI this server exposes.
**How it works:** it is a plain constant, but its *value* is the teaching point.
`https://policies/return-policy` would be a lie: the client cannot fetch that URI —
only this server can. A private scheme keeps the address honest and stops a
well-meaning host from trying to dereference something it has no business reading.

It lives in `config/` rather than `mcp/resources.ts` because it is part of the
server's published identity, in the same way the server name is: a URI that appears
in `resources/list` is a contract, and contracts belong with configuration.

### Block 6 — `loadEnv`, the fail-fast gate

```ts
function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    process.stderr.write(`[config] refusing to start — invalid environment:\n${problems}\n`);
    process.exit(1);
  }

  return parsed.data;
}
```

**What it does:** validates the environment, and on failure prints *every* problem
and exits with code 1.
**How it works:**

1. **`safeParse`, not `parse`.** `parse` throws; `safeParse` returns a
   discriminated result (`{ success: true, data }` or `{ success: false, error }`).
   That lets this function choose the *presentation* of the failure — a formatted
   list on stderr — instead of letting a `ZodError` stack trace escape. The
   distinction matters at boot: a stack trace tells you Zod was unhappy; this tells
   you which variable to fix.

2. **`parsed.error.issues.map(...)`** reports **all** failures at once, not just
   the first. An operator fixing a deployment wants one round trip, not five.

3. **`issue.path.join(".") || "(root)"`** renders the failing field name. Zod's
   `path` is an array (`["MCP_TOOL_TIMEOUT_MS"]`); joining it gives the variable
   name an operator can grep for. The `|| "(root)"` covers a failure on the object
   itself, which would otherwise render as an empty string.

4. **`process.stderr.write`, not `console.log`.** This is the STDIO rule in
   miniature. Note what is deliberately *not* used: stdout. On a stdio server,
   stdout is the JSON-RPC channel, and a log line written there corrupts the
   stream. Writing to stderr explicitly also makes the intent visible and immune to
   a future logger configuration.

5. **`process.exit(1)`.** The non-zero code is the part that matters
   operationally: a container orchestrator, a systemd unit or a shell `&&` chain
   reads it. A server that logs "invalid config" and starts anyway is worse than one
   that refuses, because it will accept traffic and fail unpredictably later.

6. **`source` as a parameter.** `loadEnv(process.env)` is called with the
   environment injected rather than reaching for the global. That is a one-word
   change that makes this function unit-testable: `loadEnv({ MCP_LOG_LEVEL: "verbose" })`
   can be asserted on without mutating the real process environment.

### Block 7 — the module-level constant

```ts
export const env: Env = loadEnv(process.env);
```

**What it does:** validates once, at import time, and exports the result.
**How it works:** ES modules are evaluated exactly once and cached. So the first
`import { env } from "../config/env.js"` anywhere in the program triggers
validation; every later import receives the same object.

This gives the whole codebase a guarantee that is easy to miss: **by the time any
other module's top-level code runs, the configuration is known to be valid.** No
function needs to ask "is the config loaded yet?", and no call site needs to handle
a config error, because an invalid config means the process never reached them.

The trade-off is that this makes `env` awkward to stub in tests. The project
accepts that deliberately: for the parts that need isolation — the logger, the
metrics registry, the rate limiter, the store, the service — dependencies are
*injected* (`ServerDeps` in Chapter 09) rather than imported. `env` is the one
global, and it is the one that must never change at runtime.

---

## 2.4 Run / verify

**Happy path** — the defaults apply and the server starts:

```bash
npm run server
```

```text
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":372088,"transport":"stdio","version":"1.0.0"}
```

(Press `Ctrl-C`. That line comes from `src/index.ts`, which you will meet in
Chapter 14.)

**Bad number:**

```bash
MCP_TOOL_TIMEOUT_MS=abc npm run server
```

```text
[config] refusing to start — invalid environment:
  - MCP_TOOL_TIMEOUT_MS: Invalid input: expected number, received NaN
```

**Bad enum:**

```bash
MCP_LOG_LEVEL=verbose npm run server
```

```text
[config] refusing to start — invalid environment:
  - MCP_LOG_LEVEL: Invalid option: expected one of "debug"|"info"|"warn"|"error"
```

**Bad version:**

```bash
MCP_SERVER_VERSION=v1 npm run server
```

```text
[config] refusing to start — invalid environment:
  - MCP_SERVER_VERSION: must be semver, e.g. 1.0.0
```

**All at once** — note that every problem is reported in a single pass:

```bash
MCP_TOOL_TIMEOUT_MS=abc MCP_LOG_LEVEL=verbose MCP_SERVER_VERSION=v1 npm run server
```

```text
[config] refusing to start — invalid environment:
  - MCP_SERVER_VERSION: must be semver, e.g. 1.0.0
  - MCP_LOG_LEVEL: Invalid option: expected one of "debug"|"info"|"warn"|"error"
  - MCP_TOOL_TIMEOUT_MS: Invalid input: expected number, received NaN
```

Every one of those runs exits with code **1** and never reaches the transport.
Confirm with `echo $?` immediately after any of them.

---

## 2.5 Checkpoint

1. **Configuration is validated once, at import time, and then never again.** An
   invalid value means the process dies before it can accept a message — which is
   why no other file in this project contains config-error handling.
2. **Booleans come from the literal strings `"true"`/`"false"`, never from
   `z.coerce.boolean()`.** `Boolean("false") === true` is the bug that turns a
   security switch into a no-op.
3. **`Env` is derived from the schema with `z.infer`.** The type and the validator
   cannot drift apart.
4. **The two host-policy switches are read by the host, not the server.** The
   server does not decide what it is allowed to do.
5. **Every variable has a floor *and* a ceiling.** A timeout of 0 and a timeout of
   ten minutes are both configuration bugs, and both are caught here.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 01 — Project Structure & File Map](./01_Project_Structure_and_File_Map.md)

**Next:** [Chapter 03 — Core: Structured Logging & Redaction](./03_Core_Structured_Logging.md)


