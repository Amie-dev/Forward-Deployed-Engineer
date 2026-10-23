# Chapter 03 — Task Service: The Data Layer

> **Goal of this chapter:** build the data every primitive touches, and see how one small array
> plus a handful of text views is enough to demonstrate static, dynamic and templated Resources.
>
> **Lecture chapters:** [03 — Resource Discovery, Reading and Anatomy](../../../notes/03_Resource_Discovery_Reading_and_Anatomy.md)
> and [04 — Building Resources: Static, Dynamic and Templated](../../../notes/04_Building_Resources_Static_Dynamic_and_Templated.md).

---

## 3.1 File details

| | |
|---|---|
| **Path** | `src/services/taskService.ts` |
| **Purpose** | the in-memory task store, plus the text views the Resources return |
| **Imports** | none — this file is pure data and pure functions |
| **Exports** | `Priority`, `Task` (types); `createTask`, `completeTask`, `listTasks`, `openTasks`, `backlogText`, `summaryText`, `projectText`, `profileText` |
| **Depends on** | nothing in `src/` |
| **Used by** | `src/tools/tools.ts` (the writes), `src/resources/resources.ts` (the reads) |
| **Implements** | Lecture 03 §3.3 (the data behind the protocol), Lecture 04 (dynamic and templated content) |

## 3.2 Commands

Nothing to run on its own. To exercise it directly:

```bash
npx tsx -e "
import('./src/services/taskService.ts').then((s) => {
  console.log(s.backlogText());
  console.log('---');
  console.log(s.summaryText());
  console.log('---');
  console.log(s.projectText('fde'));
});
"
```

---

## 3.3 Full file

**Path:** `src/services/taskService.ts`

```ts
/**
 * Chapter 03 §3.3 — the data layer behind every primitive.
 *
 * The MCP layer never touches `tasks` directly. Tools *write* through the
 * mutating functions; Resources *read* through the view functions. One store,
 * two doors — which is exactly the Tools / Resources split of Chapter 02.
 */
export type Priority = "high" | "normal";

export type Task = {
  id: number;
  title: string;
  projectId: string;
  owner: string;
  priority: Priority;
  done: boolean;
};

const tasks: Task[] = [
  { id: 1, title: "Write MCP notes", projectId: "fde", owner: "123", priority: "high", done: false },
  { id: 2, title: "Review pull request", projectId: "fde", owner: "123", priority: "normal", done: false },
  { id: 3, title: "Record Lecture 15 video", projectId: "media", owner: "456", priority: "normal", done: false },
];

let nextId = tasks.length + 1;

/* ── writes — reached only through Tools (the model holds the trigger) ────── */

export function createTask(title: string): string {
  const task: Task = {
    id: nextId++,
    title,
    projectId: "inbox",
    owner: "123",
    priority: "normal",
    done: false,
  };

  tasks.push(task);

  return `Task created: ${task.title} (${task.priority} priority, project ${task.projectId})`;
}

export function completeTask(title: string): string {
  const task = tasks.find((candidate) => candidate.title === title && !candidate.done);

  // Chapter 08 — the failure path is written as a recovery instruction, because
  // this text goes straight back into the model's context.
  if (!task) {
    return `No pending task titled "${title}". Call list_tasks to read the exact titles, then retry.`;
  }

  task.done = true;

  return `Task completed: ${task.title}`;
}

/* ── reads — reached only through Resources (the application holds it) ────── */

export function listTasks(): Task[] {
  return tasks.map((task) => ({ ...task }));
}

export function openTasks(owner?: string): Task[] {
  return listTasks().filter((task) => !task.done && (owner === undefined || task.owner === owner));
}

/**
 * Chapter 04 — the DYNAMIC resource view: computed from the store on every
 * read, so it is never stale.
 */
export function backlogText(owner?: string): string {
  const open = openTasks(owner);

  if (open.length === 0) {
    return "No open tasks.";
  }

  const lines = open.map(
    (task) => `- [${task.priority}] ${task.title}  (project: ${task.projectId}, owner: ${task.owner})`,
  );

  return [`Open tasks: ${open.length}`, "", ...lines].join("\n");
}

export function summaryText(owner?: string): string {
  const open = openTasks(owner);
  const high = open.filter((task) => task.priority === "high").length;
  const projects = [...new Set(open.map((task) => task.projectId))];

  return [
    `Open tasks: ${open.length}`,
    `High priority: ${high}`,
    `Normal priority: ${open.length - high}`,
    `Projects involved: ${projects.join(", ") || "none"}`,
  ].join("\n");
}

/** Chapter 04 — the view behind the TEMPLATED resource `task://projects/{projectId}`. */
export function projectText(projectId: string): string {
  const inProject = listTasks().filter((task) => task.projectId === projectId);

  if (inProject.length === 0) {
    return `No tasks in project "${projectId}".`;
  }

  const lines = inProject.map((task) => `- ${task.done ? "[done]" : "[open]"} ${task.title}`);

  return [`Project: ${projectId}`, `Tasks: ${inProject.length}`, "", ...lines].join("\n");
}

