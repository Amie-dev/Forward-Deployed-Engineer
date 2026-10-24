# Chapter 10 — Service: Static, Dynamic and Templated Resources

> **Where a Resource stops being a description and becomes bytes.** Four responsibilities live here and
> deliberately together: **rendering**, **caching**, **validating template variables**, and **failing
> loudly**. What does *not* live here is the context budget — and the reason is the chapter's sharpest
> design decision.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/resourceService.ts` (378 lines) |
| **Layer** | `services` — imports `zod`, `config/constants.js`, `core/errors.js`, the catalogue, and `taskService`. No protocol, no transport. |
| **Purpose** | One renderer per descriptor, a cache honouring each descriptor's policy, template-variable validation, and a refusal rather than an empty body. |
| **Exports** | `ResourceRead`, `ResourceServiceStats`, `ResourceService`, `createResourceService()` |
| **Lecture sections** | Ch03 §3.8/3.9, Ch04 §4.2–4.7, Ch04 §"Cache like a read-heavy system", Ch04 §"Validate and constrain dynamic URIs" |
| **Runs** | `npm run lifecycle` step 5 · `GET /read?uri=…` |

---

## Commands

```bash
# the three shapes, all through one verb
npm run lifecycle 2>/dev/null | sed -n '/^5\./,/^6\./p'

# an empty result, a missing resource, and a bad variable — three different answers
curl -s 'http://127.0.0.1:8080/read?uri=task://projects/nonexistent'
curl -s 'http://127.0.0.1:8080/read?uri=task://tasks/999'
curl -s 'http://127.0.0.1:8080/read?uri=task://tasks/abc'

# the cache, observed through the log
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep resource.read | head -3
```

---

## The four responsibilities, and the one it refuses

The header lists what this file owns and then states what it does not, and the omission is the design:

> What it does *not* own is the budget. Clipping a body to fit a prompt is a prompt-assembly concern, so it
> lives in `core/guards.ts` and is applied by the host — **a resource read for a user who asked for it is
> not the same thing as a resource read to be stuffed into a context window.**

That distinction is easy to miss and it is load-bearing. There are two entirely different reasons to read a
Resource:

| Why | Who asked | Should it be clipped? |
| :--- | :--- | :--- |
| The user wants to see it | A `GET /read?uri=…` from a browser | **No** — truncating what a human asked to read is a bug |
| The application wants to add context | The selection engine, before a model call | **Yes** — unbounded context is the failure being prevented |

If clipping lived in the renderer, the two cases would be indistinguishable and the first would be broken.
Keeping the budget in `core/guards.ts` — applied by the *host* at assembly time — means the same read serves
both purposes: whole for a human, clipped for a prompt. And the renderer stays a pure function from
(descriptor, variables, state) to a string, which is what makes caching it coherent.

---

## `src/services/resourceService.ts` — the full file

```ts
import * as z from "zod/v4";
import { MIME, type MimeType } from "../config/constants.js";
import { ResourceError } from "../core/errors.js";
import type {
  CatalogueEntry,
  ResolvedResource,
  ResourceCatalogue,
  ResourceDescriptor,
  SearchableEntry,
} from "../domain/resourceCatalogue.js";
import type { Task } from "../domain/taskStore.js";
import { coercePositiveInt, projectId as projectIdSchema, userId as userIdSchema, type TaskService } from "./taskService.js";

/**
 * Notes Ch04 §4.2–4.7 — **the resource layer**: where a Resource stops being a
 * description and becomes bytes.
 *
 * It owns four responsibilities, and keeping them together is the point:
 *
 *  1. **Rendering.** One function per descriptor name, turning typed facts from
 *     `taskService` into the body a URI addresses.
 *  2. **Caching.** Static bodies live for the process; dynamic ones get a TTL
 *     (Notes Ch04 §"Cache like a read-heavy system").
 *  3. **Validation of template variables.** A `{taskId}` of `"abc"` is an
 *     `INVALID_INPUT`, not an empty document (Notes Ch04 §"Validate and
 *     constrain dynamic URIs").
 *  4. **Failing loudly.** An unknown URI is a `ResourceError`, never an empty
 *     string pretending to be content (Notes Ch03 §3.9, failure-mode table).
 *
 * What it does *not* own is the budget. Clipping a body to fit a prompt is a
 * prompt-assembly concern, so it lives in `core/guards.ts` and is applied by the
 * host — a resource read for a user who asked for it is not the same thing as a
 * resource read to be stuffed into a context window.
 */

/** The static body. It lives here because it *is* the Resource (Notes Ch04 §4.2). */
const GUIDELINES = `Task Management Guidelines:

1. Deep work tasks should preferably be done before 12 PM.
2. Meetings should preferably be scheduled after 2 PM.
3. Urgent tasks should be completed on the same day.
4. Keep a maximum of three high-priority tasks per day.
5. Complete high-priority tasks before low-priority tasks.`;

/** One read, after rendering and before any prompt budget is applied. */
export interface ResourceRead {
  uri: string;
  descriptor: ResourceDescriptor;
  mimeType: MimeType;
  text: string;
  /** Where the body actually came from — the honest half of a cache. */
  source: "static" | "live" | "cache";
  /** Characters before any budget clipping. */
  chars: number;
}

export interface ResourceServiceStats {
  cached: number;
  hits: number;
  misses: number;
}

export interface ResourceService {
  /** Read one resource by URI. Throws a `ResourceError` for anything it cannot serve. */
  read(uri: string): ResourceRead;
  /** The entries `resources/list` advertises as instances. */
  list(): CatalogueEntry[];
  /** The descriptors `resources/templates/list` advertises. */
  templates(): readonly ResourceDescriptor[];
  /** What the selector ranks — metadata only, never content. */
  searchable(): readonly SearchableEntry[];
  /** Match a URI to a descriptor without reading anything. */
  resolve(uri: string): ResolvedResource | undefined;
  /** Drop cached bodies. Called after a mutation, because state moved. */
  invalidate(): void;
  stats(): ResourceServiceStats;
}

