# Chapter 07 — Domain: The Task Store & Idempotency

> **The persistence boundary.** The store owns two things no other layer should have to think about:
> the shape of the data, and **idempotency**. Every side-effecting operation eventually gets called
> twice — a retry after a timeout, an agent loop that repeats itself, a user who clicks the button
> again — and a caller-supplied key is what turns that second call into a *replay* instead of a second
> task.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/domain/taskStore.ts` (165 lines) |
| **Layer** | `domain` — imports only `core/errors.js`. No protocol, no transport, no prose. |
| **Purpose** | Hold the tasks, enforce the board limit, and make `create` idempotent by caller-supplied key. |
| **Exports** | `TaskStatus`, `TaskPriority`, `Task`, `CreateTaskCommand`, `CreateTaskResult`, `TaskStore`, `createTaskStore()` |
| **Lecture sections** | Ch04 §4.2 (why a field needs a reader), Ch02 (tools as the write path) |
| **Runs** | `npm run lifecycle` (the board is read in steps 3 and 5) |

---

## Commands

```bash
# the board as the Resource layer sees it
npm run lifecycle 2>/dev/null | sed -n '/^3\./,/^4\./p'

# the seeded state, read through the tool
curl -s 'http://127.0.0.1:8080/read?uri=task://summary'
```

---

## State is in-process on purpose

The header is explicit about the trade, and it is worth quoting because a reader will otherwise
assume a database was simply not got around to:

> State is in-process on purpose: this is a lecture codebase, and the point being taught is the
> protocol and the boundary, not a database driver. The interface is the seam a real store would
> replace — **nothing above it imports `Map`**.

That last clause is the load-bearing one. A `Map` appears in exactly two places in this project —
here, and in the TTL cache in `services/resourceService.ts` — and no file above `domain/` can tell
that this store is not a Postgres client. `TaskService` calls `create`, `list`, `get`, `update`,
`remove`, `size`. A real store implements the same six methods and nothing else changes.

The claim is checkable, and the real output is more interesting than a single count:

```bash
grep -rn 'new Map' src/
```

```text
src/domain/taskStore.ts:77:        const tasks = new Map<number, Task>();
src/domain/taskStore.ts:78:        const idempotencyKeys = new Map<string, number>();
src/services/resourceService.ts:277: const cache = new Map<string, { text: string; at: number }>();
src/core/metrics.ts:51:             const counters = new Map<string, number>();
src/core/metrics.ts:52:             const timings = new Map<string, Timing>();
src/core/guards.ts:38:              private readonly hits = new Map<string, number[]>();
src/domain/resourceCatalogue.ts:254:  const byName = new Map(descriptors.map((d) => [d.name, d]));
src/domain/resourceCatalogue.ts:258:  const compiled = new Map<string, { pattern: RegExp; names: string[] }>(...);
src/services/promptService.ts:208:    const byName = new Map(prompts.map((p) => [p.name, p]));
src/services/selectionService.ts:465:  const byUri = new Map<string, Selection>();
```

Ten sites in six files, and they fall into two clearly different categories:

| Kind | Sites | Nature |
| :--- | :--- | :--- |
| **Mutable state** | `taskStore` (2), `resourceService.cache`, `metrics` (2), `guards.hits` | Grows and changes over the process's life |
| **Read-only index** | `resourceCatalogue` (2), `promptService.byName`, `selectionService.byUri` | Built once from a fixed list, then only read |

The distinction matters because only the first category is *state that a real backend would own*. The
indices are pure functions of data that already exists in an array — `new Map(descriptors.map(...))`
is a lookup optimisation, and deleting it would change performance rather than behaviour.

So the honest form of the header's claim is narrower and still holds: **no file in `services/`,
`mcp/` or `host/` holds task state in a `Map`.** The only `Map` in `services/` are the resource cache
(a cache, not the source of truth) and two lookup indices. Every task is in `domain/taskStore.ts`,
behind six methods.

---

## `src/domain/taskStore.ts` — the full file

```ts
import { ToolError } from "../core/errors.js";

