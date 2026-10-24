# Chapter 18 — Entry: The MCP Server over Streamable HTTP

> **The transport binding, and the only transport-aware file on the server side.** Eighty lines, two of which are
> load-bearing security checks that are easy to delete by accident — and deleting them turns a local server into a
> remote one.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/index.ts` (80 lines) |
| **Layer** | entry point — binds the assembled server to a transport |
| **Purpose** | Serve `POST /mcp` over Streamable HTTP, validate `Host` and `Origin`, log to stderr, and shut down gracefully. |
| **Exports** | none — this is a program |
| **Lecture sections** | Ch03 §3.1–3.3 (transport bindings), Ch08 (production hardening) |
| **Runs** | `npm run server` |

---

## Commands

```bash
# start it
npm run server

# talk to it over HTTP — initialize, and read the negotiated capabilities
curl -s -X POST http://127.0.0.1:8081/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'

# browse it with a UI (the Inspector speaks the protocol for you)
npx @modelcontextprotocol/inspector npx tsx src/index.ts

# the two validators: a foreign Host, and a foreign Origin
curl -s -o /dev/null -w 'host=%{http_code}\n'   -H 'Host: evil.example.com'          http://127.0.0.1:8081/mcp
curl -s -o /dev/null -w 'origin=%{http_code}\n' -H 'Origin: https://evil.example.com' http://127.0.0.1:8081/mcp
```

> **A note on the stdin form.** Piping newline-delimited JSON-RPC into `npx tsx src/index.ts` does **nothing** for
> this file — it binds an HTTP server and never reads stdin. That form belongs to a **stdio** binding, which is the
> three-line swap shown in the main README and in \"Swapping the transport\" below.

---

## `src/index.ts` — the full file

```ts
#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { env } from "./config/env.js";
import { createLogger } from "./core/logger.js";
import { createServer } from "./mcp/server.js";

/**
 * Notes Ch03 §3.1 — the transport binding.
 *
 * Streamable HTTP: the host reaches this process at `POST /mcp`. The server
 * itself (`src/mcp/server.ts`) knows nothing about it, so swapping this file is
 * the only change a different binding would need — which is Chapter 01 in
 * practice: the host depends on the *protocol*, the server on its *backend*, and
 * nothing depends on a vendor.
 *
 * Two things about this file are load-bearing rather than incidental:
 *
 *  1. **The security validators are not optional.** A server bound to localhost
 *     is still reachable from any web page in the user's browser, so the `Host`
 *     and `Origin` headers have to be checked. `localhostHostValidation()` and
 *     `localhostOriginValidation()` are the SDK's DNS-rebinding and
 *     foreign-origin defences, and removing them turns a local server into a
 *     remote one.
 *
 *  2. **stdout is never written to.** Diagnostics go to stderr through the
 *     logger, because a stdio binding would make stdout the protocol channel and
 *     a stray `console.log` would corrupt a frame. Keeping the discipline here
 *     means the same server code works under either binding.
 */

const log = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME, pid: process.pid });

const handler = createMcpHandler(createServer);
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createHttpServer((request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  void nodeHandler(request, response);
});

httpServer.listen(env.MCP_SERVER_PORT, "127.0.0.1", () => {
  log.info("server.listening", {
    transport: "streamable-http",
    url: env.MCP_SERVER_URL,
    version: env.MCP_SERVER_VERSION,
  });
});

