# Chapter 09 — Entry Point & Routes: `GET /plan?hours=4`

> **Goal of this chapter:** bind the server to a transport, then build the host that a user
> actually talks to — and run the lecture's own request end to end, watching the three primitives
> each play their part.
>
> **Lecture chapters:** [01 — The Three Primitives and the Control Model](../../../notes/01_The_Three_Primitives_and_the_Control_Model.md)
> and [08 — Bringing Tools, Resources and Prompts Together](../../../notes/08_Bringing_Tools_Resources_and_Prompts_Together.md).

---

## 9.1 Files in this chapter

| | `src/index.ts` | `src/routes/index.ts` |
|---|---|---|
| **Purpose** | the MCP **server** process, on Streamable HTTP | the **host** process: HTTP routes a user calls |
| **Port** | `8081` (`MCP_PORT`) | `8080` (`HOST_PORT`) |
| **Speaks** | MCP / JSON-RPC | plain HTTP |
| **Imports** | `node:http`, `@modelcontextprotocol/node`, `@modelcontextprotocol/server`, `server/server`, `config` | `node:http`, `config`, `client/client` |
| **Imports the other?** | **no** | **no** — it talks over HTTP, not by import |
| **Run with** | `npm run server` | `npm run host` |

**They never import each other.** That is the whole point: the host reaches the server over the
protocol, not through the module system. The two processes could be on different machines.

---

## 9.2 Commands

```bash
# terminal 1 — the MCP server
npm run server

# terminal 2 — the host
npm run host
```

```bash
# terminal 3 — the lecture's end-to-end request
curl 'http://127.0.0.1:8080/plan?hours=4'
```

---

## 9.3 Full file — `src/index.ts`

```ts
#!/usr/bin/env node
import { createServer } from "node:http";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { mcpPort, serverInfo } from "./config/config.js";
import { createServer as createMcpServer } from "./server/server.js";

/**
 * Chapter 01 — the transport binding.
 *
 * Streamable HTTP: the host reaches this process at `POST /mcp`. The server
 * itself (`src/server/server.ts`) knows nothing about it, so swapping this file
 * is the only change a different binding would need.
 *
 * The two validators below are Chapter 08's security point, and they are not
 * optional: a server bound to localhost is still reachable from any web page in
 * the user's browser, so the Host and Origin headers have to be checked.
 */
const handler = createMcpHandler(createMcpServer);
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer((request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  void nodeHandler(request, response);
});

httpServer.listen(mcpPort, "127.0.0.1", () => {
  // Diagnostics go to stderr so they never mix with anything a host reads.
  console.error(
    `[${serverInfo.name}] v${serverInfo.version} MCP endpoint on http://127.0.0.1:${mcpPort}/mcp`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handler.close();
    httpServer.close();
  });
}
```

---

## 9.4 Full file — `src/routes/index.ts`

```ts
/**
 * Chapter 09 — the HOST: the HTTP application a user actually talks to.
 *
 * `GET /plan?hours=4` is the request the lecture runs end to end. Watch the
 * division of labour in it: the USER chose the workflow (the Prompt), the
 * APPLICATION chose the context (the Resources), and the MODEL chooses any tool
 * call. Three primitives, three owners, one request.
 */
import { createServer } from "node:http";

import { hostPort } from "../config/config.js";
import {
  ask,
  connect,
  disconnect,
  getPromptText,
  listPrompts,
  listResources,
  planDay,
  readResource,
} from "../client/client.js";

// One client, opened once, for the whole life of the host.
const connection = await connect();
const { client } = connection;

/**
 * The route table. Each entry is one endpoint; the key is the pathname.
 * `URL` gives us the query string for free, which is how `hours` reaches the
 * Prompt argument.
 */
