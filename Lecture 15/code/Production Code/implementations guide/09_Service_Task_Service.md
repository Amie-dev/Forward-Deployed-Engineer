# Chapter 09 — Service: Validated Business Logic

> **The execution layer.** The model never sees this file — it sees only the contract in
> `src/mcp/tools.ts`. Two rules make the layer trustworthy: **re-validate everything** (the
> `inputSchema` the host showed the model is a hint to the model, not a guarantee to you), and **a
> failure is an instruction** (every throw carries a recovery sentence, because on the tool path that
> text lands in the model's context and decides its next move).

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/taskService.ts` (246 lines) |
| **Layer** | `services` — imports `zod`, `core/errors.js` and `domain/taskStore.js`. No protocol, no transport. |
| **Purpose** | Validate every input, apply the business rules, and return **typed facts rather than prose**. |
| **Exports** | `taskTitle`, `taskId`, `taskPriority`, `statusFilter`, `idempotencyKey`, `projectId`, `userId`, `taskSchema`, `TaskStats`, `TaskService`, `coercePositiveInt()`, `createTaskService()` |
| **Lecture sections** | Ch03 §3.7 (one truth, three renderings), Ch04 §"Validate and constrain dynamic URIs", Ch02 §2.2 (descriptions as prompts) |
| **Runs** | `npm run lifecycle` steps 3 and 5 · any tool call over HTTP |

---

## Commands

```bash
# a valid call and an invalid one, side by side
curl -s 'http://127.0.0.1:8080/read?uri=task://tasks/abc'   # the slug/int validators at work
curl -s 'http://127.0.0.1:8080/read?uri=task://projects/fde'

# the three Resource views this service provides
npm run lifecycle 2>/dev/null | sed -n '/^5\./,/^6\./p'
```

---

## The two rules, and the third decision

The header states the rules, and they are the reason this file exists at all rather than the tools
calling the store directly.

**Rule 1 — re-validate everything.**

> The `inputSchema` the host showed the model is a hint to the model, not a guarantee to you: a buggy
> or hostile client can send anything it likes. The validation here is the only validation that
> counts.

This is worth being blunt about, because the opposite assumption is the natural one. You *did* declare
`inputSchema: z.object({ id: z.number().int().positive() })` on the tool. The SDK does validate against
it. So why validate again?

Because **you are not the only caller of this service.** The tool layer is one entry point; the
Resource layer is another. `task://tasks/{taskId}` reaches the same store through
`coercePositiveInt` and the URI template grammar, where the value arrives as the *string* `"1"`. The
ACL reaches `find()` with whatever came off a header. And the validation the SDK performs is a
*protocol* concern — it produces a JSON-RPC error for a malformed `tools/call`. A service that assumed
its inputs were already clean would be correct only for the one caller that went through that path.

The signature makes the claim checkable. Look at the interface:

```ts
create(input: {
  title: unknown;
  priority?: unknown;
  projectId?: unknown;
  owner?: unknown;
  idempotencyKey?: unknown;
}): CreateTaskResult;
```

Every field is typed **`unknown`**, not `string`. That is not laziness — it is the type system being
honest about the situation. A value that arrived over a wire is `unknown` until something proves
otherwise, and declaring it `string` would be an assertion the compiler then helps you *keep* rather
than check. With `unknown`, every field must pass through a schema before it can be used, and the
compiler enforces it.

**Rule 2 — a failure is an instruction.**

> Every throw carries a recovery sentence, because on the tool path the text ends up in the model's
> context and the model's next move is decided by it.

That is Chapter 05's taxonomy applied at the business layer. A `ToolError` is constructed with three
things — code, message, recovery — and the recovery is written for a model to act on. The `complete`
method below has two failure branches and both are instructions:

```text
NOT_FOUND  → "Call list_tasks to read the exact ids, then retry."
CONFLICT   → "Nothing to do — report the current state instead of retrying."
```

**The third decision — typed facts, not prose.** The header is explicit that this is a choice:

> This service deliberately returns **typed facts, not prose**. Turning a task list into a paragraph is
> the resource layer's job (Notes Ch03 §3.7: the same data is a tool result, a text resource and a JSON
> document, and those are three different renderings of one truth).

So `list()` returns `Task[]`, not a formatted string. `stats()` returns a `TaskStats` object, not a
summary paragraph. The prose lives in the renderers — `resourceService` for Resources, the tool
handlers for tool results — and it can differ between them while the data underneath stays one truth.

That is precisely what makes the lecture's central demonstration possible: `list_tasks` and
`task://backlog` return byte-identical bodies *because they render the same typed fact with the same
renderer*. A service that returned prose would have forced the two to duplicate formatting, and they
would have drifted.

---

## `src/services/taskService.ts` — the full file

