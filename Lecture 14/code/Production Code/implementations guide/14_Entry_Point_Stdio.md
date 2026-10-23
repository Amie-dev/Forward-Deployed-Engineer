# Chapter 14: Entry Point — STDIO & Shutdown

> **Chapter goal:** Bind the assembled server to a transport in one file, and shut down
> cleanly when the host or an orchestrator asks.

---

## 14.1 File details

| | |
| :--- | :--- |
| **Path** | `src/index.ts` |
| **Layer** | entry point (imports `serveStdio`, `config/env`, `core/logger`, `mcp/server`) |
| **Purpose** | Serve `createServer` over stdio, log the binding, and handle `SIGINT`/`SIGTERM` |
| **Imports** | `serveStdio` from `@modelcontextprotocol/server/stdio`, `env`, `createLogger`, `createServer` |
| **Exports** | none — it is a program, not a module |
| **Consumed by** | `npm run server`, and the host, which spawns it as a child process |
| **Lecture sections** | [04 — Host, Client, Server](../../../notes/04_Host_Client_Server_Architecture.md) (transports, the stdio rule) |

### Commands

```bash
cd "Lecture 14/code/Production Code"

npm run server        # start it; Ctrl-C to shut down gracefully
npm run dev           # same, with auto-reload on file changes
```

---

## 14.2 Full file

```ts
#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { env } from "./config/env.js";
import { createLogger } from "./core/logger.js";
import { createServer } from "./mcp/server.js";

/**
 * Chapter 04 — the transport binding.
 *
 * STDIO: the host spawns this file as a child process and the two exchange
 * JSON-RPC over stdin/stdout. The same `createServer()` factory would be served
 * over Streamable HTTP instead by swapping only this file — which is Chapter 01
 * in practice: the host depends on the *protocol*, the server on its *backend*,
 * and nothing depends on a vendor.
 *
 * STDIO rule (Chapter 04): **stdout is the protocol channel.** Anything written
 * there that is not JSON-RPC corrupts the stream, so every diagnostic goes to
 * stderr — which is why this file never calls `console.log`.
 */

const log = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME, pid: process.pid });

const handle = serveStdio(createServer, {
  onerror: (error) => log.error("transport.error", { message: error.message }),
});

log.info("server.listening", { transport: env.MCP_TRANSPORT, version: env.MCP_SERVER_VERSION });

/**
 * Chapter 08 — graceful shutdown.
 *
 * A host may close the pipe at any moment; the transport notices and the
 * process exits on its own. Handling signals explicitly is for the *other* half
 * of the problem: a container orchestrator sending SIGTERM wants the in-flight
 * turn to finish and the audit trail to be flushed, not a half-written frame.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log.info("server.shutdown", { signal });
    void handle.close().finally(() => process.exit(0));
  });
}
```

## 14.3 Block-by-block explanation

### Block 1 — the shebang, and why it is there

```ts
#!/usr/bin/env node
```

**What it does:** makes the file directly executable on a Unix system.
**How it works:** the kernel reads the first two bytes, sees `#!`, and runs the named interpreter
with the file as its argument.

It is not needed for `tsx src/index.ts` — the `npm run server` path never uses it. It is there
because a stdio MCP server is *the* thing a host spawns by path, and a host that spawns
`./src/index.js` after a build would need the shebang to work. Keeping it costs one line and makes
the file a legitimate executable entry point rather than a module that happens to be run.

The `env node` form rather than `#!/usr/bin/node` is the portable choice: it finds `node` on the
`PATH`, so an `nvm`- or `asdf`-managed Node works. A hard-coded `/usr/bin/node` would break on any
machine where Node is not installed system-wide.

### Block 2 — the transport binding, in one call

```ts
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const handle = serveStdio(createServer, {
  onerror: (error) => log.error("transport.error", { message: error.message }),
});
```

**What it does:** serves the server factory over stdin/stdout.
**How it works:** `serveStdio(factory, options)` — the factory is called once per connection, and
the returned handle can close it.

**`createServer` is passed as a *reference*, not called.** This is the first thing to notice.
`serveStdio(createServer, ...)` hands over the function; `serveStdio(createServer(), ...)` would
hand over a server instance. The difference matters because of what the SDK does with it:

> Serves MCP over stdio from a server factory, owning the era decision for the connection: the
> opening exchange selects the era, ONE instance from the factory is pinned for the connection
> lifetime.

