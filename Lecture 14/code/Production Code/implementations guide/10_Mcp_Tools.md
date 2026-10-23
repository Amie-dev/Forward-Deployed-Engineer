# Chapter 10: MCP — The Tools Primitive

> **Chapter goal:** Write four tool contracts a model will select correctly, and put
> every cross-cutting concern behind one wrapper so no handler can forget any of them.

---

## 10.1 File details

| | |
| :--- | :--- |
| **Path** | `src/mcp/tools.ts` |
| **Layer** | mcp (imports the SDK, `core/errors`, `core/guards`, `services/taskService`, `./deps`) |
| **Purpose** | Register the four tools — `create_task`, `list_tasks`, `complete_task`, `delete_task` — each with a description-as-prompt, schemas, annotations, and a handler wrapped in one `guard()` |
| **Imports** | `node:perf_hooks`, `@modelcontextprotocol/server` (type), `zod/v4`, `ToolError`/`toolFailure`/`toolSuccess`/`ToolOutcome`/`ToolResult`, `withTimeout`, `taskSchema`, `ServerDeps` |
| **Exports** | `registerTools()` |
| **Consumed by** | `src/mcp/server.ts` |
| **Lecture sections** | [05 — The Tools Primitive](../../../notes/05_The_Tools_Primitive.md) (the whole chapter), [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §"Rate limits" |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the catalogue, with annotations, exactly as the model receives it
npm run host | sed -n '5,15p'

# the raw wire: what tools/list actually returns
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npm run server --silent 2>/dev/null | tail -1 | head -c 600
```

---

## 10.2 Full file

```ts
import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ToolError, toolFailure, toolSuccess, type ToolOutcome, type ToolResult } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import { taskSchema } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";

/**
 * Chapter 05 — The Tools Primitive.
 *
 * A tool is a contract written for a reader who cannot read your code. The
 * model sees exactly four things — `name`, `description`, `inputSchema` and, if
 * you declare them, `outputSchema` and `annotations` — and **the description is
 * the prompt, not documentation.** Everything you fail to say, the model will
 * guess, confidently.
 *
 * Every handler below is wrapped in the same four guards, in the same order,
 * because "production" is mostly the discipline of never making an exception:
 *
 *     rate limit  →  validate  →  execute inside a timeout  →  map failure to a result
 */

/**
 * The single place where transport-independent concerns meet a handler.
 *
 * A handler computes an *outcome*; this decides how it reaches the model. Doing
 * it once, here, is why none of the four tools below contains a `try`/`catch`,
 * a timer, a counter or a log call — and why a fifth tool cannot forget one.
 */