/**
 * The persistence boundary.
 *
 * The store owns two things no other layer should have to think about: the
 * shape of the data, and **idempotency**.
 *
 * Every side-effecting operation eventually gets called twice — a retry after a
 * timeout, an agent loop that repeats itself, a user who clicks the button
 * again. A caller-supplied key turns that second call into a *replay* instead of
 * a second task, which is the difference between an idempotent API and a
 * duplicate-charging one.
 *
 * State is in-process on purpose: this is a lecture codebase, and the point
 * being taught is the protocol and the boundary, not a database driver. The
 * interface is the seam a real store would replace — nothing above it imports
 * `Map`.
 */

export type TaskStatus = "PENDING" | "COMPLETED";

/**
 * Notes Ch04 §4.2 — priority and project exist because the *Resources* need
 * them: `task://summary` counts by priority and `task://projects/{projectId}`
 * groups by project. A field with no reader is a field that rots.
 */
export type TaskPriority = "high" | "normal";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Which project the task belongs to — the `{projectId}` template variable. */
  projectId: string;
  /** Which person owns it — the `{userId}` template variable. */
  owner: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskCommand {
  title: string;
  priority?: TaskPriority;
  projectId?: string;
  owner?: string;
  /** Optional caller-supplied key. The same key never creates two tasks. */
  idempotencyKey?: string;
}

export interface CreateTaskResult {
  task: Task;
  /** True when the key had already been seen and nothing was written. */
  replayed: boolean;
}

export interface TaskStore {
  create(command: CreateTaskCommand): CreateTaskResult;
  list(): Task[];
  get(id: number): Task | undefined;
  /** Applies `change` to a task and stamps `updatedAt`. Returns the task, or `undefined` if it is gone. */
  update(id: number, change: (task: Task) => void): Task | undefined;
  remove(id: number): Task | undefined;
  size(): number;
}

/** The seed board, so every run of the demo starts from the same readable state. */
const SEED: ReadonlyArray<Omit<Task, "createdAt" | "updatedAt">> = [
  { id: 1, title: "Write MCP notes", status: "PENDING", priority: "high", projectId: "fde", owner: "123" },
  { id: 2, title: "Review pull request", status: "PENDING", priority: "normal", projectId: "fde", owner: "123" },
  { id: 3, title: "Record Lecture 15 video", status: "PENDING", priority: "normal", projectId: "media", owner: "456" },
  { id: 4, title: "Publish the notes", status: "COMPLETED", priority: "normal", projectId: "media", owner: "456" },
];

export function createTaskStore(options: { maxTasks: number; now?: () => Date }): TaskStore {
  const tasks = new Map<number, Task>();
  const idempotencyKeys = new Map<string, number>();
  const now = options.now ?? (() => new Date());
  let nextId = 1;

  const stamp = (): string => now().toISOString();

  // Seed through the same code path a caller would take, so the seed cannot
  // drift from the invariants (ids, timestamps, status) enforced below.
  for (const seed of SEED) {
    const timestamp = stamp();
    tasks.set(seed.id, { ...seed, createdAt: timestamp, updatedAt: timestamp });
    nextId = Math.max(nextId, seed.id + 1);
  }

  return {
    create({ title, priority = "normal", projectId = "inbox", owner = "123", idempotencyKey }) {
      // Replay check first: a retry must not be able to fail on a full board.
      if (idempotencyKey !== undefined) {
        const existingId = idempotencyKeys.get(idempotencyKey);
        const existing = existingId === undefined ? undefined : tasks.get(existingId);
        if (existing !== undefined) {
          return { task: existing, replayed: true };
        }
      }

      if (tasks.size >= options.maxTasks) {
        throw new ToolError(
          "LIMIT_EXCEEDED",
          `The task board is full (${options.maxTasks} tasks).`,
          "Complete or delete some tasks before creating more.",
        );
      }

      const timestamp = stamp();
      const task: Task = {
        id: nextId++,
        title,
        status: "PENDING",
        priority,
        projectId,
        owner,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      tasks.set(task.id, task);
      if (idempotencyKey !== undefined) {
        idempotencyKeys.set(idempotencyKey, task.id);
      }

      return { task, replayed: false };
    },

    list() {
      // A copy, so a caller cannot mutate the store through the returned array.
      return [...tasks.values()];
    },

    get(id) {
      return tasks.get(id);
    },

    update(id, change) {
      const task = tasks.get(id);
      if (task === undefined) {
        return undefined;
      }

      change(task);
      task.updatedAt = stamp();
      return task;
    },

    remove(id) {
      const task = tasks.get(id);
      if (task === undefined) {
        return undefined;
      }

      tasks.delete(id);
      return task;
    },

    size() {
      return tasks.size;
    },
  };
}
```

### Block-by-block

**Block 1 — the types (lines 21–41).**

```ts
export type TaskStatus = "PENDING" | "COMPLETED";
export type TaskPriority = "high" | "normal";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
}
```

Eight fields, and the comment on `priority` and `projectId` is a design rule worth generalising:

> priority and project exist because the *Resources* need them: `task://summary` counts by priority
> and `task://projects/{projectId}` groups by project. **A field with no reader is a field that rots.**