```ts
import * as z from "zod/v4";
import { ToolError } from "../core/errors.js";
import type { CreateTaskResult, Task, TaskPriority, TaskStatus, TaskStore } from "../domain/taskStore.js";

/**
 * The execution layer.
 *
 * The model never sees this file. It sees only the contract in
 * `src/mcp/tools.ts`. Two rules make this layer trustworthy:
 *
 *  1. **Re-validate everything.** The `inputSchema` the host showed the model is
 *     a hint to the model, not a guarantee to you: a buggy or hostile client can
 *     send anything it likes. The validation here is the only validation that
 *     counts.
 *
 *  2. **A failure is an instruction.** Every throw carries a recovery sentence,
 *     because on the tool path the text ends up in the model's context and the
 *     model's next move is decided by it.
 *
 * This service deliberately returns **typed facts, not prose**. Turning a task
 * list into a paragraph is the resource layer's job (Notes Ch03 §3.7: the same
 * data is a tool result, a text resource and a JSON document, and those are
 * three different renderings of one truth).
 */

/** The single source of truth for what a title may be. */
export const taskTitle = z
  .string()
  .trim()
  .min(1, "title must not be empty")
  .max(120, "title must be at most 120 characters");

export const taskId = z.number().int().positive("id must be a positive integer");

export const taskPriority = z.enum(["high", "normal"]);

export const statusFilter = z.enum(["PENDING", "COMPLETED"]);

export const idempotencyKey = z.string().trim().min(1).max(64, "idempotencyKey must be at most 64 characters");

/** Notes Ch04 §"Validate and constrain dynamic URIs" — a project id is a slug, not free text. */
export const projectId = z
  .string()
  .trim()
  .min(1, "projectId must not be empty")
  .max(40, "projectId must be at most 40 characters")
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "projectId must be a slug: letters, digits, dash or underscore");

/** The `{userId}` template variable. Kept deliberately narrow. */
export const userId = z
  .string()
  .trim()
  .min(1, "userId must not be empty")
  .max(40, "userId must be at most 40 characters")
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "userId must be a slug: letters, digits, dash or underscore");

/** The `outputSchema` shared by the tools that return a task — one definition, not four. */
export const taskSchema = z.object({
  id: z.number().int().positive().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]).describe("Current lifecycle state"),
  priority: z.enum(["high", "normal"]).describe("Importance, as set at creation"),
  projectId: z.string().describe("Project the task belongs to"),
  owner: z.string().describe("User id that owns the task"),
  createdAt: z.string().describe("ISO 8601 timestamp of creation"),
  updatedAt: z.string().describe("ISO 8601 timestamp of the last change"),
});

export interface TaskStats {
  total: number;
  pending: number;
  completed: number;
  highPriority: number;
  projects: string[];
}

export interface TaskService {
  create(input: {
    title: unknown;
    priority?: unknown;
    projectId?: unknown;
    owner?: unknown;
    idempotencyKey?: unknown;
  }): CreateTaskResult;
  list(input?: { status?: unknown }): Task[];
  /** Completes a pending task. Already-completed is a `CONFLICT`, not a retry. */
  complete(input: { id: unknown }): Task;
  /** Destructive and irreversible. */
  remove(input: { id: unknown }): Task;
  /** Non-throwing lookup, for callers that own their own not-found handling. */
  find(id: unknown): Task | undefined;
  /** Open work, optionally narrowed to one owner — the `task://backlog` view. */
  open(owner?: string): Task[];
  /** Every task in one project — the `task://projects/{projectId}` view. */
  inProject(projectId: string): Task[];
  /** Every task one user owns — the `user://{userId}/profile` view. */
  ownedBy(owner: string): Task[];
  stats(): TaskStats;
}

/**
 * Parses, or throws a `ToolError` whose message names the fault and whose
 * recovery sentence names the fix. This one helper is why no service method
 * below contains a validation branch.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, hint: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");

    throw new ToolError("INVALID_INPUT", `Invalid input — ${detail}.`, hint);
  }

  return parsed.data;
}

/**
 * Non-throwing, **coercing** lookup for the resource path.
 *
 * URI template variables arrive as strings — the template grammar has no types —
 * so `task://tasks/1` hands us `"1"`, not `1`. The tool path stays strict on
 * purpose (the model is given a numeric schema and must honour it); this path has
 * to meet the URI where it actually is. The coercion is bounded and positive, so
 * it is a parse rather than a permissive `Number()`.
 */