/**
 * Renders one task as a line. Shared by the backlog and project views so the two
 * cannot disagree about how a task reads.
 */
function taskLine(task: Task): string {
  const mark = task.status === "COMPLETED" ? "[done]" : `[${task.priority}]`;
  return `- ${mark} ${task.title}  (project: ${task.projectId}, owner: ${task.owner})`;
}

/** Renders the text views. Each returns a body, never a status code. */
function renderText(
  name: string,
  variables: Record<string, string>,
  tasks: TaskService,
): string {
  switch (name) {
    case "guidelines":
      return GUIDELINES;

    case "backlog": {
      const open = tasks.open();

      if (open.length === 0) {
        return "No open tasks.";
      }

      return [`Open tasks: ${open.length}`, "", ...open.map(taskLine)].join("\n");
    }

    case "summary": {
      const stats = tasks.stats();

      return [
        `Total tasks: ${stats.total}`,
        `Open tasks: ${stats.pending}`,
        `Completed: ${stats.completed}`,
        `High priority and open: ${stats.highPriority}`,
        `Projects involved: ${stats.projects.join(", ") || "none"}`,
      ].join("\n");
    }

    case "project": {
      const project = parseVariable(projectIdSchema, variables.projectId, "projectId");
      const inProject = tasks.inProject(project);

      if (inProject.length === 0) {
        // An empty *result*, not an error: the project is a valid address, it
        // simply holds nothing. Returning prose keeps the distinction honest.
        return `Project "${project}" has no tasks.`;
      }

      return [
        `Project: ${project}`,
        `Tasks: ${inProject.length}`,
        "",
        ...inProject.map(taskLine),
      ].join("\n");
    }

    default:
      throw new ResourceError(
        "NOT_FOUND",
        `No renderer for resource "${name}".`,
        "This is a server-side wiring bug: a descriptor was registered without a renderer.",
        { httpStatus: 500 },
      );
  }
}

/**
 * The renderer inventory.
 *
 * Declared as data so the constructor can prove, at boot, that it covers the
 * catalogue exactly. A descriptor with no renderer is a wiring bug that would
 * otherwise surface on the first `resources/read` of that URI — in production,
 * at 3 a.m., as a 500. Here it is a stack trace before the server ever accepts
 * a connection.
 */
const TEXT_RENDERERS = ["guidelines", "backlog", "summary", "project"] as const;
const JSON_RENDERERS = ["task", "user-profile"] as const;

/**
 * Parses a template variable, or refuses the read.
 *
 * Notes Ch04 §"Validate and constrain dynamic URIs": a template whose parameter
 * is unchecked is an enumeration oracle. A `{taskId}` of `"abc"` must therefore
 * be an `INVALID_INPUT` naming the variable — never a lookup that quietly
 * returns nothing, and never a document that pretends to be empty.
 */
function parseVariable<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");

    throw new ResourceError(
      "INVALID_INPUT",
      `Invalid ${name} in the resource URI — ${detail}.`,
      `Supply a ${name} that satisfies the template, or list the catalogue with resources/list.`,
    );
  }

  return parsed.data;
}

/**
 * Renders the JSON views.
 *
 * Notes Ch03 §3.8 — the MIME type is a contract. These two descriptors declare
 * `application/json`, so what comes back must parse, which is also why they are
 * not routed through the text renderer.
 */
function renderJson(
  name: string,
  variables: Record<string, string>,
  tasks: TaskService,
): string {
  switch (name) {
    case "task": {
      const raw = variables.taskId;
      const id = coercePositiveInt(raw);

      if (id === undefined) {
        throw new ResourceError(
          "INVALID_INPUT",
          `The task URI must carry a positive integer id, not "${raw ?? ""}".`,
          "List the catalogue with resources/list, or read task://tasks/{id} with a numeric id.",
        );
      }

      const task = tasks.find(id);

      if (task === undefined) {
        // Notes Ch03 §3.9 — a missing resource is a *protocol error*. Nothing
        // executed, so there is no `isError` channel to carry a recovery line.
        throw new ResourceError(
          "NOT_FOUND",
          `No task with id ${id}.`,
          "Call list_tasks, or read task://backlog, to see the ids that exist.",
        );
      }

      return JSON.stringify(task, null, 2);
    }

    case "user-profile": {
      const owner = parseVariable(userIdSchema, variables.userId, "userId");
      const owned = tasks.ownedBy(owner);

      if (owned.length === 0) {
        throw new ResourceError(
          "NOT_FOUND",
          `No profile found for user "${owner}".`,
          "Use a user id that owns at least one task, or read task://backlog to see the owners.",
        );
      }

      const open = owned.filter((task) => task.status === "PENDING");

      return JSON.stringify(
        {
          userId: owner,
          openTasks: open.length,
          totalTasks: owned.length,
          tasks: owned.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            projectId: task.projectId,
          })),
        },
        null,
        2,
      );
    }

    default:
      throw new ResourceError(
        "NOT_FOUND",
        `No JSON renderer for resource "${name}".`,
        "This is a server-side wiring bug: a descriptor was registered without a renderer.",
        { httpStatus: 500 },
      );
  }
}

