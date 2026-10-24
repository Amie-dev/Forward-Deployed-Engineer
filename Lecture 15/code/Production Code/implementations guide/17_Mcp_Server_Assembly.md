# Chapter 17 — MCP: Server Assembly

> **The composition root.** One server process exposing the three primitives, with no knowledge of which host, which
> model or which transport is on the other side. And one line in this file — where the state is built — is the
> difference between a working server and one whose `create_task` silently does nothing.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/mcp/server.ts` (162 lines) |
| **Layer** | `mcp` — the only file that knows how every layer fits together |
| **Purpose** | Declare the capabilities and instructions, build the stateful half **once per process**, and hand the three registrars one shared `ServerDeps`. |
| **Exports** | `createServer()` |
| **Lecture sections** | Ch01 §1.6 (assembly, capabilities as permissions), Ch08 §8.1 |
| **Runs** | `npm run lifecycle` step 1 · `npm run server` |

---

## Commands

```bash
# the capability list the client negotiates against
npm run lifecycle 2>/dev/null | head -4

# the state is announced once, when the module loads
npm run server 2>&1 | head -2
```

---

## The central fact: the factory runs once per request

This is the most consequential thing in the file, and it is a property of the **transport**, not of this code.

`src/index.ts` builds its handler with `createMcpHandler(createServer)`. In the SDK's default stateless serving mode,
that factory is called **once per HTTP request** — so anything constructed *inside* `createServer()` is thrown away
after every single request. The consequences, if the state lived there:

| State built inside the factory | What breaks |
| :--- | :--- |
| The task store | `create_task` appears to succeed and then **vanishes** on the next call |
| The resource cache | It caches nothing — every read is a miss |
| The rate limiter | It limits one request at a time, which is to say **not at all** |

The task-store case is the one that hides best, because a fresh store is *seeded* (Chapter 07) — so `list_tasks`
returns four plausible tasks and everything looks healthy. The only way to see it is to create a task and then read
it back in a second request:

```text
A create_task -> Task #5 created: PERSISTENCE PROBE (normal priority, project inbox).
A sees probe  -> false          ← the task the same client just created is gone
B sees probe  -> false
B first line  -> Open tasks: 3  ← the seed, unchanged
server.ready count -> 7         ← the factory ran once per request
```

The fix is one idea: **the factory owns the protocol object; the module owns the state.** After it:

```text
A create_task -> Task #5 created: PERSISTENCE PROBE (normal priority, project inbox).
A sees probe  -> true
B sees probe  -> true
B first line  -> Open tasks: 4
server.ready count -> 1
```

That output is reproduced in "Run / verify" below, and it is worth running yourself: the `server.ready` count going
from 7 to 1 is the cheapest possible proof that the factory's scope changed.

---

## `src/mcp/server.ts` — the full file

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { env } from "../config/env.js";
import { RateLimiter } from "../core/guards.js";
import { createLogger } from "../core/logger.js";
import { createMetrics } from "../core/metrics.js";
import { createResourceCatalogue } from "../domain/resourceCatalogue.js";
import { createTaskStore } from "../domain/taskStore.js";
import { createPromptService } from "../services/promptService.js";
import { createResourceService } from "../services/resourceService.js";
import { createTaskService } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

/**
 * Notes Ch01 §1.6 and Ch08 §8.1 — assemble the capability provider.
 *
 * This is the "standard door": one server process exposing the three primitives,
 * with no knowledge of which host, which model or which transport is on the other
 * side. `createServer` is a **factory**, so the same code serves a Streamable HTTP
 * endpoint today and an in-process test tomorrow.
 */

/**
 * Notes Ch01 §1.6 — the server may hand the client guidance at `initialize`.
 *
 * This is not a system prompt and it is not a substitute for good tool
 * descriptions; it is the one place a server can state a *policy* about itself
 * that would be repetitive in six separate descriptions.
 *
 * Note what it says about the Resources, because this is Lecture 15's whole
 * argument in one sentence: *"the model may read them only through the
 * application"* is not a limitation of the server, it is the primitive's
 * contract.
 */
const INSTRUCTIONS = [
  "Task server exposing three primitives: tools mutate the board, resources are read-only addressable context, and prompts are the recommended workflows.",
  "Every mutation is keyed by the numeric task id, so call list_tasks first to read exact ids — never guess one.",
  "list_tasks and task://backlog return the same body on purpose; which one is appropriate depends on who is deciding, not on what the data is.",
  "create_task adds one task; pass an idempotencyKey when a retry must not create a second task.",
  "complete_task is idempotent in intent, but completing an already-completed task is a conflict, not a retry.",
  "delete_task is destructive and irreversible, and requires explicit user consent.",
].join(" ");

/**
 * Notes Ch03 §3.1 — the **stateful** half of the server, built once per process.
 *
 * This placement is a correctness requirement, not an optimisation, and it is
 * worth being explicit about why.
 *
 * `createMcpHandler(createServer)` in `src/index.ts` serves 2025-era traffic in
 * its default **stateless** mode, which calls this factory **once per request**.
 * Anything constructed *inside* the factory is therefore thrown away after every
 * single request. If the task store lived in there, `create_task` would appear to
 * succeed and then vanish on the next call; the resource cache would cache
 * nothing; and the rate limiter would limit one request at a time — that is,
 * nothing at all.
 *
 * So the rule is: **the factory owns the protocol object, the module owns the
 * state.** Anything that has to outlive a request is built here, once, and closed
 * over by every per-request instance.
 */
const logger = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME });
const metrics = createMetrics();

// Domain → services, in dependency order. Each layer receives the one below it
// as an argument, which is what keeps every one of them testable without a
// transport.
const catalogue = createResourceCatalogue();
const tasks = createTaskService(createTaskStore({ maxTasks: env.MCP_MAX_TASKS }));
const resources = createResourceService({ tasks, catalogue, ttlMs: env.MCP_RESOURCE_CACHE_TTL_MS });
const prompts = createPromptService();

/** Shared, so the limit is per **process** rather than per request. */
const limiter = new RateLimiter(env.MCP_RATE_LIMIT_PER_MINUTE);

/**
 * The wiring contract, assembled once.
 *
 * `ServerDeps` is entirely `readonly`, so one instance can be handed to every
 * per-request server without any risk of two requests racing on it.
 */
const deps: ServerDeps = {
  logger,
  metrics,
  tasks,
  resources,
  prompts,
  catalogue,
  limiter,
  toolTimeoutMs: env.MCP_TOOL_TIMEOUT_MS,
  resourceTimeoutMs: env.MCP_RESOURCE_TIMEOUT_MS,
  // Notes Ch03 §3.5 — the allowlist is configuration, so the set of schemes this
  // server will resolve is auditable without reading code.
  allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES),
};

/**
 * The per-request factory: build the protocol object and register the three
 * primitives against the shared state above.
 *
 * It is deliberately cheap — no I/O, and no allocation beyond the server itself —
 * because it runs once per request. It stays a factory rather than becoming a
 * singleton so the same code serves a Streamable HTTP endpoint today and an
 * in-process test tomorrow, which is the whole point of Chapter 01's split.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: env.MCP_SERVER_NAME, version: env.MCP_SERVER_VERSION },
    {
      /**
       * Notes Ch01 §1.6 — capabilities are **permissions, not niceties**.
       * Declaring one is a promise that this server answers that capability's
       * requests, and it is the contract a host checks before it calls anything.
       *
       * `resources.subscribe` is deliberately **absent**. Declaring it would
       * make a client willing to call `resources/subscribe`, and this server has
       * no handler for it: the high-level `McpServer` does not register one. A
       * capability flag that promises something the server cannot do is worse
       * than a missing feature, because the host has no way to find out except
       * by failing.
       *
       * The `listChanged` flags are honest: the catalogues *can* move, and the
       * SDK will emit the notification when a registration changes.
       */
      capabilities: {
        logging: {},
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );

  registerTools(server, deps); // do    — driven by the model
  registerResources(server, deps); // know  — driven by the application
  registerPrompts(server, deps); // reuse — driven by the user

  return server;
}

/**
 * Announced once, when this module loads — that is, when the **state** becomes
 * ready, rather than once per request.
 *
 * The per-request factory above must stay quiet: a busy server would otherwise
 * write this line thousands of times and drown the log it is supposed to open.
 */
logger.info("server.ready", {
  version: env.MCP_SERVER_VERSION,
  resources: catalogue.descriptors().length,
  templates: catalogue.templates().length,
  prompts: prompts.list().length,
  allowedSchemes: [...deps.allowedSchemes],
  toolTimeoutMs: deps.toolTimeoutMs,
  resourceTimeoutMs: deps.resourceTimeoutMs,
  maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
  maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
  resourceCacheTtlMs: env.MCP_RESOURCE_CACHE_TTL_MS,
});
```

