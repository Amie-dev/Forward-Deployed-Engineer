# Chapter 03 — Server: The Standard Door

> **Goal of this chapter:** read the file that *assembles* the server. It is 20 lines and it is the
> architectural centre of the project: one factory that registers the three primitives and hands
> back an `McpServer` with **no knowledge of which host or which model is on the other side.**
>
> **Lecture chapters:** [02 — What MCP Is](../../../notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md)
> (§2.5 "a protocol, not a framework"), [04 — Host, Client and Server](../../../notes/04_Host_Client_Server_Architecture.md)
> (§4.4 the server's job).

---

## 3.1 File details

| Property | Value |
|---|---|
| **Path** | `src/server/server.ts` |
| **Layer** | server assembly |
| **Purpose** | `createServer()` — build an `McpServer` and register all three primitives |
| **Imports** | `McpServer` (from the SDK), `serverInfo` (config), `registerTools`, `registerResources`, `registerPrompts` |
| **Exports** | `createServer` (a function) |
| **Imported by** | `src/index.ts` (the STDIO entry point) |
| **Lecture sections** | 02 §2.2/§2.5, 04 §4.4 |

### The one idea in this file

**This file knows *what capabilities exist*, not *how they are delivered* and not *who is calling*.**
It never imports a transport, never imports the client, and never imports an LLM. Swapping STDIO for
Streamable HTTP does not touch this file — that is the "standard door" property.

---

## 3.2 Commands

This file is never run directly; it is *called*. Two ways to exercise it:

```bash
cd "Lecture 14/code/Basic Code"

# 1. Type-check it
npm run typecheck

# 2. Exercise it through the entry point that binds it (Chapter 08)
npm run server      # calls createServer() via serveStdio
```

---

## 3.3 Full file

**Path:** `src/server/server.ts`

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { serverInfo } from "../config/config.js";
import { registerPrompts } from "../prompts/prompts.js";
import { registerResources } from "../resources/resources.js";
import { registerTools } from "../tools/tools.js";

/**
 * Chapter 02 / Chapter 04 — assemble the capability provider.
 *
 * This is the "standard door": one server process exposing the three primitives,
 * with no knowledge of which host or which model is on the other side.
 */
export function createServer(): McpServer {
  const server = new McpServer(serverInfo);

  registerTools(server); // do    — driven by the model
  registerResources(server); // know  — driven by the application
  registerPrompts(server); // reuse — driven by the user

  return server;
}
```

---

## 3.4 Block-by-block explanation

### Block 1 — the imports

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { serverInfo } from "../config/config.js";
import { registerPrompts } from "../prompts/prompts.js";
import { registerResources } from "../resources/resources.js";
import { registerTools } from "../tools/tools.js";
```

**What it does:** pulls in the SDK's `McpServer` class, the identity from Chapter 02, and the three
registration functions — one per primitive.

**How it works:**
- `McpServer` is the SDK's server object. It handles the JSON-RPC framing, the `initialize`
  handshake, capability declaration and method dispatch. You only *register* capabilities; the SDK
  does the protocol work.
- The three `register*` imports come from separate files (`tools/`, `resources/`, `prompts/`) so
  each primitive's contract lives in its own module (Chapters 05–07).
- Every relative import ends in `.js`, per the ESM + `NodeNext` rule from Chapter 01.

### Block 2 — the factory signature

```ts
export function createServer(): McpServer {
```

**What it does:** declares a **factory function** (a function that builds and returns a fresh server)
rather than a module-level singleton.

**How it works:**
- Returning a *new* `McpServer` on every call matters for the SDK's transports: `serveStdio` and
  the HTTP handler both take this factory and call it per connection/session. A shared singleton
  would leak state between sessions.
- The explicit return type `: McpServer` documents the contract: "give me a ready-to-serve server".

### Block 3 — create the server with its identity

```ts
  const server = new McpServer(serverInfo);
```

**What it does:** constructs the server and stamps it with `{ name, version }`.

**How it works:**
- The object passed here is exactly the `serverInfo` from `config.ts`. It becomes the
  `serverInfo` the client receives in the `initialize` response.
- Capabilities are **not** passed in. The SDK derives the declared capabilities
  (`tools`, `resources`, `prompts`) from what you register in the next three lines — which is why
  registering a capability is what makes it *discoverable*.

### Block 4 — register the three primitives

```ts
  registerTools(server); // do    — driven by the model
  registerResources(server); // know  — driven by the application
  registerPrompts(server); // reuse — driven by the user
```

**What it does:** attaches every tool, resource and prompt to this server instance.

**How it works:**
- Each `register*(server)` call runs inside its own module and calls SDK methods like
  `server.registerTool(...)`, `server.registerResource(...)`, `server.registerPrompt(...)`.
- The trailing comments encode the lecture's **control model** (Chapter 06 §6.8):
  - **Tools = *do*** → the **model** chooses them.
  - **Resources = *know*** → the **application** reads them.
  - **Prompts = *reuse*** → the **user** selects them.
- Order does not matter functionally, but this order mirrors the mental model *do → know → reuse*.

### Block 5 — hand back the assembled server

```ts
  return server;
}
```

**What it does:** returns the fully-registered server to the caller.

**How it works:** the caller is `src/index.ts`, which passes this factory to `serveStdio`. Nothing
else in the project constructs an `McpServer`, so this is the single place the server's shape is
defined.

---

## 3.5 Run / verify

```bash
cd "Lecture 14/code/Basic Code"
npm run typecheck   # silent
npm run server      # → [task-mcp-server] v1.0.0 listening on stdio
```

The `listening on stdio` line is printed by `index.ts`, not by this file — which is the point:
this file assembled the server, and a *different* file bound it to a transport.

---

## 3.6 Checkpoint

1. **Why a factory (`createServer()`) instead of a module-level `const server = …`?** So each
   connection/session gets a fresh instance — no shared state.
2. **Where do the declared capabilities come from?** From what you register; the SDK infers them.
3. **What is absent from this file?** Any transport, any client, any LLM. That absence *is* the
   "standard door".

**Next:** [Chapter 04 — Task Service: The Execution Layer](./04_Task_Service_Execution_Layer.md)