export function createResourceService(options: {
  tasks: TaskService;
  catalogue: ResourceCatalogue;
  /** TTL for `cache: "ttl"` descriptors. `process` ignores it; `none` never caches. */
  ttlMs: number;
  /** Injectable clock, so a cache-expiry test does not have to sleep. */
  now?: () => number;
}): ResourceService {
  const { tasks, catalogue, ttlMs } = options;
  const now = options.now ?? (() => Date.now());

  const cache = new Map<string, { text: string; at: number }>();
  let hits = 0;
  let misses = 0;

  /**
   * The boot-time invariant. A descriptor without a renderer, or a renderer
   * without a descriptor, is a wiring bug — and the cheapest possible moment to
   * find it is now, before the process serves anything.
   */
  const renderable = new Set<string>([...TEXT_RENDERERS, ...JSON_RENDERERS]);
  const declared = new Set(catalogue.descriptors().map((descriptor) => descriptor.name));

  for (const name of declared) {
    if (!renderable.has(name)) {
      throw new Error(`[resources] descriptor "${name}" has no renderer. Add one to resourceService.ts.`);
    }
  }

  for (const name of renderable) {
    if (!declared.has(name)) {
      throw new Error(`[resources] renderer "${name}" has no descriptor. Add one to resourceCatalogue.ts.`);
    }
  }

  const isFresh = (at: number, policy: ResourceDescriptor["cache"]): boolean =>
    policy === "process" || now() - at < ttlMs;

  const render = (descriptor: ResourceDescriptor, variables: Record<string, string>): string =>
    descriptor.mimeType === MIME.json
      ? renderJson(descriptor.name, variables, tasks)
      : renderText(descriptor.name, variables, tasks);

  return {
    read(uri) {
      const resolved = catalogue.resolve(uri);

      if (resolved === undefined) {
        // Failing loudly beats returning an empty body: an empty string is
        // indistinguishable from "this policy says nothing", and the model will
        // answer confidently from it (Notes Ch03 §3.9).
        throw new ResourceError(
          "NOT_FOUND",
          `Unknown resource: ${uri}.`,
          "List the catalogue with resources/list and read one of the advertised URIs.",
        );
      }

      const { descriptor, variables } = resolved;
      const cacheable = descriptor.cache !== "none";
      const cached = cacheable ? cache.get(uri) : undefined;

      if (cached !== undefined && isFresh(cached.at, descriptor.cache)) {
        hits += 1;

        return {
          uri,
          descriptor,
          mimeType: descriptor.mimeType,
          text: cached.text,
          source: "cache",
          chars: cached.text.length,
        };
      }

      if (cacheable) {
        misses += 1;
      }

      const text = render(descriptor, variables);

      if (cacheable) {
        cache.set(uri, { text, at: now() });
      }

      return {
        uri,
        descriptor,
        mimeType: descriptor.mimeType,
        text,
        // "static" and "live" are different stories in a log line: one says the
        // body is a constant, the other says it was computed from state that
        // moved a moment ago.
        source: descriptor.kind === "static" ? "static" : "live",
        chars: text.length,
      };
    },

    list: () => catalogue.listable(),

    templates: () => catalogue.templates(),

    searchable: () => catalogue.searchable(),

    resolve: (uri) => catalogue.resolve(uri),

    invalidate() {
      cache.clear();
    },

    stats: () => ({ cached: cache.size, hits, misses }),
  };
}
```

### Block-by-block

**Block 1 — the static body (lines 31–39).**

```ts
const GUIDELINES = `Task Management Guidelines:

1. Deep work tasks should preferably be done before 12 PM.
2. Meetings should preferably be scheduled after 2 PM.
3. Urgent tasks should be completed on the same day.
4. Keep a maximum of three high-priority tasks per day.
5. Complete high-priority tasks before low-priority tasks.`;
```

*The static body. It lives here because it **is** the Resource (Notes Ch04 §4.2).*

A module-level constant, not a function and not a database row. That is the honest shape for a genuinely
static Resource: the content *is* the code, and there is nothing to compute. If it were a function returning
a constant, the `cache: "process"` policy would be pointless — and the point is that a static Resource costs
nothing after the first read.

Note what the content does: five rules, each an *instruction* a model can apply to a plan. Rule 4 — *"Keep a
maximum of three high-priority tasks per day"* — is the one that makes this Resource worth retrieving: it is
a policy the model could not have inferred from the task list, and it is exactly what `task://summary`'s
`highPriority` count is meant to be compared against. That is why the two Resources are useful together, and
it is the reason the lecture's `plan_day` prompt asks for both.

**Block 2 — `ResourceRead` (lines 41–50).**

```ts
export interface ResourceRead {
  uri: string;
  descriptor: ResourceDescriptor;
  mimeType: MimeType;
  text: string;
  /** Where the body actually came from — the honest half of a cache. */
  source: "static" | "live" | "cache";
  /** Characters before any budget clipping. */
  chars: number;
}
```

Six fields, and two of them are the interesting ones.

**`source: "static" | "live" | "cache"`** — *the honest half of a cache.* A cache that does not report whether
it was used is a cache you cannot debug: a stale body and a fresh one look identical, and the only way to
find out is to change the data and see if the answer moves. With `source` in the result, the log line says
which happened:

```json
{"event":"resource.read","uri":"task://backlog","name":"backlog","kind":"dynamic","source":"cache","chars":191}
```

The comment on the return value below explains why `static` and `live` are separate rather than both being
"miss": *one says the body is a constant, the other says it was computed from state that moved a moment
ago.* Those are different operational stories — a `static` read is free forever, a `live` read cost a render.

**`chars` — the size *before* any clipping.** The field's comment is explicit about the boundary: *Characters
before any budget clipping.* Because the budget is applied later (by the host), `chars` here is the true size
of the document. That is what makes Chapter 06's budget report accurate — it has an unclipped number to
compare against, which is why it can print `310 -> 174` rather than just `174`.

**Block 3 — the service interface and its stats (lines 52–70).**

