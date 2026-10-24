# Chapter 14 — MCP: The Tools Primitive

> **Tools are the primitive where the MODEL holds the trigger.** A tool is a contract written for a reader who
> cannot read your code: the model sees exactly four things — `name`, `description`, `inputSchema` and, if you
> declare them, `outputSchema` and `annotations` — and **the description is the prompt, not documentation.**
> Everything you fail to say, the model will guess, confidently.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/mcp/tools.ts` (208 lines) |
| **Layer** | `mcp` — the first layer that imports the SDK |
| **Purpose** | Register four tools, each wrapped in the same four guards in the same order, and make `list_tasks` return a Resource's body verbatim. |
| **Exports** | `registerTools()` |
| **Lecture sections** | Ch01 §1.2–1.4 (tools), Ch02 §2.2/2.4 (descriptions, intent), Ch04 §"Authorisation and validation", Ch04 §"Freshness, caching and versioning" |
| **Runs** | `npm run lifecycle` steps 2 and 3 |

---

## Commands

```bash
# discovery, and the annotations a host policy reads
npm run lifecycle 2>/dev/null | sed -n '/^2\./,/^3\./p'

# the identity: a Tool and a Resource, byte-identical
npm run lifecycle 2>/dev/null | sed -n '/^3\./,/^4\./p'

# the raw tool listing over the wire
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

---

## The guard: four steps, one place

The header names the discipline:

> Every handler below is wrapped in the same four guards, in the same order, because **"production" is mostly the
> discipline of never making an exception**:
>
> ```text
> rate limit  →  validate  →  execute inside a timeout  →  map failure to a result
> ```

That is the shape of every tool handler in the file, and the reason it is a *shared function* rather than four
copies is stated on `guard` itself:

> A handler computes an *outcome*; this decides how it reaches the model. Doing it once, here, is why **none of the
> tools below contains a `try`/`catch`, a timer, a counter or a log call** — and why a fifth tool cannot forget one.

That last clause is the argument. The alternative — each handler doing its own rate limiting, timing and error
mapping — works until someone adds the fifth tool and forgets the timeout. A shared wrapper makes the omission
impossible, and it is why the four handlers below are each three to eight lines.

The four steps in order, and why the order is fixed:

| Step | What it does | Why it must be here |
| :--- | :--- | :--- |
| 1. Rate limit | `deps.limiter.check(\`tool:${tool}\`)` | Cheapest check first — a rejected call costs nothing |
| 2. Execute | `withTimeout(run, deps.toolTimeoutMs, tool, "tool")` | Validation happens *inside* the handler's service call |
| 3. Count + log | `tool.ok.*`, `tool.call` | Only on success, so the counters mean what they say |
| 4. Map failure | `toAppError` → `toolFailure` | **Never throws** — a failure becomes an `isError` result |

