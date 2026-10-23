# Chapter 08: Service — Validated Business Logic

> **Chapter goal:** Put the business rules in one place the model never sees, make
> every input re-validated, and make every failure a `ToolError` that carries the
> sentence the model needs.

---

## 8.1 File details

| | |
| :--- | :--- |
| **Path** | `src/services/taskService.ts` |
| **Layer** | service (imports `zod`, `../core/errors.js`, `../domain/taskStore.js`) |
| **Purpose** | Re-validate every input, own the business rules, share the `taskSchema` used by every tool's `outputSchema`, and translate store outcomes into recovery-carrying `ToolError`s |
| **Imports** | `zod/v4`, `ToolError`, `type { CreateTaskResult, Task, TaskStatus, TaskStore }` |
| **Exports** | `taskTitle`, `taskId`, `idempotencyKey`, `statusFilter`, `taskSchema`, `interface TaskStats`, `interface TaskService`, `createTaskService()` |
| **Consumed by** | `src/mcp/server.ts` (constructs it), `src/mcp/tools.ts` and `src/mcp/resources.ts` (via `ServerDeps`) |
| **Lecture sections** | [05 — The Tools Primitive](../../../notes/05_The_Tools_Primitive.md) §5.4 (schema craft), [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) (never trust the client's validation) |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the business rules, in the demo
npm run host | sed -n '21,24p'
```

---

## 8.2 Full file

```ts
import * as z from "zod/v4";
import { ToolError } from "../core/errors.js";
import type { CreateTaskResult, Task, TaskStatus, TaskStore } from "../domain/taskStore.js";

/**
 * Chapter 05 §5.2 / Chapter 08 — the execution layer.
 *
 * The model never sees this file. It sees only the contract in
 * `src/mcp/tools.ts`. Two rules make this layer trustworthy:
 *
 *  1. **Re-validate everything.** The `inputSchema` the host showed the model
 *     is a hint to the model, not a guarantee to you: a buggy or hostile client
 *     can send anything it likes. The validation here is the only validation
 *     that counts.
 *
 *  2. **A failure is an instruction.** Every throw carries a recovery sentence,
 *     because the text ends up in the model's context and the model's next move
 *     is decided by it.
 */

/** The single source of truth for what a title may be. */
export const taskTitle = z
  .string()
  .trim()
  .min(1, "title must not be empty")
  .max(120, "title must be at most 120 characters");

export const taskId = z.number().int().positive("id must be a positive integer");

export const idempotencyKey = z.string().trim().min(1).max(64, "idempotencyKey must be at most 64 characters");

export const statusFilter = z.enum(["PENDING", "COMPLETED"]);

/** The `outputSchema` shared by the tools that return a task — one definition, not four. */
export const taskSchema = z.object({
  id: z.number().int().positive().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]).describe("Current lifecycle state"),
  createdAt: z.string().describe("ISO 8601 timestamp of creation"),
  updatedAt: z.string().describe("ISO 8601 timestamp of the last change"),
});

export interface TaskStats {
  total: number;
  pending: number;
  completed: number;
}