```ts
export interface ResourceService {
  read(uri: string): ResourceRead;
  list(): CatalogueEntry[];
  templates(): readonly ResourceDescriptor[];
  searchable(): readonly SearchableEntry[];
  resolve(uri: string): ResolvedResource | undefined;
  invalidate(): void;
  stats(): ResourceServiceStats;
}
```

Seven methods in three groups: **`read`** produces bytes; **`list` / `templates` / `searchable` / `resolve`**
delegate to the catalogue (metadata, no content); **`invalidate` / `stats`** manage and report the cache.

That middle group is worth noticing: four of the seven methods are pure delegations to the catalogue. They are
here because the service is the layer the MCP registrar talks to, so the registrar has one dependency rather
than two. The alternative — the registrar importing the catalogue directly — would mean the protocol layer
knows about two service objects and has to keep them straight.

```ts
export interface ResourceServiceStats {
  cached: number;
  hits: number;
  misses: number;
}
```

Three numbers, and they are the minimum needed to answer *is the cache working?* `cached` is the current
size; `hits` and `misses` are cumulative. A hit rate of zero with a non-zero `cached` would mean the TTL is
too short to ever be useful — a diagnosis impossible with any one of the three alone.

**Block 4 — `taskLine`, the shared line renderer (lines 72–79).**

```ts
function taskLine(task: Task): string {
  const mark = task.status === "COMPLETED" ? "[done]" : `[${task.priority}]`;
  return `- ${mark} ${task.title}  (project: ${task.projectId}, owner: ${task.owner})`;
}
```

*Renders one task as a line. Shared by the backlog and project views so the two cannot disagree about how a
task reads.*

Three characters of output carry a design decision: **the mark is either `[done]` or the priority, never
both.** A completed task has no priority worth showing, and a pending one has no `[done]`. That is the ternary
expressing a small domain rule — status and priority are not independent labels here, they are two mutually
exclusive *states of a line*.

The double space before `(project:` is deliberate: it visually separates the title (variable length) from the
trailing metadata (fixed shape), so a column of tasks scans as a table even in a monospace-less renderer.

Sharing this function is what makes the *identical payload* claim robust. `task://backlog` and
`task://projects/fde` both call `taskLine`, so a change to how a task reads appears in both at once — and
`list_tasks`, which returns `task://backlog`'s body verbatim, changes with them. One function, three surfaces,
no drift.

**Block 5 — `renderText` (lines 81–143).**

A `switch` on the descriptor name with a case per text Resource. Four things to read out of it:

**`guidelines` returns the constant.** One line, no computation — the `static` kind made concrete.

**`backlog` handles the empty case with prose, not an error:**

```ts
const open = tasks.open();

if (open.length === 0) {
  return "No open tasks.";
}

return [`Open tasks: ${open.length}`, "", ...open.map(taskLine)].join("\n");
```

The empty body is `"No open tasks."` — a *result*, not a failure. This is the distinction Chapter 05's taxonomy
is built around: an empty backlog is not `NOT_FOUND`, it is a resource that exists and says zero. Returning an
error would be wrong, and returning `""` would be worse — the model would have no way to tell "nothing to do"
from "the read failed".

The non-empty shape is `[header, blank, ...lines].join("\n")` — an array joined rather than a string
concatenated. That is the idiom throughout this file, and it is why the output has clean newlines with no
stray separators: the `""` element *is* the blank line, expressed as data rather than as a `\n\n` in a
template literal.

**`summary` renders five labelled lines from `stats()`:**

```ts
return [
  `Total tasks: ${stats.total}`,
  `Open tasks: ${stats.pending}`,
  `Completed: ${stats.completed}`,
  `High priority and open: ${stats.highPriority}`,
  `Projects involved: ${stats.projects.join(", ") || "none"}`,
].join("\n");
```

Five numbers, each on its own labelled line, which is the right shape for a model to read: a label and a value,
not a sentence to parse. `stats.projects.join(", ") || "none"` handles the empty case — `[].join(", ")` is `""`,
which would render as `Projects involved: ` with a dangling colon. The `|| "none"` turns it into a complete
statement.

**`project` distinguishes empty from missing, and the comment is the argument:**

```ts
const project = parseVariable(projectIdSchema, variables.projectId, "projectId");
const inProject = tasks.inProject(project);

if (inProject.length === 0) {
  // An empty *result*, not an error: the project is a valid address, it
  // simply holds nothing. Returning prose keeps the distinction honest.
  return `Project "${project}" has no tasks.`;
}
```

*"An empty result, not an error"* — and the phrase to hold onto is *"the project is a valid address, it simply
holds nothing."* Contrast the `user-profile` renderer below, where an empty result **is** an error. The
difference is what emptiness means: a project with no tasks is a project in progress; a user with no tasks is
not a user. The renderer is where that judgement is made, and it cannot be made generically — which is exactly
why there is one renderer per descriptor rather than a shared `renderEmpty()`.

**The `default` branch is a wiring bug, and it says so:**

```ts
default:
  throw new ResourceError(
    "NOT_FOUND",
    `No renderer for resource "${name}".`,
    "This is a server-side wiring bug: a descriptor was registered without a renderer.",
    { httpStatus: 500 },
  );
```

Two details. The **recovery sentence is aimed at the developer**, not the model or the user — *"This is a
server-side wiring bug"* — because no caller can fix it. And `{ httpStatus: 500 }` **overrides** the default
404 for `NOT_FOUND`, which is the escape hatch Chapter 05 documented on `AppError`. A missing renderer is not
a missing resource; it is a broken server, and 500 says so.

The `default` branch should be unreachable — and the boot-time invariant below is what makes that true rather
than hopeful.

**Block 6 — the renderer inventory (lines 145–157).**