Step 2 is worth a note: validation is *not* a separate stage here, because it happens inside the service
(Chapter 09's `parseOrThrow`). The wrapper's `run` callback is the whole handler, and a validation failure throws a
`ToolError` that step 4 catches. So the four steps are the wrapper's, and validation is the handler's — which is
why the header lists it as a stage but the code does not show it separately.

---

## `src/mcp/tools.ts` — the full file

```ts
import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { URI_SCHEME } from "../config/constants.js";
import { ToolError, toolFailure, toolSuccess, toAppError, type ToolOutcome, type ToolResult } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import { taskSchema } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";

/**
 * Notes Ch01 §1.2–1.4 — **The Tools Primitive**, where the **model** holds the
 * trigger.
 *
 * A tool is a contract written for a reader who cannot read your code. The model
 * sees exactly four things — `name`, `description`, `inputSchema` and, if you
 * declare them, `outputSchema` and `annotations` — and **the description is the
 * prompt, not documentation.** Everything you fail to say, the model will guess,
 * confidently.
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
 * it once, here, is why none of the tools below contains a `try`/`catch`, a
 * timer, a counter or a log call — and why a fifth tool cannot forget one.
 */
async function guard<Structured>(
  deps: ServerDeps,
  tool: string,
  run: () => ToolOutcome<Structured> | Promise<ToolOutcome<Structured>>,
): Promise<ToolResult<Structured>> {
  const startedAt = performance.now();

  try {
    const limit = deps.limiter.check(`tool:${tool}`);

    if (!limit.allowed) {
      throw new ToolError(
        "LIMIT_EXCEEDED",
        `Rate limit reached for ${tool}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
        "Wait for the window to pass, or stop retrying and report the current state to the user.",
        true,
      );
    }

    const outcome = await withTimeout(run, deps.toolTimeoutMs, tool, "tool");

    deps.metrics.count(`tool.ok.${tool}`);
    deps.logger.info("tool.call", { tool, ms: Math.round(performance.now() - startedAt) });

    return toolSuccess(outcome);
  } catch (error) {
    const failure = toAppError("tool", error, tool);

    deps.metrics.count(`tool.error.${tool}`);
    deps.metrics.count(`tool.error.${tool}.${failure.code}`);
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

/** The resource whose body `list_tasks` returns. Named once, so the identity is checkable. */
const BACKLOG_URI = `${URI_SCHEME.task}://backlog`;


export function registerTools(server: McpServer, deps: ServerDeps): void {
  /**
   * Annotations are hints for host policy — never enforcement. They tell a host
   * which risk class a tool belongs to, and a host is expected to keep its own
   * view, because a server's own assessment of its danger is exactly the claim a
   * compromised server would lie about.
   */
  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Adds one task to the backlog. Use it when the user asks for something to be remembered or scheduled. Pass an idempotencyKey when a retry must not create a second task.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe("Short imperative title, e.g. 'Review pull request'"),
        priority: z.enum(["high", "normal"]).optional().describe("Importance. Defaults to normal"),
        projectId: z.string().optional().describe("Project slug, e.g. 'fde'. Defaults to 'inbox'"),
        owner: z.string().optional().describe("User id that owns it, e.g. '123'"),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Caller-supplied key. The same key never creates a second task"),
      }),
      outputSchema: z.object({
        task: taskSchema,
        replayed: z.boolean().describe("True when nothing was written"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, priority, projectId, owner, idempotencyKey }) =>
      guard(deps, "create_task", () => {
        const { task, replayed } = deps.tasks.create({ title, priority, projectId, owner, idempotencyKey });

        /**
         * A write moved the state the resources render from, so every cached
         * body is now wrong.
         *
         * Invalidating here — at the write, in one place — is what stops a
         * `task://backlog` read from serving yesterday's board. This is the
         * cost of caching resources at all, and paying it explicitly is the
         * whole difference between a cache and a bug (Notes Ch04 §"Freshness,
         * caching and versioning").
         */
        deps.resources.invalidate();

        return {
          text: replayed
            ? `Task #${task.id} already existed (idempotent replay): ${task.title} (${task.status}).`
            : `Task #${task.id} created: ${task.title} (${task.priority} priority, project ${task.projectId}).`,
          structured: { task, replayed },
        };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Returns every open task with its id, title, priority, project and owner. Read-only and safe to call at any time. Call it before complete_task or delete_task whenever an id is uncertain — never guess an id.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        tasks: z.array(taskSchema),
        total: z.number().int().describe("Number of open tasks in this result"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      guard(deps, "list_tasks", () => {
        const tasks = deps.tasks.open();

        /**
         * Notes Ch02 §2.4 — the teaching point of the whole lecture, made
         * literal: this tool returns **exactly** the body of the
         * `task://backlog` Resource, because it *is* that body.
         *
         * Same payload, different owner. The model decides to call this; the
         * application decides to read that. Nothing about the bytes
         * distinguishes them — which is precisely why the distinction cannot be
         * about the bytes. It is about **intent** (Notes Ch02 §2.3).
         */
        const { text } = deps.resources.read(BACKLOG_URI);

        return { text, structured: { tasks, total: tasks.length } };
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description:
        "Marks one PENDING task as COMPLETED by id. Use it when work is finished; use delete_task to remove a task instead of completing it. Idempotent in intent, but completing an already-completed task returns a conflict — read the board rather than retrying.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Id of the task to complete, as returned by list_tasks"),
      }),
      outputSchema: z.object({ task: taskSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(deps, "complete_task", () => {
        const task = deps.tasks.complete({ id });
        deps.resources.invalidate();

        return { text: `Task completed: #${task.id} ${task.title} (${task.status}).`, structured: { task } };
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
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
        const task = deps.tasks.remove({ id });
        deps.resources.invalidate();

        return { text: `Task deleted: #${task.id} ${task.title}.`, structured: { deleted: task } };
      }),
  );
}
```

### Block-by-block

**Block 1 — the imports (lines 1–8).**

```ts
import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { URI_SCHEME } from "../config/constants.js";
import { ToolError, toolFailure, toolSuccess, toAppError, type ToolOutcome, type ToolResult } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import { taskSchema } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";
```

Eight imports, and every one is load-bearing:

| Import | Used for |
| :--- | :--- |
| `performance` from `node:perf_hooks` | The elapsed-time measurement in `guard` |
| `McpServer` (**type only**) | The parameter type of `registerTools` |
| `zod/v4` | Every `inputSchema` and `outputSchema` |
| `URI_SCHEME` | Composing `task://backlog` from the named scheme |
| `core/errors.js` | The taxonomy, the two result constructors, and the two result *types* |
| `withTimeout` | The timeout guard |
| `taskSchema` | The shared `outputSchema` for task-returning tools |
| `ServerDeps` (**type only**) | The wiring contract |

Note that `McpServer` is a **type-only** import — the file never constructs a server, it registers onto one. That is
what lets `registerTools(server, deps)` be called with any `McpServer`, including one a test built.

And note the reuse: `taskSchema` comes from `taskService.ts` (Chapter 09), `URI_SCHEME` from `config/constants.ts`
(Chapter 02), `toolSuccess`/`toolFailure` from `core/errors.ts` (Chapter 05). This file declares no schemas of its
own except the two input schemas that are genuinely local to it. **The protocol layer describes; it does not
re-define.**

**Block 2 — the `guard` wrapper (lines 26–74).**

```ts
async function guard<Structured>(
  deps: ServerDeps,
  tool: string,
  run: () => ToolOutcome<Structured> | Promise<ToolOutcome<Structured>>,
): Promise<ToolResult<Structured>> {
  const startedAt = performance.now();

  try {
    const limit = deps.limiter.check(`tool:${tool}`);

    if (!limit.allowed) {
      throw new ToolError(
        "LIMIT_EXCEEDED",
        `Rate limit reached for ${tool}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
        "Wait for the window to pass, or stop retrying and report the current state to the user.",
        true,
      );
    }

    const outcome = await withTimeout(run, deps.toolTimeoutMs, tool, "tool");

    deps.metrics.count(`tool.ok.${tool}`);
    deps.logger.info("tool.call", { tool, ms: Math.round(performance.now() - startedAt) });

    return toolSuccess(outcome);
  } catch (error) {
    const failure = toAppError("tool", error, tool);

    deps.metrics.count(`tool.error.${tool}`);
    deps.metrics.count(`tool.error.${tool}.${failure.code}`);
    deps.logger.warn("tool.failure", { tool, code: failure.code, retryable: failure.retryable, message: failure.message });

    return toolFailure(failure);
  } finally {
    deps.metrics.observe(`tool.latency_ms.${tool}`, performance.now() - startedAt);
  }
}
```

Five sections, and each has a decision in it.

**The rate limit key is namespaced: `` `tool:${tool}` ``.** That is the namespacing Chapter 06 argued for, applied
per tool rather than per primitive. A burst of `list_tasks` calls therefore consumes only `tool:list_tasks`'s window
— so a model stuck in a `list_tasks` loop cannot starve `create_task`. Per-tool granularity is finer than per-
primitive and it is what makes the limit's blast radius one capability wide.

**The rate-limit failure is thrown as a `ToolError`, then caught below.** That looks circular and it is deliberate:
throwing means one `catch` block handles every failure path, so there is exactly one place where a failure is
mapped and counted. The alternative — an early `return toolFailure(...)` — would duplicate the metrics and logging
lines. One exit path, one place to change.

**`Math.ceil(limit.retryAfterMs / 1000)`** turns milliseconds into a whole number of seconds, rounding **up**.
Rounding up is the honest direction for a wait: 1.2 s becomes "2s", which will not disappoint. Rounding down would
produce "1s" and a caller that retried a moment too early.

**The timeout carries `origin: "tool"`**, which is the third positional argument after the label — `withTimeout(run,
ms, tool, "tool")`. That is what makes a timeout surface as an `isError` result rather than a protocol error
(Chapter 06).

**Success and failure are both counted, with different metric names:**

| Path | Counters | Log |
| :--- | :--- | :--- |
| Success | `tool.ok.{tool}` | `logger.info("tool.call", …)` |
| Failure | `tool.error.{tool}`, `tool.error.{tool}.{code}` | `logger.warn("tool.failure", …)` |
| Both | `tool.latency_ms.{tool}` (in `finally`) | — |

The `tool.error.{tool}.{code}` counter is the useful one: it breaks failures down by *class*, so `LIMIT_EXCEEDED`
spikes are distinguishable from `CONFLICT` spikes at a glance. And the latency observation is in `finally` for the
reason Chapter 04 established — a failure is a latency sample too, and it is the one you most need measured.

**The log level differs: `info` for success, `warn` for failure.** That is what makes `MCP_LOG_LEVEL=warn` produce
a useful stream: only failures, with their codes.

**And the return type is `Promise<ToolResult<Structured>>` — it never throws.** Every path returns a result. That
is the Chapter 05 rule for the tool primitive: a tool failure is a *result* (`isError: true`), not a protocol
error, because the model needs to read the recovery sentence and decide what to do next.

**Block 3 — `BACKLOG_URI`, the identity (lines 76–78).**

```ts
/** The resource whose body `list_tasks` returns. Named once, so the identity is checkable. */
const BACKLOG_URI = `${URI_SCHEME.task}://backlog`;
```

One constant, composed from the scheme rather than written as a string literal. *Named once, so the identity is
checkable* — the identity being that `list_tasks` and `task://backlog` return the same body. Because it is a single
named constant used in one place, a change to the scheme or the path is a change in one line.