That is the test for whether a field belongs: name its reader. `priority` is read by
`task://summary`'s count-by-priority; `projectId` is the `{projectId}` template variable in
`task://projects/{projectId}`; `owner` is the `{userId}` variable in `user://{userId}/profile` and the
ACL's subject. Every field has a consumer, and the consumer is *in this codebase* — not a
hypothetical future feature.

Contrast a `description` field: nothing reads it, no Resource renders it, no tool accepts it. Adding
it would mean a schema change, a store change, a tool schema change and a test, for a field that
nothing consumes. That is the rot the comment is warning about.

Two type details:

**`TaskStatus` is an uppercase union** (`"PENDING" | "COMPLETED"`) while `TaskPriority` is lowercase
(`"high" | "normal"`). That looks inconsistent and is deliberate: `status` is serialised into a
Resource body and read by a model as a *state label*, so it is written the way a state label is
written. `priority` appears inside prose ("[high] Write MCP notes") where a capitalised `[HIGH]`
would read as shouting. The casing is part of the output contract.

**`createdAt` and `updatedAt` are `string`, not `Date`.** ISO-8601 strings, because these values are
serialised into JSON and into Resource bodies. A `Date` object would be converted to a string by
`JSON.stringify` anyway — but at a point the type system cannot see, and with a timezone rule decided
by whoever serialises. Storing the string means one representation end to end.

**Block 2 — the command and result (lines 43–56).**

```ts
export interface CreateTaskCommand {
  title: string;
  priority?: TaskPriority;
  projectId?: string;
  owner?: string;
  /** Optional caller-supplied key. The same key never creates two tasks. */
  idempotencyKey?: string;
}

export interface CreateTaskResult {
  task: Task;
  /** True when the key had already been seen and nothing was written. */
  replayed: boolean;
}
```

The **command** pattern: a named input type rather than five positional parameters. That is what lets
`create({ title, priority })` be readable at the call site and lets a field be added without touching
every caller.

Every field except `title` is optional, and the defaults are applied in `create` below rather than
here — which means the *interface* documents what a caller may omit while the *implementation* owns
what the omission means. `idempotencyKey` is the only one with a security-shaped consequence, and its
comment states the guarantee.

The **result** carries `replayed: boolean`, and that is the difference between an idempotent API and
one that merely tolerates duplicates. Without the flag, a caller cannot distinguish "I created this"
from "this already existed" — and those need different reports. The tool turns it into different prose
(Chapter 14):

```text
Task #5 created: IDEM (normal priority, project inbox).
Task #5 already existed (idempotent replay): IDEM (PENDING).
```

A caller that retried after a timeout needs the second message, because it tells them their original
call *did* land.

**Block 3 — the `TaskStore` interface (lines 58–66).**