export function coercePositiveInt(value: unknown): number | undefined {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function createTaskService(store: TaskStore): TaskService {
  const openTasks = (tasks: readonly Task[]): Task[] => tasks.filter((task) => task.status === "PENDING");

  return {
    create({ title, priority, projectId: project, owner, idempotencyKey: key }) {
      const cleanTitle = parseOrThrow(
        taskTitle,
        title,
        "Send a non-empty title of at most 120 characters.",
      );

      const cleanPriority =
        priority === undefined
          ? undefined
          : parseOrThrow(taskPriority, priority, 'Set priority to "high" or "normal", or omit it.');

      const cleanProject =
        project === undefined
          ? undefined
          : parseOrThrow(projectId, project, 'Use a short slug such as "fde", or omit it.');

      const cleanOwner =
        owner === undefined ? undefined : parseOrThrow(userId, owner, 'Use a short user id such as "123", or omit it.');

      const cleanKey =
        key === undefined
          ? undefined
          : parseOrThrow(idempotencyKey, key, "Send a key of at most 64 characters, or omit it entirely.");

      return store.create({
        title: cleanTitle,
        priority: cleanPriority,
        projectId: cleanProject,
        owner: cleanOwner,
        idempotencyKey: cleanKey,
      });
    },

    list(input = {}) {
      const filter = parseOrThrow(
        statusFilter.optional(),
        input.status,
        'Filter with "PENDING" or "COMPLETED", or omit the filter to read the whole board.',
      );

      const tasks = store.list();
      return filter === undefined ? tasks : tasks.filter((task) => task.status === filter);
    },

    complete({ id }) {
      const value = parseOrThrow(taskId, id, "Call list_tasks to read the exact ids, then retry.");
      const task = store.get(value);

      if (task === undefined) {
        throw new ToolError("NOT_FOUND", `No task with id ${value}.`, "Call list_tasks to read the exact ids, then retry.");
      }

      if (task.status === "COMPLETED") {
        // A conflict, not a failure to retry: the requested state already holds,
        // so retrying would only burn a call to reach the same conclusion.
        throw new ToolError(
          "CONFLICT",
          `Task #${task.id} is already COMPLETED.`,
          "Nothing to do — report the current state instead of retrying.",
        );
      }

      const updated = store.update(task.id, (current) => {
        current.status = "COMPLETED";
      });

      return updated ?? task;
    },

    remove({ id }) {
      const value = parseOrThrow(taskId, id, "Call list_tasks to read the exact ids, then retry.");
      const task = store.remove(value);

      if (task === undefined) {
        throw new ToolError("NOT_FOUND", `No task with id ${value}.`, "Call list_tasks to read the exact ids, then retry.");
      }

      return task;
    },

    find(id) {
      const value = coercePositiveInt(id);
      return value === undefined ? undefined : store.get(value);
    },

    open: (owner) => {
      const tasks = openTasks(store.list());
      return owner === undefined ? tasks : tasks.filter((task) => task.owner === owner);
    },

    inProject: (project) => store.list().filter((task) => task.projectId === project),

    ownedBy: (owner) => store.list().filter((task) => task.owner === owner),

    stats() {
      const tasks = store.list();
      const pending = openTasks(tasks);

      return {
        total: tasks.length,
        pending: pending.length,
        completed: tasks.length - pending.length,
        highPriority: pending.filter((task) => task.priority === "high").length,
        projects: [...new Set(tasks.map((task) => task.projectId))].sort(),
      };
    },
  };
}
```

### Block-by-block

**Block 1 — the field schemas (lines 25–54).**

```ts
export const taskTitle = z
  .string()
  .trim()
  .min(1, "title must not be empty")
  .max(120, "title must be at most 120 characters");

export const taskId = z.number().int().positive("id must be a positive integer");

export const taskPriority = z.enum(["high", "normal"]);
export const statusFilter = z.enum(["PENDING", "COMPLETED"]);
export const idempotencyKey = z.string().trim().min(1).max(64, "idempotencyKey must be at most 64 characters");
```

Five schemas, **exported**, and that is the point: each is the single source of truth for one field, and
four different files import them.

| Schema | Imported by | Why it must be shared |
| :--- | :--- | :--- |
| `taskTitle` | `mcp/tools.ts` (input schema) | The model must be told the same limit the service enforces |
| `taskId` | `mcp/tools.ts` | Same |
| `taskPriority` | `mcp/tools.ts` | Same |
| `projectId` | `resourceService.ts`, `mcp/resources.ts` | A URI variable and a tool argument must obey one rule |
| `userId` | `resourceService.ts`, `host/policy.ts` | The ACL's subject and the URI variable are the same thing |

If the tool declared `max(80)` while the service enforced `max(120)`, the model would be told a limit
that does not exist — a description that lies about the contract. Sharing the schema is what makes
*"the description is the prompt"* (Ch02 §2.2) true rather than aspirational.

Two details inside `taskTitle`: `.trim()` runs **before** `.min(1)`, so a title of `"   "` is rejected as
empty rather than accepted as three characters. Zod applies refinements in chain order, so the order is
the semantics.

**Block 2 — the two URI-variable schemas (lines 36–54).**

```ts
export const projectId = z
  .string()
  .trim()
  .min(1, "projectId must not be empty")
  .max(40, "projectId must be at most 40 characters")
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "projectId must be a slug: letters, digits, dash or underscore");
```

The comment above it places it: *Notes Ch04 §"Validate and constrain dynamic URIs" — a project id is a
slug, not free text.*

This is the schema that produced the 400 in Chapter 08's template-grammar test. `task://projects/my%20project`
*matched* the template — `([^/]+)` accepts anything without a slash — and then this regex rejected the
decoded `"my project"` because a slug may not contain a space.

The regex is worth reading carefully:

| Part | Means |
| :--- | :--- |
| `^[a-z0-9]` | Must **start** with a letter or digit — so no leading dash |
| `[a-z0-9_-]*` | Then any mix of letters, digits, `_`, `-` |
| `$` | And nothing else — no `/`, no `.`, no space, no `%` |
| `i` flag | Case-insensitive |

The leading-character rule is what stops `..`, `-`, and `.hidden`. Combined with the template's
`[^/]+`, the two checks mean a resolved project id can never contain a path separator, a parent
directory reference, or whitespace. Neither check alone would be sufficient — the template cannot
express "slug", and the regex cannot express "one segment".

`userId` (lines 47–54) is the same shape, and its comment names the reason it is not more permissive:
*The `{userId}` template variable. Kept deliberately narrow.* A user id that could contain arbitrary
text would be a user id that could be confused with another, and this value is the ACL's subject — the
one field where an ambiguity is a security bug.