export interface TaskService {
  create(input: { title: unknown; idempotencyKey?: unknown }): CreateTaskResult;
  list(input?: { status?: unknown }): Task[];
  /** Completes a pending task. Already-completed is a `CONFLICT`, not a retry. */
  complete(input: { id: unknown }): Task;
  /** Destructive and irreversible. */
  remove(input: { id: unknown }): Task;
  /** Non-throwing lookup, for callers that own their own not-found handling (the resource layer). */
  find(id: unknown): Task | undefined;
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

export function createTaskService(store: TaskStore): TaskService {
  return {
    create({ title, idempotencyKey: key }) {
      const cleanTitle = parseOrThrow(
        taskTitle,
        title,
        "Send a non-empty title of at most 120 characters.",
      );

      const cleanKey =
        key === undefined
          ? undefined
          : parseOrThrow(idempotencyKey, key, "Send a key of at most 64 characters, or omit it entirely.");

      return store.create({ title: cleanTitle, idempotencyKey: cleanKey });
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
        throw new ToolError(
          "NOT_FOUND",
          `No task with id ${value}.`,
          "Call list_tasks to read the exact ids, then retry.",
        );
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
        throw new ToolError(
          "NOT_FOUND",
          `No task with id ${value}.`,
          "Call list_tasks to read the exact ids, then retry.",
        );
      }

      return task;
    },

    find(id) {
      /**
       * Non-throwing lookup, and the one place an id is **coerced rather than
       * rejected**.
       *
       * URI template variables arrive as strings — the template grammar has no
       * types — so `company://tasks/1` hands us `"1"`, not `1`. The tool path
       * stays strict on purpose (the model is given a numeric schema and must
       * honour it); this path has to meet the URI where it actually is.
       */
      const parsed = z.coerce.number().int().positive().safeParse(id);
      return parsed.success ? store.get(parsed.data) : undefined;
    },

    stats() {
      const tasks = store.list();
      const completed = tasks.filter((task) => task.status === "COMPLETED").length;

      return { total: tasks.length, pending: tasks.length - completed, completed };
    },
  };
}
```

## 8.3 Block-by-block explanation

### Block 1 — the two rules that make this layer trustworthy

The header comment states both, and they are the reason the file exists as a
separate layer.

**Rule 1 — re-validate everything.** The comment is precise about *why*:

> The `inputSchema` the host showed the model is a hint to the model, not a
> guarantee to you: a buggy or hostile client can send anything it likes.

This is the single most misunderstood point about MCP tool schemas. It is tempting
to reason "the SDK validates `arguments` against `inputSchema`, so the service can
trust its inputs". Three things break that reasoning:

- **The schema is a *request*.** It travels in `tools/list` as JSON Schema, and the
  client is not obliged to enforce it. A well-behaved client does; a hand-written
  probe (like the `printf` one in the README) does not.
- **The client is a different program.** In a remote deployment it is a different
  machine, controlled by someone else. "The client validated it" is not a security
  argument.
- **Validation rules drift.** If the service's rule and the published schema ever
  disagree, the published one wins in the model's mind and the service's one wins
  in reality. Having exactly one enforcement point makes the divergence impossible.

So the rule is: **the schema is a contract with the model; the service's validation
is the contract with reality.** Both are needed, and they are not the same thing.

**Rule 2 — a failure is an instruction.** The reasoning:

> Every throw carries a recovery sentence, because the text ends up in the model's
> context and the model's next move is decided by it.

Note what this implies about *where* errors are thrown. If the service throws and
the guard catches (Chapter 10), then the recovery sentence written here is what the
model reads. So the sentence must be written in the service, next to the rule it
describes — not bolted on in the tool layer, where the author has already forgotten
the condition.

### Block 2 — the input schemas, and why they are exported

```ts
export const taskTitle = z
  .string()
  .trim()
  .min(1, "title must not be empty")
  .max(120, "title must be at most 120 characters");

export const taskId = z.number().int().positive("id must be a positive integer");

export const idempotencyKey = z.string().trim().min(1).max(64, "idempotencyKey must be at most 64 characters");