```ts
const TEXT_RENDERERS = ["guidelines", "backlog", "summary", "project"] as const;
const JSON_RENDERERS = ["task", "user-profile"] as const;
```

The doc comment is the reasoning:

> Declared as data so the constructor can prove, at boot, that it covers the catalogue exactly. A descriptor
> with no renderer is a wiring bug that would otherwise surface on the first `resources/read` of that URI —
> **in production, at 3 a.m., as a 500.** Here it is a stack trace before the server ever accepts a connection.

Two arrays rather than one, split by MIME type, and the split is what `render()` dispatches on below. `as const`
preserves the literal types so the names are checked against the catalogue by the boot invariant.

**Block 7 — `parseVariable` (lines 159–183).**

```ts
function parseVariable<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");

    throw new ResourceError(
      "INVALID_INPUT",
      `Invalid ${name} in the resource URI — ${detail}.`,
      `Supply a ${name} that satisfies the template, or list the catalogue with resources/list.`,
    );
  }

  return parsed.data;
}
```

A near-twin of `taskService`'s `parseOrThrow` (Chapter 09), with three deliberate differences:

| | `parseOrThrow` (tools) | `parseVariable` (resources) |
| :--- | :--- | :--- |
| Throws | `ToolError` → `isError` content | `ResourceError` → **protocol error** |
| Hint | Caller-supplied (business remedy) | **Derived** from the variable name |
| Message | `Invalid input — …` | `Invalid ${name} in the resource URI — …` |

The first difference is the Chapter 05 rule: a tool failure is a result, a resource failure is a protocol
error. Same validation, different wire shape — which is why the two helpers cannot be one.

The second difference is subtler and it is about audience. `parseOrThrow`'s hint is a parameter because a tool
call site knows what a *business* remedy looks like ("Call list_tasks to read the exact ids"). A URI variable
has no such remedy: the caller simply supplied a bad value for a named slot. So the hint is **derived** from
the name — `Supply a projectId that satisfies the template` — which means a new template variable gets a
correct recovery sentence for free.

The doc comment restates the security rule: *a template whose parameter is unchecked is an enumeration oracle.
A `{taskId}` of `"abc"` must therefore be an `INVALID_INPUT` naming the variable — never a lookup that quietly
returns nothing, and never a document that pretends to be empty.*

That last clause is the important one. The tempting implementation is `find(uri) ?? ""` — return an empty body
when the variable does not parse. It produces no error, no log line, and a model that confidently answers from
nothing. `parseVariable` makes the same situation a loud 400 with the variable named.

Note it is **generic** (`<T>`, `z.ZodType<T>`) so the return type follows the schema — `parseVariable(projectIdSchema, ...)`
is a `string`, and no cast appears at the call site.

**Block 8 — `renderJson` (lines 185–265).**

*Notes Ch03 §3.8 — the MIME type is a contract. These two descriptors declare `application/json`, so what comes
back must parse, which is also why they are not routed through the text renderer.*

That is the whole reason for a second renderer family: a body that claims `application/json` and does not parse
is a broken contract, and the way to guarantee it parses is to build it with `JSON.stringify` rather than with
template literals.

**`task` — the template that exposes a family of documents:**

```ts
const raw = variables.taskId;
const id = coercePositiveInt(raw);

if (id === undefined) {
  throw new ResourceError(
    "INVALID_INPUT",
    `The task URI must carry a positive integer id, not "${raw ?? ""}".`,
    "List the catalogue with resources/list, or read task://tasks/{id} with a numeric id.",
  );
}

const task = tasks.find(id);

if (task === undefined) {
  throw new ResourceError(
    "NOT_FOUND",
    `No task with id ${id}.`,
    "Call list_tasks, or read task://backlog, to see the ids that exist.",
  );
}

return JSON.stringify(task, null, 2);
```

This is the `"abc"` case from Chapter 08's verify section — the two messages and the recovery sentence that
crossed a process boundary intact in Chapter 05. And note the **two distinct failures**, matching the two
schema layers:

| Condition | Code | Message |
| :--- | :--- | :--- |
| `taskId` is not a positive integer | `INVALID_INPUT` | `The task URI must carry a positive integer id, not "abc".` |
| The id parses but no such task | `NOT_FOUND` | `No task with id 999.` |

*Well-formed address, bad value* versus *address that does not exist* — the same distinction Chapter 08 drew
between the template grammar and the schema, now at the data layer.

`JSON.stringify(task, null, 2)` — the `2` is indentation, and it is a real choice. Compact JSON would be
smaller in the context window, and this is the Resource that might be attached to a prompt. Pretty-printing
costs whitespace tokens and buys a body a human can read in `/read?uri=task://tasks/1` — and the budget
(Chapter 06) is what protects the prompt from the extra bytes. Consistency with `taskSchema` also matters: the
same object must serialise identically wherever it is rendered.

**`user-profile` — the only Resource whose emptiness is an error:**

```ts
const owner = parseVariable(userIdSchema, variables.userId, "userId");
const owned = tasks.ownedBy(owner);

if (owned.length === 0) {
  throw new ResourceError(
    "NOT_FOUND",
    `No profile found for user "${owner}".`,
    "Use a user id that owns at least one task, or read task://backlog to see the owners.",
  );
}
```

Compare this with `project`'s empty case, which returned prose. Here emptiness is `NOT_FOUND`, and the reason
is the domain: a profile is *a person*, and a person with no tasks is not a person with an empty profile — the
id simply does not correspond to anyone. Returning `{ userId: "999", openTasks: 0 }` would invent a user.

Note the recovery sentence names the *escape hatch*: *read task://backlog to see the owners.* A caller that
picked a bad id has a concrete way to find a good one, which is what makes the refusal actionable rather than
just correct.

