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
| **Imports** | `@modelcontextprotocol/express`, `@modelcontextprotocol/node`, `@modelcontextprotocol/server`, `server/server`, `config` | `express`, `config`, `client/client` |
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
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
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
 * Express is the binding, and `createMcpExpressApp` is why that costs four lines
 * instead of forty. Chapter 08's security point is still enforced — DNS-rebinding
 * (`Host`) and foreign-origin (`Origin`) validation both apply — but it is now
 * enforced *by the adapter*, because the app is bound to a localhost address and
 * the adapter turns those checks on automatically. That is not a downgrade: a
 * server bound to localhost is still reachable from any web page in the user's
 * browser, so the protection has to be impossible to forget. Hand-wiring
 * `localhostHostValidation()` and `localhostOriginValidation()` is still
 * available when you want to see them; the default is to have them.
 */
const handler = createMcpHandler(createMcpServer);
const nodeHandler = toNodeHandler(handler);

const app = createMcpExpressApp({ host: "127.0.0.1" });

/**
 * Express advertises itself with `X-Powered-By: Express` unless told not to. The
 * previous hand-wired Node binding sent no such header, and a server that
 * answers strangers should not volunteer its stack — so it goes off, exactly as
 * it does in the host (`src/routes/index.ts`) and in Lecture 06's `app.ts`.
 */
app.disable("x-powered-by");

/**
 * `request.body` is passed explicitly, and it is not optional.
 *
 * `createMcpExpressApp` installs `express.json()`, which consumes the request
 * stream to populate `request.body`. `toNodeHandler` would otherwise try to read
 * that same stream and find it already drained — so the third argument is how the
 * parsed body is handed across. (Express's `next` callback is ignored if it ever
 * arrives here; the adapter never mistakes a function for a body.)
 */
app.all("/mcp", (request, response) => {
  void nodeHandler(request, response, request.body);
});

const httpServer = app.listen(mcpPort, "127.0.0.1", () => {
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
 *
 * The host is plain Express: one route table, one 404 catch-all, one error
 * handler. Everything protocol-shaped stays behind `../client/client.js` —
 * this file speaks HTTP and nothing else.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";

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
 * `req.query` values are `string | string[] | ParsedQs`, and every route below
 * wants a single string — or nothing. This narrows the type in one place, so a
 * missing (or repeated) parameter becomes `undefined` and the `??` defaults
 * turn it into a sensible value. **No route can crash on a bad query string.**
 */
function query(request: Request, key: string): string | undefined {
  const value = request.query[key];

  return typeof value === "string" ? value : undefined;
}

/**
 * The route table. Each entry is one endpoint; the key is the pathname and the
 * value is a function that turns a request into text. `req.query` is Express's
 * parsed query string, which is how `hours` reaches the Prompt argument.
 */
const routes: Record<string, (request: Request) => Promise<string>> = {
  /* Chapter 03 — discovery of everything the server offers. */
  "/resources": async () => {
    const { resources, resourceTemplates } = await listResources(client);

    return [
      ...resources.map((resource) => `${resource.uri}\n    ${resource.description ?? ""}`),
      ...resourceTemplates.map((template) => `${template.uriTemplate}   (template)`),
    ].join("\n");
  },

  /* Chapter 03 — consumption: read one Resource by URI. */
  "/read": async (request) => readResource(client, query(request, "uri") ?? "task://guidelines"),

  /* Chapter 06 — what workflows does the server offer? */
  "/prompts": async () =>
    (await listPrompts(client))
      .map((prompt) => `${prompt.name}   ${prompt.description ?? ""}`)
      .join("\n"),

  /* Chapter 07 §7.3 — fetch the Prompt. No model is called by this route. */
  "/prompt": async (request) =>
    getPromptText(client, query(request, "name") ?? "plan_day", {
      availableHours: query(request, "hours") ?? "4",
    }),

  /* Chapter 05 — the application selects context, then the model answers. */
  "/ask": async (request) => {
    const message = query(request, "message");

    if (!message) {
      throw new Error("Query parameter 'message' is required.");
    }

    return ask(client, message);
  },

  /* Chapter 08 — the lecture's end-to-end request: Prompt → (Resources + Tools) → answer. */
  "/plan": async (request) => planDay(client, query(request, "hours") ?? "4"),
};

const app: Express = express();

// The raw Node host sent no `X-Powered-By` header; disabling it keeps the
// response surface identical after the swap to Express.
app.disable("x-powered-by");

/**
 * Register the table. Every handler returns text or throws: Express 5 forwards
 * a rejected promise straight to the error handler below, so no route needs a
 * `try`/`catch` of its own.
 */
for (const [path, handler] of Object.entries(routes)) {
  app.get(path, async (request, response) => {
    response.type("text/plain").send(await handler(request));
  });
}

/** The 404 lists the routes, so a wrong URL tells you the right ones. */
app.use((_request, response) => {
  response.status(404).type("text/plain").send(`Not found. Try one of:\n${Object.keys(routes).join("\n")}`);
});

/** The only other status this host has: 500, with the message as the body. */
app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  response.status(500).type("text/plain").send(error.message);
});