export const statusFilter = z.enum(["PENDING", "COMPLETED"]);
```

**What they do:** define each input's rules once, as a named schema.
**How they work:** Zod pipelines, with **custom messages** on the constraints that a
model could plausibly violate.

**Why custom messages?** Zod's defaults are technically accurate and practically
useless to a model: `"Too small: expected string to have >=1 characters"` does not
say which field, and it does not say what a good value looks like. The custom
messages here are written in the same voice as the recovery sentences — declarative
and specific:

| Constraint | Default message | Custom message |
| :--- | :--- | :--- |
| `min(1)` | `Too small: expected string to have >=1 characters` | `title must not be empty` |
| `max(120)` | `Too big: expected string to have <=120 characters` | `title must be at most 120 characters` |
| `positive()` | `Too small: expected number to be >0` | `id must be a positive integer` |

The second version names the field and states the bound. That is the difference
between a model that can correct itself and one that retries the same bad value.

**`.trim()` before `.min(1)` is order-dependent.** `z.string().min(1).trim()` would
accept `"   "` — three spaces is a non-empty string — and then trim it to `""`,
producing a task with no title. Trimming *first* means the length check sees the
value that will actually be stored. **Zod pipelines run left to right, so the order
of `.trim()` and `.min()` is a correctness decision, not a style one.**

**`taskId` has no `.trim()`** because it is a number. `.int()` rejects `1.5`;
`.positive()` rejects `0` and negatives. Together they mean an id must be a whole
number ≥ 1, which matches the store's id generation exactly.

**`statusFilter` is a bare enum with no custom message**, and that is fine — Zod's
enum error already lists the permitted values
(`Invalid option: expected one of "PENDING"|"COMPLETED"`), which is the actionable
part. The `parseOrThrow` *hint* supplies the rest ("omit the filter to read the whole
board").

**These four schemas are exported, and that is deliberate.** `src/mcp/tools.ts` does
not redeclare its input rules; it imports `taskTitle`-equivalent constraints by
writing its own `inputSchema` with matching bounds. The shared export that matters
most is `taskSchema` (Block 3). Where an input schema *is* duplicated between the
service and the tool layer, the duplication is intentional and shallow — the tool's
copy carries `.describe()` text for the model, which the service's copy has no use
for.

### Block 3 — `taskSchema`: one definition, three consumers

```ts
/** The `outputSchema` shared by the tools that return a task — one definition, not four. */
export const taskSchema = z.object({
  id: z.number().int().positive().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]).describe("Current lifecycle state"),
  createdAt: z.string().describe("ISO 8601 timestamp of creation"),
  updatedAt: z.string().describe("ISO 8601 timestamp of the last change"),
});
```

**What it does:** describes a `Task` for three different consumers at once.
**How it works:** a Zod object whose `.describe()` calls become JSON Schema
`description` fields.

This one constant is used in **three** places, and understanding why is the point of
the block:

1. **As an `outputSchema`** in `src/mcp/tools.ts` — the SDK converts it to JSON
   Schema and publishes it in `tools/list`, so the client learns the shape of a
   result before calling.
2. **As a nested `outputSchema`** — `create_task` declares
   `z.object({ task: taskSchema, replayed: z.boolean() })`, so the shared schema
   composes rather than being copied.
3. **As a runtime validator**, implicitly: because the tools return objects built
   from the store's `Task` type, and this schema mirrors that type, the SDK's
   output-schema validation on the server side confirms the contract holds.

**Why the duplication with `interface Task` is safe.** `Task` (in `domain/taskStore.ts`)
and `taskSchema` (here) declare the same five fields, so there *is* redundancy. It is
acceptable because the two serve different roles — one is a compile-time type, the
other a runtime validator — and because TypeScript catches divergence: the tool
handlers pass `Task` values where the SDK expects the schema's inferred type, so if
the two ever disagree, **`npm run typecheck` fails**. The schema is the source of
truth for the wire; the interface is the source of truth for the code; the compiler
keeps them honest.

**`.describe()` on every field, including the ones that look obvious.** The
descriptions are the model's only documentation for the *result*. `createdAt` and
`updatedAt` in particular need it: without "ISO 8601 timestamp", a model reading
`"2026-10-23T11:02:50.731Z"` has to guess the format, and a model that guesses wrong
will compute a wrong duration. The field name alone is not enough.

**The descriptions are written for a reader, not for a tooltip.** Compare
`"Server-assigned task id"` with a plausible alternative like `"The id"`. The first
tells the model that ids come *from the server* — so it should read them, not invent
them. That one word ("Server-assigned") is the difference between a model that calls
`list_tasks` first and one that guesses `id: 1`.

**`status` re-declares the enum rather than reusing `TaskStatus`.** It has to: a Zod
schema is a runtime value, and `TaskStatus` is a compile-time type that does not exist
at runtime. The two are kept in sync by the compiler, as above.

### Block 4 — `TaskService` and the `unknown` input type

```ts
export interface TaskService {
  create(input: { title: unknown; idempotencyKey?: unknown }): CreateTaskResult;
  list(input?: { status?: unknown }): Task[];
  /** Completes a pending task. Already-completed is a `CONFLICT`, not a retry. */
  complete(input: { id: unknown }): Task;
  /** Destructive and irreversible. */
  remove(input: { id: unknown }): Task;
  /** Non-throwing lookup, for callers that own their own not-found handling (the resource layer). */
  find(id: unknown): Task | undefined;
  stats(): TaskStats;
}
```

**What it does:** declares the service's surface, with **untrusted** inputs.
**How it works:** every parameter that comes from outside is typed `unknown`, and the
method's job is to narrow it.

**`title: unknown`, not `title: string`.** This is the type system enforcing Rule 1.
If the signature said `string`, the service would be *claiming* its input was already
a string — and the only way to make that true would be to trust the caller. `unknown`
is the honest type for "something arrived from the network". It also means the
compiler will not let a method body *use* the value without parsing it first, so the
validation cannot be forgotten.

There is a cost: the tool layer's handler receives already-typed arguments from the
SDK (it validated them against `inputSchema`), and it now passes them into a method
that re-checks them. That is the belt-and-braces stance, and it is deliberate. The
alternative — typing the service as if inputs were trustworthy — makes the security
property depend on the caller's behaviour.

**`find(id: unknown): Task | undefined` — the one non-throwing lookup.** Its doc
comment names the reason: it exists for "callers that own their own not-found
handling (the resource layer)". A tool that cannot find a task has a *model* to
inform, so it throws a `ToolError` with a recovery sentence. A `resources/read` that
cannot find a task has an *application* waiting on a JSON-RPC response, so it needs to
raise `ResourceNotFoundError` instead — a different error mechanism entirely
(Chapter 05's distinction, applied). Giving both callers the same throwing method
would force the resource layer to catch and re-throw, which is exactly the kind of
translation that gets forgotten.

**`stats(): TaskStats` has no input**, so there is nothing to validate. It exists for
the same reason `size()` does: to be assertable, and to be available to a future
summary resource.

**The `input` object rather than positional parameters** matches the store's
convention (`CreateTaskCommand`), so the layers read alike.

### Block 5 — `parseOrThrow`: one helper, zero validation branches

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

**What it does:** validates a value or throws a fully-formed `ToolError`.
**How it works:** three parts — parse, format the diagnosis, throw with a hint.

**Why this function exists.** Without it, every method would open with a validation
branch:

```ts
const parsed = taskTitle.safeParse(title);
if (!parsed.success) {
  throw new ToolError("INVALID_INPUT", …);
}
const cleanTitle = parsed.data;
```

Four methods × two fields each = eight copies of the same five lines, each with a
slightly different message format. `parseOrThrow` collapses that to one call per
field, and the comment names the payoff explicitly: *"This one helper is why no
service method below contains a validation branch."* Read `complete()` and you see a
straight line of business logic with no `if (invalid)` in sight.

**The generic `<T>` is inferred from the schema.** `z.ZodType<T>` ties the return type
to the schema's output, so `parseOrThrow(taskTitle, …)` returns `string` and
`parseOrThrow(taskId, …)` returns `number`, with no annotations at the call site. It
also handles schemas whose input and output differ — `statusFilter.optional()` accepts
`unknown` and yields `"PENDING" | "COMPLETED" | undefined`.

**`safeParse`, not `parse`.** Same reasoning as `config/env.ts`: `safeParse` returns a
result, which lets this function build the message it wants instead of catching a
`ZodError` and reformatting it.

**`issue.path.join(".") || "value"`** — the field name, with a fallback. For a
top-level schema the path is empty, so `join(".")` yields `""` and the `||` supplies
the generic `"value"`. Without the fallback the message would begin with a stray
`": title must not be empty"`.

**`issues.map(...).join("; ")`** — **all** failures, semicolon-separated. A model that
sent both a bad title and a bad key gets both messages in one turn, so it can fix both
at once. Reporting only the first would cost an extra round trip.

**The message format is `Invalid input — <detail>.`** The em dash separates the
category from the specifics, and the trailing period makes it a sentence — which
matters because it is concatenated with the recovery sentence in `toolFailure`
(Chapter 05):

```text
Invalid input — title: title must not be empty. Send a non-empty title of at most 120 characters.
```

Two sentences: the diagnosis, then the fix. That is the shape every tool error in this
codebase has.

**`hint` is a required parameter, not optional.** Making it required forces the author
to write the recovery sentence at the moment they know the rule. An optional hint would
be omitted exactly where it matters most. Note that the hints are written as
*instructions* ("Call list_tasks to read the exact ids, then retry"), not as
descriptions ("the id was invalid").

**`INVALID_INPUT` is the code for all of them.** Per Chapter 05's taxonomy, the model's
decision is the same for every validation failure — correct the argument and retry — so
one code suffices, and the detail string carries the specificity.

### Block 6 — the methods, and the one that coerces

**`create` — the two-stage optional key.**

```ts
const cleanKey =
  key === undefined
    ? undefined
    : parseOrThrow(idempotencyKey, key, "Send a key of at most 64 characters, or omit it entirely.");