The returned body is a **projection**, not the raw tasks:

```ts
return JSON.stringify(
  {
    userId: owner,
    openTasks: open.length,
    totalTasks: owned.length,
    tasks: owned.map((task) => ({ id, title, status, priority, projectId })),
  },
  null, 2,
);
```

Five fields per task, and `owner` is **omitted** — every task in this document belongs to `userId` by
construction, so repeating it five times is noise. And `createdAt` / `updatedAt` are dropped too: a profile is
a *workload* view, not an audit trail. This is a renderer making a judgement about what a caller needs, which is
exactly what a renderer is for.

**Block 9 — the constructor and the boot-time invariant (lines 267–303).**

```ts
export function createResourceService(options: {
  tasks: TaskService;
  catalogue: ResourceCatalogue;
  ttlMs: number;
  now?: () => number;
}): ResourceService {
  const { tasks, catalogue, ttlMs } = options;
  const now = options.now ?? (() => Date.now());

  const cache = new Map<string, { text: string; at: number }>();
  let hits = 0;
  let misses = 0;
```

The `ttlMs` comment on the option is a precise statement of the policy split: *TTL for `cache: "ttl"`
descriptors. `process` ignores it; `none` never caches.* Three policies, one knob, and the knob only affects
the middle one.

`now` is the **injectable clock** — the same seam as `createTaskStore` (Chapter 07) and `RateLimiter`
(Chapter 06). Its comment gives the reason: *so a cache-expiry test does not have to sleep.* A test that
asserts "a body older than `ttlMs` is re-rendered" can advance a counter instead of waiting 30 seconds.

Note the default is `() => Date.now()`, returning a **number** rather than a `Date`. Milliseconds-since-epoch
is the right unit for TTL arithmetic — subtraction and comparison, no date library.

```ts
const renderable = new Set<string>([...TEXT_RENDERERS, ...JSON_RENDERERS]);
const declared = new Set(catalogue.descriptors().map((descriptor) => descriptor.name));

for (const name of declared) {
  if (!renderable.has(name)) {
    throw new Error(`[resources] descriptor "${name}" has no renderer. Add one to resourceService.ts.`);
  }
}

for (const name of renderable) {
  if (!declared.has(name)) {
    throw new Error(`[resources] renderer "${name}" has no descriptor. Add one to resourceCatalogue.ts.`);
  }
}
```

**This is the most valuable twenty lines in the file.** Two sets, two loops, and both directions checked:

| Check | Fails when | Error says |
| :--- | :--- | :--- |
| Every descriptor has a renderer | Someone adds a descriptor and forgets the renderer | *Add one to resourceService.ts.* |
| Every renderer has a descriptor | Someone adds a renderer and forgets the descriptor | *Add one to resourceCatalogue.ts.* |

The doc comment states the payoff in operational terms:

> A descriptor with no renderer is a wiring bug that would otherwise surface on the first `resources/read` of
> that URI — in production, at 3 a.m., as a 500. Here it is a stack trace before the server ever accepts a
> connection.

Consider the failure mode it prevents. Add `task://metrics` to the catalogue and forget the renderer. Without
the invariant, the server starts happily, `resources/list` advertises `task://metrics` to every client, and the
first client to read it gets the `default` branch's 500 — with the *recovery sentence telling them it is a
server-side wiring bug*, which is honest but useless at 3 a.m. With the invariant, the process refuses to
start and names both files.

**The two directions are not redundant.** The first loop catches a descriptor with no renderer (a missing
implementation). The second catches a renderer with no descriptor (dead code, or a renamed descriptor) — which
would otherwise be a `switch` case that can never be reached, invisible until someone reads the file. Note the
second error names the *other* file, so the message tells you where to make the change.

These are plain `Error`s, not `AppError`s, and that is correct: this is a boot-time programming error, not a
runtime business failure. There is no taxonomy class for "the developer made a mistake", and no recovery
sentence a caller could act on. It throws, the process exits, and the stack trace is the fix.

**The other two helpers (lines 305–312).**

```ts
const isFresh = (at: number, policy: ResourceDescriptor["cache"]): boolean =>
  policy === "process" || now() - at < ttlMs;

const render = (descriptor: ResourceDescriptor, variables: Record<string, string>): string =>
  descriptor.mimeType === MIME.json
    ? renderJson(descriptor.name, variables, tasks)
    : renderText(descriptor.name, variables, tasks);
```

`isFresh` is a one-liner that encodes the policy table, and the short-circuit matters:

```text
policy === "process"  →  ALWAYS fresh, no clock read at all
policy === "ttl"      →  fresh while now() - at < ttlMs
policy === "none"     →  never reaches here (the caller does not cache at all)
```

A `static` Resource is therefore fresh by definition, which is the correct semantics — its content cannot
change, so there is nothing to invalidate and the TTL is irrelevant. Note the `||` short-circuits: for a
`process` policy, `now()` is never called, so the clock seam is not even consulted.

`render` dispatches on **MIME type**, not on `kind`. That is the right discriminator because MIME type is what
the body's *validity* depends on: a body claiming `application/json` must parse, and a body claiming
`text/plain` must not be a JSON document. Kind describes the *lifecycle* (static/dynamic/template); MIME
describes the *format*. Two independent axes, and only one of them decides which function to call.

**Block 10 — `read`, the cache path (lines 314–368).**