async function guard<Structured>(
  deps: ServerDeps,
  tool: string,
  run: () => ToolOutcome<Structured>,
): Promise<ToolResult<Structured>> {
  const startedAt = performance.now();

  try {
    const limit = deps.limiter.check(tool);
    if (!limit.allowed) {
      throw new ToolError(
        "LIMIT_EXCEEDED",
        `Rate limit reached for ${tool}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
        "Wait for the window to pass, or stop retrying and report the current state to the user.",
        true,
      );
    }

    const outcome = await withTimeout(run, deps.timeoutMs, tool);

    deps.metrics.count(`tool.ok.${tool}`);
    deps.logger.info("tool.call", { tool, ms: Math.round(performance.now() - startedAt) });

    return toolSuccess(outcome);
  } catch (error) {
    const failure = toToolError(tool, error);

    deps.metrics.count(`tool.error.${tool}`);
    deps.logger.warn("tool.failure", {
      tool,
      code: failure.code,
      retryable: failure.retryable,
      message: failure.message,
    });

    return toolFailure(failure);
  } finally {
    deps.metrics.observe(`tool.latency_ms.${tool}`, performance.now() - startedAt);
  }
}

/**
 * Anything unexpected becomes a retryable `UNAVAILABLE` — never a protocol
 * error. The call reached the handler, so the model is owed a result it can
 * reason about rather than a connection that dies mid-turn.
 */
function toToolError(tool: string, error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(
    "UNAVAILABLE",
    `${tool} failed: ${message}`,
    "Retry once. If it fails again, treat this capability as temporarily unavailable.",
    true,
  );
}

export function registerTools(server: McpServer, deps: ServerDeps): void {
  /**
   * Annotations are hints for host policy — never enforcement. They tell a host
   * which risk class a tool belongs to, and a host is expected to keep its own
   * view, because a hostile server can mislabel its own tools.
   */
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Adds one task to the board and returns it with a server-assigned id. Use it when the user wants something remembered or scheduled. Do not use it to change or remove an existing task — use complete_task or delete_task with an id from list_tasks. Pass idempotencyKey when a retry must not create a second task.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe("Short, human-readable title of the task to create"),
        idempotencyKey: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "Caller-generated key such as a request id. Re-sending the same key returns the original task instead of creating another",
          ),
      }),
      outputSchema: z.object({
        task: taskSchema,
        replayed: z.boolean().describe("True when the idempotency key had already been used and nothing was written"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, idempotencyKey }) =>
      guard(deps, "create_task", () => {
        const { task, replayed } = deps.service.create({ title, idempotencyKey });

        return {
          text: replayed
            ? `Task #${task.id} already existed (idempotent replay): ${task.title} (${task.status}).`
            : `Task #${task.id} created: ${task.title} (${task.status}).`,
          structured: { task, replayed },
        };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description:
        "Returns tasks with their ids, titles and statuses, optionally filtered by status. Read-only and safe to call at any time. Call it before complete_task or delete_task whenever an id is uncertain — never guess an id.",
      inputSchema: z.object({
        status: z
          .enum(["PENDING", "COMPLETED"])
          .optional()
          .describe("Return only tasks in this state. Omit to read the whole board"),
      }),
      outputSchema: z.object({
        tasks: z.array(taskSchema),
        total: z.number().int().describe("Number of tasks in this result"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status }) =>
      guard(deps, "list_tasks", () => {
        const tasks = deps.service.list({ status });

        return {
          text: tasks.length === 0 ? "No tasks matched." : JSON.stringify(tasks),
          structured: { tasks, total: tasks.length },
        };
      }),
  );



  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description:
        "Marks one PENDING task as COMPLETED by id. Use it when work is finished; use delete_task to remove a task instead of completing it. Idempotent in intent, but completing an already-completed task returns a conflict — read the board rather than retrying.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Id of the task to complete, as returned by list_tasks or create_task"),
      }),
      outputSchema: z.object({ task: taskSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(deps, "complete_task", () => {
        const task = deps.service.complete({ id });

        return {
          text: `Task completed: #${task.id} ${task.title} (${task.status}).`,
          structured: { task },
        };
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete Task",
      description:
        "Permanently removes one task by id. Irreversible — the task is gone and its id is never reused, so prefer complete_task when the user means 'finished' rather than 'remove'. Requires explicit user consent, which the host obtains before calling it.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Id of the task to delete, as returned by list_tasks"),
      }),
      outputSchema: z.object({ deleted: taskSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id }) =>
      guard(deps, "delete_task", () => {
        const task = deps.service.remove({ id });

        return {
          text: `Task deleted: #${task.id} ${task.title}.`,
          structured: { deleted: task },
        };
      }),
  );
}
```

## 10.3 Block-by-block explanation

### Block 1 — what the model actually sees

The header comment lists the model's entire view of this file:

> The model sees exactly four things — `name`, `description`, `inputSchema` and, if you
> declare them, `outputSchema` and `annotations` — and **the description is the prompt,
> not documentation.** Everything you fail to say, the model will guess, confidently.

That is the design constraint for every line below. The model never sees `taskService`,
`taskStore`, the `ToolError` class, or this comment. It sees JSON. So the description is
not a docstring for a colleague — it is the *only* thing telling the model when to reach
for this tool, and it is competing with three sibling descriptions for the model's
attention.

**The four guards, in order.** The comment states the pipeline:

```text
rate limit  →  validate  →  execute inside a timeout  →  map failure to a result
```

The order is not arbitrary:

- **Rate limit first** — refuse *before* doing any work. A limited call should cost
  nothing, not a validation pass plus a lookup.
- **Validate second** — the service does this, so the guard does not. It happens inside
  the timeout, which is correct: validation is fast, but it is still work, and a
  pathological input should not be able to exceed the budget.
- **Timeout third** — the whole handler body runs inside it.
- **Map failure last** — in the `catch`, so no path escapes unmapped.

### Block 2 — `guard()`: the one wrapper

```ts
async function guard<Structured>(
  deps: ServerDeps,
  tool: string,
  run: () => ToolOutcome<Structured>,
): Promise<ToolResult<Structured>> {
  const startedAt = performance.now();

  try {
    const limit = deps.limiter.check(tool);
    if (!limit.allowed) {
      throw new ToolError(
        "LIMIT_EXCEEDED",
        `Rate limit reached for ${tool}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
        "Wait for the window to pass, or stop retrying and report the current state to the user.",
        true,
      );
    }

    const outcome = await withTimeout(run, deps.timeoutMs, tool);

    deps.metrics.count(`tool.ok.${tool}`);
    deps.logger.info("tool.call", { tool, ms: Math.round(performance.now() - startedAt) });

    return toolSuccess(outcome);
  } catch (error) {
    const failure = toToolError(tool, error);

    deps.metrics.count(`tool.error.${tool}`);
    deps.logger.warn("tool.failure", {
      tool,
      code: failure.code,
      retryable: failure.retryable,
      message: failure.message,
    });

    return toolFailure(failure);
  } finally {
    deps.metrics.observe(`tool.latency_ms.${tool}`, performance.now() - startedAt);
  }
}
```

**What it does:** owns every concern that is not business logic, for every tool.
**How it works:** one `try`/`catch`/`finally` around a caller-supplied thunk.

**`run: () => ToolOutcome<Structured>` — a thunk, not a value.** Same reasoning as
`withTimeout` in Chapter 06: taking a thunk means the work is *not* started until inside
the budget, and it lets the rate-limit check run before any work at all. If `guard` took
an already-computed outcome, the rate limiter would be decorative.

**The generic `<Structured>` flows through three types.** It is inferred from `run`'s
return, threaded into `ToolOutcome<Structured>`, and emerges as `ToolResult<Structured>`.
So a handler returning `{ task, replayed }` gets a result typed
`{ task: Task; replayed: boolean }` — and the SDK's `outputSchema` check sees the same
type. One inference, three positions.

**`const startedAt = performance.now()` before the `try`.** If it were inside the `try`, a
throw before the assignment would make the `finally` reference an uninitialised value.
Placing it first means the latency observation is always well-defined — and it also means
the measured window *includes* the rate-limit check, which is the honest measurement: a
refused call still cost the caller time.

**`performance.now()` rather than `Date.now()`.** `performance.now()` is a monotonic clock
with sub-millisecond resolution; `Date.now()` is wall-clock and can jump backwards during
an NTP correction, producing a negative latency. `node:perf_hooks` is imported explicitly
rather than relying on the global, so the dependency is visible.

**The rate-limit branch *throws* rather than returning.** It could have returned
`toolFailure(...)` directly, but throwing means the failure travels the same path as a
service failure — through `toToolError`, into the same catch block, into the same metric
and the same log line. One failure path means the counters (`tool.error.${tool}`) include
rate-limit refusals, which is what you want on a dashboard: a spike in
`tool.error.create_task` should include the refusals, not silently exclude them.

**`Math.ceil(limit.retryAfterMs / 1000)`** converts milliseconds to a whole-second wait.
`Math.ceil` rather than `Math.round` because rounding *down* would tell the model to retry
before the window has actually moved — and it would be refused again. Telling the model to
wait 60s when the true answer is 59.4s is safe; telling it 59s is not.

**The success path logs `tool.call` with `ms`.** Note it logs *after* the work, with the
elapsed time, not before. A "starting" log plus a "finished" log would double the line
count; one line with a duration is enough to spot a slow tool.

**`deps.metrics.observe(...)` in `finally`.** This is the one metric that must record on
*every* path — success, business failure, rate-limit refusal, timeout — because latency is
about the caller's experience, and a refused call still took time. The `finally` guarantees
it, and it is the reason `startedAt` had to be hoisted out of the `try`.

**The tool name is passed in, not read from the handler.** `guard(deps, "create_task", …)`
repeats the name that is already the first argument to `registerTool`. That repetition is
deliberate: it makes the metric names, the log fields and the rate-limit keys all derive
from one literal the reader can see at the call site, without `guard` needing to know
anything about the SDK's registration API.

### Block 3 — `toToolError`: the catch-all that is not an anti-code

```ts
function toToolError(tool: string, error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(
    "UNAVAILABLE",
    `${tool} failed: ${message}`,
    "Retry once. If it fails again, treat this capability as temporarily unavailable.",
    true,
  );
}
```

**What it does:** normalises *any* thrown value into a `ToolError`.
**How it works:** a pass-through for known failures, a converter for everything else.

**`error instanceof ToolError` is the fast path**, and it is the reason `ToolError extends
Error` matters. The service's deliberate business failures arrive here already complete —
with their own code, message and recovery sentence — and are returned untouched. Nothing
is re-wrapped, so the careful wording written in `taskService.ts` reaches the model
verbatim.

**`error: unknown`, not `error: any`.** In TypeScript, a `catch` clause's variable is typed
`unknown` (with `useUnknownInCatchVariables`, part of `strict`). That is correct: *anything*
can be thrown — a string, a number, `undefined` — and typing it as `Error` would be a lie
that the compiler would then help you believe.

**`error instanceof Error ? error.message : String(error)`** handles the non-Error throw.
`String(error)` on a plain object gives `"[object Object]"`, which is uninformative but not
a crash. The alternative — assuming `error.message` exists — would throw a `TypeError`
*inside the error handler*, turning a handled failure into an unhandled crash.

**Everything unexpected becomes `UNAVAILABLE` with `retryable: true`.** Chapter 05 explains
why there is no `INTERNAL_ERROR` code: it would describe the absence of a diagnosis while
looking like one. `UNAVAILABLE` at least tells the model what to do — try once, then report
the capability as down — which is better than a model that retries forever or that gives up
immediately.

**The `retryable: true` deserves a caveat.** A genuine bug (a `TypeError` in the service)
is not going to be fixed by a retry, so marking it retryable is optimistic. The justification
is that from *inside the protocol* the two cases are indistinguishable — a timeout, a
transient downstream failure and a bug all arrive as "the handler threw" — and the recovery
sentence caps the cost at one retry rather than a loop. A production system would
additionally alert on the `tool.failure` log line with `code: "UNAVAILABLE"`, which is what
this file does.

**Why `${tool} failed: ${message}`?** Because `guard`'s catch block has no other context to
attach. The handler's own error messages ("Cannot read properties of undefined") do not say
*which* tool broke, and in a log with four tools that matters. Prefixing the tool name makes
the log line self-describing.

### Block 4 — `create_task`: description craft and the idempotency contract

```ts
server.registerTool(
  "create_task",
  {
    title: "Create Task",
    description:
      "Adds one task to the board and returns it with a server-assigned id. Use it when the user wants something remembered or scheduled. Do not use it to change or remove an existing task — use complete_task or delete_task with an id from list_tasks. Pass idempotencyKey when a retry must not create a second task.",
    inputSchema: z.object({
      title: z.string().min(1).max(120).describe("Short, human-readable title of the task to create"),
      idempotencyKey: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "Caller-generated key such as a request id. Re-sending the same key returns the original task instead of creating another",
        ),
    }),
    outputSchema: z.object({
      task: taskSchema,
      replayed: z.boolean().describe("True when the idempotency key had already been used and nothing was written"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ title, idempotencyKey }) =>
    guard(deps, "create_task", () => {
      const { task, replayed } = deps.service.create({ title, idempotencyKey });

      return {
        text: replayed
          ? `Task #${task.id} already existed (idempotent replay): ${task.title} (${task.status}).`
          : `Task #${task.id} created: ${task.title} (${task.status}).`,
        structured: { task, replayed },
      };
    }),
);
```

**The description has four clauses, each doing a job.** This is the "description is the
prompt" principle made concrete:

| Clause | Purpose |
| :--- | :--- |
| "Adds one task to the board and returns it with a server-assigned id" | **What** it does, and that ids come from the server |
| "Use it when the user wants something remembered or scheduled" | **When** to reach for it |
| "Do not use it to change or remove an existing task — use complete_task or delete_task with an id from list_tasks" | **When not to** — and it names the alternative *and* where to get the id |
| "Pass idempotencyKey when a retry must not create a second task" | A non-obvious parameter, explained as a *situation* rather than a definition |

The third clause is the most valuable and the most commonly omitted. Without it, a model
asked to "mark the video task done" may reach for `create_task` because the word "task" is
in the tool name. Naming the sibling tools explicitly is disambiguation, and it is cheaper
than an evaluation set.

**`title` is `.min(1).max(120)` — matching the service exactly.** The service's `taskTitle`
is `z.string().trim().min(1).max(120)`. The tool's copy omits `.trim()` because the *model*
should not be taught to rely on trimming; the service normalises regardless. The bounds
must match, though, or the model would be told a 200-character title is fine and then
receive an `INVALID_INPUT` for it.

**`idempotencyKey` is optional and its description is a *use case*.** Compare
`"The idempotency key"` (useless) with `"Caller-generated key such as a request id.
Re-sending the same key returns the original task instead of creating another"` — which
states what it is, gives an example of where it comes from, and states the effect. A model
that reads that description can decide *when* to use it, which is the only thing that
matters.