/** Chapter 04 — the view behind the TEMPLATED resource `user://{userId}/profile`. */
export function profileText(userId: string): string {
  const owned = listTasks().filter((task) => task.owner === userId);
  const open = owned.filter((task) => !task.done);

  if (owned.length === 0) {
    return `No profile found for user "${userId}".`;
  }

  return [
    `User: ${userId}`,
    `Open tasks: ${open.length} of ${owned.length}`,
    "",
    ...owned.map((task) => `- ${task.done ? "[done]" : "[open]"} ${task.title}`),
  ].join("\n");
}
```

---

## 3.4 Block-by-block explanation

### Block 1 — the types

```ts
export type Priority = "high" | "normal";

export type Task = {
  id: number;
  title: string;
  projectId: string;
  owner: string;
  priority: Priority;
  done: boolean;
};
```

- `Priority` is a **string literal union** — a tiny enum with no runtime cost. TypeScript
  rejects `priority: "urgent"` at compile time, which is the same guarantee a `zod` enum would
  give at runtime.
- `Task` carries the four dimensions the Resources need:
  - `projectId` → powers the `task://projects/{projectId}` template,
  - `owner` → powers the `user://{userId}/profile` template,
  - `priority` → powers the summary counts,
  - `done` → is the difference between a backlog and an archive.
- **Design note:** the shape of the data is what makes the Resource catalogue possible. If
  `Task` had no `owner`, you could not template on a user at all.

### Block 2 — the store

```ts
const tasks: Task[] = [
  { id: 1, title: "Write MCP notes", projectId: "fde", owner: "123", priority: "high", done: false },
  { id: 2, title: "Review pull request", projectId: "fde", owner: "123", priority: "normal", done: false },
  { id: 3, title: "Record Lecture 15 video", projectId: "media", owner: "456", priority: "normal", done: false },
];

let nextId = tasks.length + 1;
```

- `tasks` is **module-private**: it is declared `const` and never exported. Nothing outside this
  file can reach the array, which forces every access through the functions below.
- That privacy is the whole design. Because writes and reads are separate exported functions,
  it is impossible to accidentally read a task from a Tool or write one from a Resource without
  it being visible in the code.
- `nextId` starts at `tasks.length + 1` = 4, so the seeded tasks are 1–3 and new ones continue
  from 4. It is `let`, not `const`, because `createTask` increments it.
- **Why in memory?** A database would add setup and hide the protocol. The lecture is about
  Resources and Prompts, so the store stays deliberately boring. Swapping it for MySQL changes
  only this file — the same point the board makes with `user://123/profile → MySQL`.

### Block 3 — the writes (reached only through Tools)

```ts
export function createTask(title: string): string {
  const task: Task = {
    id: nextId++,
    title,
    projectId: "inbox",
    owner: "123",
    priority: "normal",
    done: false,
  };

  tasks.push(task);

  return `Task created: ${task.title} (${task.priority} priority, project ${task.projectId})`;
}
```

- `nextId++` is **post-increment**: the current value is used for `id`, then `nextId` grows by
  one. Two tasks can never share an id.
- The function returns a **`string`, not the `Task` object**. That is a deliberate protocol
  decision: MCP tool results are `content` blocks, and the caller wants a sentence it can hand
  to a model, not a JSON blob it has to interpret.