const routes: Record<string, (url: URL) => Promise<string>> = {
  /* Chapter 03 — discovery of everything the server offers. */
  "/resources": async () => {
    const { resources, resourceTemplates } = await listResources(client);

    return [
      ...resources.map((resource) => `${resource.uri}\n    ${resource.description ?? ""}`),
      ...resourceTemplates.map((template) => `${template.uriTemplate}   (template)`),
    ].join("\n");
  },

  /* Chapter 03 — consumption: read one Resource by URI. */
  "/read": async (url) => readResource(client, url.searchParams.get("uri") ?? "task://guidelines"),

  /* Chapter 06 — what workflows does the server offer? */
  "/prompts": async () =>
    (await listPrompts(client))
      .map((prompt) => `${prompt.name}   ${prompt.description ?? ""}`)
      .join("\n"),

  /* Chapter 07 §7.3 — fetch the Prompt. No model is called by this route. */
  "/prompt": async (url) =>
    getPromptText(client, url.searchParams.get("name") ?? "plan_day", {
      availableHours: url.searchParams.get("hours") ?? "4",
    }),

  /* Chapter 05 — the application selects context, then the model answers. */
  "/ask": async (url) => {
    const message = url.searchParams.get("message");

    if (!message) {
      throw new Error("Query parameter 'message' is required.");
    }

    return ask(client, message);
  },

  /* Chapter 08 — the lecture's end-to-end request: Prompt → (Resources + Tools) → answer. */
  "/plan": async (url) => planDay(client, url.searchParams.get("hours") ?? "4"),
};

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);
  const handler = routes[url.pathname];

  if (!handler) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Not found. Try one of:\n${Object.keys(routes).join("\n")}`);
    return;
  }

  handler(url)
    .then((body) => {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(body);
    })
    .catch((error: Error) => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.message);
    });
});

httpServer.listen(hostPort, "127.0.0.1", () => {
  console.error(`Task host is running at http://127.0.0.1:${hostPort}`);
  console.error(`Try: http://127.0.0.1:${hostPort}/plan?hours=4`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void disconnect(connection);
    httpServer.close();
  });
}
```

---

## 9.5 Block-by-block explanation — `src/index.ts`

### Block 1 — the shebang and imports

```ts
#!/usr/bin/env node
import { createServer } from "node:http";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { mcpPort, serverInfo } from "./config/config.js";
import { createServer as createMcpServer } from "./server/server.js";
```

- `#!/usr/bin/env node` makes the file directly executable (`./src/index.ts`). It is optional with
  `tsx`, but it is honest documentation that this file *is* a program.
- `createServer` comes from `node:http` — **the raw Node HTTP server, no framework.** Four routes
  and one MCP endpoint do not need Express.
- **The alias is the interesting part.** `import { createServer as createMcpServer }` — there are
  two different "create server" functions in this file, so one is renamed. Without it you would
  have a name collision, and with a worse name you would lose the reader. `createMcpServer` says
  exactly which one it is.
- `toNodeHandler` is the adapter from the SDK's **web-standard** handler to Node's
  `(request, response)` signature. The SDK speaks `Request`/`Response`; Node's `http` module does
  not. That adapter is the bridge.
- `localhostHostValidation` and `localhostOriginValidation` are **security middleware**. See
  Block 3.

### Block 2 — build the handler

```ts
const handler = createMcpHandler(createMcpServer);
const nodeHandler = toNodeHandler(handler);
```

- `createMcpHandler(createMcpServer)` takes the **factory** from Chapter 07 — not an instance.
  The handler calls it when it needs a server, which is what makes per-connection instances
  possible.
- Two objects, two jobs:
  - `handler` — the protocol logic (JSON-RPC in, JSON-RPC out, sessions, SSE).
  - `nodeHandler` — the same thing, adapted to Node's HTTP signature.
- **Neither of these knows what capabilities the server has.** That lives entirely in
  `createServer()`. This file is purely plumbing, which is why swapping transports touches only
  this file.

### Block 3 — the two validators (the security point)

```ts
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
```

- Both are **factories**: you call them to get a validator function, then call that function per
  request. That is why there are parentheses on these lines and none on the one below.