**Block 4 — `registerTools` and the annotations note (lines 80–87).**

```ts
export function registerTools(server: McpServer, deps: ServerDeps): void {
  /**
   * Annotations are hints for host policy — never enforcement. They tell a host
   * which risk class a tool belongs to, and a host is expected to keep its own
   * view, because a server's own assessment of its danger is exactly the claim a
   * compromised server would lie about.
   */
```

One exported function taking `(server, deps)` — the contract from Chapter 13. The comment above the first
registration is the most security-relevant sentence in the file, and it is worth reading twice:

> Annotations are hints for host policy — **never enforcement**. They tell a host which risk class a tool belongs
> to, and a host is expected to keep its own view, because **a server's own assessment of its danger is exactly
> the claim a compromised server would lie about.**

That is the reason `host/policy.ts` (Chapter 20) keeps its own tier table. A server could declare
`destructiveHint: false` on a tool that deletes everything, and a host that trusted the annotation would show it to
the model without a consent gate. Annotations are *self-reported*, and self-reported risk is not a security
control.

What they *are* good for is a hint that a host can combine with its own knowledge: this host reads
`destructiveHint` and compares it against its own configuration, which is why flipping
`MCP_HOST_ALLOW_DESTRUCTIVE=false` hides `delete_task` from the model entirely. The annotation informs the
decision; the host makes it.

