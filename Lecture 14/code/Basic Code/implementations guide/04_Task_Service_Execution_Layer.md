# Chapter 04 — Task Service: The Execution Layer

> **Goal of this chapter:** read the *business logic* — the part that actually does the work.
> This file is the reason the lecture insists the model never sees your code: the model reads a
> contract (`tools.ts`), and this file is the ordinary, deterministic, unit-testable software
> behind it.
>
> **Lecture chapters:** [05 — The Tools Primitive](../../../notes/05_The_Tools_Primitive.md)
> (§5.2 "a tool is not a function in your codebase"),
> [07 — Discovery, Invocation and Lifecycle](../../../notes/07_Discovery_Invocation_and_Lifecycle.md)
> (§7.4 the deterministic middle).

---

## 4.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/taskService.ts` |
| **Layer** | execution / business logic (knows nothing about MCP) |
| **Purpose** | in-memory task store with `create`, `list`, `complete` |
| **Imports** | **none** (not even the SDK) |
| **Exports** | `TaskStatus` (type), `Task` (interface), `taskService` (object) |
| **Imported by** | `src/tools/tools.ts` only |
| **Lecture sections** | 05 §5.2, 07 §7.4 |

### Why "no imports" is the whole point

This file does not import the MCP SDK, zod, or the config. It could be lifted into any Node
project unchanged. That is Chapter 05's boundary made structural: **the contract (`tools.ts`) and
the implementation (`taskService.ts`) live in different files, so the model can never see this one.**

---

## 4.2 Commands

There is no npm script for this file, but you can drive it directly with `tsx` — a quick way to
prove it is ordinary, testable software:

```bash
cd "Lecture 14/code/Basic Code"

npx tsx -e "import { taskService } from './src/services/taskService.ts';
console.log('create ->', taskService.create('Demo Task'));
console.log('list   ->', taskService.list());
console.log('complete(exact) ->', taskService.complete('Demo Task'));
console.log('complete(miss)  ->', taskService.complete('Nope'));"
```

Expected output:

```text
create -> { id: 1, title: 'Demo Task', status: 'PENDING' }
list   -> [ { id: 1, title: 'Demo Task', status: 'PENDING' } ]
complete(exact) -> { id: 1, title: 'Demo Task', status: 'COMPLETED' }
complete(miss)  -> undefined
```

Notice the last line: a miss returns **`undefined`**, not a thrown error. That choice is what lets
the tool turn a failure into a recoverable `isError: true` result (Chapter 05).

---

## 4.3 Full file

**Path:** `src/services/taskService.ts`

```ts
/**
 * Chapter 05 §5.2 and Chapter 07 §7.4 — the *execution* layer.
 *
 * The model never sees this file. It sees only the contract written in
 * `src/tools/tools.ts`. Everything below is ordinary, deterministic,
 * unit-testable software — which is exactly the point of the lecture's
 * "two of the five phases are non-deterministic, and neither is this one".
 */

export type TaskStatus = "PENDING" | "COMPLETED";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
}

const tasks = new Map<number, Task>();
let nextId = 1;

export const taskService = {
  create(title: string): Task {
    const task: Task = { id: nextId++, title, status: "PENDING" };
    tasks.set(task.id, task);
    return task;
  },

  list(): Task[] {
    return [...tasks.values()];
  },

  /**
   * Completes the pending task carrying this exact title.
   * `undefined` means "the operation failed" — the tool turns that into a
   * tool execution error (`isError: true`), not a protocol error.
   */
  complete(title: string): Task | undefined {
    const task = [...tasks.values()].find((candidate) => candidate.title === title && candidate.status === "PENDING");
    if (!task) {
      return undefined;
    }

    task.status = "COMPLETED";
    return task;
  },
};
```

---

## 4.4 Block-by-block explanation

### Block 1 — the module comment (read it as a spec)

```ts
/**
 * Chapter 05 §5.2 and Chapter 07 §7.4 — the *execution* layer.
 *
 * The model never sees this file. It sees only the contract written in
 * `src/tools/tools.ts`. ...
 */
```

**What it does:** states the file's role and its boundary.

**How it works:** it is documentation only — it has no runtime effect. But it encodes the rule you
should apply whenever you add logic here: *if the model needs to know about it, it belongs in
`tools.ts` (the description/schema), not here.*

### Block 2 — the status type

```ts
export type TaskStatus = "PENDING" | "COMPLETED";
```

**What it does:** defines the only two states a task can be in.

**How it works:**
- A **string-literal union type** — TypeScript restricts the value to exactly `"PENDING"` or
  `"COMPLETED"` at compile time. Assigning `"DONE"` is a type error.