So the factory is invoked *after* the opening exchange, once the protocol era is known. Calling it
eagerly would construct a server before the connection existed — and, per Chapter 11's
`ALREADY_CONNECTED` finding, would leave it unable to register anything afterwards.

**`onerror` is the transport's escape hatch.** The SDK documents it as *"a callback for
out-of-band errors (reporting only; it never alters what is written to the wire)"*. That
parenthetical matters: this is a **reporting** hook, not a handler. It cannot change the response —
by the time it fires, the wire has already been written. What it can do is put the error into the
structured log stream, which is exactly what it does here.

**`log.error("transport.error", { message: error.message })`** — note that only the message is
logged, not the whole error object. An `Error` instance serialises to `{}` under `JSON.stringify`
(its properties are non-enumerable), so logging the object directly would produce `{"error":{}}`.
Extracting `message` is the one field that carries information. A stack trace would need `.stack`
explicitly, and the logger's redaction would truncate it anyway (Chapter 03) — the right trade for
a transport-level error, which is usually a protocol violation rather than a bug.

**`const handle = ...` is not discarded.** The returned `StdioServerHandle` has a single method,
`close()`, and Block 4 uses it. Ignoring the return value would make graceful shutdown impossible —
the transport would have to be closed by exiting the process, which is what the signal handler
deliberately avoids.

**What `serveStdio` does that this file does not have to:** it creates the `StdioServerTransport`,
starts it, reads the opening exchange, decides the protocol era, calls the factory, connects the
server, and routes every subsequent message. All of that is the SDK's job; doing it by hand is the
"low-level `Server`" path — more control, considerably more code, and no benefit here.

### Block 3 — the logger, and the two bindings

```ts
const log = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME, pid: process.pid });
```

**What it does:** creates the entry point's own logger, bound to the server name and the process
id.
**How it works:** `createLogger(level, bindings)` — the same factory as Chapter 03, with two
bindings.

**`pid` is the addition here.** `src/mcp/server.ts` binds only `server`, because a server does not
care which process it is in. The entry point *does* care: it is the file that runs once per
process, so it is the only place that knows the pid. That makes this the right place to record it —
and it means every line from this file carries the pid without the other files having to know it
exists.

**A second logger, not a shared one.** This file creates its own rather than importing a singleton
from `mcp/server.ts`. That is deliberate: the entry point and the server are different layers
(Chapter 01), and a shared logger would be a dependency from the transport layer into the server
layer. Two `createLogger` calls cost nothing — the logger is a closure, not a resource.

**The logger is created at module scope, before `serveStdio`.** So if `serveStdio` itself threw,
the error would still be loggable. Placing it after would leave the one failure mode that matters
most — "the transport would not start" — without a channel.

### Block 4 — `server.listening`, the transport's readiness line

```ts
log.info("server.listening", { transport: env.MCP_TRANSPORT, version: env.MCP_SERVER_VERSION });
```

**What it does:** records that the process is bound and waiting.
**How it works:** one `info` line with the binding and the version.

**This pairs with `server.ready` from Chapter 13**, and the two lines answer different questions:

| Line | Source | Answers |
| :--- | :--- | :--- |
| `server.listening` | `src/index.ts` | Is the process up and bound to a transport? |
| `server.ready` | `src/mcp/server.ts` | Is a server instance assembled and registered? |

**They do not appear together at startup, and that is the interesting part.** Run the server alone
and only `server.listening` appears — because `serveStdio` has not called the factory yet. The
factory runs only once the client's opening exchange arrives, since that exchange is what decides
the protocol era. So the sequence is:

```text
process starts          → server.listening
client sends initialize → factory runs → server.ready
```

**Seeing `listening` without `ready` is therefore normal, not a hang.** It means the transport is up
and waiting for a client — which is exactly what `npm run server` is for. An operator who expects
both lines immediately will think the server is stuck; the run section below shows both lines by
piping an `initialize` in.

**`transport: env.MCP_TRANSPORT` is logged even though it is always `"stdio"`.** Chapter 13 makes
the same choice for the same reason: the field documents the binding, and when a second binding
exists the line is already correct. It is validated against a one-value enum in `config/env.ts`, so
it cannot be a typo.

