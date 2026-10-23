# Chapter 13: MCP — Server Assembly

> **Chapter goal:** Assemble the whole capability provider in one place — the composition
> root — and declare the capabilities and instructions that a client learns at `initialize`.

---

## 13.1 File details

| | |
| :--- | :--- |
| **Path** | `src/mcp/server.ts` |
| **Layer** | mcp (imports the SDK, `config/env`, every `core/` module, `domain/`, `services/`, and the three registrars) |
| **Purpose** | `createServer()`: build the collaborators, construct the `McpServer` with capabilities and instructions, wire the three primitives, and log readiness |
| **Imports** | `McpServer`, `env`, `RateLimiter`, `createLogger`, `createMetrics`, `createTaskStore`, `createTaskService`, `ServerDeps`, `registerPrompts`, `registerResources`, `registerTools` |
| **Exports** | `createServer()` |
| **Consumed by** | `src/index.ts` (as the `serveStdio` factory), `src/host/client.ts` (spawns it as a child process) |
| **Lecture sections** | [02 — What MCP is](../../../notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md) (capabilities, no LLM), [04 — Host, Client, Server](../../../notes/04_Host_Client_Server_Architecture.md) (capabilities are permissions) |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the server alone — the factory is called, nothing else happens
npm run server

# what initialize returns
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  | npm run server --silent 2>/dev/null | python3 -m json.tool
```

---

## 13.2 Full file

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { env } from "../config/env.js";
import { RateLimiter } from "../core/guards.js";
import { createLogger } from "../core/logger.js";
import { createMetrics } from "../core/metrics.js";
import { createTaskStore } from "../domain/taskStore.js";
import { createTaskService } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

/**
 * Chapter 02 / Chapter 04 — assemble the capability provider.
 *
 * This is the "standard door": one server process exposing the three
 * primitives, with no knowledge of which host, which model or which transport
 * is on the other side. `createServer` is a **factory**, so the same code serves
 * a stdio child process today and a Streamable HTTP handler tomorrow.
 */

/**
 * Chapter 02 — the server may hand the client guidance at `initialize`.
 *
 * This is not a system prompt and it is not a substitute for good tool
 * descriptions; it is the one place a server can state a *policy* about itself
 * ("mutations are keyed by id", "this operation needs consent") that would be
 * repetitive in four separate descriptions.
 */
const INSTRUCTIONS = [
  "Task server. Every mutation is keyed by the numeric task id, so call list_tasks first to read exact ids and titles.",
  "create_task adds one task; pass an idempotencyKey when a retry must not create a second task.",
  "list_tasks is read-only and safe to call at any time.",
  "complete_task is idempotent, but completing an already-completed task is a conflict, not a retry.",
  "delete_task is destructive and irreversible, and requires explicit user consent.",
].join(" ");

export function createServer(): McpServer {
  // Composition root: the only place that knows how the layers fit together.
  const logger = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME });
  const metrics = createMetrics();
  const service = createTaskService(createTaskStore({ maxTasks: env.MCP_MAX_TASKS }));
  const limiter = new RateLimiter(env.MCP_RATE_LIMIT_PER_MINUTE);

  const server = new McpServer(
    { name: env.MCP_SERVER_NAME, version: env.MCP_SERVER_VERSION },
    {
      /**
       * Chapter 04 — capabilities are **permissions, not niceties**. Declaring
       * one is a promise that this server answers that capability's requests,
       * and it is the contract the host checks before it calls anything.
       *
       * `logging` lets the server emit `notifications/message`; the `listChanged`
       * flags let it tell a client that a catalogue moved.
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

  const deps: ServerDeps = {
    logger,
    metrics,
    service,
    limiter,
    timeoutMs: env.MCP_TOOL_TIMEOUT_MS,
  };

  registerTools(server, deps); // do    — driven by the model
  registerResources(server, deps); // know  — driven by the application
  registerPrompts(server); // reuse — driven by the user

  logger.info("server.ready", {
    version: env.MCP_SERVER_VERSION,
    transport: env.MCP_TRANSPORT,
    timeoutMs: deps.timeoutMs,
    rateLimitPerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
    maxTasks: env.MCP_MAX_TASKS,
  });

  return server;
}
```

