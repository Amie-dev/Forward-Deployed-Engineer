# Chapter 08 — Entry Point: STDIO Transport

> **Goal of this chapter:** read the file that *binds* the assembled server to a transport. It is the
> **only transport-aware file in the project** — the entire point of Chapter 04's "the binding is a
> detail, not a rewrite".
>
> **Lecture chapter:** [04 — Host, Client and Server](../../../notes/04_Host_Client_Server_Architecture.md)
> (§4.7 transports: stdio vs Streamable HTTP; §4.10 the stdout rule).

---

## 8.1 File details

| Property | Value |
|---|---|
| **Path** | `src/index.ts` |
| **Layer** | transport binding (the process entry point) |
| **Purpose** | run `createServer()` behind **STDIO** so a host can spawn and talk to it |
| **Imports** | `serveStdio` (SDK), `serverInfo` (config), `createServer` (server) |
| **Exports** | none (it *runs*, it is not imported) |
| **Run by** | `npm run server` → `tsx src/index.ts`; and spawned by the client (Chapter 09) |
| **Lecture sections** | 04 §4.7, §4.10 |

### The STDIO rule (memorise this one)

> **On STDIO, `stdout` is the protocol channel.** Anything written to `stdout` that is not JSON-RPC
> **corrupts the stream** and kills the connection. So all diagnostics go to **`stderr`** — which is
> why the last line of this file uses `console.error`, not `console.log`.

---

## 8.2 Commands

```bash
cd "Lecture 14/code/Basic Code"

npm run server     # start the server alone; it waits for JSON-RPC on stdin
npm run dev        # same, with auto-reload on file changes
```

Because the server waits on stdin, the useful way to try it is to pipe a request in. This is the
exact smoke test from the project README — `initialize` then `tools/list`:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | npm run server --silent
```

---

## 8.3 Full file

**Path:** `src/index.ts`

```ts
#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { serverInfo } from "./config/config.js";
import { createServer } from "./server/server.js";

/**
 * Chapter 04 — the transport binding.
 *
 * STDIO: the host spawns this file as a child process and the two exchange
 * JSON-RPC over stdin/stdout. The same `createServer()` factory would be served
 * over Streamable HTTP instead by swapping only this line.
 *
 * STDIO rule (Chapter 04): **stdout is the protocol channel**. Anything written
 * there that is not JSON-RPC corrupts the stream — so diagnostics go to stderr.
 */
serveStdio(createServer, {
  onerror: (error) => console.error(`[${serverInfo.name}] ${error.message}`),
});

console.error(`[${serverInfo.name}] v${serverInfo.version} listening on stdio`);
```

---

## 8.4 Block-by-block explanation

### Block 1 — the shebang

```ts
#!/usr/bin/env node
```

**What it does:** tells the OS to run this file with `node` if it is executed directly (e.g.
`./src/index.ts`).

**How it works:** the `#!` line is a Unix convention. It is optional when you always launch through
`tsx`/`npm`, but it makes the file a proper CLI entry point. TypeScript/tsx ignore it at runtime.

### Block 2 — the imports

```ts
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { serverInfo } from "./config/config.js";
import { createServer } from "./server/server.js";
```

**What it does:** pulls in the STDIO transport helper, the identity, and the server factory.

**How it works:**
- `serveStdio` comes from a **subpath** (`@modelcontextprotocol/server/stdio`), not the main entry —
  this is the *transport-specific* module, kept separate so you only load the binding you use.
- `serverInfo` (Chapter 02) is used purely for the log lines below.
- `createServer` (Chapter 03) is the factory that will be called to build the server. Note: the
  *factory* is imported, not an instance — `serveStdio` calls it for you.

### Block 3 — bind the server to STDIO

```ts
serveStdio(createServer, {
  onerror: (error) => console.error(`[${serverInfo.name}] ${error.message}`),
});
```

**What it does:** starts the server on the STDIO transport — reading JSON-RPC from `stdin`, writing
JSON-RPC to `stdout`.

**How it works:**
- **`serveStdio(createServer, …)`** takes the **factory** (not an instance). The SDK wires up the
  stdin/stdout streams, performs the `initialize` handshake, and dispatches `tools/*`,
  `resources/*` and `prompts/*` methods to the registered capabilities. Everything you registered in
  Chapters 05–07 becomes reachable here — this one line is the "door".
- **`onerror`** — a hook for transport/protocol-level errors. It writes to **`console.error`**
  (stderr), which is correct: diagnostics must never touch the protocol channel.
  - `` `[${serverInfo.name}] ${error.message}` `` reuses the identity from Chapter 02, so log lines
    are labelled with the configured server name.
- **Swapping transports:** replace this call with the Streamable-HTTP handler (see the project
  README's example) and **nothing else changes** — `createServer()` is identical. That is the whole
  Chapter 04 lesson in one line.

### Block 4 — announce readiness on stderr

```ts
console.error(`[${serverInfo.name}] v${serverInfo.version} listening on stdio`);
```

**What it does:** prints a single readiness line when the server starts.

**How it works:**
- **`console.error` → stderr.** If this used `console.log`, it would write
  `[task-mcp-server] v1.0.0 listening on stdio` into the **stdout protocol stream**, and the client
  would choke on a non-JSON-RPC line. This is the single most common STDIO mistake (§4.10).
- The line appears in `npm run client`'s output because the client inherits the child's stderr
  (`stderr: "inherit"` in Chapter 09) — so you see it, but it never enters the protocol.
- It is printed *after* `serveStdio` is called; because the transport is event-driven, the process
  keeps running, listening on stdin.

---

## 8.5 Run / verify

Start the server alone:

```bash
cd "Lecture 14/code/Basic Code"
npm run server
# stderr: [task-mcp-server] v1.0.0 listening on stdio
# (it now waits for JSON-RPC on stdin — Ctrl-C to stop)
```

Smoke-test it with a piped `initialize` + `tools/list`:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | npm run server --silent
```

The `initialize` reply declares `tools`, `resources` and `prompts` capabilities, and `tools/list`
returns the full definitions — schemas and annotations included.

> **Important:** `2>/dev/null` on that pipeline hides the stderr readiness line and shows only the
> JSON-RPC on stdout — a neat way to see that **stdout carries protocol and stderr carries logs.**

---

## 8.6 Checkpoint

1. **Why does the readiness line use `console.error`?** Because on STDIO, `stdout` is the JSON-RPC
   channel; a stray line there corrupts the stream.
2. **What is the only file that knows about the transport?** `src/index.ts`. `createServer()` does not.
3. **What would you change to serve over Streamable HTTP?** Only this binding line — swap
   `serveStdio(...)` for the HTTP handler.

**Next:** [Chapter 09 — Client & Host: The Lifecycle](./09_Client_Host_and_Lifecycle.md)