```ts
export interface TaskStore {
  create(command: CreateTaskCommand): CreateTaskResult;
  list(): Task[];
  get(id: number): Task | undefined;
  update(id: number, change: (task: Task) => void): Task | undefined;
  remove(id: number): Task | undefined;
  size(): number;
}
```

Six methods, and the return types carry the contract:

| Method | Returns | Why that type |
| :--- | :--- | :--- |
| `create` | `CreateTaskResult` (never throws except `LIMIT_EXCEEDED`) | Creation either happens or replays |
| `list` | `Task[]` | A snapshot of the board |
| `get` | `Task \| undefined` | Absence is a normal outcome, not an exception |
| `update` | `Task \| undefined` | Same — the task may have been removed concurrently |
| `remove` | `Task \| undefined` | Returns the removed task, so a caller can report *what* was deleted |
| `size` | `number` | The board limit check |

The `undefined` returns are where `noUncheckedIndexedAccess` (Chapter 01) pays off. Because the
compiler forces every caller to handle the `undefined` branch, "not found" cannot be forgotten — and
the branch where it is handled is where the recovery sentence lives.

`update(id, change: (task: Task) => void)` is worth noting: it takes a **mutator callback** rather
than a partial object. The store applies the change and stamps `updatedAt`, so no caller can forget
to. With a partial-object signature, every call site would be responsible for the timestamp, and one
of them would forget.

**Block 4 — the seed (lines 68–74).**

```ts
const SEED: ReadonlyArray<Omit<Task, "createdAt" | "updatedAt">> = [
  { id: 1, title: "Write MCP notes", status: "PENDING", priority: "high", projectId: "fde", owner: "123" },
  { id: 2, title: "Review pull request", status: "PENDING", priority: "normal", projectId: "fde", owner: "123" },
  { id: 3, title: "Record Lecture 15 video", status: "PENDING", priority: "normal", projectId: "media", owner: "456" },
  { id: 4, title: "Publish the notes", status: "COMPLETED", priority: "normal", projectId: "media", owner: "456" },
];
```

Four tasks, chosen so that every Resource and every ACL branch has something to show:

| Task | Why it is there |
| :--- | :--- |
| 1 — *Write MCP notes* | `high` priority → exercises `task://summary`'s priority count |
| 2 — *Review pull request* | A second `fde` task, so the project group has more than one |
| 3 — *Record Lecture 15 video* | `media` project, owner `456` → a **different user**, which is what the ACL test needs |
| 4 — *Publish the notes* | `COMPLETED` → so `list_tasks` and `task://backlog` show 3 open of 4 total |

The `Omit<Task, "createdAt" | "updatedAt">` type is the useful detail: the seed declares everything
**except** the timestamps, so a seed entry that tried to hard-code a timestamp would be a type error.
Timestamps are always generated (line 87), which is what makes every run produce the same *readable*
state without producing the same *timestamps*.

And 3 open of 4 total is exactly what the lifecycle prints — `Open tasks: 3` — which is why the demo
is reproducible enough to quote in a guide.

**Block 5 — the closure state and the clock (lines 76–90).**

```ts
export function createTaskStore(options: { maxTasks: number; now?: () => Date }): TaskStore {
  const tasks = new Map<number, Task>();
  const idempotencyKeys = new Map<string, number>();
  const now = options.now ?? (() => new Date());
  let nextId = 1;

  const stamp = (): string => now().toISOString();
```

A **factory** returning an object literal, not a class. Same reasoning as `createLogger` in Chapter
03: the state lives in the closure, no caller can reach it, and a test can construct an isolated
store. `createTaskStore({ maxTasks: 10 })` twice gives two independent boards.

Three pieces of state, and the middle one is the idempotency mechanism:

| State | Type | Purpose |
| :--- | :--- | :--- |
| `tasks` | `Map<number, Task>` | The board, keyed by id |
| `idempotencyKeys` | `Map<string, number>` | Caller key → the id it created |
| `nextId` | `number` | Monotonic id allocation |

**The idempotency map is a second index, not a field on the task.** That is a deliberate choice with a
consequence: the key is *not* part of the `Task` shape, so it never leaks into a Resource body, a tool
result, or a log line. A key is a caller's private bookkeeping token, and the store keeps it private.

