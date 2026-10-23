# Chapter 05 — Tools: The Tools Primitive

> **Goal of this chapter:** read the file the *model* reads. A tool is **a contract written for a
> reader who cannot read your code** — the model sees exactly `name`, `description` and
> `inputSchema`, and the description *is the prompt*.
>
> **Lecture chapter:** [05 — The Tools Primitive](../../../notes/05_The_Tools_Primitive.md)
> (§5.2 what a tool is, §5.3 anatomy, §5.6 result & structured content, §5.7 errors, §5.3 annotations).

---

## 5.1 File details

| Property | Value |
|---|---|
| **Path** | `src/tools/tools.ts` |
| **Layer** | MCP primitive — **Tools** (*do*) |
| **Purpose** | register `create_task`, `list_tasks`, `complete_task` on the server |
| **Imports** | `McpServer` (type-only), `zod/v4`, `taskService` |
| **Exports** | `registerTools(server)` |
| **Imported by** | `src/server/server.ts` |
| **Lecture sections** | 05 §5.2–§5.7 |

### The three things the model sees (and nothing else)

```text
name          "create_task"
description   "Creates a new task. Use when the user wants to add or remember something to do…"
inputSchema   { title: string (min 1) }     ← expressed here as a zod schema
```

Everything else — `taskService`, the `Map`, the ids — is invisible. That is the boundary this file
exists to draw.

---

## 5.2 Commands

```bash
cd "Lecture 14/code/Basic Code"

npm run typecheck   # types the zod schemas and the handlers
npm run client      # prints: 1. tools/list -> create_task, list_tasks, complete_task
```

To browse the tool definitions with a UI instead:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

---

## 5.3 Full file

**Path:** `src/tools/tools.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { taskService } from "../services/taskService.js";

/**
 * Chapter 05 — The Tools Primitive.
 *
 * A tool is a contract written for a reader who cannot read your code: the
 * model sees exactly three things — `name`, `description`, `inputSchema` — and
 * the description is the prompt. It is not documentation.
 */

/** The result contract shared by the tools that return a task. */
const taskSchema = z.object({
  id: z.number().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]),
});

export function registerTools(server: McpServer): void {
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Creates a new task. Use when the user wants to add or remember something to do. Do not use it to read or complete tasks.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Title of the task to create"),
      }),
      // Chapter 05 §5.6 — declaring an outputSchema makes the result a contract
      // the client can validate, not a blob of prose.
      outputSchema: taskSchema,
      // Chapter 05 §5.3 — annotations are hints for host policy, never enforcement.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title }) => {
      const task = taskService.create(title);
      return {
        content: [{ type: "text" as const, text: `Task #${task.id} created: ${task.title} (${task.status})` }],
        structuredContent: task,
      };
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description: "Returns every task with its id, title and status. Read-only; call it before completing a task whose title you do not know exactly.",
      inputSchema: z.object({}),
      outputSchema: z.object({ tasks: z.array(taskSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const tasks = taskService.list();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
        structuredContent: { tasks },
      };
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description: "Marks a pending task as COMPLETED using its exact title. Call list_tasks first when the title is uncertain.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Exact title of the task to complete"),
      }),
      outputSchema: taskSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ title }) => {
      const task = taskService.complete(title);

      // Chapter 05 §5.7 — a *tool execution error*: the call ran and the outcome
      // failed. This is a result with `isError: true`, not a JSON-RPC error, and
      // the text lands in the model's context — so it must say how to recover.
      if (!task) {
        return {
          content: [
            { type: "text" as const, text: `No pending task titled "${title}". Call list_tasks to read the exact titles, then retry.` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Task completed: ${task.title} (${task.status})` }],
        structuredContent: task,
      };
    },
  );
}
```

---

## 5.4 Block-by-block explanation

### Block 1 — the imports

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { taskService } from "../services/taskService.js";
```

**What it does:** brings in the server type, the schema library, and the execution layer.

**How it works:**
- `import type { McpServer }` — a **type-only** import. It is erased at compile time, so this file
  never *runs* the SDK; it only needs the type for the parameter of `registerTools`. (Good habit:
  it makes the dependency direction visible.)
- `import * as z from "zod/v4"` — the schema builder. `z.object`, `z.string`, `z.enum`, `.describe`
  and `.min` all come from here. These schemas are converted by the SDK into JSON Schema for the wire.
- `import { taskService }` — the *only* place the contract touches the implementation. Everything
  the model can trigger ultimately calls one of three methods on this object.

### Block 2 — the shared result schema (`taskSchema`)

```ts
const taskSchema = z.object({
  id: z.number().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]),
});
```

**What it does:** defines the shape of a task *as a contract* — reused as the `outputSchema` of two
tools and nested inside `list_tasks`' output.

**How it works:**
- `z.object({...})` builds a schema object; each field is its own schema.
- `.describe("…")` attaches a human-readable hint that ends up in the generated JSON Schema — the
  same trick as `description` on a tool, applied to individual fields.
- `z.enum(["PENDING", "COMPLETED"])` constrains the value to one of two strings. This is the
  runtime twin of the `TaskStatus` type from Chapter 04.
- **Why it matters (§5.6):** declaring an `outputSchema` turns the result from *a blob of prose*
  into *something the client can validate*. The model (and the host) can then trust the shape.

### Block 3 — the registration entry point

```ts
export function registerTools(server: McpServer): void {
```

**What it does:** declares the function `server.ts` calls to attach all tools.

**How it works:**
- It takes the server and returns nothing (`: void`) — its only job is a side effect: calling
  `server.registerTool(...)` for each tool.
- Keeping registration in a function (rather than top-level code) means tools are attached to *the
  specific server instance* the factory just created — no globals, no shared registry.

### Block 4 — `create_task`

```ts
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Creates a new task. Use when the user wants to add or remember something to do. Do not use it to read or complete tasks.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Title of the task to create"),
      }),
      outputSchema: taskSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title }) => {
      const task = taskService.create(title);
      return {
        content: [{ type: "text" as const, text: `Task #${task.id} created: ${task.title} (${task.status})` }],
        structuredContent: task,
      };
    },
  );