const httpServer = app.listen(hostPort, "127.0.0.1", () => {
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
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { mcpPort, serverInfo } from "./config/config.js";
import { createServer as createMcpServer } from "./server/server.js";
```

- `#!/usr/bin/env node` makes the file directly executable (`./src/index.ts`). It is optional with
  `tsx`, but it is honest documentation that this file *is* a program.
- `createMcpExpressApp` comes from **`@modelcontextprotocol/express`** — the SDK's Express adapter.
  It returns a configured Express app and, because it is told the bind is `127.0.0.1`, it installs
  the localhost `Host`/`Origin` checks for you. That is Chapter 08's security point, now enforced by
  the framework instead of by hand — see Block 3.
- **The alias is the interesting part.** `import { createServer as createMcpServer }` — there are
  two different "create server" concepts in this file, so one is renamed. `createMcpServer` says
  exactly which one it is: the *MCP* server factory from `server/server.ts`, not an HTTP server.
- `toNodeHandler` is the adapter from the SDK's **web-standard** handler to Node's
  `(request, response)` signature. The SDK speaks `Request`/`Response`; Express sits on Node's
  `http` module and speaks `IncomingMessage`/`ServerResponse`. That adapter is the bridge.
- Note what is **not** imported any more: `node:http`. `app.listen()` returns the underlying
  `http.Server` for you, so the raw module is not needed in this file at all.

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

### Block 3 — the Express app (the security point)

```ts
const app = createMcpExpressApp({ host: "127.0.0.1" });
app.disable("x-powered-by");
```

- **`createMcpExpressApp({ host })` does two jobs.** It builds the app *and* decides whether to
  install the localhost header checks — the `host` option is what it makes that decision from. Pass
  a localhost-class host (`127.0.0.1`, `localhost`, `::1`) and both checks are installed; pass
  anything else and they are not.
- **Why they matter, and why this is not paranoia.** Binding to `127.0.0.1` stops *other machines*
  reaching the server — but it does **not** stop a web page in the user's own browser. Any site the
  user visits can issue a `fetch("http://127.0.0.1:8081/mcp")`, and the browser will happily send
  it, because localhost is the user's own machine.
  - The **Host** check rejects requests whose `Host` header is not a localhost name. That defeats
    **DNS rebinding**, where an attacker's domain resolves to `127.0.0.1` to impersonate you.
  - The **Origin** check rejects requests whose `Origin` header is a foreign website. That is
    standard CORS-style protection, applied at the server. A request with *no* `Origin` header
    passes, which is why `curl` and a native MCP client still work.
- Without them, a page at `evil.example` could enumerate and read every Resource on this server —
  including `user://123/profile`. The hand-wired form is five words long
  (`localhostHostValidation()` / `localhostOriginValidation()`, both still exported from
  `@modelcontextprotocol/node`); the default form is zero words, and that is the improvement. You
  can no longer *forget* the protection — only *remove* it, deliberately.
- `app.disable("x-powered-by")` is a one-line correction. Express advertises itself in a response
  header by default, and a server that answers strangers should not volunteer its stack. The
  previous `node:http` binding sent no such header, so switching frameworks should not add one.

### Block 4 — the endpoint

```ts
app.all("/mcp", (request, response) => {
  void nodeHandler(request, response, request.body);
});
```

- **`app.all("/mcp", …)` is the whole routing story.** One path, every method — the protocol decides
  what a `POST` means, and a `GET`/`DELETE` on the same path are the Streamable HTTP session verbs.
  There is no route table here because there is nothing to route: the host decides *what* to call,
  and the server only answers the protocol. All five Resources and both Prompts are reached through
  this one URL.
- **`request.body` is the third argument, and dropping it is the one mistake this file can make.**
  `createMcpExpressApp` installs `express.json()`, which drains the request stream into
  `request.body` *before* this handler runs. `toNodeHandler` reads the body from either the third
  argument or the raw stream — so without it, the adapter reads a stream that is already empty and
  the request fails as a protocol error. This is the sharpest edge of putting Express in front of a
  Node adapter, and it is why the line carries a comment.
- `void nodeHandler(...)` — the SDK's handler is async, and `void` marks the deliberate
  fire-and-forget, the same idiom as Chapter 08's `void main()`. The handler writes to `response`
  itself when it is done, so there is nothing to await here.
- Note what is *absent*: no `try`/`catch`. A rejection inside the handler is the SDK's business —
  it answers with a JSON-RPC error rather than throwing at this layer.

### Block 5 — listen, and why stderr

```ts
const httpServer = app.listen(mcpPort, "127.0.0.1", () => {
  // Diagnostics go to stderr so they never mix with anything a host reads.
  console.error(
    `[${serverInfo.name}] v${serverInfo.version} MCP endpoint on http://127.0.0.1:${mcpPort}/mcp`,
  );
});
```

- `app.listen(mcpPort, "127.0.0.1", …)` — the address is **explicit**. Omitting it would bind
  `0.0.0.0` and expose the server to the whole network. On a development machine that is a mistake
  with real consequences. It is stated twice in this file — once to `createMcpExpressApp` (which
  needs it to decide whether to install the header checks) and once here (which needs it to decide
  what to bind) — and the two must agree.
- **`app.listen()` returns the underlying `http.Server`**, which is why the result is still stored
  in `httpServer`: Block 6 closes it. Express builds a pipeline in front of the server; it does not
  hide it.
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

### Block 1 — the imports, the single connection, and the query helper

```ts
import express, { type Express, type NextFunction, type Request, type Response } from "express";

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
 * `req.query` values are `string | string[] | ParsedQs`, and every route below
 * wants a single string — or nothing. This narrows the type in one place, so a
 * missing (or repeated) parameter becomes `undefined` and the `??` defaults
 * turn it into a sensible value. **No route can crash on a bad query string.**
 */