- Note the defaults: a new task lands in project `inbox`, owner `123`, priority `normal`. Simple
  and predictable — the model only supplies a title, so there is nothing for it to get wrong.

```ts
export function completeTask(title: string): string {
  const task = tasks.find((candidate) => candidate.title === title && !candidate.done);

  if (!task) {
    return `No pending task titled "${title}". Call list_tasks to read the exact titles, then retry.`;
  }

  task.done = true;

  return `Task completed: ${task.title}`;
}
```

- `Array.prototype.find` returns the **first** match or `undefined`. The `!candidate.done` guard
  means completing an already-completed task reports "not found" rather than silently doing
  nothing.
- **The failure message is a feature, not an error string.** It names the fix (*"Call list_tasks
  to read the exact titles, then retry."*). This text goes back into the model's context, so it
  is an instruction channel — the same lesson Lecture 14 taught for `isError` results.
- `task.done = true` mutates the object **inside** the array. `find` returns a reference to the
  stored object, so no re-assignment or `splice` is needed.

### Block 4 — the reads (reached only through Resources)

```ts
export function listTasks(): Task[] {
  return tasks.map((task) => ({ ...task }));
}

export function openTasks(owner?: string): Task[] {
  return listTasks().filter((task) => !task.done && (owner === undefined || task.owner === owner));
}
```

- `tasks.map((task) => ({ ...task }))` returns **copies**. The spread `{ ...task }` is a shallow
  clone, so a caller cannot reach into the store and mutate a task by accident. For six flat
  fields that is enough.
- The parentheses around `({ ...task })` are required: without them JavaScript would parse the
  braces as a function body, not an object literal.
- `openTasks(owner?)` has an **optional parameter**. The guard reads: *not done* **and**
  *(no owner filter OR this task's owner matches)*. When `owner` is `undefined` the right-hand
  side is always `true`, so the filter degenerates to "all open tasks". That one function
  therefore serves both the whole-backlog view and the per-user view.

### Block 5 — `backlogText`: the dynamic view

```ts
export function backlogText(owner?: string): string {
  const open = openTasks(owner);

  if (open.length === 0) {
    return "No open tasks.";
  }

  const lines = open.map(
    (task) => `- [${task.priority}] ${task.title}  (project: ${task.projectId}, owner: ${task.owner})`,
  );

  return [`Open tasks: ${open.length}`, "", ...lines].join("\n");
}
```

- **This is what makes a Resource "dynamic".** The text is built from the live array on every
  call, so a task created one second ago appears on the next `resources/read`. There is no cache
  and no stored string.
- The early return handles the empty case *before* formatting, so you never get a header
  followed by nothing.
- `[`Open tasks: …`, "", ...lines]` builds an array of lines and joins them with `\n`. The `""`
  entry is an intentional blank line between the header and the list. The spread `...lines`
  flattens the mapped array into the same array.
- **Why plain text and not JSON?** `mimeType: "text/plain"` (Chapter 04) is honest, it is what a
  model reads best, and it keeps the example readable. A machine consumer would want
  `application/json` and `structuredContent` — a good exercise, not a requirement here.

### Block 6 — `summaryText`: the same data, aggregated

```ts
export function summaryText(owner?: string): string {
  const open = openTasks(owner);
  const high = open.filter((task) => task.priority === "high").length;
  const projects = [...new Set(open.map((task) => task.projectId))];

  return [
    `Open tasks: ${open.length}`,
    `High priority: ${high}`,
    `Normal priority: ${open.length - high}`,
    `Projects involved: ${projects.join(", ") || "none"}`,
  ].join("\n");
}
```

- `high` counts the high-priority open tasks; **normal is derived** as `open.length - high`
  rather than counted again. Fewer passes over the array and one less thing to keep in sync.
- `[...new Set(…)]` is the idiomatic de-duplication. `new Set` keeps unique project ids; the
  spread turns the Set back into an array so `.join(", ")` works.
- `|| "none"` handles the empty case: `[].join(", ")` is `""`, which is falsy, so the label
  becomes `none`.
- **Why a second Resource instead of one?** This is Lecture 02's *"same data, different intent"*.
  `task://backlog` is a list you read; `task://summary` is a number you reason about. A model
  asked *"how busy am I?"* should not have to count lines.

### Block 7 — `projectText`: the first template view

```ts
export function projectText(projectId: string): string {
  const inProject = listTasks().filter((task) => task.projectId === projectId);

  if (inProject.length === 0) {
    return `No tasks in project "${projectId}".`;
  }

  const lines = inProject.map((task) => `- ${task.done ? "[done]" : "[open]"} ${task.title}`);

  return [`Project: ${projectId}`, `Tasks: ${inProject.length}`, "", ...lines].join("\n");
}
```

- The parameter `projectId` is exactly the `{projectId}` variable of the URI template
  `task://projects/{projectId}`. **That correspondence is the whole idea of a templated
  Resource**: the URI carries the argument, and the handler receives it.
- Note this includes **done** tasks (`listTasks()`, not `openTasks()`) — a project brief is a
  record, not a to-do list. Different intent, different filter.
- The ternary `task.done ? "[done]" : "[open]"` picks the marker inline.
- The unknown-project path returns a **useful** sentence rather than throwing. Chapter 04 relies
  on that: a template can be asked for any id, so the handler must survive a bad one.

### Block 8 — `profileText`: the second template view

```ts
export function profileText(userId: string): string {
  const owned = listTasks().filter((task) => task.owner === userId);
  const open = owned.filter((task) => !task.done);

  if (owned.length === 0) {
    return `No profile found for user "${userId}".`;
  }

  return [
    `User: ${userId}`,
    `Open tasks: ${open.length} of ${owned.length}`,
    "",
    ...owned.map((task) => `- ${task.done ? "[done]" : "[open]"} ${task.title}`),
  ].join("\n");
}
```

- This is the board's `user://123/profile` example. In the lecture it is backed by MySQL; here it
  is derived from the tasks' `owner` field, which keeps the example honest without inventing a
  users table.
- `Open tasks: 2 of 2` gives both numbers, so the reader learns workload *and* history from one
  line.
- The spread `...owned.map(...)` maps inline instead of naming a `lines` variable — same result,
  one less binding, because the expression is only used once.

---

## 3.5 The one idea to take from this file

**Tools and Resources read and write the *same* array.** `createTask` is a Tool path;
`backlogText` is a Resource path. If the split were about *data*, they would need separate
stores. It is not about data — it is about **intent and control**, which is Lecture 02 in one
sentence.

You can see that in the project deliberately: `list_tasks` (a Tool, Chapter 07) returns exactly
the same string as `task://backlog` (a Resource, Chapter 04). The payload is identical. Only the
owner of the decision differs.

---

## 3.6 Run / verify

```bash
npx tsx -e "
import('./src/services/taskService.ts').then((s) => {
  console.log(s.backlogText());
  console.log('---');
  console.log(s.summaryText());
  console.log('---');
  console.log(s.projectText('fde'));
  console.log('---');
  console.log(s.profileText('123'));
  console.log('---');
  console.log(s.projectText('nope'));
});
"
```

Expected:

```text
Open tasks: 3

- [high] Write MCP notes  (project: fde, owner: 123)
- [normal] Review pull request  (project: fde, owner: 123)
- [normal] Record Lecture 15 video  (project: media, owner: 456)
---
Open tasks: 3
High priority: 1
Normal priority: 2
Projects involved: fde, media
---
Project: fde
Tasks: 2

- [open] Write MCP notes
- [open] Review pull request
---
User: 123
Open tasks: 2 of 2

- [open] Write MCP notes
- [open] Review pull request
---
No tasks in project "nope".
```

---

## 3.7 Checkpoint

1. **Why is `tasks` not exported?** → so every read and write goes through a named function,
   making the Tools/Resources split visible in the code.
2. **What makes `backlogText` a "dynamic" Resource?** → it is recomputed from the live array on
   every call, so it can never be stale.
3. **Where does `{projectId}` from the URI template end up?** → as the `projectId` argument of
   `projectText()`, via the template callback in Chapter 04.
4. **Which two functions does the model reach?** → `createTask` and `completeTask` (through
   Tools). Everything else here is application-side.

**Next:** [Chapter 04 — Resources: Static, Dynamic, Templated](./04_Resources_Static_Dynamic_and_Templated.md)