**Block 3 — `taskSchema`, the output contract (lines 56–67).**

```ts
export const taskSchema = z.object({
  id: z.number().int().positive().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]).describe("Current lifecycle state"),
  priority: z.enum(["high", "normal"]).describe("Importance, as set at creation"),
  projectId: z.string().describe("Project the task belongs to"),
  owner: z.string().describe("User id that owns the task"),
  createdAt: z.string().describe("ISO 8601 timestamp of creation"),
  updatedAt: z.string().describe("ISO 8601 timestamp of the last change"),
});
```

*The `outputSchema` shared by the tools that return a task — one definition, not four.*

Three things are happening:

**1. It is the output contract, declared in the service.** Four tools return a task (`create_task`,
`complete_task`, `delete_task`, and `list_tasks` inside an array). Each declares `outputSchema`
referencing this one object, so the shape the client can validate against is identical across all four.
The SDK validates tool output against the declared schema, which means a handler that accidentally
returned a `Task` with a missing field fails at the boundary rather than confusing a client.

**2. `.describe()` on every field, and those descriptions reach the model.** Zod's `.describe()`
becomes JSON Schema `description`, which is part of what the model receives. So
`"Server-assigned task id"` is not a code comment — it is prompt text. That is why they read as
instructions to a reader rather than as type documentation:

| Field | Description | What it tells the model |
| :--- | :--- | :--- |
| `id` | "Server-assigned task id" | *You do not choose this; read it from a list* |
| `title` | "Exact task title" | *Do not paraphrase it* |
| `priority` | "Importance, as set at creation" | *It is not recomputed* |
| `createdAt` | "ISO 8601 timestamp of creation" | *The format, so it can be parsed* |

**3. `z.string()` for the timestamps, not `z.date()`.** The wire format is a string, and the schema
describes the wire. Declaring `z.date()` would describe an object the JSON never contains.

Note this schema is also what makes the *identical payload* demonstration hold: the same `Task` objects
serialise to the same JSON whether the caller was a tool or a renderer.

**Block 4 — `TaskStats` and the `TaskService` interface (lines 69–95).**

```ts
export interface TaskStats {
  total: number;
  pending: number;
  completed: number;
  highPriority: number;
  projects: string[];
}
```

Five aggregate numbers, and each has a named reader:

| Field | Reader |
| :--- | :--- |
| `total` | `task://summary` — "4 tasks" |
| `pending` | `task://summary`, `task://backlog` header |
| `completed` | `task://summary` |
| `highPriority` | `task://summary` — and the guidelines' "how many high-priority tasks a day may hold" |
| `projects` | the `project` template's `list` hook (Chapter 15) **and** `completionsFor` |

That last one is a nice economy: `projects` serves as the summary's project list, as the enumeration of
`task://projects/{projectId}` instances, *and* as the completion suggestions for the `projectId`
variable. One computed field, three consumers — which is why it is computed once in `stats()` rather
than in each of them.

```ts
export interface TaskService {
  create(input: { title: unknown; priority?: unknown; ... }): CreateTaskResult;
  list(input?: { status?: unknown }): Task[];
  complete(input: { id: unknown }): Task;
  remove(input: { id: unknown }): Task;
  find(id: unknown): Task | undefined;
  open(owner?: string): Task[];
  inProject(projectId: string): Task[];
  ownedBy(owner: string): Task[];
  stats(): TaskStats;
}
```

Nine methods in three groups, and the grouping is the design:

| Group | Methods | Inputs | Throws? |
| :--- | :--- | :--- | :--- |
| **Commands** (tool path) | `create`, `list`, `complete`, `remove` | `unknown` | Yes — `ToolError` with a recovery sentence |
| **Lookup** (mixed) | `find` | `unknown` | No — returns `undefined` |
| **Views** (resource path) | `open`, `inProject`, `ownedBy`, `stats` | Typed `string` | No — pure filters |

**The commands take `unknown` and the views take `string`.** That asymmetry is deliberate and it mirrors
the two paths' realities:

- A **command** is reached from a tool call, where the value came off a wire. It must be validated, so
  it is typed as what it is: unknown.
- A **view** is reached from a renderer, which has already resolved and validated its template variable
  through `parseVariable` (Chapter 10). The value is a `string` by then, and re-typing it as `unknown`
  would force a redundant parse in every renderer.

`find` sits between them: it takes `unknown` (because the ACL calls it with header data) but does not
throw (because a lookup miss is a normal outcome, not an error). Its comment states the contract:
*Non-throwing lookup, for callers that own their own not-found handling.*

And note that `complete` and `remove` are documented differently, which is the taxonomy in the
interface itself:

```ts
/** Completes a pending task. Already-completed is a `CONFLICT`, not a retry. */
complete(input: { id: unknown }): Task;
/** Destructive and irreversible. */
remove(input: { id: unknown }): Task;
```

**Block 5 — `parseOrThrow` (lines 97–113).**

```ts
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, hint: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");

    throw new ToolError("INVALID_INPUT", `Invalid input — ${detail}.`, hint);
  }

  return parsed.data;
}
```