/**
 * Graceful shutdown.
 *
 * A container orchestrator sending SIGTERM wants the in-flight turn to finish and
 * the log stream to be flushed, not a half-written frame. The `shuttingDown`
 * guard matters because a second signal — or the same one delivered twice —
 * would otherwise run `close()` while the first is still draining.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info("server.shutdown", { signal });

    httpServer.close();
    void handler.close().finally(() => process.exit(0));
  });
}
```

### Block-by-block

**Block 1 — the header, and the two warnings (lines 11–33).**

The comment names two things that are *load-bearing rather than incidental*, and they are worth reading before the
code:

> 1. **The security validators are not optional.** A server bound to localhost is still reachable from any web page in
>    the user's browser, so the `Host` and `Origin` headers have to be checked. `localhostHostValidation()` and
>    `localhostOriginValidation()` are the SDK's DNS-rebinding and foreign-origin defences, and **removing them turns a
>    local server into a remote one.**
>
> 2. **stdout is never written to.** Diagnostics go to stderr through the logger, because a stdio binding would make
>    stdout the protocol channel and a stray `console.log` would corrupt a frame. Keeping the discipline here means the
>    same server code works under either binding.

**The first warning is the one to take seriously**, because the threat is counter-intuitive. Binding to `127.0.0.1`
feels like a firewall, and it is not one: a page open in the user's own browser can send requests to
`http://127.0.0.1:8081/mcp`, and the browser will happily deliver them. That is **DNS rebinding** — an attacker's domain
re-resolved to `127.0.0.1`, so the browser thinks it is talking to the attacker's site while the request arrives at a
service on the user's own machine.

The defence is header validation, and the SDK provides it:

```ts
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
```

Two validators, checking two headers. `Host` validation is what stops the rebinding attack (the request's `Host` will be
the attacker's domain, not `localhost`); `Origin` validation stops a cross-origin request from a page that is not the
host application. **Both are needed** — they defend against different attacks, and a reader who deletes one because
"the other one covers it" has removed half the protection.

The second warning is a discipline rather than a defence. This file binds to HTTP, where stdout is *not* the protocol
channel, so a `console.log` would be harmless here. The discipline is kept anyway so the STDIO swap in the main README
stays a three-line change — and Chapter 03 made it structural by giving the logger no way to write to stdout.

**Block 2 — the composition (lines 35–40).**

```ts
const log = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME, pid: process.pid });

const handler = createMcpHandler(createServer);
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
```

Four lines, and the first is where the per-request factory behaviour from Chapter 17 is established:

**`createMcpHandler(createServer)` — the factory is passed, not a server.** That is what makes serving stateless, and
it is the reason Chapter 17 had to move the state to module scope. This one line is the cause; that chapter is the
consequence.

**`toNodeHandler(handler)`** adapts the SDK's fetch-style handler to Node's `(request, response)` signature — the same
kind of boundary adapter as `uri.href` in Chapter 15. Two SDK calls, one adapter, and the composition is done.

**The logger binds `pid`** in addition to the server name. That is a small addition with a practical purpose: with the
server and host as separate processes, a log line's `pid` is what tells you which process emitted it — and it is why
the lifecycle's `server.shutdown` line names the pid it signalled.

**Block 3 — the HTTP server, and the validators in the request path (lines 42–48).**

```ts
const httpServer = createHttpServer((request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  void nodeHandler(request, response);
});
```

**Six lines, and the security of the whole server is in the `if`.** Three details:

**Short-circuit `||`** — if `validateHost` returns false, `validateOrigin` is not called. Both validators *write the
rejection response themselves* when they fail, so returning early is the complete handling; there is nothing to add.

**`return` rather than `response.end()`** — the validator has already responded. A caller that also ended the response
would attempt a double-write, which throws.

**`void nodeHandler(...)`** — the explicit `void` is a promise-ignoring annotation. The handler returns a promise; nothing
awaits it, and the `void` says *this is deliberate*. Without it, a linter (or a reader) would flag a floating promise
as a missing `await` — and adding an `await` here would be wrong, because the response is written asynchronously by the
handler, not by this function.

**Block 4 — listening, and the log that proves the ordering (lines 50–56).**

```ts
httpServer.listen(env.MCP_SERVER_PORT, "127.0.0.1", () => {
  log.info("server.listening", {
    transport: "streamable-http",
    url: env.MCP_SERVER_URL,
    version: env.MCP_SERVER_VERSION,
  });
});
```

**`"127.0.0.1"` as the second argument** — the hostname is passed explicitly rather than defaulting. Node's default is to
bind all interfaces, which would make this server reachable from the local network — a much larger exposure than the
browser-rebinding case the validators defend against. Binding to loopback is the primary control; the header validators
are the secondary one.

And note this log line is what makes the module-scope ordering from Chapter 17 observable. Because `server.ready` fires
at module evaluation and `server.listening` fires here, the log stream shows the dependency order:

```text
{"event":"server.ready",…}        ← module evaluation: state built, capabilities declared
{"event":"server.listening",…}    ← the socket is bound
```

**Block 5 — graceful shutdown (lines 58–80).**

```ts
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info("server.shutdown", { signal });

    httpServer.close();
    void handler.close().finally(() => process.exit(0));
  });
}
```

The comment states the intent:

> A container orchestrator sending SIGTERM wants the in-flight turn to finish and the log stream to be flushed, not a
> half-written frame. The `shuttingDown` guard matters because a second signal — or the same one delivered twice —
> would otherwise run `close()` while the first is still draining.

Four decisions:

**Both `SIGINT` and `SIGTERM`, in a loop.** `SIGINT` is Ctrl-C (a developer), `SIGTERM` is an orchestrator. Handling both
means the shutdown path is exercised in development rather than only in production — which is how you find out it is
broken before you need it.

**The `shuttingDown` flag is not defensive paranoia.** A container runtime sends `SIGTERM`, waits, and then sends
`SIGKILL`. A double `SIGTERM` (or a user pressing Ctrl-C twice) is routine, and running the shutdown sequence twice
would call `handler.close()` while the first call is still draining in-flight requests — turning a graceful shutdown
into an abrupt one. The flag makes the second signal a no-op.

**`httpServer.close()` stops accepting new connections** but lets in-flight ones finish. That is the first half of
graceful: new requests are refused, existing ones are not cut off.

**`handler.close().finally(() => process.exit(0))`** — the MCP session is closed, and the process exits **only after**
that resolves. The `finally` is what guarantees the exit even if the close rejects, and `exit(0)` reports success: the
server shut down because it was asked to, not because it failed.

The ordering is the point: stop accepting, drain, then exit. Doing it the other way — exiting first — is what produces
half-written frames and requests that vanish.

---

## Run / verify

### 1. The handshake, over HTTP

```bash
npm run server &
sleep 4

curl -s -X POST http://127.0.0.1:8081/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

```text
event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"logging":{},"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"listChanged":true},"completions":{}},"serverInfo":{"name":"task-mcp-server","version":"1.0.0"},"instructions":"Task server exposing three primitives: …
```

Four things to read out of that one response:

**The transport is SSE-shaped** — `event: message` then `data: {...}`. Streamable HTTP answers a `POST` with a
Server-Sent Events stream (or a JSON body, depending on the request), and the `Accept: application/json, text/event-stream`
header above is what tells the server both are acceptable. That header is required; omitting it is a common cause of a
`406`.

**All five capabilities are here** — `logging`, `tools`, `resources`, `prompts`, `completions` — matching the
`capabilities` block in Chapter 17. `completions` is present because the resource templates register `complete` hooks
(Chapter 15), which is the SDK deriving it from the registrations rather than from the declaration.

**`subscribe` is absent**, exactly as intended. This is the response a host reads before deciding what to call — so an
absent flag here is the host being told not to try.

**`instructions` is the `INSTRUCTIONS` constant**, delivered verbatim. Chapter 17's argument that this is the server's
self-description rather than a system prompt is visible in the fact that it travels in the *handshake*.

### 2. The two validators, and the difference they make

```bash
curl -s -o /dev/null -w 'host=%{http_code}\n'   -H 'Host: evil.example.com'          http://127.0.0.1:8081/mcp
curl -s -o /dev/null -w 'origin=%{http_code}\n' -H 'Origin: https://evil.example.com' http://127.0.0.1:8081/mcp
curl -s -o /dev/null -w 'plain=%{http_code}\n'  http://127.0.0.1:8081/mcp
```

```text
host=403
origin=403
plain=405
```

**Both validators fire, and both refuse with 403** — the request never reaches the MCP handler. That is the
defence Chapter 18 opened with: a server bound to `127.0.0.1` is still reachable from a page in the user's browser,
and a foreign `Host` is exactly what a DNS-rebinding attack produces.

The third line — `plain=405` — is a useful sanity check rather than an error. A bare `GET /mcp` is a 2025 session
operation, and the SDK's stateless serving mode answers `GET` and `DELETE` with **405 Method Not Allowed** by design
(it has no session to get or delete). So a `405` here means the request *passed* both validators and reached the
handler, which is what distinguishes it from the `403`s above.

To see what the validators are preventing, comment out the `if` in the request handler and repeat the first two
curls: both would return `200`, and the server would be answering requests from any web page the user had open.

### 3. Graceful shutdown, and the pid

```bash
npm run server &
SERVER_PID=$!
sleep 3
kill -TERM $SERVER_PID
```

```json
{"ts":"…","level":"info","event":"server.shutdown","server":"task-mcp-server","pid":937584,"signal":"SIGTERM"}
```

One line, naming the **signal** and the **pid**. The signal is worth logging because `SIGINT` (Ctrl-C, a developer) and
`SIGTERM` (an orchestrator) are different events operationally — and the pid is worth logging because the server and
host are separate processes, so a shutdown line with a pid is the only way to attribute it.

Send it twice and the second is a no-op — that is the `shuttingDown` flag, and it is why a double Ctrl-C does not
produce two shutdown sequences racing on `handler.close()`.

### 4. The same server behind a different door

This is the payoff of everything above, and it is the reason the validators and the stdout discipline were kept even
though this binding does not strictly need them. Chapter 01's split means the transport is a detail:

```ts
// Notes Ch03 — the same server behind a different door.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./mcp/server.js";

serveStdio(createServer);
```

`createServer()` does not change at all — not its signature, not its body, not the three registrations. Everything
that had to be true for this to work was established elsewhere:

| Property | Established in | Why the swap needs it |
| :--- | :--- | :--- |
| The logger writes to **stderr** | Chapter 03 | On stdio, stdout *is* the protocol channel |
| `createServer` knows nothing of the transport | Chapter 17 | It takes no arguments and returns an `McpServer` |
| The state is at module scope | Chapter 17 | A stdio session still needs one process-wide store |

And with a stdio binding, the stdin form from the top of this chapter becomes the right way to smoke-test it —
newline-delimited JSON-RPC in, replies out.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Why is binding to `127.0.0.1` not sufficient on its own?**
   Because a page open in the user's own browser can send requests to `127.0.0.1`. DNS rebinding re-resolves an
   attacker's domain to loopback, so the browser delivers the request to a service on the user's machine. The `Host`
   and `Origin` validators are what catch it.

2. **Why are there two validators rather than one?**
   They defend against different attacks: `Host` validation catches DNS rebinding, `Origin` validation catches a
   cross-origin request from a page that is not the host application. Deleting either removes half the protection.

3. **What does `createMcpHandler(createServer)` establish, and where is the consequence documented?**
   That serving is stateless and the factory is called **once per request** — which is why the state had to move to
   module scope in Chapter 17.

4. **Why is the hostname passed explicitly to `httpServer.listen`?**
   Node's default is to bind all interfaces, which would make the server reachable from the local network — a much
   larger exposure than the browser-rebinding case. Binding to loopback is the primary control; the validators are the
   secondary one.

5. **What is the `shuttingDown` flag for?**
   A double `SIGTERM` (or a double Ctrl-C) is routine. Without it, the second signal would run `handler.close()` while
   the first is still draining in-flight requests — turning a graceful shutdown into an abrupt one.

6. **In what order does shutdown happen, and why?**
   `httpServer.close()` (stop accepting), then `handler.close()` (drain the MCP session), then `process.exit(0)` in a
   `finally`. Exiting first is what produces half-written frames and vanishing requests.

7. **What makes the STDIO swap three lines?**
   `createServer()` takes no arguments and knows nothing about the transport; the logger writes to stderr so stdout is
   free; and the state is process-scoped rather than request-scoped. None of the three had to change.

---

**[← Chapter 17: Server Assembly](./17_Mcp_Server_Assembly.md)** · **[Chapter 19: The Host Client →](./19_Host_Client.md)**