- This is the same idea the tool schema expresses at runtime with `z.enum(["PENDING", "COMPLETED"])`
  (Chapter 05). The type keeps *your* code honest; the schema keeps the *model's* arguments honest.

### Block 3 — the task shape

```ts
export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
}
```

**What it does:** declares the record every operation reads and writes.

**How it works:** it mirrors `taskSchema` in `tools.ts` field-for-field. Keeping them aligned by
hand is fine here; in a larger codebase you would derive the schema from the type (or vice-versa)
so they cannot drift.

### Block 4 — the module-level state

```ts
const tasks = new Map<number, Task>();
let nextId = 1;
```

**What it does:** holds all tasks in memory and tracks the next id to assign.

**How it works:**
- `new Map<number, Task>()` — a keyed collection `id → Task`, giving O(1) lookups by id.
- `let nextId = 1` — a simple monotonic counter. `nextId++` returns the current value *then*
  increments, so the first task gets id `1`.
- Both are **module-private** (`const`/`let`, not `export`ed), so nothing outside this file can
  mutate the store directly — all access goes through `taskService`.
- Because the state is in memory, it resets when the process restarts. That is fine for the demo;
  a real server would swap this for a database without changing the tool contract.

### Block 5 — `create`

```ts
  create(title: string): Task {
    const task: Task = { id: nextId++, title, status: "PENDING" };
    tasks.set(task.id, task);
    return task;
  },
```

**What it does:** adds a new task in `PENDING` status and returns it.

**How it works:**
- `{ id: nextId++, title, status: "PENDING" }` uses shorthand property syntax: `title` means
  `title: title`. The id is assigned and the counter advanced in one expression.
- `tasks.set(task.id, task)` stores it in the map.
- Returning the created `Task` lets the tool echo the assigned id back to the model.

### Block 6 — `list`

```ts
  list(): Task[] {
    return [...tasks.values()];
  },
```

**What it does:** returns every task as an array.

**How it works:**
- `tasks.values()` is an *iterator*, not an array. `[...iterator]` spreads it into a new array.
- Returning a **new array** (not the Map) means callers cannot mutate the store through the return
  value — they get a snapshot of the references. This is the small discipline that keeps the
  service the single owner of its state.

### Block 7 — `complete` and the `undefined` contract

```ts
  /**
   * Completes the pending task carrying this exact title.
   * `undefined` means "the operation failed" — the tool turns that into a
   * tool execution error (`isError: true`), not a protocol error.
   */
  complete(title: string): Task | undefined {
    const task = [...tasks.values()].find((candidate) => candidate.title === title && candidate.status === "PENDING");
    if (!task) {
      return undefined;
    }

    task.status = "COMPLETED";
    return task;
  },
```

**What it does:** finds a *pending* task whose title **exactly** matches, marks it `COMPLETED`,
and returns it. If no such task exists, it returns `undefined`.

**How it works:**
- `[...tasks.values()].find(predicate)` scans the snapshot and returns the first match (or
  `undefined`). The predicate requires **both** an exact title match **and** `status === "PENDING"`
  — so completing an already-completed task is treated as a miss (which is why the tool's
  `idempotentHint` is a *hint*, not a guarantee).
- `if (!task) return undefined;` — the failure signal. Deliberately **not** a `throw`:
  - A thrown exception in the SDK would become a **protocol error** (the call "did not happen").
  - Returning `undefined` lets `tools.ts` return a **tool execution error** — a normal result with
    `isError: true` — whose text goes back into the model's context as a recovery instruction
    (Chapter 05 §5.7). That distinction is the entire reason this method returns `undefined`.
- On success, `task.status = "COMPLETED"` **mutates the stored object** (it is the same reference
  the Map holds), then returns it.

---

## 4.5 Run / verify

```bash
cd "Lecture 14/code/Basic Code"
npx tsx -e "import { taskService } from './src/services/taskService.ts';
console.log(taskService.create('A'));
console.log(taskService.complete('A'));
console.log(taskService.complete('A'));  // second call -> undefined (already COMPLETED)
console.log(taskService.complete('B'));  // unknown title -> undefined"
```

You should see the first `complete` return a `COMPLETED` task and both later calls return
`undefined` — proving the "exact title + must be pending" rule.

---

## 4.6 Checkpoint

1. **Why does `complete` return `undefined` instead of throwing?** So the tool can report a *tool
   execution error* (`isError: true`) with a recovery message, rather than a protocol error.
2. **What is the matching rule?** Exact title match **and** the task must currently be `PENDING`.
3. **What does this file know about MCP?** Nothing — it has zero imports.

**Next:** [Chapter 05 — Tools: The Tools Primitive](./05_Tools_The_Tools_Primitive.md)