*This one helper is why no service method below contains a validation branch.* Nine methods, and not
one of them has an `if` about a value's shape. That is the entire value of the helper: validation is
uniform, and a tenth method cannot forget it.

The signature is generic in `T` and takes `z.ZodType<T>`, so the *return type is derived from the
schema* rather than asserted. `parseOrThrow(taskTitle, title, ...)` returns `string` because `taskTitle`
produces a `string` — no cast, no annotation at the call site.

The two-part message construction is worth noting:

```ts
throw new ToolError("INVALID_INPUT", `Invalid input — ${detail}.`, hint);
```

- **`detail`** is zod's own message, prefixed with the failing path: `"id: id must be a positive
  integer"`. It names the *fault*.
- **`hint`** is passed in by the caller and names the *fix*. It is a parameter rather than derived
  because only the call site knows what a sensible correction looks like.

That split is what makes the resulting model-facing text actionable. Compare:

```text
Invalid input — id: id must be a positive integer. Call list_tasks to read the exact ids, then retry.
```

Zod could not have produced the second sentence, and the caller could not have produced the first
without re-deriving the schema. Together they are a complete instruction: *what went wrong* plus *what
to do*.

`|| "value"` handles an issue whose path is empty — the same guard as `config/env.ts` (Chapter 02), for
the same reason: an empty path would render as `": message"` with no field name.

**Block 6 — `coercePositiveInt` (lines 115–131).**

```ts
export function coercePositiveInt(value: unknown): number | undefined {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
```

Five lines with a substantial comment above them, and the comment is the argument for a deliberate
inconsistency:

> URI template variables arrive as **strings** — the template grammar has no types — so `task://tasks/1`
> hands us `"1"`, not `1`. The tool path stays strict on purpose (the model is given a numeric schema
> and must honour it); this path has to meet the URI where it actually is. The coercion is bounded and
> positive, so it is a **parse** rather than a permissive `Number()`.

So the same service accepts `1` from a tool and `"1"` from a URI, and the difference is expressed by
which entry point was used rather than by a loosened schema. Two reasons this is right:

**The tool path should stay strict.** The model was given `z.number().int().positive()` and told so in
the description. Accepting `"1"` there would teach the model that the contract is soft — and the next
thing it sends is `"one"`.

**The URI path cannot be strict.** A URI is text by definition. `task://tasks/1` has no way to carry a
number. So the renderer's path coerces — but through `z.coerce.number().int().positive()`, not a bare
`Number()`. Here is the measured behaviour of every awkward input:

```text
input      coercePositiveInt   Number()    which check decides it
"1"        → 1                 1           —
"0"        → undefined         0           fails .positive()
"-3"       → undefined         -3          fails .positive()
"1.5"      → undefined         1.5         fails .int()
2.5        → undefined         2.5         fails .int()
"abc"      → undefined         NaN         fails every check
""         → undefined         0           fails .positive()
"1e309"    → undefined         Infinity    fails .int()
" 12 "     → 12                12          accepted — see below
"0x10"     → 16                16          accepted — see below
1          → 1                 1           already a number
```

Nine of the eleven are rejected, and the ones that survive are exactly the ones a human would consider
reasonable. The `.positive()` and `.int()` refinements do the work: `Infinity` is not an integer, `NaN`
is neither, and `0` and negatives are not positive. `Number()` alone would have returned `Infinity` for
`"1e309"` — a value that passes a naive `typeof === "number"` check and would then index into the store
with nonsense.

**Two inputs are accepted that a stricter parse would reject, and it is worth being honest about them.**
`z.coerce.number()` delegates to `Number()`, so `" 12 "` and `"0x10"` both parse — meaning
`task://tasks/0x10` and `task://tasks/16` address the **same task**. That is a real looseness, and the
comment above the function overstates the case slightly when it calls this *"a parse rather than a
permissive `Number()`"*. What it actually is, precisely:

> `Number()` **plus bounds** — every non-finite, non-integer and non-positive result is rejected, but the
> numeral syntax itself is JavaScript's.

The consequence is bounded and benign here: an alias for an address, not an access-control hole, because
the ACL keys on a task's `owner` rather than on the spelling of its URI. A deployment that needed one
canonical form per task would add a `^\\d+$` regex — and knowing that is the point of measuring rather
than assuming.

Returning `number | undefined` rather than throwing is the correct choice for this layer: the function
has no idea whether a missing id is an error (the read path) or an ordinary outcome (a lookup).

**Block 7 — `createTaskService` and the shared helper (lines 133–135).**

```ts
export function createTaskService(store: TaskStore): TaskService {
  const openTasks = (tasks: readonly Task[]): Task[] => tasks.filter((task) => task.status === "PENDING");
```

A factory taking the store — same pattern as every other layer, so a test can pass a fake store. The
store is the only dependency, and the service never reaches for it directly: it is a parameter.

`openTasks` is a two-line helper used by three methods (`open`, `stats`, and conceptually `list` with a
filter). Defining "open" in one place matters more than it looks, because it is a *business rule* — a
third status would be added here and nowhere else.

Note the parameter is `readonly Task[]`, so the helper cannot mutate the board it was handed.

**Block 8 — `create` (lines 137–166).**