```ts
read(uri) {
  const resolved = catalogue.resolve(uri);

  if (resolved === undefined) {
    throw new ResourceError(
      "NOT_FOUND",
      `Unknown resource: ${uri}.`,
      "List the catalogue with resources/list and read one of the advertised URIs.",
    );
  }

  const { descriptor, variables } = resolved;
  const cacheable = descriptor.cache !== "none";
  const cached = cacheable ? cache.get(uri) : undefined;

  if (cached !== undefined && isFresh(cached.at, descriptor.cache)) {
    hits += 1;

    return { uri, descriptor, mimeType: descriptor.mimeType, text: cached.text, source: "cache", chars: cached.text.length };
  }

  if (cacheable) {
    misses += 1;
  }

  const text = render(descriptor, variables);

  if (cacheable) {
    cache.set(uri, { text, at: now() });
  }

  return { ... , source: descriptor.kind === "static" ? "static" : "live", chars: text.length };
}
```

Five steps, and the first one's comment is the failure philosophy:

> Failing loudly beats returning an empty body: an empty string is indistinguishable from "this policy says
> nothing", and the model will answer confidently from it (Notes Ch03 §3.9).

That is the same argument as `parseVariable`'s, applied to an unknown URI. `""` is the worst possible answer
because it is *plausible*: a model told nothing will invent something, and a model handed an empty document
will treat the emptiness as information.

**`cacheable = descriptor.cache !== "none"`** — one boolean, computed once, guarding all three cache
operations. That is what makes the `none` policy actually mean *never caches* rather than *caches but ignores
it*: the `Map.get`, the `misses` increment and the `Map.set` are all skipped, so a `none` Resource leaves no
trace in the cache and does not pollute the hit/miss statistics.

**The hit path returns early** and is the only place `source: "cache"` is produced. Note it reports
`chars: cached.text.length` — the *cached* length, so a log line for a cache hit reports the size of what was
returned, not of what was computed.

**The miss path's `misses += 1` is inside `if (cacheable)`**, which is a small piece of accounting care: a
`none`-policy read is not a miss, because nothing was ever going to be cached. Counting it would make the hit
rate look worse than it is and would make the `none` policy look like a caching problem.

**The `source` ternary is the last line's payoff:**

```ts
source: descriptor.kind === "static" ? "static" : "live",
```

*"static" and "live" are different stories in a log line: one says the body is a constant, the other says it was
computed from state that moved a moment ago.* So a `static` Resource reports `static` on every read (and would
report `cache` if the cache ever served it — which, with `cache: "process"`, it always does after the first).

**Block 11 — `invalidate` and `stats` (lines 370–375).**

```ts
invalidate() {
  cache.clear();
},

stats: () => ({ cached: cache.size, hits, misses }),
```

`invalidate()` is called by **every mutating tool** — `create_task`, `complete_task`, `delete_task` all call
`deps.resources.invalidate()` after their service call (Chapter 14). That is the whole invalidation strategy:
the write path knows it changed something, so it drops the cache wholesale.

A wholesale `clear()` rather than targeted key deletion is the right trade at this size. Working out *which*
URIs are affected by a task change means reasoning about the backlog, the summary, every project brief the task
belongs to, and the owner's profile — and getting it wrong means serving a stale body, which is the failure the
cache was supposed to be invisible to. Clearing everything is O(1), always correct, and costs at most a few
re-renders.

The honest limit, stated in the main README: this is correct for **one process**. A multi-process deployment
would need `notifications/resources/list_changed` (or a shared cache with a version key), because a write in
one process cannot clear another process's cache.

---

## Run / verify

### 1. The boot-time invariant, fired deliberately

This is worth demonstrating rather than describing, because it is the file's best idea. A short script builds a
catalogue containing one descriptor with no renderer:

```ts
import { createResourceCatalogue, RESOURCE_DESCRIPTORS } from "./src/domain/resourceCatalogue.js";
import { createResourceService } from "./src/services/resourceService.js";

const tasks = createTaskService(createTaskStore({ maxTasks: 10 }));

// A descriptor with no renderer: exactly the wiring bug the invariant exists for.
const orphan = { ...RESOURCE_DESCRIPTORS[0]!, name: "orphan", uri: "task://orphan" };

createResourceService({
  tasks,
  catalogue: createResourceCatalogue([...RESOURCE_DESCRIPTORS, orphan]),
  ttlMs: 30_000,
});
```

```text
[resources] descriptor "orphan" has no renderer. Add one to resourceService.ts.
```

One line, naming the offending descriptor **and the file to edit**. And note *when* it fires: at construction,
which happens at module load in `mcp/server.ts` — **before the HTTP server binds a port**. The process never
reaches a state where a client could ask for `task://orphan`.

Compare the alternative: the same mistake without the invariant produces a server that starts, advertises
`task://orphan` in `resources/list`, and answers the first read with:

```text
No renderer for resource "orphan".
This is a server-side wiring bug: a descriptor was registered without a renderer.
```

— a 500, at 3 a.m., with the recovery sentence correctly telling the caller it is the server's fault and nothing
they can do. The invariant converts a production incident into a stack trace at boot.

The same script with the real catalogue constructs cleanly, which is the other half of the check: the invariant
must not fire on correct code.

### 2. The cache, observed directly

Still in-process, so `source` is visible without reading logs:

```text
first read   task://backlog    source: live
second read  task://backlog    source: cache
static read  task://guidelines source: static
static again task://guidelines source: cache
tasks/1 read task://tasks/1    source: live     (cache: none)
stats: {"cached":2,"hits":2,"misses":2}
```

Five reads, five distinct stories, and every field of `ResourceRead` accounted for:

| Read | `source` | Why |
| :--- | :--- | :--- |
| `backlog` #1 | `live` | `cache: "ttl"`, cache empty → rendered from state |
| `backlog` #2 | `cache` | Within the TTL → served from the `Map` |
| `guidelines` #1 | `static` | `cache: "process"`, cache empty → the constant |
| `guidelines` #2 | `cache` | A `process` policy is *always* fresh, so it hits |
| `tasks/1` | `live` | `cache: "none"` → never cached, so always rendered |

