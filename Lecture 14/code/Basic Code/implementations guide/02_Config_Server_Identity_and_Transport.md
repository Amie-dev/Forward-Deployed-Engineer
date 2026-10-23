# Chapter 02 — Config: Server Identity & Transport

> **Goal of this chapter:** read the smallest file in the project — the one every other file
> imports. It defines the server's **identity**, its **transport**, and the **URI scheme** its
> resources live under.
>
> **Lecture chapters:** [02 — What MCP Is](../../../notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md)
> (§2.2 "What is an MCP server"), [04 — Host, Client and Server](../../../notes/04_Host_Client_Server_Architecture.md)
> (transports), [06 — Resources and Prompts](../../../notes/06_Resources_and_Prompts.md) (§6.2 "the URI is the point").

---

## 2.1 File details

| Property | Value |
|---|---|
| **Path** | `src/config/config.ts` |
| **Layer** | configuration (a leaf module — imports almost nothing, imported by many) |
| **Purpose** | the server's identity, the transport selector, and the resource URI scheme |
| **Imports** | `dotenv/config` (side-effect only) |
| **Exports** | `serverInfo`, `transport`, `policyScheme` |
| **Imported by** | `src/server/server.ts` (`serverInfo`), `src/index.ts` (`serverInfo`), `src/resources/resources.ts` (`policyScheme`) |
| **Lecture sections** | 02 §2.2 (identity = everything the client learns), 04 (transport), 06 §6.2 (URI scheme) |

### What this file is *not*

It is **not** a class, a service, or a factory. It is three exported constants. That is
deliberate: the lecture's point is that an MCP server's *identity* is tiny — **a name and a
version** — because the server holds no model and no prompt of its own.

---

## 2.2 Commands

There is no script that runs `config.ts` alone (it just defines values). Verify it two ways:

```bash
cd "Lecture 14/code/Basic Code"

# 1. Type-check it as part of the project
npm run typecheck

# 2. Prove the .env overrides work: run the server with a different name and watch stderr
MCP_SERVER_NAME=my-server npm run server
#   → [my-server] v1.0.0 listening on stdio      (Ctrl-C to stop)
```

The second command is the important one: it shows the `?? "task-mcp-server"` fallbacks in the
file being *overridden* by the environment.

---

## 2.3 Full file

**Path:** `src/config/config.ts`

```ts
import "dotenv/config";

/**
 * Chapter 02 — What MCP Is.
 *
 * An MCP Server is a capability provider behind a standard door. These two
 * fields are everything a client learns about it at `initialize`: there is no
 * model, no prompt and no vendor SDK in this process.
 */
export const serverInfo = {
  name: process.env.MCP_SERVER_NAME ?? "task-mcp-server",
  version: process.env.MCP_SERVER_VERSION ?? "1.0.0",
};

/**
 * Chapter 04 — the transport.
 *
 * STDIO is the local binding (a child process speaking JSON-RPC over
 * stdin/stdout); Streamable HTTP is the remote one. The server's code is the
 * same either way — only the binding changes.
 */
export const transport = process.env.MCP_TRANSPORT ?? "stdio";

/**
 * Chapter 06 §6.2 — a Resource is *addressable* context, so it needs a scheme.
 * `https://` is only honest when the client can fetch the URI itself, so we use
 * a custom scheme for content only this server can read.
 */