**Block 5 — `create_task` (lines 87–132).**

```ts
server.registerTool(
  "create_task",
  {
    title: "Create task",
    description:
      "Adds one task to the backlog. Use it when the user asks for something to be remembered or scheduled. Pass an idempotencyKey when a retry must not create a second task.",
    inputSchema: z.object({
      title: z.string().min(1).max(120).describe("Short imperative title, e.g. 'Review pull request'"),
      priority: z.enum(["high", "normal"]).optional().describe("Importance. Defaults to normal"),
      projectId: z.string().optional().describe("Project slug, e.g. 'fde'. Defaults to 'inbox'"),
      owner: z.string().optional().describe("User id that owns it, e.g. '123'"),
      idempotencyKey: z.string().optional().describe("Caller-supplied key. The same key never creates a second task"),
    }),
    outputSchema: z.object({
      task: taskSchema,
      replayed: z.boolean().describe("True when nothing was written"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ title, priority, projectId, owner, idempotencyKey }) =>
    guard(deps, "create_task", () => { ... }),
);
```

**The `description` is the prompt, and every sentence in it is an instruction.** Four clauses, four jobs:

| Clause | The job it does |
| :--- | :--- |
| *"Adds one task to the backlog."* | What it does — so the model knows when it applies |
| *"Use it when the user asks for something to be remembered or scheduled."* | **When** to reach for it |
| *"Pass an idempotencyKey when a retry must not create a second task."* | A non-obvious capability, named |
| *(implied by "Adds **one**")* | It does not batch — call it per task |

The third clause is the interesting one. `idempotencyKey` is a feature the model would never discover from the
schema alone — the schema says a string is accepted, not *why* you would send one. Without the sentence, the
feature exists and is never used, and the model creates duplicates on retry. **A capability a model cannot find is
a capability that does not exist.**

Compare the description with `list_tasks`'s, which ends with a much blunter instruction:

```text
Call it before complete_task or delete_task whenever an id is uncertain — never guess an id.
```

*"Never guess an id"* — an explicit prohibition, because id-guessing is the failure mode this tool set actually
has. The model has seen task #2 in a list; later it wants to complete "the pull request task" and might guess `2`
again. The instruction is there to stop it.

**Every field carries a `.describe()`, and each is a micro-prompt with a concrete example:**

| Field | Description | What it prevents |
| :--- | :--- | :--- |
| `title` | `Short imperative title, e.g. 'Review pull request'` | A paragraph-length title |
| `priority` | `Importance. Defaults to normal` | The model omitting it and worrying |
| `projectId` | `Project slug, e.g. 'fde'. Defaults to 'inbox'` | A display name like "FDE Team" |
| `owner` | `User id that owns it, e.g. '123'` | A username |
| `idempotencyKey` | `Caller-supplied key. The same key never creates a second task` | The retry-duplication bug |