## 13.3 Block-by-block explanation

### Block 1 — a factory, not a module-level instance

```ts
export function createServer(): McpServer {
```

**What it does:** builds and returns a fully-assembled server.
**How it works:** the function is a **factory** — it constructs, it does not run.

Two properties follow from that choice, and both matter:

**1 · The transport can be swapped without touching this file.** `serveStdio` (Chapter 14) takes
a factory and calls it once per connection. A Streamable HTTP binding (`createMcpHandler`) takes
the same factory. So the same `createServer` serves a stdio child process today and an HTTP
handler tomorrow — Chapter 01's dependency rule made mechanical: *the host depends on the
protocol, the server on its backend, and nothing depends on a vendor.*

**2 · State is per-server, not per-process.** Every call to `createServer()` gets a fresh
`Metrics`, a fresh `RateLimiter` and a fresh `TaskStore`. If this were a module-level
`export const server = new McpServer(...)`, two connections in the same process would share one
task board and one rate-limit bucket — and a stdio process serving one connection would never
reveal the bug. The factory makes "one server instance per connection" the default rather than an
accident.

The cost is that nothing is memoised. For this server that is correct: the state is meant to be
per-session.

### Block 2 — the composition root

```ts
const logger = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME });
const metrics = createMetrics();
const service = createTaskService(createTaskStore({ maxTasks: env.MCP_MAX_TASKS }));
const limiter = new RateLimiter(env.MCP_RATE_LIMIT_PER_MINUTE);
```

**What it does:** constructs every collaborator, once, in dependency order.
**How it works:** four lines, each reading outward-to-inward.

**This is the only file in the project that knows how the pieces are built.** Everywhere else
receives them. That is the whole point of `ServerDeps` (Chapter 09): the tool layer knows the
*shape* of a `TaskService`, and only this line knows it is a service wrapping a store wrapping a
`Map`.

**`createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME })`** — the second argument is a
*binding*, so `server: "task-mcp-server"` appears on every subsequent log line without any call
site repeating it. In a deployment with two servers piped into one collector, that field is what
makes the lines attributable.

**`createTaskService(createTaskStore({ maxTasks: env.MCP_MAX_TASKS }))`** — the nesting is
deliberate and visible. The store is created inline because nothing else needs a reference to it:
the service is its only consumer, and the composition root is where that relationship should be
legible. If the store ever needed to be shared (with a resource layer writing to it, say), it
would be hoisted to its own `const` — and the diff would show exactly that.

**`new RateLimiter(...)` is a `new`, the others are `create*` functions.** Not an inconsistency:
`RateLimiter` is a **class** because it holds mutable per-key state and its identity matters; the
others are **closures** because they hide state and expose behaviour. Both are legitimate, and
Chapters 06 and 07 explain the choices individually.

**Every value comes from `env`, and nowhere else.** There is no `process.env` access in this file
and no default literal. That is what makes `config/env.ts` (Chapter 02) the single source of
truth: a reader who wants to know what this server *can* be configured with reads one file, and a
reader who wants to know what it *is* configured with runs it once.

### Block 3 — `McpServer` construction: identity, capabilities, instructions

```ts
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
```

**What it does:** creates the server with its identity, its declared permissions, and its
self-description.
**How it works:** two arguments — `serverInfo` and options.

**`{ name, version }` is the entire identity.** No vendor id, no model id, no API key, no prompt.
This is Chapter 02's point stated in code: an MCP server is a capability provider and needs no
LLM. The `name` and `version` are also what a host uses to decide whether to trust the server at
all — which is why `config/env.ts` validates the version as semver rather than accepting `v1`.

**`capabilities` is a promise, not a wish list.** The comment is emphatic:

> Chapter 04 — capabilities are **permissions, not niceties**. Declaring one is a promise that
> this server answers that capability's requests, and it is the contract the host checks before
> it calls anything.