**Why log at all, rather than staying silent?** Because a stdio server's first observable behaviour
is *nothing*. It waits. Without a startup line, an operator staring at a hung host cannot tell
whether the server started, whether it is waiting, or whether it failed silently. A line on stderr
resolves that ambiguity at a glance — and because it goes to **stderr**, it does not touch the
protocol channel.

### Block 5 — graceful shutdown: the idempotent guard

```ts
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log.info("server.shutdown", { signal });
    void handle.close().finally(() => process.exit(0));
  });
}
```

**What it does:** closes the transport cleanly on `Ctrl-C` or a termination signal, once.
**How it works:** one listener per signal, sharing a boolean guard.

**Why handle signals at all, when the transport already exits on its own?** The comment draws the
distinction precisely:

> A host may close the pipe at any moment; the transport notices and the process exits on its own.
> Handling signals explicitly is for the *other* half of the problem: a container orchestrator
> sending SIGTERM wants the in-flight turn to finish and the audit trail to be flushed, not a
> half-written frame.

So there are two shutdown paths, and they are genuinely different:

| Trigger | Who starts it | What happens without a handler |
| :--- | :--- | :--- |
| **stdin reaches EOF** | the host closes the pipe | The transport closes itself and the process exits — no handler needed |
| **`SIGTERM` / `SIGINT`** | an orchestrator, or the user | The default action kills the process mid-frame |

The first case is why the SDK's own docs say a server "should exit promptly when their standard
input is closed" — and it works with no code here. The second case is what this block adds: a chance
to close the transport rather than being killed with a write in flight.

**`let shuttingDown = false` is the idempotency guard.** A `SIGINT` followed quickly by a `SIGTERM`
— which is exactly what `docker stop` produces after its grace period — would otherwise run the
handler twice, calling `handle.close()` on an already-closing transport and logging two shutdown
lines. The guard makes the *second* signal a no-op.

**Note that the guard does not escalate.** A more sophisticated handler would treat a second signal
as "the user is impatient, exit now". This one returns silently, relying on the `process.exit(0)`
from the first invocation to end the process. That is a deliberate simplification: the close is fast
(in-memory state, no database), so the grace period is never a concern.

**`for (const signal of ["SIGINT", "SIGTERM"] as const)`** — the `as const` narrows the array to a
tuple of literal types, so `signal` is `"SIGINT" | "SIGTERM"` rather than `string`. That matters
because `process.on` is overloaded per signal name; passing a widened `string` would select a weaker
overload and lose the typing. It is the same `as const` idiom as `LOG_LEVELS` in Chapter 03.

**One listener per signal, not one shared handler.** `process.on(signal, handler)` is called twice
with a closure each time, and both closures share the `shuttingDown` flag. An alternative is a
single named function registered for both — but then the `signal` value would not be available for
the log line, and knowing *which* signal arrived is the useful part of the record.

**`void handle.close().finally(() => process.exit(0))`** — three deliberate pieces:

1. **`void`** marks the floating promise as intentional. Without it, a linter (or a future
   `no-floating-promises` rule) would flag a promise nobody awaits — and it *is* intentional here,
   because the process is about to exit.
2. **`.finally(...)` rather than `.then(...)`** so the exit happens on **both** paths. If
   `handle.close()` rejected, `.then` would never run and the process would hang in a
   shutting-down state with a dead transport — the worst possible outcome for an orchestrator
   waiting on a grace period.
3. **`process.exit(0)`** with an explicit success code. A `SIGTERM` is a *request* to stop, not a
   failure, so a non-zero code would report a crash to the orchestrator and could trigger an
   unnecessary restart-with-backoff.

**`log.info("server.shutdown", { signal })` is written before the close.** If the close throws or
hangs, the log line is already on stderr — so the last thing the operator sees is a *reason*, not
silence.

**What is *not* here:** there is no `process.on("uncaughtException")` or
`process.on("unhandledRejection")`. Adding them would be a judgement call, and the choice here is to
let an uncaught exception crash loudly. A server that swallows unexpected exceptions and keeps
running is a server that serves wrong answers; for a stdio child process the host will notice the
pipe close and can restart it. The tool layer's `toToolError` (Chapter 10) already converts
*expected* failures into results, so anything reaching an uncaught handler is genuinely unexpected.

---

## 14.4 Run / verify

Start the server alone and watch what appears:

```bash
npm run server
```

```text
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":440320,"transport":"stdio","version":"1.0.0"}
```