### Block-by-block

**Block 1 — the header comment, and the "standard door" (lines 16–23).**

> This is the "standard door": one server process exposing the three primitives, with no knowledge of which host,
> which model or which transport is on the other side. `createServer` is a **factory**, so the same code serves a
> Streamable HTTP endpoint today and an in-process test tomorrow.

*No knowledge of which transport* is the property that makes the STDIO swap in the main README three lines long — and
it is why `src/index.ts` is the only transport-aware file on the server side.

**Block 2 — `INSTRUCTIONS` (lines 25–44).**

```ts
const INSTRUCTIONS = [
  "Task server exposing three primitives: tools mutate the board, resources are read-only addressable context, and prompts are the recommended workflows.",
  "Every mutation is keyed by the numeric task id, so call list_tasks first to read exact ids — never guess one.",
  "list_tasks and task://backlog return the same body on purpose; which one is appropriate depends on who is deciding, not on what the data is.",
  "create_task adds one task; pass an idempotencyKey when a retry must not create a second task.",
  "complete_task is idempotent in intent, but completing an already-completed task is a conflict, not a retry.",
  "delete_task is destructive and irreversible, and requires explicit user consent.",
].join(" ");
```

**The doc comment is careful about what this is *not*:**

> This is not a system prompt and it is not a substitute for good tool descriptions; it is the one place a server can
> state a *policy* about itself that would be repetitive in six separate descriptions.