The SDK's own documentation states the rule from the other side: *"a server that declares a
capability MUST respond to that capability's requests (e.g. `tools/list` for `tools`) —
potentially with an empty result — rather than with a 'Method not found' error."* So declaring
`tools: {}` is a commitment to answer `tools/list` and `tools/call`, and declaring `logging: {}`
is a commitment to answer `logging/setLevel`.

`McpServer` honours that automatically for the capabilities declared here — which is why these
four entries are all it takes, and why Chapter 11's finding about `resources.subscribe` is
notable: it is the one capability the high-level API *advertises* but does not *answer*.

**The four entries, and why each is declared:**

| Capability | Why it is declared |
| :--- | :--- |
| `logging: {}` | The server may emit `notifications/message`. Declared so a client can call `logging/setLevel`; the demo does not currently emit, and the README says so. |
| `tools: { listChanged: true }` | Four tools exist, and the flag says the catalogue could change during a session. |
| `resources: { listChanged: true }` | Resources and a template exist; `sendResourceListChanged()` is the notification that pairs with it. |
| `prompts: { listChanged: true }` | Two prompts exist, same reasoning. |

The `{}` for `logging` is not an oversight — the capability has no options, so its presence is
the whole signal. That is a slightly awkward protocol shape (a boolean would be clearer), but it
is what the spec defines, and the empty object says "declared, with no sub-options".

**`listChanged: true` on three of the four is honest but currently unused.** Nothing in this
server calls `sendToolListChanged()`. Declaring the flag without using it is defensible — it
costs nothing and means the client is already prepared if a future change adds a runtime
notification — but the *flag* and the *behaviour* are separate, and only the flag is present.

**`instructions` is the one channel a server has to describe itself.** The comment is careful
about what it is and is not:

> This is not a system prompt and it is not a substitute for good tool descriptions; it is the
> one place a server can state a *policy* about itself ("mutations are keyed by id", "this
> operation needs consent") that would be repetitive in four separate descriptions.

That distinction matters. A tool description answers "when should I use *this* tool?".
`instructions` answers "what is true about *this server*?" — and the two things it says here are
exactly that:

1. **"Every mutation is keyed by the numeric task id, so call list_tasks first to read exact ids
   and titles."** A *convention* spanning all four tools. Repeating it in four descriptions would
   cost four times the tokens for the same information.
2. **"delete_task is destructive and irreversible, and requires explicit user consent."** A
   *policy*, and the one place the model is told that the host will intervene.

**The string is built with an array and `.join(" ")`**, the same technique as the prompt text in
Chapter 12 — each sentence is a separately readable line in the source, and the joined result is
one paragraph. A single long string literal would be harder to review and easier to break with a
stray newline.

**`instructions` is advisory.** The protocol does not require a host to show it to the model, and
a host that ignores it loses nothing structurally — which is why the *tool descriptions* still
carry their own disambiguation clauses. `instructions` is reinforcement, not the only line of
defence.

### Block 4 — the wiring, in three lines that name the control model

```ts
const deps: ServerDeps = {
  logger,
  metrics,
  service,
  limiter,
  timeoutMs: env.MCP_TOOL_TIMEOUT_MS,
};

registerTools(server, deps); // do    — driven by the model
registerResources(server, deps); // know  — driven by the application
registerPrompts(server); // reuse — driven by the user
```

**What it does:** hands the collaborators to the three registrars.
**How it works:** one object literal, then three calls whose trailing comments carry the
chapter's mental model.

**The `deps` literal is typed, not inferred.** `const deps: ServerDeps = {...}` means a missing
or misspelled field is a compile error here rather than an `undefined` three files away. That is
the interface from Chapter 09 earning its keep: the composition root cannot forget a collaborator.

**`timeoutMs: env.MCP_TOOL_TIMEOUT_MS` is the only field with an explicit key.** The other four
use shorthand (`logger,` not `logger: logger`) because the variable name already matches. The
timeout is different — the field is `timeoutMs` and the source is `MCP_TOOL_TIMEOUT_MS` — so the
mapping is written out. That asymmetry is informative: four collaborators are passed through
unchanged, and one is a *derived value* from configuration.

**The three trailing comments are the chapter's control model, one line each:**

```text
registerTools(server, deps);     // do    — driven by the model
registerResources(server, deps); // know  — driven by the application
registerPrompts(server);         // reuse — driven by the user
```

That is Chapter 06 §6.6 in three lines, and it is the most useful comment in the file. A reader
who remembers nothing else from this codebase should remember this block: the model drives tools,
the application drives resources, the user drives prompts.

**`registerPrompts(server)` takes no `deps`, and the missing argument is meaningful.** It is the
signature-level proof that prompts read no data (Chapter 12). Reading the three lines side by
side, the asymmetry is visible at a glance — exactly what you want from a call site.

**The order of the three calls does not matter** — they register into different collections, and
none reads another's registrations. They are ordered here to match the table above, not for any
technical reason.

### Block 5 — the readiness log, and what it is for

```ts
logger.info("server.ready", {
  version: env.MCP_SERVER_VERSION,
  transport: env.MCP_TRANSPORT,
  timeoutMs: deps.timeoutMs,
  rateLimitPerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
  maxTasks: env.MCP_MAX_TASKS,
});

return server;
```

**What it does:** emits one structured line recording the configuration the server actually
started with.
**How it works:** an `info` event with the five values that change its behaviour.

**This is the single most useful log line in the project**, because it converts configuration from
an *assumption* into *evidence*. When someone reports "the rate limit is wrong", the answer is in
this line — not in a file they have to go and read, and not in a guess about which `.env` was
loaded.

**Why these five fields?** Each one changes observable behaviour:

| Field | What it answers |
| :--- | :--- |
| `version` | Which build is running? |
| `transport` | Is this the stdio binding or HTTP? |
| `timeoutMs` | Why did a slow call fail at 5 s and not 30 s? |
| `rateLimitPerMinute` | Why was the fifth call refused? |
| `maxTasks` | Why did creation fail at 1,000 tasks? |

Note what is *absent*: nothing about the tools, the resources or the prompts. Those are visible in
`tools/list` — a client can discover them, so logging them here would duplicate a fact the protocol
already publishes. The five fields above are the ones a **client cannot discover**.

**`transport: env.MCP_TRANSPORT` is informational, and the README says so.** `src/index.ts` binds
stdio unconditionally, so the value is always `"stdio"` today. Logging it means the line stays
accurate when the HTTP binding arrives — and logging an unvalidated value would be worse, which is
why `config/env.ts` validates it against a one-value enum.

**`return server;` is the last statement, after the log.** Order matters: the log is emitted once
the server is fully assembled, so a line in the log stream means the registration completed.
Logging before `registerTools` would be a lie if a registration threw.

**Why is the readiness line not in `src/index.ts`?** Because readiness is about the *server*, and
`index.ts` is about the *transport*. `createServer` knowing whether it assembled successfully is
correct; the entry point knowing it is not its business. Chapter 14 shows the complementary line —
`server.listening` — which is the transport's version of the same idea.

---

## 13.4 Run / verify

Start the server alone. Only **one** line appears, and that is the lesson:

```bash
npm run server
```

```text
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":440320,"transport":"stdio","version":"1.0.0"}
```

There is **no `server.ready` line yet** — and that is not a bug. `serveStdio` (Chapter 14) does
not call the factory until the client's opening exchange arrives, so at this moment no server
instance exists. The factory is lazy by design: it has to be, because the protocol era is decided
by that opening exchange, and a server cannot be registered after it connects.

The moment a client connects, the factory runs and the second line appears. Send an `initialize`
and watch both:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  | npm run server --silent 2>&1 >/dev/null
```

```text
{"ts":"…","level":"info","event":"server.listening","server":"task-mcp-server","pid":440401,"transport":"stdio","version":"1.0.0"}
{"ts":"…","level":"info","event":"server.ready","server":"task-mcp-server","version":"1.0.0","transport":"stdio","timeoutMs":5000,"rateLimitPerMinute":60,"maxTasks":1000}
```

Two lines, from two files. `server.listening` comes from `src/index.ts` (Chapter 14);
`server.ready` comes from this file — emitted only after the factory was invoked. **Seeing
`listening` without `ready` is the normal state of a server waiting for a client.**

Now see what that `initialize` returned — identity, capabilities and instructions, with no host in
the picture:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  | npm run server --silent 2>/dev/null | python3 -m json.tool
```

```json
{
    "result": {
        "protocolVersion": "2025-06-18",
        "capabilities": {
            "logging": {},
            "tools": { "listChanged": true },
            "resources": { "listChanged": true },
            "prompts": { "listChanged": true },
            "completions": {}
        },
        "serverInfo": { "name": "task-mcp-server", "version": "1.0.0" },
        "instructions": "Task server. Every mutation is keyed by the numeric task id, so call list_tasks first to read exact ids and titles. create_task adds one task; pass an idempotencyKey when a retry must not create a second task. list_tasks is read-only and safe to call at any time. complete_task is idempotent, but completing an already-completed task is a conflict, not a retry. delete_task is destructive and irreversible, and requires explicit user consent."
    },
    "jsonrpc": "2.0",
    "id": 1
}
```

Four things to notice:

1. **All four declared capabilities are echoed back** — plus a fifth, `completions: {}`, which the
   SDK adds automatically because the resource template declares a `complete` callback
   (Chapter 11). **A capability you did not write appeared because the SDK inferred it from your
   registrations** — a good reminder that the capability list is derived, not merely declared.
2. **`serverInfo` carries exactly two fields.** No vendor, no model. Chapter 02's claim, on the
   wire.
3. **`instructions` is delivered in full** — the five-sentence paragraph, with the server's
   conventions and its consent policy.
4. **`protocolVersion: "2025-06-18"` was negotiated**, echoing the version the client proposed. An
   unsupported version would have been rejected rather than silently accepted.

Finally, confirm the config values are live rather than decorative — change two and watch the
readiness line change with them:

```bash
MCP_RATE_LIMIT_PER_MINUTE=5 MCP_MAX_TASKS=3 npm run server
```

```text
{"ts":"…","level":"info","event":"server.ready","server":"task-mcp-server","version":"1.0.0","transport":"stdio","timeoutMs":5000,"rateLimitPerMinute":5,"maxTasks":3}
```

`rateLimitPerMinute: 5` and `maxTasks: 3` — the values came from the shell, through
`config/env.ts`, into the composition root, and out into the log. That chain is the whole point of
Chapter 02, and this is where it terminates.

> **Note the environment forwarding from Chapter 17.** These two overrides reach the *server*
> process only because `src/host/client.ts` forwards `MCP_*` variables explicitly. Running
> `npm run server` directly puts them in the process environment, so they always worked — but the
> same overrides with `npm run host` depend on that forwarding, and the stdio transport does not
> inherit the parent environment by default.

---

## 13.5 Checkpoint

1. **`createServer()` is a factory, not a singleton.** State is per-server, so two connections
   cannot share a task board, and the transport can be swapped without touching this file.
2. **This is the composition root — the only file that knows how the pieces are built.** Everywhere
   else receives them through `ServerDeps`.
3. **Capabilities are permissions, not niceties.** Declaring one promises the server answers that
   capability's requests; `McpServer` handles the ones declared here automatically.
4. **`instructions` states server-wide policy** — conventions and consent — where a tool description
   states when to use *that* tool. It is advisory, so descriptions still carry their own
   disambiguation.
5. **The three registrars' trailing comments are the control model:** tools are driven by the model,
   resources by the application, prompts by the user.
6. **`registerPrompts(server)` has no `deps`**, and that asymmetry is the proof that prompts read no
   data.
7. **The readiness log records what a client cannot discover** — the five configuration values that
   change behaviour, so configuration is evidence rather than assumption.
8. **A capability you did not declare (`completions`) can appear anyway**, inferred by the SDK from
   the template's `complete` callback.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 12 — MCP: Prompts](./12_Mcp_Prompts.md)

**Next:** [Chapter 14 — Entry Point: STDIO & Shutdown](./14_Entry_Point_Stdio.md)