**`outputSchema` declares `replayed`.** This is why the store bothered to report it
(Chapter 07): the flag is published to the client, so a host can distinguish a creation from
a replay without parsing prose. The `.describe()` explains the boolean's meaning, because
`replayed: true` alone is ambiguous — replayed *what*?

**The handler is three statements and no branches.** `deps.service.create(...)` either
returns a result or throws; the `replayed` ternary chooses between two *messages*, not
between two control flows. Note what is absent: no validation, no rate-limit check, no
timer, no counter, no `try`. All of that is in `guard`.

**`structured: { task, replayed }` matches the `outputSchema` exactly.** The SDK validates
this, and the schema is generated with `additionalProperties: false` — so an extra field
here would be a runtime failure, not a silent pass. That strictness is why `Task` has no
optional fields (Chapter 07): the shape of `structuredContent` must be predictable.

### Block 5 — `list_tasks`: the tool that makes the others safe

```ts
description:
  "Returns tasks with their ids, titles and statuses, optionally filtered by status. Read-only and safe to call at any time. Call it before complete_task or delete_task whenever an id is uncertain — never guess an id.",
inputSchema: z.object({
  status: z
    .enum(["PENDING", "COMPLETED"])
    .optional()
    .describe("Return only tasks in this state. Omit to read the whole board"),
}),
outputSchema: z.object({
  tasks: z.array(taskSchema),
  total: z.number().int().describe("Number of tasks in this result"),
}),
annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
```