The examples are doing real work. *"e.g. 'fde'"* tells the model the format is a **slug** without saying "must be a
slug"; *"e.g. '123'"* tells it `owner` is an **id**, not a name. And *"Defaults to 'inbox'"* means the model does
not have to invent a project — it can omit the field and get a sane answer, which is what the service's
`x === undefined ? undefined : parseOrThrow(...)` guard exists to support (Chapter 09).

**`annotations`: four booleans, and this tool's are all `false`.**

```ts
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
```

Read as a group they say: *this writes, it is not destructive, it is **not** idempotent, and it touches only local
state.* The `idempotentHint: false` is the honest one — `create_task` is *not* idempotent by default, because two
calls with no key create two tasks. It becomes idempotent only when the caller supplies a key, and the annotation
describes the default rather than the capability. A host that read `idempotentHint: true` would feel free to retry
a failed call automatically — which is exactly the duplicate-creation bug.

`openWorldHint: false` means the tool operates on a closed, local set of resources rather than reaching into an
open world (a web search, a filesystem). It is `false` for all four tools here, because the entire domain is the
in-process task board.

**The handler is five lines, plus a comment that matters:**

```ts
async ({ title, priority, projectId, owner, idempotencyKey }) =>
  guard(deps, "create_task", () => {
    const { task, replayed } = deps.tasks.create({ title, priority, projectId, owner, idempotencyKey });

    deps.resources.invalidate();

    return {
      text: replayed
        ? `Task #${task.id} already existed (idempotent replay): ${task.title} (${task.status}).`
        : `Task #${task.id} created: ${task.title} (${task.priority} priority, project ${task.projectId}).`,
      structured: { task, replayed },
    };
  }),
```

**No `try`/`catch`, no timer, no counter, no log call** — the guard's promise kept. The handler computes an
`ToolOutcome` (`text` + `structured`) and nothing else.

**`deps.resources.invalidate()` is the cache strategy, and the comment is the argument:**

> A write moved the state the resources render from, so every cached body is now wrong. Invalidating here — **at
> the write, in one place** — is what stops a `task://backlog` read from serving yesterday's board. This is the cost
> of caching resources at all, and **paying it explicitly is the whole difference between a cache and a bug**
> (Notes Ch04 §"Freshness, caching and versioning").

*At the write, in one place* is the design. There are three mutating tools and each calls `invalidate()` — so the
rule is "every writer invalidates", which is reviewable by looking at three call sites. The alternative — a TTL
that is short enough to be safe — is a cache that is mostly useless. Explicit invalidation is what lets the TTL be
30 seconds without risking stale reads on the path that matters.

**The two prose branches are the `replayed` flag reaching the model:**

```text
Task #5 created: IDEM (normal priority, project inbox).
Task #5 already existed (idempotent replay): IDEM (PENDING).
```

Different sentences, and the second is the one a retrying caller needs — it says *your original call landed*, which
is exactly the uncertainty a timeout creates. And note the second names the **status** rather than the priority: for
an existing task, what matters is its current state, not how it was created. The `structured` payload carries
`{ task, replayed }`, so a client gets both the object and the boolean — the prose is for the model, the structure
for the client.

**Block 6 — `list_tasks`, and the identity the whole lecture rests on (lines 134–165).**

```ts
server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description:
      "Returns every open task with its id, title, priority, project and owner. Read-only and safe to call at any time. Call it before complete_task or delete_task whenever an id is uncertain — never guess an id.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      tasks: z.array(taskSchema),
      total: z.number().int().describe("Number of open tasks in this result"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () =>
    guard(deps, "list_tasks", () => {
      const tasks = deps.tasks.open();

      const { text } = deps.resources.read(BACKLOG_URI);

      return { text, structured: { tasks, total: tasks.length } };
    }),
),
```

**`inputSchema: z.object({})`** — an empty object, not an omitted schema. The tool takes no arguments, and an empty
schema says so explicitly. An omitted `inputSchema` would mean "anything is accepted", which is a different claim.

**The description ends with the prohibition again** — *"never guess an id"* — and starts with *"Read-only and safe
to call at any time."* That phrase is what makes the model willing to call it: a model that suspects a tool has
side effects will avoid calling it speculatively, and this one is explicitly licensed for that.

**The annotations flip:** `readOnlyHint: true, idempotentHint: true`. This is the only tool of the four that is
read-only, and the only one whose retry is unambiguously safe. Those two booleans are what a host policy keys on —
`host/policy.ts` tiers this tool `auto` with the reason *"readOnlyHint is set"* (visible in lifecycle step 2).