**One line.** No `server.ready`, because the factory has not been called — the transport is waiting
for a client's opening exchange. This is the lazy-factory behaviour from Block 4, visible in the
output. Press `Ctrl-C` and the shutdown line follows:

```text
^C
{"ts":"…","level":"info","event":"server.shutdown","server":"task-mcp-server","pid":440320,"signal":"SIGINT"}
```

Note that `pid` appears on `server.listening` and `server.shutdown` — the two lines from this file —
but **not** on `server.ready`, which comes from `src/mcp/server.ts` and binds only `server`. That is
the binding difference from Block 3, visible in the output.

Now send an `initialize` so the factory runs, and watch both startup lines:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  | npm run server --silent 2>&1 >/dev/null
```

```text
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":441839,"transport":"stdio","version":"1.0.0"}
{"ts":"…","level":"info","event":"server.ready","server":"task-mcp-server","version":"1.0.0","transport":"stdio","timeoutMs":5000,"rateLimitPerMinute":60,"maxTasks":1000}
```

`2>&1 >/dev/null` sends **stderr** to the terminal and discards **stdout** — which is the right way
to read this server's diagnostics while ignoring its protocol traffic. Both lines appear because the
opening exchange arrived, the era was decided, and the factory ran.

### The other shutdown path

Now prove the path that needs no handler. Closing stdin is what a host does when it exits:

```bash
printf '' | npx tsx src/index.ts 2>&1 | head -2
```

```text
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":439539,"transport":"stdio","version":"1.0.0"}
```

The process exits **immediately** with code 0, and there is no `server.shutdown` line — because no
signal was sent. The transport saw stdin reach EOF and closed itself, exactly as the SDK's
documentation describes. **Two shutdown paths, and only one of them involves this file's signal
handler.**

### The exit code, which is what an orchestrator reads

The signal must reach the **node process**, not a wrapper around it. Signalling `npx` kills the
wrapper (exit code 143) and never reaches the handler:

```bash
node --import tsx src/index.ts > /dev/null 2>/tmp/term.txt &
PID=$!
sleep 2
kill -TERM $PID
wait $PID; echo "exit code: $?"
cat /tmp/term.txt
```

```text
exit code: 0
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":440320,"transport":"stdio","version":"1.0.0"}
{"ts":"…","level":"info","event":"server.shutdown","server":"task-mcp-server","pid":440320,"signal":"SIGTERM"}
```

**Exit code `0`**, with the `server.shutdown` line naming `SIGTERM` — the `process.exit(0)` from
Block 5, doing its job. A `SIGTERM` is a request to stop rather than a failure, so a zero code is
what the orchestrator should see; a non-zero code would report a crash and could trigger an
unnecessary restart.

> **This is the one place where `npx tsx` is the wrong tool for a test.** `npm run server` and
> `npx tsx src/index.ts` both insert a wrapper process, so a signal sent to the job's PID reaches
> the wrapper. `node --import tsx src/index.ts` runs Node directly, so the PID *is* the server — and
> that is how you test a signal handler.

---

## 14.5 Checkpoint

1. **This is the only transport-aware file in the project.** The same `createServer` factory would be
   served over Streamable HTTP by replacing this file and nothing else.
2. **`createServer` is passed as a reference, not called.** The SDK invokes the factory *after* the
   opening exchange, once the protocol era is known — so `server.listening` appears without
   `server.ready` until a client connects.
3. **stdout is the protocol channel; every diagnostic goes to stderr.** That is why this file never
   calls `console.log`, and why `2>&1 >/dev/null` is the right way to read its diagnostics.
4. **`onerror` is a reporting hook, not a handler.** By the time it fires, the wire has already been
   written — so it logs the message and nothing more.
5. **`pid` is bound here and nowhere else.** The entry point is the layer that runs once per process,
   so it is the only layer that knows the pid.
6. **There are two shutdown paths.** stdin EOF needs no code; `SIGTERM`/`SIGINT` get a handler that
   closes the transport cleanly.
7. **The signal handler is idempotent and always exits.** The `shuttingDown` guard stops a double
   signal from closing twice, and `.finally(() => process.exit(0))` runs on both paths so a failed
   close cannot leave the process hanging — and reports success, because a stop request is not a
   failure.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 13 — MCP: Server Assembly](./13_Mcp_Server_Assembly.md)

**Next:** [Chapter 15 — Host: Policy, Consent & Filtering](./15_Host_Policy.md)