```

**What it does:** registers the first tool — create a task — with a name, a description, an input
schema, an output schema, annotations, and the handler that runs it.

**How it works, argument by argument:**
- **`"create_task"`** — the *name* the model must emit to call it. It is `snake_case` and verb-first;
  the model never guesses a name it cannot see.
- **`title`** — a human-friendly label for UIs (e.g. an approval dialog). Not what the model calls.
- **`description`** — *the prompt*. Read it as three instructions: *what* it does, *when* to use it
  ("when the user wants to add or remember something to do"), and **when not to** ("Do not use it to
  read or complete tasks"). That last clause is what stops the model from reaching for the wrong
  sibling tool (§5.3).
- **`inputSchema`** — `z.object({ title: z.string().min(1)… })`. `.min(1)` forbids an empty title,
  so the model cannot call it with `""`; `.describe(...)` documents the field. This is the
  *constrain the space so the model can be correct by construction* principle.
- **`outputSchema: taskSchema`** — declares the result shape (`{ id, title, status }`) so the client
  can validate it.
- **`annotations`** — hints for **host policy**, never enforcement (§5.3):
  - `readOnlyHint: false` — it *writes* (creates something).
  - `destructiveHint: false` — it adds, it does not destroy.
  - `idempotentHint: false` — calling it twice creates **two** tasks (not idempotent).
  - `openWorldHint: false` — it touches only this server's closed world.
- **`async ({ title }) => { … }`** — the handler. The SDK has already validated `title` against the
  schema, so it is destructured directly. It calls `taskService.create(title)` — the contract now
  reaches the implementation.
- **The return value** has two parts:
  - `content: [{ type: "text", text: … }]` — the human/model-readable block. A result is *always*
    `content[]` blocks, never a bare value (§5.6).
  - `structuredContent: task` — the machine-readable object matching `outputSchema`.
  Returning both means a UI can render the text and a program can parse the structured form.

### Block 5 — `list_tasks`

```ts
  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description: "Returns every task with its id, title and status. Read-only; call it before completing a task whose title you do not know exactly.",
      inputSchema: z.object({}),
      outputSchema: z.object({ tasks: z.array(taskSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const tasks = taskService.list();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
        structuredContent: { tasks },
      };
    },
  );