**And then the three lines that are the lecture:**

```ts
const tasks = deps.tasks.open();

const { text } = deps.resources.read(BACKLOG_URI);

return { text, structured: { tasks, total: tasks.length } };
```

*The teaching point of the whole lecture, made literal: this tool returns **exactly** the body of the `task://backlog`
Resource, because it **is** that body.*

> Same payload, different owner. The model decides to call this; the application decides to read that. Nothing about
> the bytes distinguishes them — which is precisely why the distinction cannot be about the bytes. It is about
> **intent** (Notes Ch02 §2.3).

Read the mechanism precisely, because the strength of the claim depends on it. `deps.resources.read(BACKLOG_URI)` is
not a *copy* of the backlog renderer — it **is** the backlog renderer. `list_tasks` calls into the resource service,
which calls `renderText("backlog", …)`, which calls `taskLine` (Chapter 10). So there is exactly one function that
produces a backlog body, and two ways to reach it:

| Caller | How it reaches the body | Who decided |
| :--- | :--- | :--- |
| `tools/call list_tasks` | The model | The **model** |
| `resources/read task://backlog` | The application | The **application** |

Same bytes. So if the two ever disagreed, it would mean the renderer had changed under one of them — and the
lifecycle asserts they do not:

```ts
console.log(
  `   identical payloads: ${toolText === backlog.text ? "YES — the same bytes" : "NO — the renderers have drifted"}.`
);
```

That assertion is a *test of the lecture's own claim*, run on every `npm run lifecycle`. It is the reason the
walkthrough is worth running rather than reading.

One thing worth noting about the structured payload: `tasks` comes from `deps.tasks.open()` (the service, giving
typed `Task[]`) while `text` comes from the resource renderer. So the tool's `structuredContent` is a typed array
validated against `outputSchema`, and its `content` is prose produced by the *resource* layer. Two different
renderings of one truth, in one result — which is Ch03 §3.7's point, visible in a single return statement.

**Block 7 — `complete_task` (lines 167–186).**