```

The ternary is not defensive noise. `parseOrThrow` on `undefined` would *fail*
(`z.string()` rejects `undefined`), so an omitted key would become an error. The check
distinguishes "no key supplied" (valid, non-idempotent create) from "a key was
supplied but is bad" (an error). Both look like `undefined` to a careless
implementation, and collapsing them would make every non-idempotent create fail.

**`list` — an optional filter, and the default parameter.**

```ts
list(input = {}) {
  const filter = parseOrThrow(statusFilter.optional(), input.status, …);
  const tasks = store.list();
  return filter === undefined ? tasks : tasks.filter((task) => task.status === filter);
}
```

`input = {}` means `service.list()` is a valid call. `statusFilter.optional()` means
`input.status` may be absent — and `undefined` passes `.optional()`, yielding
`undefined`. The final ternary returns the whole board rather than filtering by
`undefined`, which would return nothing.

**`complete` — the three-way outcome, and the `?? task`.**

```ts
if (task === undefined) { throw new ToolError("NOT_FOUND", …); }
if (task.status === "COMPLETED") { throw new ToolError("CONFLICT", …); }

const updated = store.update(task.id, (current) => {
  current.status = "COMPLETED";
});

return updated ?? task;
```

This is the richest method in the file, because completing a task has three possible
outcomes and all three are legitimate:

| Outcome | Mechanism | Recovery sentence |
| :--- | :--- | :--- |
| Completed | returns the task | — |
| No such task | `NOT_FOUND` thrown | *Call list_tasks to read the exact ids, then retry.* |
| Already completed | `CONFLICT` thrown | *Nothing to do — report the current state instead of retrying.* |

**The `CONFLICT` case is the one worth studying.** A naive implementation would treat
"already completed" as success — the desired end state holds, after all — and return
the task. That is wrong for an agent, because it makes the operation indistinguishable
from a real transition: the model cannot tell whether *it* completed the task or
whether it was already done, and it will report "I completed it" when it did not. A
distinct `CONFLICT` with a "do not retry" recovery sentence keeps the model's narrative
accurate.

**`return updated ?? task;`** — the `??` avoids a non-null assertion. We just fetched
`task` from the store and nothing removed it in between (this is synchronous,
single-threaded code), so `updated` is defined in practice. But `store.update` is typed
`Task | undefined`, and `?? task` satisfies the compiler *and* stays correct if the
invariant were ever broken. Compare `return updated!` — the non-null assertion silences
the compiler while asserting something the type system cannot verify.

**`remove` — no state check, deliberately.**

```ts
remove({ id }) {
  const value = parseOrThrow(taskId, id, …);
  const task = store.remove(value);
  if (task === undefined) { throw new ToolError("NOT_FOUND", …); }
  return task;
}
```

Unlike `complete`, there is no "already in that state" branch — a deleted task is gone,
and deleting a nonexistent task is genuinely `NOT_FOUND`. The asymmetry between
`complete` and `remove` is not an inconsistency; it reflects the difference between an
operation with a *target state* and one with a *target absence*.

**`find` — the one coercion.**

```ts
const parsed = z.coerce.number().int().positive().safeParse(id);
return parsed.success ? store.get(parsed.data) : undefined;
```

The doc comment explains the asymmetry, and it is worth restating because it was a real
bug found while building this codebase: **URI template variables arrive as strings.**
The template grammar (`company://tasks/{taskId}`) has no types, so
`resources/read company://tasks/1` hands the handler `"1"`, not `1`. A strict
`taskId.safeParse("1")` fails, `find` returns `undefined`, and every templated resource
read answers `ResourceNotFoundError` — for a resource that exists.