function query(request: Request, key: string): string | undefined {
  const value = request.query[key];

  return typeof value === "string" ? value : undefined;
}
```

- **This file imports the client and Express, and nothing else.** No MCP SDK, no OpenAI, no task
  service. The host's job is HTTP in, HTTP out; everything protocol-shaped is behind Chapter 08's
  functions.
- `express` supplies the router, the parsed query string and the error pipeline. The four named
  imports are **types only** (`import { type … }`), so they are erased at runtime — they document
  the shapes the handlers work with without adding anything to the process.
- **The `query()` helper exists because `req.query` is not a string map.** Express parses the query
  string into `string | string[] | ParsedQs` per key — a repeated parameter becomes an array, a
  bracketed one becomes an object. Every route here wants *one string or nothing*, so the narrowing
  happens once, in a named function, instead of six times inside the table. Returning `undefined`
  for anything unexpected is what makes the `??` defaults in Block 2 safe.
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
const routes: Record<string, (request: Request) => Promise<string>> = {
  "/resources": async () => { … },
  "/read": async (request) => readResource(client, query(request, "uri") ?? "task://guidelines"),
  "/prompts": async () => …,
  "/prompt": async (request) => …,
  "/ask": async (request) => { … },
  "/plan": async (request) => planDay(client, query(request, "hours") ?? "4"),
};
```

- **The type is the design.** `Record<string, (request: Request) => Promise<string>>` says: a map
  from pathname to a function that takes an Express request and returns text. Every route has the
  same shape, which is why the registration loop in Block 4 can be that short.
- **Why a table instead of six `app.get(…)` calls?** Three reasons:
  1. The 404 handler can list the routes automatically — `Object.keys(routes)`.
  2. Adding a route is one entry, not one more branch in a growing chain.
  3. The whole API surface is visible in one screen.
- `query(request, "uri") ?? "task://guidelines"` — the helper returns `string | undefined`, and `??`
  supplies a sensible default. Every route uses this pattern, so **no route can crash on a missing
  query parameter**.
- Two Express 5 details worth knowing, both relevant here: the default query parser changed from
  *extended* to *simple*, and `req.query` is now a **getter** — you read it, you never assign to it.
  `query()` reads one key and does not mutate anything, so neither change touches this file.
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
  "/ask": async (request) => {
    const message = query(request, "message");

    if (!message) {
      throw new Error("Query parameter 'message' is required.");
    }

    return ask(client, message);
  },

  /* Chapter 08 — the lecture's end-to-end request: Prompt → (Resources + Tools) → answer. */
  "/plan": async (request) => planDay(client, query(request, "hours") ?? "4"),