Two phrases carry the weight. **"Read-only and safe to call at any time"** tells the model
it may call this freely — which matters, because a model that suspects a tool has side
effects will avoid calling it, and then guess an id. **"Never guess an id"** is the
instruction that prevents the single most likely failure in this server: the model inventing
`id: 1`.

`status` is an **enum, not a free string**, and Chapter 05 §5.4 is explicit about why: a
free-string filter has an infinite vocabulary, and `"done"`, `"Done"` and `"completed"`
would all fail validation with a message the model has to guess at. An enum makes the
permitted values part of the contract.

The `text` field branches on emptiness:

```ts
text: tasks.length === 0 ? "No tasks matched." : JSON.stringify(tasks),
```

An empty array serialises to `"[]"`, which is technically accurate and practically useless —
a model reading `[]` may wonder whether the call failed. A sentence removes the ambiguity.
For the non-empty case, the raw JSON is the honest choice: the model gets every field
including the ids, and nothing is lost to a summarisation the model did not ask for.

### Block 6 — `complete_task`: the state transition, pre-announced

```ts
description:
  "Marks one PENDING task as COMPLETED by id. Use it when work is finished; use delete_task to remove a task instead of completing it. Idempotent in intent, but completing an already-completed task returns a conflict — read the board rather than retrying.",
inputSchema: z.object({
  id: z.number().int().positive().describe("Id of the task to complete, as returned by list_tasks or create_task"),
}),
outputSchema: z.object({ task: taskSchema }),
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
```