That distinction matters. A system prompt is the *host's* artefact; instructions are the *server's* self-description,
delivered at `initialize` and typically appended to whatever the host already has. The comment is warning against the
temptation to move all the guidance here — which would be worse, because instructions are sent once at handshake while
tool descriptions travel with the tools themselves.

What belongs here is the cross-cutting policy that would be redundant per tool. Six sentences, and the last four are
the interesting ones:

| Sentence | Why it is server-level rather than per-tool |
| :--- | :--- |
| *"call list_tasks first … never guess one"* | Governs **four** tools — it is the id convention |
| *"list_tasks and task://backlog return the same body on purpose"* | Explains a **Tool and a Resource together** |
| *"pass an idempotencyKey when a retry must not create a second task"* | A cross-cutting retry policy |
| *"completing an already-completed task is a conflict, not a retry"* | A semantic the annotation cannot express |
| *"delete_task is destructive … requires explicit user consent"* | The consent contract |

The second sentence is Lecture 15's argument in one clause: *"which one is appropriate depends on who is deciding,
not on what the data is."* A model reading that has been told the actual distinction between the two primitives —
not the mechanics, the *intent*.

And the doc comment's own closing observation is the same point from the other direction:

> Note what it says about the Resources, because this is Lecture 15's whole argument in one sentence: *"the model may
> read them only through the application"* is not a limitation of the server, it is the primitive's contract.

**Block 3 — the stateful half, built once (lines 46–76).**

```ts
const logger = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME });
const metrics = createMetrics();

const catalogue = createResourceCatalogue();
const tasks = createTaskService(createTaskStore({ maxTasks: env.MCP_MAX_TASKS }));
const resources = createResourceService({ tasks, catalogue, ttlMs: env.MCP_RESOURCE_CACHE_TTL_MS });
const prompts = createPromptService();

/** Shared, so the limit is per **process** rather than per request. */
const limiter = new RateLimiter(env.MCP_RATE_LIMIT_PER_MINUTE);
```

**Seven module-scope constants, and the comment above them is the argument:**

> This placement is a correctness requirement, not an optimisation […] Anything that has to outlive a request is built
> here, once, and closed over by every per-request instance.

Read the list as an answer to "which of these is state?":

| Constant | Stateful? | Why it must be here |
| :--- | :--- | :--- |
| `logger` | No, but | A per-request logger would be a fresh object per request for no reason |
| `metrics` | **Yes** | Counters that reset per request count nothing |
| `catalogue` | No (immutable) | Built once because it is constant, and shared because it is read-only |
| `tasks` | **Yes** | The task board |
| `resources` | **Yes** | It holds the TTL cache |
| `prompts` | No (immutable) | Same as the catalogue |
| `limiter` | **Yes** | A window that resets per request is not a window |

