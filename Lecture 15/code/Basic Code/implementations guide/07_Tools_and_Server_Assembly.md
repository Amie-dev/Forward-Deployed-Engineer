# Chapter 07 — Tools & Server Assembly

> **Goal of this chapter:** add the third primitive (the one Lecture 14 covered, kept deliberately
> small here) and then watch all three meet in a single function — which is where the control
> model becomes readable at a glance.
>
> **Lecture chapter:** [01 — The Three Primitives and the Control Model](../../../notes/01_The_Three_Primitives_and_the_Control_Model.md).

---

## 7.1 Files in this chapter

| | `src/tools/tools.ts` | `src/server/server.ts` |
|---|---|---|
| **Purpose** | the Tools the **model** may call | assemble all three primitives behind one door |
| **Imports** | `type McpServer`, `zod/v4`, `taskService` | `McpServer`, `config`, the three `register*` functions |
| **Exports** | `registerTools(server)` | `createServer()` |
| **Depends on** | `src/services/taskService.ts` | everything above |
| **Called by** | `src/server/server.ts` | `src/index.ts` |

**Why one chapter for two files?** Because `server.ts` is only four lines of work, and its whole
meaning comes from the three `register*` calls it makes. Reading them together is what makes the
control model click.

---

## 7.2 Commands

```bash
npm run typecheck
npm run lifecycle     # step 7 exercises the server that createServer() built
```

---

## 7.3 Full file — `src/tools/tools.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { backlogText, completeTask, createTask } from "../services/taskService.js";

/**
 * Chapter 01 — Tools: the MODEL holds the trigger.
 *
 * A tool is verb-named, carries an `inputSchema`, and is allowed to change
 * state. Lecture 14 covered this primitive in depth; these three tools are the
 * minimum needed for Chapter 08's end-to-end request to have something the
 * model can choose to call.
 */
export function registerTools(server: McpServer): void {
  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Add a new task to the backlog.",
      inputSchema: z.object({
        title: z.string().describe("Title of the task"),
      }),
    },
    async ({ title }) => ({
      content: [{ type: "text" as const, text: createTask(title) }],
    }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List the tasks that are not done yet.",
      inputSchema: z.object({}),
    },
    // Chapter 02 — note that this returns exactly the same text as the
    // `task://backlog` Resource. Same payload, different intent: the model
    // *decides* to call this, the application *decides* to read that.
    async () => ({
      content: [{ type: "text" as const, text: backlogText() }],
    }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task as done, using its exact title.",
      inputSchema: z.object({
        title: z.string().describe("Exact title of the task"),
      }),
    },
    async ({ title }) => ({
      content: [{ type: "text" as const, text: completeTask(title) }],
    }),
  );
}
```

---

## 7.4 Full file — `src/server/server.ts`

```ts
import { McpServer } from "@modelcontextprotocol/server";

import { serverInfo } from "../config/config.js";
import { registerPrompts } from "../prompts/prompts.js";
import { registerResources } from "../resources/resources.js";
import { registerTools } from "../tools/tools.js";

/**
 * Chapter 01 / Chapter 08 — three primitives, three owners, one standard door.
 *
 * Note what is *not* here: no model, no HTTP, no transport. This factory only
 * declares capabilities, so the very same server can be served over Streamable
 * HTTP (`src/index.ts`) or spawned by a host without changing a line — which is
 * Chapter 01's point that the binding is a detail, not a rewrite.
 */
export function createServer(): McpServer {
  const server = new McpServer(serverInfo);

  registerTools(server); // MODEL holds the trigger        — verbs, schemas, side effects
  registerResources(server); // APPLICATION holds the trigger — nouns, URIs, read-only
  registerPrompts(server); // USER holds the trigger       — message templates

  return server;
}
```

---

## 7.5 Block-by-block explanation — `tools.ts`

### Block 1 — the imports

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { backlogText, completeTask, createTask } from "../services/taskService.js";
```

- The first two imports are identical to Chapter 06's. The third is the difference: **a Tool file
  reaches into the data layer.** That is not an accident — it is the definition of the primitive.
  A Tool *does* something, so it must touch something.
- Compare the three primitive files by what they import:

  | File | Imports `taskService`? | Why |
  |---|---|---|
  | `tools/tools.ts` | **yes** — `createTask`, `completeTask`, `backlogText` | Tools act on data |
  | `resources/resources.ts` | yes — the four text views | Resources read data |
  | `prompts/prompts.ts` | **no** | Prompts are text with no data behind them |

### Block 2 — `create_task`, the state-changing Tool

```ts
server.registerTool(
  "create_task",
  {
    title: "Create task",
    description: "Add a new task to the backlog.",
    inputSchema: z.object({
      title: z.string().describe("Title of the task"),
    }),
  },
  async ({ title }) => ({
    content: [{ type: "text" as const, text: createTask(title) }],
  }),
);
```

- `registerTool(name, config, callback)` — three arguments, same shape as `registerPrompt`.
  `config` here carries **`inputSchema`** rather than `argsSchema`; the different name is a
  deliberate protocol distinction. A Tool's schema is a *contract the model must satisfy*; a
  Prompt's is a *form the user fills in*.