- **Why they matter, and why this is not paranoia.** Binding to `127.0.0.1` stops *other machines*
  reaching the server — but it does **not** stop a web page in the user's own browser. Any site
  the user visits can issue a `fetch("http://127.0.0.1:8081/mcp")`, and the browser will happily
  send it, because localhost is the user's own machine.
  - `validateHost` rejects requests whose `Host` header is not a localhost name. That defeats
    **DNS rebinding**, where an attacker's domain resolves to `127.0.0.1` to impersonate you.
  - `validateOrigin` rejects requests whose `Origin` header is a foreign website. That is
    standard CORS-style protection, applied at the server.
- Without these two lines, a page at `evil.example` could enumerate and read every Resource on
  this server — including `user://123/profile`. The validators are five words long and they close
  a real hole.

### Block 4 — the request handler

```ts
const httpServer = createServer((request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  void nodeHandler(request, response);
});
```

- **The validators write the rejection themselves.** They take `(request, response)`, and on
  failure they have already sent a `403` and returned `false`. That is why the handler only needs
  to `return` — there is nothing left to write.
- `||` short-circuits: if the Host check fails, the Origin check is skipped and the request is
  dropped. Fail fast, one rejection.
- `void nodeHandler(request, response)` — the SDK's handler is async, but Node's `createServer`
  callback is not. `void` marks the deliberate fire-and-forget, the same idiom as Chapter 08's
  `void main()`. The handler writes to `response` itself when it is done.
- **Every path is the MCP endpoint.** There is no routing here at all — the host decides *what* to
  call, and the server only answers the protocol. All five Resources and both Prompts are reached
  through this one URL.

### Block 5 — listen, and why stderr

```ts
httpServer.listen(mcpPort, "127.0.0.1", () => {
  // Diagnostics go to stderr so they never mix with anything a host reads.
  console.error(
    `[${serverInfo.name}] v${serverInfo.version} MCP endpoint on http://127.0.0.1:${mcpPort}/mcp`,
  );
});
```

- `listen(mcpPort, "127.0.0.1", …)` — the address is **explicit**. Omitting it would bind
  `0.0.0.0` and expose the server to the whole network. On a development machine that is a mistake
  with real consequences.
- The banner uses `serverInfo` from Chapter 02, so it prints the *configured* name and version.
  Change `.env` and the banner changes — a small, useful confirmation that config was loaded.
- **`console.error`, not `console.log`.** This is not a style preference. On a stdio transport,
  **stdout is the protocol channel** — anything written there that is not JSON-RPC corrupts the
  stream. This project uses HTTP, so stdout is technically free, but the convention is kept so the
  same file would survive a transport swap. It also means `console.error` output never pollutes a
  pipe.
- The URL ends in `/mcp`, matching `mcpServerUrl` in Chapter 02. The port is the only thing that
  has to agree; the path is a convention.

### Block 6 — graceful shutdown

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handler.close();
    httpServer.close();
  });
}
```

- `["SIGINT", "SIGTERM"] as const` handles **both** ways a process is asked to stop:
  - `SIGINT` — you pressed `Ctrl+C`.
  - `SIGTERM` — a supervisor or script asked it to stop. This is the signal Chapter 08's
    `process.kill(-pid, "SIGTERM")` sends, so this loop is what makes the walkthrough's cleanup
    actually work.
- The `as const` is needed for the same reason as Chapter 06's `role: "user" as const`: without it
  the array is `string[]`, and `process.on` expects the narrower signal union.
- `handler.close()` releases MCP sessions; `httpServer.close()` stops accepting new connections.
  Both are needed — closing only the HTTP server would leave protocol sessions open.
- **Why this matters in practice:** without it, `Ctrl+C` on the *host* leaves the MCP server
  running and holding port 8081, and your next `npm run server` fails with `EADDRINUSE`. Graceful
  shutdown is not decoration; it is what makes the project re-runnable.

---

## 9.6 Block-by-block explanation — `src/routes/index.ts`

### Block 1 — the imports and the single connection

```ts
import { createServer } from "node:http";

import { hostPort } from "../config/config.js";
import {
  ask,
  connect,
  disconnect,
  getPromptText,
  listPrompts,
  listResources,
  planDay,
  readResource,
} from "../client/client.js";

// One client, opened once, for the whole life of the host.
const connection = await connect();
const { client } = connection;
```