The dependency order is also the composition order: `catalogue` → `tasks` → `resources` (which needs both) → `prompts`.
Each layer receives the one below it as an argument, which is the property that keeps every layer constructible in a
test.

Note that `resources` receives `tasks` and `catalogue` at construction, so the renderers close over the shared services.
That is what makes the boot-time invariant (Chapter 10) run exactly once, at module load.

**Block 4 — `deps`, assembled once (lines 78–97).**

```ts
const deps: ServerDeps = {
  logger,
  metrics,
  tasks,
  resources,
  prompts,
  catalogue,
  limiter,
  toolTimeoutMs: env.MCP_TOOL_TIMEOUT_MS,
  resourceTimeoutMs: env.MCP_RESOURCE_TIMEOUT_MS,
  allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES),
};
```

The doc comment states why sharing one object across per-request servers is safe:

> `ServerDeps` is entirely `readonly`, so one instance can be handed to every per-request server without any risk of
> two requests racing on it.

That is Chapter 13's `readonly` markers earning their keep. Without them, sharing `deps` would be a genuine hazard —
a registrar could reassign `deps.tasks` mid-flight and affect a concurrent request. With them, the compiler makes it
impossible, and the sharing becomes obviously correct.

Note `allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES)` — the `Set` is built **once**, here, rather than per
read. The config value is an array (Chapter 02); the runtime value is a `Set` because membership is the only
operation performed on it.

**Block 5 — the per-request factory (lines 99–142).**

```ts
export function createServer(): McpServer {
  const server = new McpServer(
    { name: env.MCP_SERVER_NAME, version: env.MCP_SERVER_VERSION },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );

  registerTools(server, deps);     // do    — driven by the model
  registerResources(server, deps); // know  — driven by the application
  registerPrompts(server, deps);   // reuse — driven by the user

  return server;
}
```

**`createServer` builds only the protocol object and registers the three primitives.** It allocates a `McpServer` and
nothing else — no store, no cache, no limiter — because it runs once per request and everything else is already built.

That is the fix from the top of this chapter, expressed as a scope decision: **the function that runs per request
contains no state.**

The three registrations carry their control model as a trailing comment, which is a small thing that makes the file
self-documenting at the point where the three primitives are wired:

```text
registerTools     — do    — driven by the model
registerResources — know  — driven by the application
registerPrompts   — reuse — driven by the user
```

And the comment above the function states why it remains a factory rather than becoming a singleton:

> It stays a factory rather than becoming a singleton so the same code serves a Streamable HTTP endpoint today and an
> in-process test tomorrow, which is the whole point of Chapter 01's split.

**The capabilities block, and the deliberate omission.** The doc comment above it is the longest in the file:

> Notes Ch01 §1.6 — capabilities are **permissions, not niceties**. Declaring one is a promise that this server answers
> that capability's requests, and it is the contract a host checks before it calls anything.
>
> `resources.subscribe` is deliberately **absent**. Declaring it would make a client willing to call
> `resources/subscribe`, and this server has no handler for it: the high-level `McpServer` does not register one. **A
> capability flag that promises something the server cannot do is worse than a missing feature, because the host has
> no way to find out except by failing.**

Four capabilities declared — `logging`, `tools`, `resources`, `prompts` — and `resources.subscribe` absent. The
reasoning is worth restating as a rule: **a capability flag is a promise, and a host that trusts a flag it cannot use
fails in a way it cannot diagnose.**

Note the distinction between the two kinds of flag in this block:

| Flag | Kind | Harm if wrong |
| :--- | :--- | :--- |
| `resources.subscribe: true` (omitted) | A capability the **host calls** | The host calls it and the server has no handler — an undiagnosable failure |
| `listChanged: true` | A notification the **server sends** | A host subscribes to a notification that never arrives — harmless silence |

So the omission is the safety-relevant one. The `listChanged` flags are honest in the weaker sense: the registration
layer does support mutating the set within a session, so a server built on this code *could* emit the notification —
this deployment's catalogue is fixed at boot, so no notification is ever emitted today. That is an inert flag rather
than a false promise, and the difference is that inertness cannot break a client.

**Block 6 — the boot announcement (lines 144–162).**