```ts
create({ title, priority, projectId: project, owner, idempotencyKey: key }) {
  const cleanTitle = parseOrThrow(taskTitle, title, "Send a non-empty title of at most 120 characters.");

  const cleanPriority =
    priority === undefined
      ? undefined
      : parseOrThrow(taskPriority, priority, 'Set priority to "high" or "normal", or omit it.');

  const cleanProject =
    project === undefined ? undefined : parseOrThrow(projectId, project, 'Use a short slug such as "fde", or omit it.');
  ...
}
```

Five fields, five validations, and the pattern is identical for each: **only validate what was
supplied.**

The `x === undefined ? undefined : parseOrThrow(...)` shape is what makes optional fields work. If
`parseOrThrow` were called unconditionally, `undefined` would fail every schema and an omitted
`priority` would become an error. Guarding on `undefined` means "absent" stays absent and the *store's*
default applies — `"normal"`, `"inbox"`, `"123"` (Chapter 07).

That is a division of responsibility worth naming: **the service decides what is valid; the store
decides what a default is.** The service has no opinion about what priority to use when none is given,
and the store has no opinion about which priorities exist.

Every hint is written as an instruction with the valid options spelled out:

| Field | Hint |
| :--- | :--- |
| `title` | "Send a non-empty title of at most 120 characters." |
| `priority` | `Set priority to "high" or "normal", or omit it.` |
| `projectId` | `Use a short slug such as "fde", or omit it.` |
| `owner` | `Use a short user id such as "123", or omit it.` |
| `idempotencyKey` | "Send a key of at most 64 characters, or omit it entirely." |

Each names a *concrete acceptable value* — `"high"`, `"fde"`, `"123"` — rather than restating the rule.
A model told *"priority must be one of the enum members"* has to infer; a model told
*`Set priority to "high" or "normal"`* can comply immediately. And each ends with the escape hatch
(`or omit it`), because for an optional field the easiest correct action is usually to drop it.

The destructuring rename — `projectId: project`, `idempotencyKey: key` — avoids shadowing the module-level
`projectId` schema with the parameter of the same name. Without the rename, `parseOrThrow(projectId, project, ...)`
would pass the *value* where the *schema* is expected. A small thing that would be a confusing bug.

**Block 9 — `list` (lines 168–176).**

```ts
list(input = {}) {
  const filter = parseOrThrow(
    statusFilter.optional(),
    input.status,
    'Filter with "PENDING" or "COMPLETED", or omit the filter to read the whole board.',
  );

  const tasks = store.list();
  return filter === undefined ? tasks : tasks.filter((task) => task.status === filter);
}
```

Three decisions in eight lines:

**`input = {}` as the default.** `list()` with no argument is valid, which is what a `list_tasks` call with
an empty `inputSchema` produces.

**`statusFilter.optional()` — the schema is composed at the call site.** The optionality belongs to *this
method's* contract, not to the `statusFilter` schema, which is also used where a status is required. Composing
`.optional()` here keeps the base schema strict.

**The filter runs after `store.list()`, not inside it.** The service does the filtering, so the store stays a
dumb container and the rule "PENDING means open" lives in one layer. A store with a `listByStatus` method would
have to know what statuses mean.

**Block 10 — `complete` (lines 178–196).**

```ts
complete({ id }) {
  const value = parseOrThrow(taskId, id, "Call list_tasks to read the exact ids, then retry.");
  const task = store.get(value);

  if (task === undefined) {
    throw new ToolError("NOT_FOUND", `No task with id ${value}.`, "Call list_tasks to read the exact ids, then retry.");
  }

  if (task.status === "COMPLETED") {
    // A conflict, not a failure to retry: the requested state already holds,
    // so retrying would only burn a call to reach the same conclusion.
    throw new ToolError(
      "CONFLICT",
      `Task #${task.id} is already COMPLETED.`,
      "Nothing to do — report the current state instead of retrying.",
    );
  }

  const updated = store.update(task.id, (current) => {
    current.status = "COMPLETED";
  });

  return updated ?? task;
}
```

The **two failure branches are the taxonomy's clearest example in the codebase**, and the comment above
the second one is the reasoning:

> A conflict, not a failure to retry: the requested state already holds, so retrying would only burn a
> call to reach the same conclusion.

| Branch | Code | Status | Recovery | Retryable |
| :--- | :--- | :--- | :--- | :--- |
| No such task | `NOT_FOUND` | 404 | *Call list_tasks to read the exact ids, then retry.* | no |
| Already completed | `CONFLICT` | 409 | *Nothing to do — report the current state instead of retrying.* | no |

Both are non-retryable, and for opposite reasons: the first needs a *different id*, the second needs *no
action at all*. And the messages differ in kind — `No task with id 999.` is a fact about the world;
`Task #2 is already COMPLETED.` is a fact about the *request's* relationship to the world.

That is the difference between 404 and 409 expressed as prose, and it is why the recovery sentences are
different instructions rather than the same one with different wording. Both were verified live in
Chapter 05, where the two calls produced visibly different `isError` texts.

**`return updated ?? task;`** — a defensive fallback that handles the impossible-but-type-legal case where
`store.update` returns `undefined` (the task was removed between the `get` and the `update`). Returning the
stale `task` is better than throwing here: the completion already happened for practical purposes, and the
caller gets a coherent object.

**Block 11 — `remove` (lines 198–206).**