```ts
server.registerTool(
  "complete_task",
  {
    title: "Complete task",
    description:
      "Marks one PENDING task as COMPLETED by id. Use it when work is finished; use delete_task to remove a task instead of completing it. Idempotent in intent, but completing an already-completed task returns a conflict — read the board rather than retrying.",
    inputSchema: z.object({
      id: z.number().int().positive().describe("Id of the task to complete, as returned by list_tasks"),
    }),
    outputSchema: z.object({ task: taskSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) =>
    guard(deps, "complete_task", () => {
      const task = deps.tasks.complete({ id });
      deps.resources.invalidate();

      return { text: `Task completed: #${task.id} ${task.title} (${task.status}).`, structured: { task } };
    }),
),
```

**The description is a masterclass in disambiguation, and it does three separate jobs:**

1. **It distinguishes itself from `delete_task`:** *"use delete_task to remove a task instead of completing it."*
   The two tools take the same argument and look similar, and a model with only `title: "Complete task"` might reach
   for `complete_task` when the user says "get rid of this". Naming the alternative explicitly is what prevents that.
2. **It names the conflict in advance:** *"completing an already-completed task returns a conflict — read the board
   rather than retrying."* The model is told the failure *and* the recovery before it ever hits it. That is the
   description doing the work a recovery sentence would otherwise have to do after the fact.
3. **It explains the `idempotentHint: true`:** *"Idempotent in intent"* — a careful phrase. The *intent* is
   idempotent (completing twice has one outcome) while the *call* is not (the second returns a conflict). The
   annotation says `true` because the underlying operation is idempotent; the description carries the nuance the
   boolean cannot.

That third point is genuinely subtle and it is exactly the kind of thing a description must say because the schema
cannot. `idempotentHint: true` means "retrying is safe"; the truth is "retrying is safe in effect, and will return
a conflict you should report rather than retry". The annotation tells a host it may retry; the description tells the
model what it will see.

**The `id` field's description is a pointer:** *"Id of the task to complete, **as returned by list_tasks**."* Not
"the task id" — a *provenance* instruction, telling the model where to get a valid value. Together with
`list_tasks`'s "never guess an id", the two descriptions form a complete protocol: *get it from there, do not
invent it.*

**The handler invalidates the cache, like every writer.** `deps.tasks.complete({ id })` then
`deps.resources.invalidate()` — two lines, in that order, because invalidating before the write would let a
concurrent read repopulate the cache with pre-write state.

**Block 8 — `delete_task` (lines 188–207).**

```ts
server.registerTool(
  "delete_task",
  {
    title: "Delete task",
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
      const task = deps.tasks.remove({ id });
      deps.resources.invalidate();

      return { text: `Task deleted: #${task.id} ${task.title}.`, structured: { deleted: task } };
    }),
),
```

**The only tool with `destructiveHint: true`**, and the description is written accordingly:

| Phrase | Its job |
| :--- | :--- |
| *"Permanently removes one task by id."* | States irreversibility up front |
| *"the task is gone and **its id is never reused**"* | A consequence the model cannot infer |
| *"prefer complete_task when the user means 'finished' rather than 'remove'"* | The correct alternative |
| *"Requires explicit user consent, which **the host obtains** before calling it."* | Names the gate and whose job it is |

The *"its id is never reused"* clause is the one a reader would not think to write. It tells the model that a
deleted id will not come back — so a stale reference in the conversation is permanently invalid, not merely stale.
And *"the host obtains"* is a precise assignment of responsibility: consent is not the server's to gather and not
the model's to assume. It is the host's, which is why `host/policy.ts` has a `ConsentHandler` (Chapter 20) and why
the lifecycle prints *"? consent DECLINED for delete_task(…)"* when the scripted gate says no.

**The annotations are the mirror image of `list_tasks`:** `destructiveHint: true, idempotentHint: false`. Both are
correct. Deleting is destructive, and deleting twice is *not* idempotent in the sense that matters — the second call
returns `NOT_FOUND` rather than succeeding, and more importantly, a retry after a timeout cannot distinguish "the
first call worked" from "it never ran". So a host must not auto-retry it, which is exactly what
`idempotentHint: false` tells it.

**`outputSchema` returns `{ deleted: taskSchema }`** — the *removed* task, named `deleted`. That is why
`TaskStore.remove` returns the task rather than a boolean (Chapter 07): so the reply can name what was destroyed.
A client that only got `{ ok: true }` would have no way to show the user what they lost.

And the prose is deliberately terse: *"Task deleted: #2 Review pull request."* No priority, no project — the task no
longer exists, so its metadata is history. Compare `create_task`'s reply, which names priority and project because
those are the *current* facts. **Each tool's prose names what is still true.**

---

## Run / verify

### 1. Discovery, and the annotations a host policy reads

```bash
npm run lifecycle 2>/dev/null | sed -n '/^2\./,/^3\./p'
```

```text
2. tools/list  -> 4 discovered, 4 shown to the model
   auto     create_task     no destructive hint
   auto     list_tasks      readOnlyHint is set
   auto     complete_task   no destructive hint
   confirm  delete_task     destructiveHint is set: irreversible, so it needs explicit consent
```

Four tools discovered, and each row is the host's *own* verdict — not the server's. The `tier` column is decided by
`host/policy.ts` reading the annotations, and the `reason` column names which annotation it read:

| Tool | Tier | The reason, and which annotation produced it |
| :--- | :--- | :--- |
| `create_task` | `auto` | *no destructive hint* — `destructiveHint: false` |
| `list_tasks` | `auto` | *readOnlyHint is set* — the strongest signal |
| `complete_task` | `auto` | *no destructive hint* |
| `delete_task` | **`confirm`** | *destructiveHint is set: irreversible, so it needs explicit consent* |

**Only `delete_task` needs confirmation**, and only because of one annotation. That is the design working: the
server describes honestly, and the host decides — which is why the comment at the top of this file insists
annotations are *hints, never enforcement*.

And the tier is only half the story. Flip the configuration and the tool does not merely need confirmation — it
never reaches the model at all:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run lifecycle 2>/dev/null | sed -n '/^2\./,/^3\./p'
```

```text
2. tools/list  -> 4 discovered, 3 shown to the model
   auto     create_task     no destructive hint
   auto     list_tasks      readOnlyHint is set
   auto     complete_task   no destructive hint
   denied   delete_task     destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false
```

**`4 discovered, 3 shown`** — the tool is registered, discovered, and then *not shown*. That is the strongest form of
host policy: the model cannot call what it has never seen.

### 2. The identity — a Tool and a Resource, byte-identical

```bash
npm run lifecycle 2>/dev/null | sed -n '/^3\./,/^4\./p'
```

```text
3. intent      -> list_tasks (Tool) and task://backlog (Resource), side by side
   tools/call list_tasks      -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) - [normal] Review pull request  …(+91)
   resources/read task://backlog -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) - [normal] Review pull request  …(+91)
   identical payloads: YES — the same bytes. The difference is who decided to fetch them, not what came back.
```

**The two payloads are byte-identical**, and the third line is a live assertion rather than a description:

```ts
toolText === backlog.text ? "YES — the same bytes" : "NO — the renderers have drifted"
```

If a future change made `list_tasks` format its own output, this line would read `NO — the renderers have drifted`
on the next run. The claim is therefore *tested*, not merely stated — which is what makes it safe to build a lecture
around.

And the mechanism is what gives the claim its force. `list_tasks` does not format a task list; it calls
`deps.resources.read(BACKLOG_URI)`. One renderer (`renderText("backlog")` → `taskLine`), two entry points:

```text
model  ──tools/call list_tasks──────────┐
                                        ├──▶  renderText("backlog")  ──▶  the same bytes
app    ──resources/read task://backlog──┘
```

So the difference between the two is **not** in the payload. It is in the arrow at the left — who decided to fetch.
That is Ch02 §2.3's argument, and this is the code that makes it executable rather than rhetorical.

### 3. The tool failures, as results

From Chapter 05's verification, restated here because this is where they are produced:

```text
1st complete_task #2 → {"content":[…"Task completed: #2 Review pull request (COMPLETED)."…],"structuredContent":{…}}
2nd complete_task #2 → {"content":[…"Task #2 is already COMPLETED. Nothing to do — report the current state instead of retrying."…],"isError":true}
delete_task 999      → {"content":[…"No task with id 999. Call list_tasks to read the exact ids, then retry."…],"isError":true}
```

The first line has `structuredContent` and no `isError`. The other two have `isError: true` and **no**
`structuredContent` — because `toolFailure` returns `ToolResult<never>` (Chapter 05), and a failure has no typed
payload.

All three are HTTP 200 and valid `tools/call` replies. **The guard never throws**, which is what the four-step
contract buys: a failure reaches the model as content it can read and act on, rather than as a broken call.

### 4. The rate limiter, per tool

From Chapter 06's verification — the key is `tool:list_tasks`, so the limit is scoped to one capability:

```text
call 1: isError=false Open tasks: 3
call 2: isError=false Open tasks: 3
call 3: isError=true  Rate limit reached for list_tasks; a slot frees in 60s. …
call 4: isError=true  Rate limit reached for list_tasks; a slot frees in 60s. …
```

A `list_tasks` loop cannot starve `create_task`, because they occupy different keys. That is the namespacing from
Chapter 06, applied at the finest useful granularity.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **What are the four guards, in order, and why is the order fixed?**
   Rate limit → execute inside a timeout → count and log → map failure to a result. The rate limit is first because
   it is the cheapest rejection; the failure mapping is last because it must catch everything. One wrapper, so a
   fifth tool cannot forget a step.

2. **Why is `list_tasks` byte-identical to `task://backlog`?**
   Because it calls `deps.resources.read(BACKLOG_URI)` — the *same renderer*, not a copy of it. One function produces
a backlog body and two callers reach it, which is why the difference between a Tool and a Resource cannot be about
the payload. It is about who decided to fetch.

3. **What does the `guard` buy, concretely?**
   No tool handler contains a `try`/`catch`, a timer, a counter or a log call. A handler computes a `ToolOutcome`
   (`text` + `structured`) and the wrapper decides how it reaches the model.

4. **Why are annotations "hints, never enforcement"?**
   Because they are self-reported, and *a server's own assessment of its danger is exactly the claim a compromised
   server would lie about.* `host/policy.ts` keeps its own tier table and reads the annotations as input to its own
   decision.

5. **What does `idempotentHint: true` on `complete_task` mean, given that a second call returns a conflict?**
   The underlying operation is idempotent (completing twice has one outcome), so a host may retry it. The
   *description* carries the nuance the boolean cannot: the second call returns a conflict you should report rather
   than retry.

6. **Why does `delete_task` have `idempotentHint: false`?**
   Because a retry after a timeout cannot distinguish "the first call worked" from "it never ran" — the second call
   returns `NOT_FOUND` either way. So a host must not auto-retry a destructive call.

7. **Why does every mutating tool call `deps.resources.invalidate()`?**
   Because a write moved the state the resources render from, so every cached body is wrong. Doing it at the write,
   in one place, is what stops `task://backlog` from serving a stale board — and it is what lets the TTL be 30
   seconds without risking stale reads on the path that matters.

8. **What is the rate-limit key, and why is it per tool rather than global?**
   `` `tool:${tool}` `` — so a burst of one capability consumes only its own window. A global key would let a model
   stuck in a `list_tasks` loop starve every other tool the server offers.

---

**[← Chapter 13: The MCP Wiring Contract](./13_Mcp_Wiring_Contract.md)** · **[Chapter 15: The Resources Primitive →](./15_Mcp_Resources.md)**