`z.coerce.number()` fixes it by applying `Number(...)` before validating, so `"1"` → `1`,
while `"abc"` → `NaN` → rejected by `.int()`. And note `find` uses `safeParse` rather
than `parseOrThrow`: it must **not** throw, because the resource layer owns the
not-found decision (Block 4).

Why not coerce in the tool path too? Because the tool path is *supposed* to be strict.
The model is given `z.number()` and told the field is numeric; if it sends `"1"` as a
string, a clear `INVALID_INPUT` is the correct response, not silent leniency. **Strict
where a contract exists, lenient where the grammar cannot express one** — that is the
principle, and it is why the two paths differ.

**`stats` — a pure derivation.**

```ts
const tasks = store.list();
const completed = tasks.filter((task) => task.status === "COMPLETED").length;
return { total: tasks.length, pending: tasks.length - completed, completed };
```

One `list()` call, then both counts derived from it. Computing `pending` as
`total - completed` rather than running a second `filter` is not premature
optimisation — it is a *consistency* guarantee: two independent filters could disagree
if a task's status were not in the enum, and the derived form cannot.

---

## 8.4 Run / verify

The business rules are visible in the demo's failure section:

```bash
npm run host | sed -n '21,24p'
```

```text
6. failures    -> tool execution errors (`isError: true`)
   complete_task id=999 -> isError=true No task with id 999. Call list_tasks to read the exact ids, then retry.
   complete_task id=1   -> Task completed: #1 Record MCP Video (COMPLETED).
   complete_task id=1   -> isError=true Task #1 is already COMPLETED. Nothing to do — report the current state instead of retrying.
```