export const policyScheme = "company";
```

---

## 2.4 Block-by-block explanation

### Block 1 — load `.env` as a side effect

```ts
import "dotenv/config";
```

**What it does:** runs `dotenv`'s config loader as an *import side effect*, so any variables in
`.env` are copied into `process.env` **before** the lines below read them.

**How it works:**
- `import "…"` with no bindings is a *side-effect-only* import — nothing is assigned; the module's
  top-level code runs once.
- `dotenv/config` reads `Basic Code/.env`, parses `KEY=VALUE` lines, and sets `process.env.KEY`
  *only if it is not already set*. That last part matters: a real environment variable
  (`MCP_SERVER_NAME=my-server npm run server`) wins over the `.env` file, which is exactly what
  the "Commands" section demonstrated.
- Because this is the **first** import in `config.ts`, and `config.ts` is imported early, the
  values are in place before anything reads them.

> **Ordering rule:** if you moved this import below the `serverInfo` block, `process.env` would be
> empty and you would silently get the fallbacks. Side-effect imports must come first.

### Block 2 — the server's identity (`serverInfo`)

```ts
export const serverInfo = {
  name: process.env.MCP_SERVER_NAME ?? "task-mcp-server",
  version: process.env.MCP_SERVER_VERSION ?? "1.0.0",
};
```

**What it does:** builds the object the MCP SDK uses to identify this server during the
`initialize` handshake. It has exactly two fields: `name` and `version`.

**How it works:**
- `process.env.X ?? "fallback"` is the **nullish-coalescing** operator: use the environment value
  if it is neither `undefined` nor `null`, otherwise use the default. So the file works with *or*
  without a `.env` — good for tests and for a reviewer who forgot to copy `.env.example`.
- `export const` means the object is created once at module load and shared by every importer.
  `server.ts` passes it straight into `new McpServer(serverInfo)`.
- There is intentionally **no** `capabilities` field here — capabilities are declared by the SDK
  based on what you register (Chapter 03). Identity is just the label.

**Why this is the whole "Chapter 02" idea:** at `initialize` the client learns `{ name, version }`
plus the declared capabilities — and nothing else. There is no model name, no prompt, no vendor
SDK in this process. That is what makes the server a *capability provider behind a standard door*.

### Block 3 — the transport selector

```ts
export const transport = process.env.MCP_TRANSPORT ?? "stdio";
```

**What it does:** records which binding the server intends to use. `"stdio"` means "the host
spawns this process and we speak JSON-RPC over stdin/stdout".

**How it works:**
- Same `??` fallback pattern, defaulting to `"stdio"` (the local transport).
- Note it is exported but *not imported anywhere* in the current code. It exists as the single
  documented place where transport is configured — a hook for the HTTP swap shown in the project
  README. In a fuller build, `index.ts` would branch on it:

  ```ts
  // illustrative — how `transport` would be consumed
  if (transport === "stdio") serveStdio(createServer);
  else serveHttp(createServer); // Streamable HTTP
  ```

- The important architectural claim is in the comment: **`createServer()` does not change** between
  stdio and HTTP. Only the binding changes. That is Chapter 04's "transport is a detail".

### Block 4 — the resource URI scheme

```ts
export const policyScheme = "company";
```

**What it does:** defines the custom URI scheme used to address the policy resources
(`company://policies/return-policy`).

**How it works:**
- A **Resource** must be *addressable*, so it needs a URI. The scheme is the part before `://`.
- Choosing `company` (rather than `https`) is a deliberate honesty decision: `https://` implies any
  client could fetch the URL, but only *this* server can read these policies. A custom scheme
  stops a host from trying to dereference something it should not (Chapter 06 §6.2).
- `resources.ts` builds each URI as `` `${policyScheme}://policies/${name}` ``, so the scheme lives
  in exactly one place.

---

## 2.5 Run / verify

```bash
cd "Lecture 14/code/Basic Code"

npm run typecheck                       # silent = types are fine
MCP_SERVER_NAME=my-server npm run server  # → [my-server] v1.0.0 listening on stdio
```

- If you see `[my-server] …`, Block 2's environment override works.
- If you see `[task-mcp-server] …`, the fallback is in use (i.e. `MCP_SERVER_NAME` was not set).

---

## 2.6 Checkpoint

1. **Where does the server's identity come from?** `.env` → `dotenv/config` → `process.env` →
   `serverInfo`, with hardcoded fallbacks.
2. **Why is `serverInfo` only `{ name, version }`?** Because an MCP server is a capability
   provider, not an application; there is nothing else for the client to learn.
3. **Why a custom `company://` scheme for resources?** A resource must be addressable, and
   `https://` would falsely imply the client could fetch it. Only this server can.

**Next:** [Chapter 03 — Server: The Standard Door](./03_Server_The_Standard_Door.md)