- **This file imports the client, and nothing else.** No MCP SDK, no OpenAI, no task service. The
  host's job is HTTP in, HTTP out; everything protocol-shaped is behind Chapter 08's functions.
- `hostPort` is the only config it needs. Note it does **not** import `mcpServerUrl` — the client
  module already handled that.
- **Top-level `await`** — `const connection = await connect();` at module scope. This is why
  `package.json` requires Node ≥ 20 and why `"type": "module"` matters. The module does not finish
  loading until the MCP handshake completes.
- **That is a real design decision, not a convenience.** It means the HTTP server is never
  listening before the MCP connection is ready. No request can arrive at a host that cannot reach
  its server. The alternative — connect lazily on first request — would need a readiness check on
  every route.
- `const { client } = connection;` unpacks the client once so the route table can close over a
  short name. `connection` is still needed for `disconnect()` at shutdown.

### Block 2 — the route table

```ts
const routes: Record<string, (url: URL) => Promise<string>> = {
  "/resources": async () => { … },
  "/read": async (url) => readResource(client, url.searchParams.get("uri") ?? "task://guidelines"),
  "/prompts": async () => …,
  "/prompt": async (url) => …,
  "/ask": async (url) => { … },
  "/plan": async (url) => planDay(client, url.searchParams.get("hours") ?? "4"),
};
```

- **The type is the design.** `Record<string, (url: URL) => Promise<string>>` says: a map from
  pathname to a function that takes a parsed URL and returns text. Every route has the same shape,
  which is why the dispatcher below can be five lines.
- **Why a table instead of `if (pathname === "/plan") …`?** Three reasons:
  1. The 404 handler can list the routes automatically — `Object.keys(routes)`.
  2. Adding a route is one entry, not one more branch in a growing chain.
  3. The whole API surface is visible in one screen.
- `url.searchParams.get("uri") ?? "task://guidelines"` — `get` returns `string | null`, and `??`
  supplies a sensible default. Every route uses this pattern, so **no route can crash on a missing
  query parameter**.
- Note the deliberate **symmetry** of the six routes — each one maps to exactly one lecture
  capability:

  | Route | Chapter | What it exercises |
  |---|---|---|
  | `/resources` | 03 | `resources/list` + `resources/templates/list` (discovery) |
  | `/read` | 03 | `resources/read` (consumption) |
  | `/prompts` | 06 | `prompts/list` (the menu) |
  | `/prompt` | 07 | `prompts/get` (**no model**) |
  | `/ask` | 05 | resource selection + the model |
  | `/plan` | 08 | the whole flow: prompt → model → tools |

- **`/prompt` versus `/plan` is the teaching pair.** They differ by exactly one thing: `/prompt`
  stops after `prompts/get`, `/plan` continues into `askModel`. Put them side by side and Chapter
  07 §7.3 stops being abstract:

  ```bash
  curl 'http://127.0.0.1:8080/prompt?name=plan_day&hours=4'   # the QUESTION
  curl 'http://127.0.0.1:8080/plan?hours=4'                   # the ANSWER
  ```

### Block 3 — the two flow routes in detail

```ts
  /* Chapter 05 — the application selects context, then the model answers. */
  "/ask": async (url) => {
    const message = url.searchParams.get("message");

    if (!message) {
      throw new Error("Query parameter 'message' is required.");
    }

    return ask(client, message);
  },

  /* Chapter 08 — the lecture's end-to-end request: Prompt → (Resources + Tools) → answer. */
  "/plan": async (url) => planDay(client, url.searchParams.get("hours") ?? "4"),
```

- `/ask` is the only route that **validates**. `message` has no sensible default — a request
  without it is a mistake, so it throws.
- **Throwing here is the right call, because of the dispatcher's `.catch`.** The error becomes a
  `500` with the message as the body. In a bigger app you would return `400`; for a teaching host,
  the important thing is that the failure is *visible and named*.