Note the description **pre-announces the conflict behaviour**: "completing an
already-completed task returns a conflict — read the board rather than retrying". That is the
recovery sentence from `taskService.ts` (Chapter 08) surfaced in the *contract*, so a model
reading `tools/list` already knows how to handle the case before it hits it. This is the
difference between an error the model recovers from and an error it walks into.

**`idempotentHint: true` on a tool that can return `CONFLICT` is not a contradiction.** The
hint means "calling this twice does not produce two different effects" — which is true:
completing a task twice leaves it completed. The `CONFLICT` is about *reporting*, not about
state. And the host's retry policy (Chapter 17) reads this hint to decide that a transport
failure on `complete_task` is safe to retry, which is correct.

**`describe("… as returned by list_tasks or create_task")`** — the field description names
where a valid value comes from. That is a small thing with a large effect: the model's
cheapest path to a correct id is the one the description points at.

**The handler is three lines**, and the `CONFLICT` branch is nowhere in it:

```ts
async ({ id }) =>
  guard(deps, "complete_task", () => {
    const task = deps.service.complete({ id });
    return { text: `Task completed: #${task.id} ${task.title} (${task.status}).`, structured: { task } };
  }),
```

The `NOT_FOUND` and `CONFLICT` cases are handled by `taskService.complete` throwing, and the
throwing is mapped by `guard`. **A handler that contains no error handling is the symptom of
an error taxonomy that works.**

### Block 7 — `delete_task`: the destructive tool, and the annotation table

```ts
description:
  "Permanently removes one task by id. Irreversible — the task is gone and its id is never reused, so prefer complete_task when the user means 'finished' rather than 'remove'. Requires explicit user consent, which the host obtains before calling it.",