```

**What it does:** registers the read-only "list every task" tool.

**How it works:**
- **`inputSchema: z.object({})`** — an **empty object schema**: the tool takes no arguments. This is
  still required; a tool with no input declares "no fields" rather than omitting the schema.
- **`outputSchema: z.object({ tasks: z.array(taskSchema) })`** — the result is *wrapped* in an object
  with a `tasks` array. Wrapping matters: `outputSchema` describes an object, so an array of tasks
  must live under a key.
- **`annotations`** flip the read-only flags:
  - `readOnlyHint: true` — it changes nothing.
  - `idempotentHint: true` — calling it repeatedly has the same effect (none).
  - This is exactly the tool `complete_task`'s description tells the model to call first.
- **Handler:** `taskService.list()` → returns `content` (a JSON string of the array, for the model)
  **and** `structuredContent: { tasks }` (for a program). Note the two shapes are deliberately
  different: `text` is the human-facing rendering, `structuredContent` matches `outputSchema`.

### Block 6 — `complete_task` and the `isError` path

```ts
  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description: "Marks a pending task as COMPLETED using its exact title. Call list_tasks first when the title is uncertain.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Exact title of the task to complete"),
      }),
      outputSchema: taskSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ title }) => {
      const task = taskService.complete(title);

      if (!task) {
        return {
          content: [
            { type: "text" as const, text: `No pending task titled "${title}". Call list_tasks to read the exact titles, then retry.` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Task completed: ${task.title} (${task.status})` }],
        structuredContent: task,
      };
    },
  );
```

**What it does:** registers the tool that completes a task, and — crucially — shows how a **failed
operation** is reported.

**How it works:**
- **Description** again teaches *when* and *when to prepare*: "Call list_tasks first when the title
  is uncertain." The model is told the recovery path *before* it ever fails.
- **`annotations.idempotentHint: true`** — completing the same task twice should be safe. (In this
  implementation a second call returns `undefined`, i.e. the *operation* reports failure; the hint
  is still the right label because no *new* side effect occurs.)
- **The happy path** is identical in shape to `create_task`: text block + `structuredContent`.
- **The failure path** is the important one (§5.7):

  ```ts
  return { content: [...], isError: true };
  ```

  - This is a **tool execution error** — the call *ran*, and the *operation* failed. It is **not** a
    JSON-RPC/protocol error (which would mean the call never happened).
  - Because it is a normal *result*, its `text` is placed **into the model's context**. That makes
    the text an **instruction channel**, so it must be written as a recovery step, not a status
    code: `No pending task titled "…". Call list_tasks to read the exact titles, then retry.`
  - Contrast with `throw new Error("…")`: that would surface as a protocol error and the model would
    get no actionable text. The lecture's rule — *error messages are instructions* — is enforced here.
  - Note the failed result carries **no `structuredContent`**, because there is no `Task` to return;
    `outputSchema` describes the success shape, and `isError: true` marks the exception.

---

## 5.5 Run / verify

```bash
cd "Lecture 14/code/Basic Code"
npm run client
```

Watch these lines in the output — each maps to a block above:

```text
1. tools/list -> create_task, list_tasks, complete_task          ← all three registered
2. tools/call create_task -> Task #1 created: Record MCP Video (PENDING)   ← Block 4 happy path
3. tools/call complete_task (unknown title) -> isError=true No pending task titled "No such task". Call list_tasks to read the exact titles, then retry.   ← Block 6 failure path
   tools/call complete_task (exact title)   -> Task completed: Record MCP Video (COMPLETED)            ← Block 6 happy path
```

To inspect the raw definitions (schemas + annotations included):

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

---

## 5.6 Checkpoint

1. **What are the only three things the model sees about a tool?** `name`, `description`, `inputSchema`
   (plus, for the client, `outputSchema` and `annotations`).
2. **Where is the recovery instruction for a failed call, and why does it go there?** In the `text` of
   an `isError: true` result, because that text is appended to the model's context.
3. **What is the difference between `throw` and `isError: true`?** `throw` → protocol error (the call
   never happened); `isError: true` → the call ran and the operation failed, with recoverable text.

**Next:** [Chapter 06 — Resources: Addressable Context](./06_Resources_Addressable_Context.md)