**`now` is injectable** — `options.now ?? (() => new Date())`. This is the single most valuable line in
the file for testability, and it is the same trick as `RateLimiter`'s `now` parameter (Chapter 06). A
test that wants to assert "`updatedAt` changed after `update`" can pass a clock it controls instead of
sleeping:

```ts
let clock = new Date("2026-01-01T00:00:00Z");
const store = createTaskStore({ maxTasks: 10, now: () => clock });
store.create({ title: "x" });
clock = new Date("2026-01-01T00:00:05Z");   // no sleeping required
```

Without the seam, that test needs a real delay and becomes flaky. Note the default is a *function*
`() => new Date()`, not a `Date` value — a `Date` captured once at construction would freeze time for
the life of the store, which is a subtle bug the function form avoids.

**`stamp()`** is a one-line helper so `now().toISOString()` is written once. Two call sites need it
(creation and update), and a helper is how they cannot diverge in format.

**The seeding loop (lines 84–90).**

```ts
for (const seed of SEED) {
  const timestamp = stamp();
  tasks.set(seed.id, { ...seed, createdAt: timestamp, updatedAt: timestamp });
  nextId = Math.max(nextId, seed.id + 1);
}
```

The comment says *seed through the same code path a caller would take, so the seed cannot drift from
the invariants (ids, timestamps, status) enforced below.* The seed is applied through the same
`tasks.set` the `create` path uses, with timestamps generated the same way — so a seeded task is
indistinguishable from a created one except by its id.

`nextId = Math.max(nextId, seed.id + 1)` is the line that stops the store handing out a colliding id.
With four seeds, `nextId` becomes 5 — which is why the first `create_task` in a fresh process reports
**Task #5**. Hard-coding `nextId = 5` would work today and break the moment someone edits `SEED`.

**Block 6 — `create`, and the order of its two checks (lines 92–129).**

```ts
create({ title, priority = "normal", projectId = "inbox", owner = "123", idempotencyKey }) {
  // Replay check first: a retry must not be able to fail on a full board.
  if (idempotencyKey !== undefined) {
    const existingId = idempotencyKeys.get(idempotencyKey);
    const existing = existingId === undefined ? undefined : tasks.get(existingId);
    if (existing !== undefined) {
      return { task: existing, replayed: true };
    }
  }

  if (tasks.size >= options.maxTasks) {
    throw new ToolError(
      "LIMIT_EXCEEDED",
      `The task board is full (${options.maxTasks} tasks).`,
      "Complete or delete some tasks before creating more.",
    );
  }
  ...
}
```

**The ordering is the whole point, and the comment states it:** *replay check first: a retry must not
be able to fail on a full board.*

Consider the reverse order. A caller creates a task, the response times out, and the caller retries
with the same idempotency key. If the board-limit check ran first and the board was now full, the
retry would fail with `LIMIT_EXCEEDED` — for a task that already exists and that the caller
*cannot* create again. The caller is stuck: it cannot retry (the board is full) and it cannot proceed
(the task it wanted is already there but it does not know that).

Checking the replay first means the second call returns the existing task, which is the correct and
useful answer. **Idempotency has to be checked before any precondition that the first call might have
invalidated.** That is a general rule, and this is the line that applies it.

Note the two-step lookup: `idempotencyKeys.get(key)` gives an **id**, then `tasks.get(id)` gives the
task. The `existingId === undefined ? undefined : ...` guard is required by
`noUncheckedIndexedAccess` and also handles a genuine edge case — a key whose task was subsequently
deleted. In that case `tasks.get` returns `undefined`, the replay check does not fire, and the call
proceeds to create a new task. Deleting a task therefore *releases* its idempotency key, which is the
behaviour you want: the key's purpose was to prevent a duplicate of a task that no longer exists.