```

- `/ask` is the only route that **validates**. `message` has no sensible default — a request
  without it is a mistake, so it throws.
- **Throwing here is the right call, because of Express's error pipeline.** Express 5 calls
  `next(value)` automatically when a handler's returned promise rejects, so the thrown `Error`
  travels to the error handler at the bottom of the file and becomes a `500` with the message as
  the body. In a bigger app you would return `400`; for a teaching host, the important thing is that
  the failure is *visible and named* — and that no route needed a `try`/`catch` to make it so.
- `/plan` is a **one-liner**, and that is the payoff of the whole architecture. The lecture's
  flagship request — `GET /plan?hours=4` — needs no logic in the host at all, because the flow
  lives in `planDay()` (Chapter 08), the template lives on the server (Chapter 06), and the
  context lives in Resources (Chapter 04).
- `query(request, "hours") ?? "4"` — this is where the query string becomes the Prompt argument.
  The path is: query string → `getPromptText(…, { availableHours })` → `z.string()` schema →
  template interpolation. **Four layers, one value.**
- **Neither route mentions `resources/read`, `prompts/get` or `tools/call`.** The host speaks HTTP
  and calls client functions. The protocol stays behind the boundary — which is exactly why you
  could replace the MCP server without touching this file.

### Block 4 — registering the table, the 404, and the error handler

```ts
const app: Express = express();

// The raw Node host sent no `X-Powered-By` header; disabling it keeps the
// response surface identical after the swap to Express.
app.disable("x-powered-by");

/**
 * Register the table. Every handler returns text or throws: Express 5 forwards
 * a rejected promise straight to the error handler below, so no route needs a
 * `try`/`catch` of its own.
 */
for (const [path, handler] of Object.entries(routes)) {
  app.get(path, async (request, response) => {
    response.type("text/plain").send(await handler(request));
  });
}

/** The 404 lists the routes, so a wrong URL tells you the right ones. */
app.use((_request, response) => {
  response.status(404).type("text/plain").send(`Not found. Try one of:\n${Object.keys(routes).join("\n")}`);
});

/** The only other status this host has: 500, with the message as the body. */
app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  response.status(500).type("text/plain").send(error.message);
});
```

- **`express()` builds the application**, and `const app: Express = …` annotates it so the file reads
  like the other lectures' `app.ts` files.
- `app.disable("x-powered-by")` — Express advertises itself with an `X-Powered-By: Express`
  response header by default. The previous `node:http` host did not, and changing the framework
  should not change the bytes on the wire, so the header is turned off. (Lecture 06's `app.ts` does
  the same, for a security reason rather than a fidelity one.) Check it with
  `curl -i` — the header should be absent.
- **`for (const [path, handler] of Object.entries(routes))` registers all six routes**, one line of
  body each. This is the payoff of Block 2's uniform type: because every entry is
  `(request) => Promise<string>`, the loop does not care which route it is registering.
- `response.type("text/plain").send(…)` replaces `writeHead` + `end`. Express appends
  `charset=utf-8` to a `text/*` type for you, which matters because the output contains em dashes
  and box-drawing characters from the Resource text — the old `"text/plain; charset=utf-8"` header
  is reproduced exactly. Confirm with `curl -i`; the `Content-Type` line is identical.
- `await handler(request)` is the only part that varies per route. A route that returns text is
  sent; a route that throws rejects the handler's promise, and **Express 5 calls `next(err)` for
  you** — that is the documented behaviour for handlers that return a promise. Which is why there
  is no `try`/`catch` anywhere in this file.
- **The 404 is self-documenting.** `Object.keys(routes).join("\n")` lists every endpoint, so a
  wrong URL tells you the right ones — same philosophy as Chapter 03's recovery-instruction error
  message. A two-argument `app.use(…)` is an ordinary middleware, so it only runs when no route
  matched; that is the entire 404 mechanism.
- **The error handler is the four-argument overload.** Express identifies an error handler by
  arity, so `(error, _request, response, _next)` is not a style choice — drop the last parameter
  and Express treats the function as ordinary middleware. The unused parameters are prefixed `_`,
  the same convention Chapter 08 uses for deliberately-unused values.
- **`(error: Error)` is an explicit annotation.** Express types an error handler's first argument
  as `any`; naming it `Error` is what lets `error.message` type-check under `strict`.
- The two status codes are the whole error model: `404` for an unknown path, `500` for anything a
  handler threw. For a teaching host, that is the right amount.

### Block 5 — listen and shutdown

```ts
const httpServer = app.listen(hostPort, "127.0.0.1", () => {
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

- `app.listen(hostPort, "127.0.0.1", …)` **returns the underlying `http.Server`**, which is why the
  result is still stored in `httpServer`: the shutdown loop below needs a handle to close. Express
  builds a request pipeline in front of the server; it does not hide it.
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
| `package.json` | 42 | four scripts: `server`, `host`, `lifecycle`, `typecheck` |
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
| `src/index.ts` | 64 | the **transport binding**: the Express app, the `/mcp` endpoint + the security defaults |
| `src/routes/index.ts` | 126 | the Express host; **`GET /plan?hours=4` is a one-liner** |

**Total: 997 lines** across 13 files, and it demonstrates the whole of Lecture 15: three
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