inputSchema: z.object({
  id: z.number().int().positive().describe("Id of the task to delete, as returned by list_tasks"),
}),
outputSchema: z.object({ deleted: taskSchema }),
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
```

Three things in this description are doing unusual work.

**"Irreversible — the task is gone and its id is never reused"** explains a consequence the
model cannot infer. It matters because a model that believes deletion is reversible will
delete casually; a model that knows the id is burned will prefer `complete_task` when it can.

**"prefer complete_task when the user means 'finished' rather than 'remove'"** is a
*disambiguation rule stated as user intent*. The model is not told which tool to call — it is
told which *user intention* maps to which tool. That framing generalises: intent-based
disambiguation survives paraphrase, whereas tool-name-based rules do not.

**"Requires explicit user consent, which the host obtains before calling it"** tells the model
that the host will intervene. This is a deliberate choice: the model is *informed* that a
consent gate exists. The alternative — leaving the model to discover it when a call is refused
— produces a model that retries, because it cannot distinguish "the user said no" from "the
tool is broken".

**The four annotations, and what each one claims:**

| Annotation | Value | What it tells a host |
| :--- | :--- | :--- |
| `readOnlyHint` | `false` | This changes state; do not treat it as a lookup |
| `destructiveHint` | `true` | Irreversible — this is the flag the consent gate reads |
| `idempotentHint` | `false` | A retry after a transport failure may not be satisfiable — do not retry |
| `openWorldHint` | `false` | It touches only this server's own data, not the outside world |

The full table for all four tools:

| Tool | readOnly | destructive | idempotent | openWorld |
| :--- | :---: | :---: | :---: | :---: |
| `create_task` | ✗ | ✗ | ✗ | ✗ |
| `list_tasks` | ✓ | ✗ | ✓ | ✗ |
| `complete_task` | ✗ | ✗ | ✓ | ✗ |
| `delete_task` | ✗ | **✓** | ✗ | ✗ |

**Every value is explicit — `false` is written out, never omitted.** Omitting a hint is legal
and would be read as `undefined`, which a host must then treat as *unknown* rather than *safe*.
Writing `false` means a host can read the table above without ambiguity, and it means adding a
fifth tool requires filling in four values rather than leaving them blank.

**`delete_task`'s handler is identical in shape to `complete_task`'s** — three lines, no error
handling. The difference between a safe tool and a dangerous one lives entirely in the
metadata (the description and the annotations) and in the host's policy (Chapter 15). **The
handler does not know it is dangerous**, and that is the correct design: a handler that
enforced its own consent would be a server deciding its own permissions, which is exactly the
confused-deputy mistake Chapter 08 warns about.

> **Annotations are hints, not enforcement.** The comment above `registerTools` says so
> directly: *"a host is expected to keep its own view, because a hostile server can mislabel
> its own tools."* `delete_task` could have declared `destructiveHint: false` and this server
> would still run — which is why the host's policy (Chapter 15) and its audit trail
> (Chapter 16) exist.

---

## 10.4 Run / verify

The catalogue the model receives, exactly as the host prints it:

```bash
npm run host | sed -n '5,15p'
```

```text
3. tools/list  -> 4 tools discovered
   complete_task  readOnly=false destructive=false idempotent=true
   create_task    readOnly=false destructive=false idempotent=false
   delete_task    readOnly=false destructive=true  idempotent=false
   list_tasks     readOnly=true  destructive=false idempotent=true