- `/plan` is a **one-liner**, and that is the payoff of the whole architecture. The lecture's
  flagship request — `GET /plan?hours=4` — needs no logic in the host at all, because the flow
  lives in `planDay()` (Chapter 08), the template lives on the server (Chapter 06), and the
  context lives in Resources (Chapter 04).
- `url.searchParams.get("hours") ?? "4"` — this is where the URL becomes the Prompt argument.
  The path is: query string → `getPromptText(…, { availableHours })` → `z.string()` schema →
  template interpolation. **Four layers, one value.**
- **Neither route mentions `resources/read`, `prompts/get` or `tools/call`.** The host speaks HTTP
  and calls client functions. The protocol stays behind the boundary — which is exactly why you
  could replace the MCP server without touching this file.

### Block 4 — the dispatcher

```ts
const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);
  const handler = routes[url.pathname];

  if (!handler) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Not found. Try one of:\n${Object.keys(routes).join("\n")}`);
    return;
  }

  handler(url)
    .then((body) => {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(body);
    })
    .catch((error: Error) => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.message);
    });
});
```

- `new URL(request.url ?? "/", \`http://127.0.0.1:${hostPort}\`)` — Node gives you only the
  **path** (`/plan?hours=4`), which is not a valid URL on its own. The second argument supplies
  the base, so `searchParams` works. This is the standard idiom, and forgetting it is the most
  common mistake with `node:http`.
- `routes[url.pathname]` — a **single object lookup** replaces the whole routing chain. `pathname`
  excludes the query string, so `/plan?hours=4` and `/plan` hit the same entry.
- **The 404 is self-documenting.** `Object.keys(routes).join("\n")` lists every endpoint, so a
  wrong URL tells you the right ones. Same philosophy as Chapter 03's recovery-instruction error
  message.
- `handler(url)` returns a Promise, so the result is handled with `.then` / `.catch` rather than
  `await`. Node's `createServer` callback is not `async`; using `.then` keeps it honest.
- `(error: Error)` is an explicit annotation — with `strict` mode, `error` in a `.catch` is
  `unknown`, and annotating it lets `error.message` type-check.
- **`"text/plain; charset=utf-8"` on every response**, including errors. The `charset` matters
  because the output contains em dashes and box-drawing characters from the Resource text.
- The two status codes are the whole error model: `404` for an unknown path, `500` for anything a
  handler threw. For a teaching host, that is the right amount.

### Block 5 — listen and shutdown

```ts
httpServer.listen(hostPort, "127.0.0.1", () => {
  console.error(`Task host is running at http://127.0.0.1:${hostPort}`);
  console.error(`Try: http://127.0.0.1:${hostPort}/plan?hours=4`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void disconnect(connection);
    httpServer.close();
  });
}
```

- Same `127.0.0.1` binding and the same `console.error` reasoning as `src/index.ts`.
- The banner **prints the example request**. For a teaching host that is worth two lines: the
  first thing you see is the thing you came to try.
- `void disconnect(connection)` — closing the client is async and the signal handler is not, so
  the `void` idiom again. Note it calls `disconnect`, not just `httpServer.close()`: **the MCP
  session has to be released too**, or the server keeps it until its own timeout.
- `as const` on the signal array, for the third time in this project. It is the recurring cost of
  a strictly-typed API.

---

## 9.7 The end-to-end trace: `GET /plan?hours=4`

This is the lecture's own request, traced through every file you have read.

```text
curl 'http://127.0.0.1:8080/plan?hours=4'
   │
   ▼
src/routes/index.ts        /plan  →  planDay(client, "4")
   │
   ▼
src/client/client.ts       getPromptText(client, "plan_day", { availableHours: "4" })
   │                          │
   │                          ▼
   │                       prompts/get  ──Streamable HTTP──▶  src/index.ts
   │                                                              │
   │                                                              ▼
   │                                                       src/server/server.ts
   │                                                              │
   │                                                              ▼
   │                                                       src/prompts/prompts.ts
   │                                                       renders:
   │                                                         "Help me plan my pending
   │                                                          tasks for today. …
   │                                                          I have 4 hours available today. …"
   │                          ◀─────────  messages[0].content.text  ─────────┘
   ▼