The `maxTasks` guard raises a `ToolError` with `LIMIT_EXCEEDED` — the code whose default status is
429 (Chapter 05) — and a recovery sentence naming the two available actions: *complete or delete some
tasks before creating more.* A caller told the board is full and given nothing to do about it will
retry; a caller given two concrete options can act.

**The defaults (line 93).** `priority = "normal"`, `projectId = "inbox"`, `owner = "123"`. The last
one deserves a flag: `owner` defaults to `"123"` — a hard-coded user id. In this codebase that is the
demo's actor, and it is defensible because a real deployment would take the owner from the
**session** rather than from a tool argument. Putting it here, in the domain, with an obvious
placeholder, is more honest than threading a fake session through the tool layer to make the default
look principled. A reader who notices it has found the seam where identity belongs.

**Block 7 — the read paths (lines 131–164).**

```ts
list() {
  // A copy, so a caller cannot mutate the store through the returned array.
  return [...tasks.values()];
},
```

One line and a real decision. `[...tasks.values()]` allocates a new array. Returning the array itself
is impossible (a `Map`'s values iterator is not an array), but the tempting shortcut is to cache an
array and return it — which would let a caller `push` into the store's own array.

The tasks *inside* the array are still shared references, so a caller could mutate a task object. That
is a deliberate trade: deep-cloning every task on every `list` would cost real allocation on a hot
path, and this is a demo. The interface documents the intent (`update` is the way to change a task),
and the defensive copy covers the case that actually happens by accident — a caller sorting or
splicing the result.

```ts
get(id) { return tasks.get(id); },

update(id, change) {
  const task = tasks.get(id);
  if (task === undefined) {
    return undefined;
  }

  change(task);
  task.updatedAt = stamp();
  return task;
},

remove(id) {
  const task = tasks.get(id);
  if (task === undefined) {
    return undefined;
  }

  tasks.delete(id);
  return task;
},

size() { return tasks.size; },
```

`get` is a bare `Map.get` and returns `Task | undefined` — absence is a value, not an exception. That
is the convention `noUncheckedIndexedAccess` encourages and it is what makes the "not found" branch
in `TaskService.complete` and `TaskService.remove` compulsory.

`update` takes a mutator and **stamps `updatedAt` itself**. The caller's callback does not see the
timestamp, cannot set it, and cannot forget it. The return value is the task (not `void`), so a caller
that wants to report the new state does not need a second lookup.

`remove` returns the **removed** task rather than a boolean. That is what lets `delete_task` say
*"Task deleted: #2 Review pull request."* — naming what was destroyed. A `boolean` would force the
caller to look up the task *before* deleting it, and would leave a window in which the two could
disagree.

Neither `update` nor `remove` touches `idempotencyKeys`. The consequence is intentional and was
noted above: removing a task releases its key, so a subsequent create with that key succeeds rather
than replaying into a tombstone.

---

## Run / verify

The store is a pure in-process object with an injectable clock, so every behaviour below is directly probeable with no server and no HTTP. A fixed clock makes the timestamps deterministic:

```ts
import { createTaskStore } from "./src/domain/taskStore.js";

let tick = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 12, 0, tick++));

const store = createTaskStore({ maxTasks: 10, now });
```

### 1. The seed, and the ids

```text
seed size: 4 | ids: 1,2,3,4
```

**Four tasks, ids 1–4** — matching `SEED` exactly. The seeding loop also advances `nextId`:

```ts
nextId = Math.max(nextId, seed.id + 1);
```

So the first created task gets id 5 rather than colliding with the seed. The comment on the loop explains why the seed goes through the *same* code path: *so the seed cannot drift from the invariants (ids, timestamps, status) enforced below.* A hand-written literal seed with `createdAt: ""` would compile and produce a task with an empty timestamp.

### 2. Idempotency — the same key is a replay

```text
--- idempotency ---
first : id=5 replayed=false
second: id=5 replayed=true
same object? true | size after two creates: 5
```

**Two creates, one task.** The second returns `id=5` with `replayed: true`, and the size stays at 5. Note `same object? true` — the replay returns the *identical* `Task` reference, not a copy, because the branch returns `tasks.get(existingId)` directly. That is correct for a replay: the caller gets the state that already exists.

And the mechanism is two lookups, which is why the check reads the way it does:

```ts
const existingId = idempotencyKeys.get(idempotencyKey);
const existing = existingId === undefined ? undefined : tasks.get(existingId);
if (existing !== undefined) { return { task: existing, replayed: true }; }
```

The key maps to an **id**, and the id maps to a task. So the map is small (a string per key) and the task is the single source of truth — a key can never point at a task that does not exist, because the second lookup is what decides.

**The `replayed` flag is what makes the difference observable.** A store that silently returned the existing task would be idempotent but would leave a caller unable to distinguish *"I created it"* from *"it already existed"* — which matters when the caller wants to report what happened.

### 3. A different key is a different task; no key means no dedupe

```text
--- a different key is a different task ---
id=6 replayed=false | size: 6

--- no key means no dedupe ---
ids: 7 8 -> distinct: true
```

**`key-2` produced id 6**, because the map is keyed by the caller's string — a different string is a different task. That is the intended semantics: the key identifies *the operation*, not the payload.

And **two identical creates with no key produced two tasks** (ids 7 and 8). That is also correct and worth stating: idempotency here is **opt-in**, because the store cannot invent a key that identifies "the same operation" — only the caller knows whether a repeated call is a retry or a genuine second request. A store that deduped on `title` would silently swallow a legitimate duplicate.

### 4. `update` stamps `updatedAt`; `remove` returns the task

```text
--- update stamps updatedAt, remove returns the task ---
update(2): COMPLETED | createdAt=2026-01-01T12:00:01.000Z | updatedAt=2026-01-01T12:00:08.000Z
update(999): undefined
remove(4): Publish the notes | size now: 7
remove(4) again: undefined
```

**The two timestamps differ, and the difference is the injected clock at work.** `createdAt` is `…12:00:01.000Z` (the seed's tick) while `updatedAt` is `…12:00:08.000Z` (the tick at the moment of the update). The mutator set only `status`; the store stamped the time itself:

```ts
update(id, change) {
  const task = tasks.get(id);
  if (task === undefined) return undefined;
  change(task);
  task.updatedAt = stamp();
  return task;
}
```

So a caller **cannot forget** to stamp it and **cannot forge** it. That is the same principle as `actor` coming from the session rather than from the model.

**Absence is a value, not an exception** — `update(999)` and the second `remove(4)` both return `undefined` rather than throwing. The store distinguishes *"no such task"* from *"the operation failed"*, and the caller decides which is an error. In `TaskService` that decision is a `ToolError("NOT_FOUND", …)`; in a hypothetical bulk operation it might be a skip.

**`remove(4)` returned `Publish the notes`** — the removed task, not a boolean. That is what lets `delete_task` name what it destroyed (Block 7).


### 5. Removing releases the key

```text
--- removing releases the key ---
new id: 10 | replayed: false (false = the key was released)
```

**A deliberate consequence, and a subtle one.** `remove` deletes from `tasks` but not from `idempotencyKeys`, so the key now points at an id that no longer resolves. The next `create` with that key finds `existing === undefined`, falls through, and creates a **new** task — `replayed: false`.

The alternative — keeping a tombstone — would spend the key permanently: a retry after a delete would replay into a task that no longer exists, which is worse than creating a fresh one. Block 7 notes the trade rather than hiding it.

### 6. The limit, and the 429

```text
--- the limit, on a full board ---
code: LIMIT_EXCEEDED | httpStatus: 429 | retryable: false
message: The task board is full (4 tasks).
recovery: Complete or delete some tasks before creating more.
```

**Four fields, and all four were decided at the throw site** — the same `ToolError` discipline as Chapter 05. The `httpStatus: 429` is the taxonomy's mapping for `LIMIT_EXCEEDED` (Too Many Requests), so this becomes a correct HTTP response without the controller choosing anything.

The `message` interpolates `options.maxTasks`, so the operator sees the *configured* number rather than a bare "full". And the `recovery` sentence is an instruction: *Complete or delete some tasks before creating more.*

### 7. The replay-before-limit ordering, verified properly

The comment in `create` makes a specific claim: *"Replay check first: a retry must not be able to fail on a full board."* That is testable, and the test needs care — the key must have been **registered by an earlier successful create**:

```text
--- replay on a FULL board, when the key was registered FIRST ---
original : id=5 replayed=false | size: 5
new key  : refused -> LIMIT_EXCEEDED
retry    : id=5 replayed=true | size: 5
-> a retry cannot fail on a full board, because the replay check runs first
```

**The middle line is what makes the third line meaningful.** With the board at capacity (4 seeded + 1 created), a *new* key is correctly refused — and the *same* key replays successfully. So the ordering does what the comment says: a retry of a call that already succeeded cannot be turned into a failure by the board filling up in the meantime.

And the boundary case, which corrects a natural misreading:

```text
--- but a key that was never registered has nothing to replay ---
board is full at 4 tasks
an unseen key on a full board -> LIMIT_EXCEEDED
-> the replay check only helps when an earlier create REGISTERED the key
```

**A brand-new key on a full board is still refused**, and that is right: there is nothing to replay, so the request is a genuine create and the limit applies. So the guarantee is precisely *"a retry cannot fail"* — **not** *"any keyed call succeeds on a full board."* Reading the comment as the latter would be a mistake, and it is the kind of mistake that only shows up under load.

### 8. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

The store is where `noUncheckedIndexedAccess` earns its place: `get` returns `Task | undefined`, so every caller must handle absence, and the compiler enforces it rather than leaving it to a runtime `undefined is not a function`.


---

## Checkpoint

1. **Why is state in-process, and what makes that acceptable?**
   Because the point being taught is the *protocol and the boundary*, not a database driver. It is acceptable because **the interface is the seam a real store would replace — nothing above it imports `Map`.**

2. **Why does the seed go through the same construction path as a caller's create?**
   So *the seed cannot drift from the invariants* (ids, timestamps, status). A hand-written literal seed could compile with an empty `createdAt`.

3. **What exactly does an idempotency key turn a second call into?**
   A **replay** rather than a second task — which is *the difference between an idempotent API and a duplicate-charging one.*

4. **Why does the key map to an id rather than to a task?**
   So the task remains the single source of truth. The key cannot point at a task that does not exist, because the second lookup is what decides.

5. **Why is `replayed` in the result?**
   So a caller can tell *"I created it"* from *"it already existed"* — a store that silently returned the existing task would be idempotent but unreportable.

6. **Why is idempotency opt-in rather than automatic?**
   Because only the caller knows whether a repeated call is a retry or a genuine second request. Deduping on `title` would silently swallow a legitimate duplicate.

7. **What does `update` guarantee that a caller cannot?**
   That `updatedAt` is stamped — the mutator does not see the timestamp, cannot set it and cannot forget it. Same principle as `actor` coming from the session.

8. **Why does `remove` return the removed task rather than a boolean?**
   So `delete_task` can name what it destroyed. A `boolean` would force a lookup *before* the delete and leave a window in which the two could disagree.

9. **Why does removing a task release its idempotency key?**
   Because the alternative — a tombstone — would spend the key permanently, so a retry after a delete would replay into a task that no longer exists. Creating a fresh one is the better failure mode.

10. **What does the "replay check first" ordering actually guarantee?**
    That **a retry cannot fail on a full board** — not that any keyed call succeeds on one. The guarantee only applies when an earlier create registered the key; a brand-new key on a full board is still refused with `LIMIT_EXCEEDED`.

11. **Which status code does `LIMIT_EXCEEDED` map to, and where was that decided?**
    `429`. It was decided at the throw site in `core/errors.ts`, so the controller performs a lookup rather than a judgement call.

---

**[← Chapter 06: Core Guards — Rate, Timeout, Budget](./06_Core_Guards_Rate_Timeout_Budget.md)** · **[Chapter 08: Domain — The Resource Catalogue →](./08_Domain_Resource_Catalogue.md)**