4. host policy -> 4 of 4 tools shown to the model
   auto     complete_task  no destructive hint
   auto     create_task    no destructive hint
   confirm  delete_task    destructiveHint is set: irreversible, so it needs explicit consent
   auto     list_tasks     readOnlyHint is set
```

Two facts are worth reading out of that block. `delete_task` is the **only** tool with
`destructive=true`, and the host's policy reacts to exactly that flag — the annotation table
from Block 7, being consumed downstream. And `list_tasks` is the only `readOnly=true`, which is
what makes it the tool the descriptions tell the model to call first.

Now look at the raw wire — what `tools/list` actually returns, with no host in between:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npm run server --silent 2>/dev/null | tail -1 \
  | python3 -c 'import json,sys; t=json.load(sys.stdin)["result"]["tools"][0]; print(json.dumps({k:t[k] for k in ("name","title","inputSchema","annotations")}, indent=2))'
```

```json
{
  "name": "create_task",
  "title": "Create Task",
  "inputSchema": {
    "type": "object",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "properties": {
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "description": "Short, human-readable title of the task to create"
      },
      "idempotencyKey": {
        "description": "Caller-generated key such as a request id. Re-sending the same key returns the original task instead of creating another",
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": ["title"]
  },
  "annotations": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  }
}
```

Every `.describe()` became a JSON Schema `description`, every `.min()`/`.max()` became
`minLength`/`maxLength`, and `.optional()` kept `idempotencyKey` out of `required`. Nothing
about `taskService`, the store or the error taxonomy appears — Chapter 05's boundary, visible
on the wire.

The `outputSchema` is stricter still. Its nested `task` object is emitted with
`"additionalProperties": false` and all five fields listed in `required` — the mechanical
reason `Task` (Chapter 07) has no optional fields. A `completedAt?` would appear in
`properties` but not `required`, so a `structuredContent` that omitted it would pass while one
that added an unexpected field would fail. Keeping every field always-present removes the whole
class of question.

Finally, confirm the **protocol-error** mechanism for an unknown tool — the other error path,
which never reaches a handler:

```bash
npx tsx -e '
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
(async () => {
  const client = new Client({ name: "probe", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "src/index.ts"], stderr: "ignore",
  }));
  try {
    await client.callTool({ name: "does_not_exist", arguments: {} });
    console.log("no error (unexpected)");
  } catch (error) {
    console.log("protocol error ->", error.message);
  }
  await client.close();
})();
'
```

```text
protocol error -> Tool does_not_exist not found
```

A **thrown** error, not an `isError: true` result — because nothing ran. Compare it with the
`NOT_FOUND` result from Chapter 08 (`isError=true No task with id 999. …`), which is a returned
value. Two mechanisms, two shapes, and the difference is whether the call happened.

---

## 10.5 Checkpoint

1. **The description is the prompt.** Four clauses: what, when, when not, and how to use the
   non-obvious parameter. It is the only thing telling the model when to pick this tool.
2. **One `guard()` owns rate limit, timeout, metrics, logging and error mapping** — in that
   order. No handler contains a `try`, a timer, a counter or a log call, and a fifth tool
   cannot forget any of them.
3. **Handlers throw, `guard` maps.** A handler with no error handling is the symptom of an error
   taxonomy that works.
4. **Every annotation is written out explicitly, including the `false`s.** A host reading the
   table must not have to guess whether `undefined` means safe.
5. **The handler does not know it is dangerous.** `delete_task`'s body is identical in shape to
   `complete_task`'s; the risk lives in the metadata and in the host's policy.
6. **`outputSchema` is validated with `additionalProperties: false`**, so `structuredContent`
   must match the declared shape exactly — which is why `Task` has no optional fields.
7. **`toToolError` turns anything unexpected into a retryable `UNAVAILABLE`**, never a protocol
   error. The call reached the handler, so the model is owed a result.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 09 — MCP: The Wiring Contract](./09_Mcp_Wiring_Contract.md)

**Next:** [Chapter 11 — MCP: Resources & Templates](./11_Mcp_Resources.md)