```ts
/**
 * Announced once, when this module loads — that is, when the **state** becomes
 * ready, rather than once per request.
 *
 * The per-request factory above must stay quiet: a busy server would otherwise
 * write this line thousands of times and drown the log it is supposed to open.
 */
logger.info("server.ready", {
  version: env.MCP_SERVER_VERSION,
  resources: catalogue.descriptors().length,
  templates: catalogue.templates().length,
  prompts: prompts.list().length,
  allowedSchemes: [...deps.allowedSchemes],
  toolTimeoutMs: deps.toolTimeoutMs,
  resourceTimeoutMs: deps.resourceTimeoutMs,
  maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
  maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
  resourceCacheTtlMs: env.MCP_RESOURCE_CACHE_TTL_MS,
});
```

**This log call is at module scope, not inside `createServer()`** — and that placement is the whole point of the
comment. It fires when the *state* is ready, which is once per process; if it were inside the factory it would fire
once per request, and a busy server would write the same line thousands of times.

It is also the reason the announcement appears **before** `server.listening` in the log stream. Module evaluation
happens at import time, which is before `httpServer.listen()` runs — so the capability provider is ready before the
socket is. That ordering is not a timing coincidence; it is the dependency order, visible in the log:

```json
{"event":"server.ready","resources":6,"templates":3,"prompts":3,"allowedSchemes":["task","user"],…}
{"event":"server.listening","transport":"streamable-http","url":"http://127.0.0.1:8081/mcp",…}
```

The payload is a **policy summary**: counts of what exists, the allow-listed schemes, the two timeouts, and the three
budget knobs. Everything an operator would otherwise have to read `.env` to learn — which is the point of announcing
it. Note `[...deps.allowedSchemes]` — the `Set` is spread back into an array because JSON has no set type, and the
`readonly` marker from Chapter 13 means the spread is the only way to read it out.

---

## Run / verify

### 1. The capability list, negotiated rather than guessed

```bash
npm run lifecycle 2>/dev/null | head -4
```

```text
1. handshake   -> capabilities are negotiated, not guessed
   server       task-mcp-server v1.0.0
   capabilities completions, logging, prompts, resources, tools
   model        offline — the pipeline runs without one, and that is a feature
```

Five capabilities: `completions`, `logging`, `prompts`, `resources`, `tools`. Sorted by the walkthrough, so the order
is alphabetical rather than declaration order — and `completions` is present because the resource templates register
`complete` hooks (Chapter 15).

**`subscribe` is absent**, and the check is that it stays absent: adding `resources: { subscribe: true, listChanged: true }`
to the capabilities block would make the server advertise a capability it has no handler for. The walkthrough's line
would read `…resources, subscribe, tools`, and the failure would only appear when a host acted on it.

And `model offline — the pipeline runs without one, and that is a feature` is the host reporting its own state: no
`OPENAI_API_KEY`, so the pipeline runs and echoes. The server has no opinion, because it has no model (Chapter 16).

### 2. The state is built once per process

The most important verification in this chapter, and it needs a two-session probe rather than the lifecycle — because
the lifecycle never calls a mutating tool.

```ts
// create a task in one session, then read the board in a second
const a = await session("A");
const created = await a.callTool({ name: "create_task", arguments: { title: "PERSISTENCE PROBE" } });
console.log("A create_task ->", text(created).split("\n")[0]);
console.log("A sees probe  ->", text(await a.callTool({ name: "list_tasks", arguments: {} })).includes("PERSISTENCE PROBE"));

const b = await session("B");
const bText = text(await b.callTool({ name: "list_tasks", arguments: {} }));
console.log("B sees probe  ->", bText.includes("PERSISTENCE PROBE"));
console.log("B first line  ->", bText.split("\n")[0]);
```

**With the state inside the factory** — the defect this chapter is about:

```text
A create_task -> Task #5 created: PERSISTENCE PROBE (normal priority, project inbox).
A sees probe  -> false
B sees probe  -> false
B first line  -> Open tasks: 3
server.ready count -> 7
```

**With the state at module scope** — the fix:

```text
A create_task -> Task #5 created: PERSISTENCE PROBE (normal priority, project inbox).
A sees probe  -> true
B sees probe  -> true
B first line  -> Open tasks: 4
server.ready count -> 1
```

Four things to read out of the pair:

**`A sees probe -> false` is the bug.** The same client created a task and then could not see it — because the second
call was a different request, and therefore a different `TaskStore`. Note that *nothing errored*: `create_task`
returned a success, the id was assigned, and the write was simply discarded with the server instance.

**`B first line -> Open tasks: 3` is why it hides.** Three is the *seed* (Chapter 07), so the board looks plausible.
A reader who did not count would see nothing wrong.

**`server.ready count -> 7` is the cheapest proof of the cause.** Seven requests, seven factory calls, seven `server.ready`
lines. After the fix it is `1` — one process, one state.

**`A sees probe -> true` and `B sees probe -> true` are the fix, across two sessions.** The state is process-scoped, so
both clients see the same board. Note that this is *not* session-sharing in the protocol sense — there are no
sessions here at all, because serving is stateless. It is simply one process with one store.

The lesson generalises beyond this codebase: **when a framework calls your factory per request, everything the factory
constructs is per request.** That is correct for the protocol object and wrong for anything with state — and the
failure is silent, because a per-request store is a *valid* store that just happens to be empty.

### 3. The idle log stream, and the ordering

```bash
npm run server 2>&1 | head -2
```

```json
{"ts":"…","level":"info","event":"server.ready","server":"task-mcp-server","version":"1.0.0","resources":6,"templates":3,"prompts":3,"allowedSchemes":["task","user"],"toolTimeoutMs":5000,"resourceTimeoutMs":2000,"maxResourcesPerRequest":3,"maxContextChars":40000,"resourceCacheTtlMs":30000}
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":937584,"transport":"streamable-http","url":"http://127.0.0.1:8081/mcp","version":"1.0.0"}
```

Two lines, and then silence until a client connects. `server.ready` first — module evaluation — then
`server.listening` — the socket. If you curl the server and see `server.ready` reappear, the state has moved back
inside the factory.

### 4. The same factory, without a transport

Because `createServer` builds only the protocol object, it can be called directly:

```ts
import { createServer } from "./src/mcp/server.js";

const server = createServer();   // no port, no transport, no child process
```

That is Chapter 01's split in practice, and it is why the factory was kept a factory. A test can build a server,
register the primitives against a fake `deps`, and exercise a tool with no I/O anywhere.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **How often does `createServer()` run, and why does that matter?**
   Once per HTTP request, in the SDK's default stateless serving mode. So anything constructed inside it is thrown
   away per request — which is correct for the `McpServer` object and wrong for the store, the cache and the limiter.

2. **What are the four symptoms of building state inside the factory?**
   `create_task` succeeds and vanishes; the resource cache never hits; the rate limiter never fires; and `server.ready`
   is logged once per request. The first three are silent, because a fresh store is seeded and therefore looks valid.

3. **Why is it safe to share one `deps` object across every per-request server?**
   Because `ServerDeps` is entirely `readonly`. Without that, a registrar could reassign `deps.tasks` mid-flight and
   affect a concurrent request; with it, the compiler makes the sharing obviously correct.

4. **What is the rule for what belongs at module scope?**
   *The factory owns the protocol object, the module owns the state.* Anything that has to outlive a request is built
   once, at module scope, and closed over.

5. **Why is `resources.subscribe` absent while `listChanged` is declared?**
   `subscribe` is a capability the **host calls** — declaring it would make a host call a handler that does not exist,
   which it cannot diagnose. `listChanged` is a notification the **server sends**, so its worst case is harmless
   silence. A capability flag is a promise; only the first kind can break a client.

6. **Why is `INSTRUCTIONS` not a system prompt?**
   Because a system prompt is the host's artefact. Instructions are the server's self-description at `initialize`,
   and they carry cross-cutting policy that would be repetitive in six separate tool descriptions.

7. **Why does `server.ready` appear before `server.listening`?**
   Because module evaluation (which builds the state) happens at import time, before `httpServer.listen()` runs. The
   ordering is the dependency order, visible in the log.

8. **Which capability flags does the walkthrough print, and what does their order tell you?**
   `completions, logging, prompts, resources, tools` — five, sorted alphabetically by the walkthrough rather than in
   declaration order. `subscribe` is absent.

---

**[← Chapter 16: The Prompts Primitive](./16_Mcp_Prompts.md)** · **[Chapter 18: The MCP Server over HTTP →](./18_Entry_Mcp_Server_Http.md)**