```ts
remove({ id }) {
  const value = parseOrThrow(taskId, id, "Call list_tasks to read the exact ids, then retry.");
  const task = store.remove(value);

  if (task === undefined) {
    throw new ToolError("NOT_FOUND", `No task with id ${value}.`, "Call list_tasks to read the exact ids, then retry.");
  }

  return task;
}
```

Shorter than `complete` because there is no state to check — deleting is unconditional once the task
exists. Note the return: `store.remove` gives back the **removed** task, so the caller can report *what*
was destroyed (Chapter 07). And note there is **no `CONFLICT` branch**: deleting an already-deleted task is
`NOT_FOUND`, not a conflict, because there is no "already deleted" state to be in.

**Block 12 — `find` and the three views (lines 208–222).**

```ts
find(id) {
  const value = coercePositiveInt(id);
  return value === undefined ? undefined : store.get(value);
},

open: (owner) => {
  const tasks = openTasks(store.list());
  return owner === undefined ? tasks : tasks.filter((task) => task.owner === owner);
},

inProject: (project) => store.list().filter((task) => task.projectId === project),

ownedBy: (owner) => store.list().filter((task) => task.owner === owner),
```

The three views map one-to-one onto the three Resources that use them, and naming the mapping is the point:

| Method | Resource | The predicate |
| :--- | :--- | :--- |
| `open(owner?)` | `task://backlog` | `status === "PENDING"`, optionally `owner === owner` |
| `inProject(id)` | `task://projects/{projectId}` | `projectId === id` — **open and completed both** |
| `ownedBy(id)` | `user://{userId}/profile` | `owner === id` |

`inProject` deliberately does **not** filter by status: its descriptor's description says *"Every task in one
project, open and completed."* The view's contract is stated in the catalogue (Chapter 08) and implemented here
— and the two agree because the description was written for a chooser, not invented separately.

`open(owner?)` is the only view with an optional narrowing, and it exists because the same method serves two
callers: `task://backlog` calls `open()` for everything, and `user://{userId}/profile` calls `open(userId)` for
one person's plate. One method, two consumers, no duplication of the `PENDING` rule.

**Block 13 — `stats` (lines 224–237).**

```ts
stats() {
  const tasks = store.list();
  const pending = openTasks(tasks);

  return {
    total: tasks.length,
    pending: pending.length,
    completed: tasks.length - pending.length,
    highPriority: pending.filter((task) => task.priority === "high").length,
    projects: [...new Set(tasks.map((task) => task.projectId))].sort(),
  };
}
```

One pass over the board, five derived numbers, and two subtleties:

**`completed: tasks.length - pending.length`** is computed by subtraction rather than by a second filter. That
is only correct because `TaskStatus` is a two-member union — every task is either pending or completed. With a
third status, this line would silently become wrong, which is exactly the kind of coupling a two-member union
makes safe and a three-member one would not. It is a legitimate optimisation *because* the type is closed.

**`projects` is de-duplicated and sorted in one expression:**

```ts
projects: [...new Set(tasks.map((task) => task.projectId))].sort(),
```

`map` extracts, `Set` de-duplicates, the spread turns it back into an array, `sort` orders it. The sort is not
cosmetic — this array becomes the **`resources/list` ordering of project instances** and the **`completion/complete`
suggestions** for the `projectId` variable (Chapter 15). An unsorted array would make the catalogue listing
reorder between calls, and a client caching it would see spurious changes.

That is the same reasoning as `snapshot()`'s sort in Chapter 04: **unstable ordering makes output
undiffable and makes caches lie.**

---

## Run / verify

### 1. One truth, three renderings

This is the service's `typed facts, not prose` decision, made visible. Step 5 reads three Resources whose
bodies all come from the same `Task` objects this service returns:

```bash
npm run lifecycle 2>/dev/null | sed -n '/^5\./,/^6\./p'
```

```text
5. resources/read -> static, templated and JSON, all through one verb
   task://guidelines        STATIC    310 chars, text/plain
   task://projects/fde      TEMPLATE  134 chars
   Project: fde | Tasks: 2 |  | - [high] Write MCP notes  (project: fde, owner: 123) | - [normal] Review pull req…(+32)
   task://tasks/1           TEMPLATE  214 chars, application/json
   { "id": 1, "title": "Write MCP notes", "status": "PENDING", "priority": "high", "projectId": "fde", "owner": "…(+88)
```

Three renderings of the **same** task #1, and the differences are exactly what the lecture predicts:

| Resource | Kind | MIME | Rendering of task #1 |
| :--- | :--- | :--- | :--- |
| `task://projects/fde` | template | `text/plain` | `- [high] Write MCP notes  (project: fde, owner: 123)` — one **line** in a list |
| `task://tasks/1` | template | `application/json` | `{ "id": 1, "title": "Write MCP notes", "status": "PENDING", … }` — the **whole object** |
| `task://guidelines` | static | `text/plain` | *not a task at all* — company policy |

One `Task` value, two prose/JSON renderings, produced by two renderers in `resourceService` (Chapter 10).
Neither renderer recomputes anything: both call `inProject("fde")` or `find(1)` and format the result. That
is the service returning facts rather than prose — **if it had returned a formatted string, the two
renderings would have had to duplicate the formatting, and the JSON version could not have existed at all.**