All three outcomes of `complete` are on display, and each produced a different
sentence:

| Call | Code | Text the model reads |
| :--- | :--- | :--- |
| `id=999` | `NOT_FOUND` | `No task with id 999.` + *read the exact ids, then retry* |
| `id=1` | — | `Task completed: #1 Record MCP Video (COMPLETED).` |
| `id=1` again | `CONFLICT` | `Task #1 is already COMPLETED.` + *report the current state instead of retrying* |

Now verify the validation layer directly. This exercises `parseOrThrow`, the
`.trim()`-before-`.min()` ordering, and the two-path coercion asymmetry:

```bash
npx tsx -e '
import { createTaskService } from "./src/services/taskService.ts";
import { createTaskStore } from "./src/domain/taskStore.ts";
const service = createTaskService(createTaskStore({ maxTasks: 100 }));

const attempt = (label, run) => {
  try { console.log(label, "-> OK:", JSON.stringify(run())); }
  catch (error) { console.log(label, "->", error.code + ":", error.message, "|", error.recovery); }
};

attempt("whitespace title", () => service.create({ title: "   " }));
attempt("string id (tool path)", () => service.complete({ id: "1" }));
attempt("string id (resource path)", () => service.find("1"));

const created = service.create({ title: "  Record MCP Video  " });
console.log("trimmed title ->", JSON.stringify(created.task.title));

attempt("bad filter", () => service.list({ status: "DONE" }));
console.log("stats ->", JSON.stringify(service.stats()));
'
```

```text
whitespace title -> INVALID_INPUT: Invalid input — title: title must not be empty. | Send a non-empty title of at most 120 characters.
string id (tool path) -> INVALID_INPUT: Invalid input — id: id must be a positive integer. | Call list_tasks to read the exact ids, then retry.
string id (resource path) -> OK: undefined
trimmed title -> "Record MCP Video"
bad filter -> INVALID_INPUT: Invalid input — status: Invalid option: expected one of "PENDING"|"COMPLETED". | Filter with "PENDING" or "COMPLETED", or omit the filter to read the whole board.
stats -> {"total":1,"pending":1,"completed":0}
```

Five results, five lessons:

1. **`"   "` is rejected.** Proof that `.trim()` runs before `.min(1)` — if the order
   were reversed, this would have created a task with an empty title.
2. **The tool path is strict.** `complete({ id: "1" })` is `INVALID_INPUT`, because the
   model was given a numeric schema and sent a string.
3. **The resource path is lenient.** `find("1")` returns `undefined` — not an error,
   because there is no such task yet, and crucially *not* an `INVALID_INPUT`, because
   the string was successfully coerced. This is the coercion that makes
   `company://tasks/1` work.
4. **`"  Record MCP Video  "` is stored trimmed.** The service normalises before the
   store sees it, so the model's later `list_tasks` will report the exact title to use.
5. **Every failure carries a recovery sentence**, and the bad filter's message lists
   the permitted values.

> **The `stats` output is `{"total":1,"pending":1,"completed":0}`** — one task, pending.
> Note that the four failed attempts above did **not** create anything, which is itself
> a check: a rejected call must leave no trace.

---

## 8.5 Checkpoint

1. **Re-validate everything.** `inputSchema` is a contract with the *model*; the
   service's validation is the contract with *reality*. They are not the same thing,
   and the client cannot be trusted to enforce the first.
2. **`.trim()` before `.min(1)`.** Zod pipelines run left to right, so ordering is a
   correctness decision — reversed, `"   "` becomes an empty title.
3. **`parseOrThrow` is why no service method has a validation branch.** One helper,
   one message format, all failures reported at once.
4. **Every throw carries a recovery sentence, written next to the rule it describes.**
   The text lands in the model's context, so it is an instruction, not a log line.
5. **`CONFLICT` is not success.** Treating "already completed" as success makes the
   model report an action it did not perform.
6. **Strict on the tool path, lenient on the resource path.** A contract deserves
   strictness; a URI grammar cannot express a type, so it gets coercion instead.
7. **`taskSchema` is defined once and reused** as a nested `outputSchema`, and the
   compiler keeps it in sync with `interface Task`.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 07 — Domain: The Task Store & Idempotency](./07_Domain_Task_Store.md)

**Next:** [Chapter 09 — MCP: The Wiring Contract](./09_Mcp_Wiring_Contract.md)