**`stats: {"cached":2,"hits":2,"misses":2}` is the arithmetic that proves the `none` policy works.** Two
entries cached (`backlog` and `guidelines`), two hits, two misses. `task://tasks/1` contributed to **none** of
the three counters — not a miss, not a hit, not an entry — because `cacheable` was false and all three cache
operations were skipped.

That is the difference between a `none` policy and a `ttl` policy with `ttlMs: 0`. The latter would still
`Map.get`, still count a miss, still `Map.set`, and would leak one `Map` entry per task read forever. The
`cacheable` guard is what makes `none` mean *never*.

Note also that `guidelines`' first read reports `static` rather than `cache` — correct, because the cache was
empty. So `source: "static"` does not mean "this read did not use the cache"; it means "this body is a
constant". The two facts are independent, which is why `source` has three values rather than two.

### 3. The same cache, visible in the log stream

```bash
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep resource.read | head -3
```

```json
{"ts":"2026-10-23T19:11:32.946Z","level":"info","event":"resource.read","server":"task-mcp-server","uri":"task://backlog","name":"backlog","kind":"dynamic","source":"cache","chars":191}
```

`source: "cache"` in production logs, next to `kind: "dynamic"`. An operator reading that line knows three
things at once: which Resource, that its body is state-derived, and that this particular read was free. Without
`source`, the same line would say only that a read happened — and the *only* way to find out whether the cache
is doing anything would be to change the data and watch the answer.

### 4. Empty is not the same as missing, and it depends on the Resource

Three requests, three different answers, and the contrast between the first two and the third is the design:

```bash
curl -s 'http://127.0.0.1:8080/read?uri=task://projects/nonexistent'
curl -s 'http://127.0.0.1:8080/read?uri=task://tasks/999'
curl -s -H 'x-actor: 999' 'http://127.0.0.1:8080/read?uri=user://999/profile'
```

```json
{"uri":"task://projects/nonexistent","mimeType":"text/plain","chars":35,"text":"Project \"nonexistent\" has no tasks.","policy":"\"project\" is public"}
```

```json
{"error":{"code":"NOT_FOUND","message":"No task with id 999.","recovery":"Call list_tasks, or read task://backlog, to see the ids that exist.","retryable":false,"requestId":"4756ffb9"}}
```

```json
{"error":{"code":"NOT_FOUND","message":"No profile found for user \"999\".","recovery":"Use a user id that owns at least one task, or read task://backlog to see the owners.","retryable":false,"requestId":"a83c5890"}}
```

| Request | HTTP | Meaning |
| :--- | :--- | :--- |
| `task://projects/nonexistent` | **200** | A valid address holding nothing. `Project "nonexistent" has no tasks.` |
| `task://tasks/999` | **404** | The address is fine; that id does not exist |
| `user://999/profile` | **404** | A user id that corresponds to no one — *not* an empty profile |

The first two are the distinction the `project` renderer's comment draws: *an empty result, not an error.* The
third is the same situation resolved the other way, because a profile is *a person* and `openTasks: 0` would
invent a user who does not exist.

Both 404s carry the **server's own** recovery sentences, which is the Chapter 05 wire adapter at work — and both
name a concrete next step (`Call list_tasks`, `read task://backlog`) rather than restating the problem.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Why is the context budget *not* in this file?**
   Because there are two reasons to read a Resource: a user asked to see it (never clip), and the application
   wants to add context (must clip). Clipping here would break the first case. The budget lives in
   `core/guards.ts` and is applied by the host at assembly time, so one read serves both purposes.

2. **What does the boot-time invariant check, and in which direction(s)?**
   Both directions: every descriptor has a renderer (catching a missing implementation) **and** every renderer
   has a descriptor (catching dead code or a rename). It fires at construction — before the port binds — so the
   alternative is a 500 in production rather than a stack trace at boot.

3. **Why does `ResourceRead` carry `source`?**
   *The honest half of a cache.* A stale body and a fresh one look identical; `source: "cache" | "live" |
   "static"` is what makes the difference visible in a log line without changing the data to test it.

4. **What is the difference between `cache: "none"` and `cache: "ttl"` with `ttlMs: 0`?**
   `none` skips all three cache operations — no `get`, no miss count, no `set` — so it leaves no entry and does
   not pollute the hit-rate statistics. A zero TTL would still store an entry per URI forever.

5. **When is an empty body a result, and when is it an error?**
   It depends on the Resource's domain. A project holding no tasks is `Project "x" has no tasks.` (200). A user
   id that owns nothing is `NOT_FOUND`, because returning `openTasks: 0` would invent a person.

6. **Why does `render` dispatch on MIME type rather than on `kind`?**
   Because MIME type is what the body's validity depends on — a body claiming `application/json` must parse.
   `kind` describes the lifecycle (static/dynamic/template), which is an independent axis.

7. **Why is `invalidate()` a wholesale `clear()`?**
   Because computing which URIs a task change affects means reasoning about the backlog, the summary, every
   affected project brief and the owner's profile — and getting it wrong serves a stale body. Clearing is O(1)
   and always correct, at the cost of a few re-renders. It is correct for **one process**; a multi-process
   deployment needs `notifications/resources/list_changed` instead.

8. **Why does `parseVariable` derive its recovery sentence instead of taking one?**
   Because a URI variable has no business-specific remedy — the caller supplied a bad value for a named slot. So
   `Supply a ${name} that satisfies the template` is generated from the name, which means a new template
   variable gets a correct sentence for free.

---

**[← Chapter 09: The Task Service](./09_Service_Task_Service.md)** · **[Chapter 11: The Prompt Service →](./11_Service_Prompt_Service.md)**