src/client/client.ts       askModel(prompt)
   │                          │
   │                          ▼
   │                       the LLM  (or the offline echo)
   │                          │
   │                          │   the model may now call:
   │                          │     tools/call  list_tasks   ─▶ src/tools/tools.ts
   │                          │     resources/read task://guidelines  ─▶ src/resources/resources.ts
   │                          ▼
   └──────────────────────  final answer  ──────────────────────────▶  HTTP 200
```

Read the three primitives off the trace:

| Step | Primitive | Who held the trigger |
|---|---|---|
| `/plan` arrives with `hours=4` | **Prompt** — `plan_day` | the **USER** (they chose the workflow) |
| the model needs the rules | **Resource** — `task://guidelines` | the **APPLICATION** (or the model, guided by the prompt) |
| the model needs the task list | **Tool** — `list_tasks` | the **MODEL** |

**Three primitives, three owners, one request.** That sentence is the entire lecture, and this
diagram is it running.

### The verified response (offline)

```text
$ curl 'http://127.0.0.1:8080/plan?hours=4'
(offline — no OPENAI_API_KEY, so no model was called)
USER:
Help me plan my pending tasks for today.

First read my current pending tasks, then apply the task guidelines.

I have 4 hours available today.

Give me a concise and ordered plan.
```

Note there is **no `SYSTEM:` block** — `planDay` passes no `instructions`, because the Prompt is
already the user's message.

### The Resource flow, for comparison

```text
$ curl -s --get --data-urlencode 'message=how busy am I today?' 'http://127.0.0.1:8080/ask'
(offline — no OPENAI_API_KEY, so no model was called)
SYSTEM:
You are a task management assistant.

Use the context below whenever it is relevant to the question.

--- task://guidelines (chosen by application state) ---
Task Management Guidelines:
…

--- task://summary (chosen by retrieval) ---
Open tasks: 3
High priority: 1
Normal priority: 2
Projects involved: fde, media
USER:
how busy am I today?
```

Here there **is** a `SYSTEM:` block, and each Resource is labelled with the strategy that chose it
— Chapter 05's `strategy` field, visible on the wire.

---

## 9.8 Run / verify

```bash
cd "Lecture 15/code/Basic Code"
npm install
```

**Terminal 1 — the MCP server:**

```bash
npm run server
# [task-mcp-server] v1.0.0 MCP endpoint on http://127.0.0.1:8081/mcp
```

**Terminal 2 — the host:**

```bash
npm run host
# Task host is running at http://127.0.0.1:8080
# Try: http://127.0.0.1:8080/plan?hours=4
```

**Terminal 3 — all six routes:**

```bash
curl 'http://127.0.0.1:8080/resources'
curl 'http://127.0.0.1:8080/prompts'
curl 'http://127.0.0.1:8080/read?uri=task://summary'
curl 'http://127.0.0.1:8080/prompt?name=plan_day&hours=8'
curl 'http://127.0.0.1:8080/plan?hours=4'
curl 'http://127.0.0.1:8080/ask?message=what%20is%20on%20my%20plate'
```

Verified output for four of them:

```text
$ curl 'http://127.0.0.1:8080/resources'
task://guidelines
    Company rules for prioritising and scheduling tasks. Read this before planning anyone's day.
task://backlog
    Every task that is not done yet, with its priority, project and owner. Use this when the user asks what is on their plate.
task://summary
    Counts of open tasks by priority, plus the projects they belong to. Use this to answer questions like 'how busy am I?'.
task://projects/{projectId}   (template)
user://{userId}/profile   (template)

$ curl 'http://127.0.0.1:8080/prompts'
plan_day   Build an ordered plan for the tasks already on the backlog, using the hours the user has available.
review_workload   Look at the current backlog and say whether it is realistic, and what to drop first.

$ curl 'http://127.0.0.1:8080/read?uri=task://summary'
Open tasks: 3
High priority: 1
Normal priority: 2
Projects involved: fde, media

$ curl 'http://127.0.0.1:8080/plan?hours=4'
(offline — no OPENAI_API_KEY, so no model was called)
USER:
Help me plan my pending tasks for today.

First read my current pending tasks, then apply the task guidelines.

I have 4 hours available today.

Give me a concise and ordered plan.
```