- **`"create_task"` is verb-named.** `create_` is the verb. Compare the Resource names from
  Chapter 04 — `"guidelines"`, `"backlog"`, `"summary"` — all nouns. The naming convention is a
  free hint to a model about which primitive it is looking at.
- `z.object({ title: z.string().describe(…) })` is the input contract. The SDK validates the
  model's arguments against it before your callback runs, so `title` is guaranteed to be a
  string. You never write a defensive check.
- `inputSchema: z.object({})` — used by `list_tasks` — declares **"takes no arguments"**.
  An empty `z.object` is not the same as omitting `inputSchema`: it explicitly tells the model
  this tool is safe to call with `{}`.
- `async ({ title }) => ({ … })` returns a **`CallToolResult`**: `{ content: [...] }`. That is the
  mirror image of a Resource's `{ contents: [...] }` — `content` (singular) for tools,
  `contents` (plural) for resources. It is easy to mix up and worth memorising.
- `createTask(title)` is the actual work, and it returns the string the tool reports back.

### Block 3 — `list_tasks`, the Tool that duplicates a Resource

```ts
server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description: "List the tasks that are not done yet.",
    inputSchema: z.object({}),
  },
  // Chapter 02 — note that this returns exactly the same text as the
  // `task://backlog` Resource. Same payload, different intent: the model
  // *decides* to call this, the application *decides* to read that.
  async () => ({
    content: [{ type: "text" as const, text: backlogText() }],
  }),
);
```

- **This is the most instructive twenty lines in the project.** `list_tasks` and
  `task://backlog` return *byte-identical* text — both call `backlogText()`.
- So why do both exist? Because **the difference is not the payload, it is the owner of the
  decision.**
  - `list_tasks` is a **Tool**: the *model* decides to call it, mid-conversation, when it
    realises it needs the list.
  - `task://backlog` is a **Resource**: the *application* decides to read it, before the model
    is even invoked.
- That single comparison is Lecture 02's entire argument. If you only remember one thing from
  this guide, remember this pair of registrations.
- The callback takes **no parameters** — `async () => ({ … })` — because `inputSchema` is empty.

### Block 4 — `complete_task`, the failing Tool

```ts
server.registerTool(
  "complete_task",
  {
    title: "Complete task",
    description: "Mark a task as done, using its exact title.",
    inputSchema: z.object({
      title: z.string().describe("Exact title of the task"),
    }),
  },
  async ({ title }) => ({
    content: [{ type: "text" as const, text: completeTask(title) }],
  }),
);
```

- The `.describe("Exact title of the task")` is not decoration. Chapter 03's `completeTask()`
  matches titles **exactly**, so the schema has to say so. A description that says just
  *"the task"* invites a model to paraphrase, and the call fails.