Note the JSON body is `application/json` while the project brief is `text/plain`, and both describe the same
task. MIME type is a contract about how to render the bytes, not a property of the data — which is why the
descriptor declares it per Resource rather than the service deciding it (Ch03 §3.8).

### 2. The validators, seen from outside

```bash
curl -s 'http://127.0.0.1:8080/read?uri=task://tasks/abc'
```

```json
{"error":{"code":"INVALID_INPUT","message":"The task URI must carry a positive integer id, not \"abc\".","recovery":"List the catalogue with resources/list, or read task://tasks/{id} with a numeric id.","retryable":false,"requestId":"6881018d"}}
```

`abc` fails `coercePositiveInt`, the renderer turns the `undefined` into a `NOT_FOUND`-shaped refusal, and the
recovery sentence names the *fix* — a numeric id. That is the `parseOrThrow` pattern's split (fault from the
schema, fix from the call site) reaching all the way to the wire.

```bash
curl -s 'http://127.0.0.1:8080/read?uri=task://projects/my%20project'
```

```json
{"error":{"code":"INVALID_INPUT","message":"Invalid projectId in the resource URI — projectId must be a slug: letters, digits, dash or underscore.","recovery":"Supply a projectId that satisfies the template, or list the catalogue with resources/list.","retryable":false,"requestId":"b199448a"}}
```

This is the `projectId` schema doing its job: the template matched, `decodeURIComponent` produced
`"my project"`, and the slug regex rejected it. Chapter 08 walks through the three layers in that one
response; the point here is that the *schema that rejected it* is the one declared in this file, imported by
`resourceService.ts` — one definition, two callers.

### 3. The two failure branches of `complete`, side by side

Verified in Chapter 05 and worth restating here, because this is where they are raised:

```text
2nd complete_task on #2  → isError  "Task #2 is already COMPLETED. Nothing to do — report the current
                                    state instead of retrying."            ← CONFLICT (409)
delete_task 999          → isError  "No task with id 999. Call list_tasks to read the exact ids, then
                                    retry."                              ← NOT_FOUND (404)
```

Same method shape, same wire shape, two different codes and two different instructions — and the CONFLICT
one explicitly tells the model to *stop*, which is the only way to break a retry loop.

### 4. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

The `unknown` input types are what the typecheck is really enforcing here. Change a `TaskService` command
signature from `id: unknown` to `id: number` and the compiler immediately complains inside the method —
because `parseOrThrow(taskId, id, ...)` would no longer be receiving something that needs parsing, and
`store.get(id)` would no longer be receiving something that has been proven. The type is doing the
security work.

---

## Checkpoint

1. **Why re-validate when the tool already declared an `inputSchema`?**
   Because the service has more than one caller. The tool path is one entry point; the Resource path reaches
the same store through URI variables (which arrive as strings) and the ACL reaches `find()` with header data.
   SDK validation is a protocol concern for `tools/call`; it says nothing about the other paths.

2. **Why are the command inputs typed `unknown` rather than `string`?**
   Because that is what they actually are. A value off a wire is unproven, and declaring it `string` would turn
the compiler into an accomplice — it would help you *keep* the assumption rather than check it. `unknown`
forces every field through a schema.

3. **What is the division of responsibility between the service and the store on defaults?**
   The service decides what is *valid*; the store decides what a *default* is. That is why `create` validates
   only the fields that were supplied (`x === undefined ? undefined : parseOrThrow(...)`) and the store applies
   `"normal"`, `"inbox"`, `"123"`.

4. **Why is `complete` on an already-completed task a `CONFLICT` rather than a success?**
   Because the requested state already holds, so the caller's *intent* is satisfied but its *request* was
   based on stale information. Reporting a conflict with the instruction *report the current state instead of
   retrying* is what stops a retry loop; reporting success would hide that the caller's view was stale.

5. **What does `parseOrThrow` combine, and why can neither part produce the other?**
   Zod's message (naming the *fault*, e.g. `id: id must be a positive integer`) plus a caller-supplied hint
   (naming the *fix*, e.g. `Call list_tasks to read the exact ids, then retry.`). The schema cannot know the
   business-appropriate remedy, and the call site cannot re-derive the schema's message.

6. **Why does the URI path coerce when the tool path does not?**
   Because a URI is text and has no way to carry a number, while the model was given a numeric schema and
   should honour it. Accepting `"1"` on the tool path would teach the model that the contract is soft.

7. **What exactly does `z.coerce.number().int().positive()` reject, and what does it let through?**
   It rejects `NaN`, `Infinity`, non-integers, zero, negatives and the empty string. It **accepts** `" 12 "`
   and `"0x10"` (→ 16), because it delegates to `Number()` — so two spellings can address one task. That is a
   bounded alias, documented rather than assumed away.

8. **Why is `projects` sorted in `stats()`?**
   Because that array becomes the ordering of `resources/list`'s project instances and the
   `completion/complete` suggestions. An unstable order makes the catalogue listing reorder between calls and
   makes a caching client see spurious changes.

---

**[← Chapter 08: The Resource Catalogue](./08_Domain_Resource_Catalogue.md)** · **[Chapter 10: The Resource Service →](./10_Service_Resource_Service.md)**