And the 404 route listing itself:

```text
$ curl 'http://127.0.0.1:8080/nope'
Not found. Try one of:
/resources
/read
/prompts
/prompt
/ask
/plan
```

**To stop everything:** `Ctrl+C` in each terminal. Then confirm nothing is left holding the ports:

```bash
ss -ltn | grep -E '8080|8081' || echo "ports free"
```

---

## 9.9 Checkpoint

1. **Why do `src/index.ts` and `src/routes/index.ts` never import each other?** → they are separate
   processes that communicate over the protocol, not through the module system. They could be on
   different machines.
2. **What are the two localhost validators for, if the server only binds `127.0.0.1`?** → they stop
   a web page in the user's own browser from reaching the server (DNS rebinding and foreign
   origins).
3. **Why does `src/routes/index.ts` use top-level `await connect()`?** → so the HTTP server never
   accepts a request before the MCP connection is ready.
4. **What is the difference between `/prompt` and `/plan`?** → `/prompt` stops after `prompts/get`
   (the question); `/plan` continues into `askModel` (the answer).
5. **Why does the 404 list the routes?** → so a wrong URL tells you the right ones — the same
   recovery-instruction principle as the tool error messages.
6. **What breaks if you remove the signal handlers?** → `Ctrl+C` leaves the server holding port
   8081, and the next `npm run server` fails with `EADDRINUSE`.

---

## 9.10 The whole project, in one table

You have now read every file. Here is the entire project compressed.

| File | Lines | The one idea |
|---|---|---|
| `package.json` | 40 | four scripts: `server`, `host`, `lifecycle`, `typecheck` |
| `tsconfig.json` | 19 | `NodeNext` + `strict` — why imports end in `.js` |
| `.env` / `.env.example` | 19 | ports, identity, and an **empty** API key so it runs offline |
| `src/config/config.ts` | 42 | identity, **URI schemes**, ports, `hasModelKey` |
| `src/services/taskService.ts` | 127 | one array, **writes for Tools, reads for Resources** |
| `src/resources/resources.ts` | 114 | **static / dynamic / templated** — five Resources |
| `src/services/resourceSelector.ts` | 79 | **the application decides** — four strategies, with reasons |
| `src/prompts/prompts.ts` | 71 | **Prompt ≠ LLM response** — two templates, one with an argument |
| `src/tools/tools.ts` | 57 | the **model's** primitive; `list_tasks` duplicates `task://backlog` on purpose |
| `src/server/server.ts` | 24 | **three primitives, three owners, one function** |
| `src/client/client.ts` | 233 | one function per MCP verb; `askModel` is the only model call |
| `src/index.ts` | 46 | the **transport binding** + the two security validators |
| `src/routes/index.ts` | 104 | the host; **`GET /plan?hours=4` is a one-liner** |

**Total: 975 lines** across 13 files, and it demonstrates the whole of Lecture 15: three
primitives, three owners, resource selection, prompt arguments, and the end-to-end flow.

### If you remember only five things

1. **Three primitives, three owners** — the model calls Tools, the application reads Resources, the
   user selects Prompts.
2. **Tools and Resources are not distinguished by payload** — `list_tasks` and `task://backlog`
   return the same text; only the owner differs.
3. **A Resource is addressable context** — a URI that identifies it, never a promise that anyone
   else can fetch it.
4. **`template instead of enumerate`** — one `ResourceTemplate` serves a whole family of URIs.
5. **`prompts/get` is not an LLM call** — it returns the question; `askModel` produces the answer,
   and in this project they are different files.

**Back to:** [Implementation Guide index](./README.md) · [Lecture 15 notes](../../../notes/README.md) · [Basic Code README](../README.md)