- Note that the failure is still a **successful tool call**. When `completeTask` cannot find the
  title, it returns a sentence (*"No pending task titled … Call list_tasks to read the exact
  titles, then retry."*) inside a normal `content` block. The protocol layer reports no error —
  and that is deliberate: the message goes into the model's context, so it can self-correct.
- That is the recovery-instruction pattern from Chapter 03, seen from the tool side.

### Block 5 — the three tools at a glance

| Tool | Verb? | `inputSchema` | Changes state? | Backing function |
|---|---|---|---|---|
| `create_task` | create | `{ title: string }` | **yes** — pushes to `tasks` | `createTask` |
| `list_tasks` | list | `{}` | no | `backlogText` |
| `complete_task` | complete | `{ title: string }` | **yes** — sets `done = true` | `completeTask` |

Two of three change state, and every one of them is named with a verb. That is the Tool
signature: **verbs, schemas, and the possibility of side effects.**

---

## 7.6 Block-by-block explanation — `server.ts`

### Block 1 — the imports

```ts
import { McpServer } from "@modelcontextprotocol/server";

import { serverInfo } from "../config/config.js";
import { registerPrompts } from "../prompts/prompts.js";
import { registerResources } from "../resources/resources.js";
import { registerTools } from "../tools/tools.js";
```

- `McpServer` is imported **without** `type` this time, because it is used as a value:
  `new McpServer(serverInfo)`.
- The three `register*` imports are the only place in the whole project where the three primitive
  folders meet. Nothing else imports more than one of them.
- Notice the absence of `node:http`, `Client`, `openai` and the transports. **This factory cannot
  talk to the network and cannot call a model.** That is what makes it reusable: the same
  `createServer()` is served over Streamable HTTP by `src/index.ts`, and could be served over
  stdio by swapping one line elsewhere.

### Block 2 — the factory

```ts
export function createServer(): McpServer {
  const server = new McpServer(serverInfo);

  registerTools(server); // MODEL holds the trigger        — verbs, schemas, side effects
  registerResources(server); // APPLICATION holds the trigger — nouns, URIs, read-only
  registerPrompts(server); // USER holds the trigger       — message templates

  return server;
}
```

- **`createServer()` is a factory, not a singleton.** Each call builds a fresh `McpServer`. That
  matters for the HTTP transport, where a new server instance may be created per connection
  (Chapter 09), and it matters for tests.
- `new McpServer(serverInfo)` takes the two-field object from Chapter 02. This is the only place
  server identity enters the program.
- **The three lines in the middle are the whole lecture.** Read the comments down the column:

  | Call | Primitive | Owner | Shape |
  |---|---|---|---|
  | `registerTools` | Tools | **MODEL** | verbs, schemas, side effects |
  | `registerResources` | Resources | **APPLICATION** | nouns, URIs, read-only |
  | `registerPrompts` | Prompts | **USER** | message templates |

  Three primitives, three different owners, one function. If you can explain this table you can
  explain Chapter 01.
- **The order of the three calls does not matter.** They are independent registrations on the
  same object; nothing here is sequential. The order in the file is chosen to match the lecture's
  own order (Tools → Resources → Prompts), which is the only reason it looks deliberate.
- Each `register*` function takes `server` and returns `void`. Passing the server *in* rather
  than having each module create one keeps the dependency arrow pointing one way:
  `server.ts → tools.ts`, never `tools.ts → server.ts`.

### Block 3 — the return value

```ts
  return server;
}
```

- The caller receives a fully-populated `McpServer` and decides what to do with it. In this
  project, `src/index.ts` hands it to `createMcpHandler` and serves it over HTTP (Chapter 09).
- **Why this matters:** the server's *capabilities* are now a pure function of the code. There is
  no hidden state, no global, no side effect beyond registering handlers. That is what makes the
  same code testable, embeddable and transport-agnostic.

---

## 7.7 The control model, in one table

Everything in this project reduces to this table. It is worth writing out by hand once.

| | **Tool** | **Resource** | **Prompt** |
|---|---|---|---|
| **Who holds the trigger** | the **model** | the **application** | the **user** |
| **Naming** | verb — `create_task` | noun — `task://backlog` | workflow — `plan_day` |
| **Discovery** | `tools/list` | `resources/list` + `resources/templates/list` | `prompts/list` |
| **Invocation** | `tools/call` | `resources/read` | `prompts/get` |
| **Schema field** | `inputSchema` | — (URI template instead) | `argsSchema` |
| **Result shape** | `{ content: [...] }` | `{ contents: [...] }` | `{ messages: [...] }` |
| **Changes state?** | **yes, possibly** | never | never |
| **Code file** | `src/tools/tools.ts` | `src/resources/resources.ts` | `src/prompts/prompts.ts` |

**The one-line version:** *the model calls Tools, the application reads Resources, the user
selects Prompts.*

---

## 7.8 Run / verify

```bash
npm run typecheck     # silent, exit 0
npm run lifecycle     # step 7 shows createServer() in action
```

Step 7 is the server this factory built, being used:

```text
7. the model step, after prompts/get — GET /plan?hours=4 in miniature
   (offline — no OPENAI_API_KEY, so no model was called)
   USER:
   Help me plan my pending tasks for today.
   ...
```

To see the three capability sets declared in **one** `initialize` reply, start the server and
send one raw JSON-RPC message:

```bash
# terminal 1
npm run server
```

```bash
# terminal 2
curl -s -X POST http://127.0.0.1:8081/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}'
```

Verified response:

```text
event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"listChanged":true}},"serverInfo":{"name":"task-mcp-server","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

Read that `capabilities` object — it is the proof this chapter works:

```json
"capabilities": {
  "tools":     { "listChanged": true },
  "resources": { "listChanged": true },
  "prompts":   { "listChanged": true }
}
```

Three capabilities, because `createServer()` made three `register*` calls. If you deleted
`registerResources(server)` the `resources` key would vanish — and a well-behaved client would
then never send `resources/list`. **Capability negotiation is automatic; you never write it.**

To browse the same server visually:

```bash
npx @modelcontextprotocol/inspector --url http://127.0.0.1:8081/mcp
```

---

## 7.9 Checkpoint

1. **Why is `McpServer` imported without `type` in `server.ts` but with `type` in `tools.ts`?** →
   `server.ts` uses it as a value (`new McpServer(...)`); `tools.ts` only uses it as a parameter
   type.
2. **What is the difference between `list_tasks` and `task://backlog`?** → nothing in the payload;
   everything in the owner. The model decides to call the tool; the application decides to read
   the resource.
3. **Why does `server.ts` import no transport and no model?** → so the same factory can be served
   over any transport, and so the server stays a pure capability provider.
4. **What does `{ content: [...] }` mean versus `{ contents: [...] }`?** → `content` is a
   `tools/call` result; `contents` is a `resources/read` result.
5. **Does the order of the three `register*` calls matter?** → no. They are independent
   registrations on the same server object.
6. **Where do the three declared capabilities come from?** → the three `register*` calls. The SDK
   negotiates them for you at `initialize`.

**Next:** [Chapter 08 — Client Wiring: `resources/read` & `prompts/get`](./08_Client_Wiring_resources_read_and_prompts_get.md)



