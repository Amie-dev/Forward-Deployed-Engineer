# Chapter 07: Domain — The Task Store & Idempotency

> **Chapter goal:** Give the server a persistence boundary that owns two things the
> service should never think about — the shape of the data, and **idempotency** — so
> that a retried `create_task` is a replay rather than a duplicate.

---

## 7.1 File details

| | |
| :--- | :--- |
| **Path** | `src/domain/taskStore.ts` |
| **Layer** | domain (imports only `../core/errors.js`) |
| **Purpose** | Hold the tasks, generate ids and timestamps, enforce the board's capacity, and turn a caller-supplied idempotency key into a replay instead of a second write |
| **Imports** | `ToolError` from `../core/errors.js` |
| **Exports** | `type TaskStatus`, `interface Task`, `interface CreateTaskCommand`, `interface CreateTaskResult`, `interface TaskStore`, `createTaskStore()` |
| **Consumed by** | `src/services/taskService.ts` |
| **Lecture sections** | [07 — The tool lifecycle](../../../notes/07_Discovery_Invocation_and_Lifecycle.md) §7.4 (execution is deterministic), [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §"Idempotency" |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the replay, visible end to end
npm run host | grep 'same key'
```

---

## 7.2 Full file

```ts
import { ToolError } from "../core/errors.js";

/**
 * Chapter 07 §7.4 / Chapter 08 — the persistence boundary.
 *
 * The store owns two things the service should never have to think about: the
 * shape of the data, and **idempotency**.
 *
 * Every side-effecting operation eventually gets called twice — a retry after a
 * timeout, an agent loop that repeats itself, a user who clicks the button
 * again. A caller-supplied key turns that second call into a *replay* instead of
 * a second task, which is the difference between an idempotent API and a
 * duplicate-charging one.
 *
 * State is in-process on purpose: this is the lecture's demo server, and the
 * point being taught is the protocol and the boundary, not a database driver.
 */

export type TaskStatus = "PENDING" | "COMPLETED";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskCommand {
  title: string;
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

export function createTaskStore(options: { maxTasks: number; now?: () => Date }): TaskStore {
  const tasks = new Map<number, Task>();
  const idempotencyKeys = new Map<string, number>();
  const now = options.now ?? (() => new Date());
  let nextId = 1;

  const stamp = (): string => now().toISOString();

  return {
    create({ title, idempotencyKey }) {
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
      const task: Task = { id: nextId++, title, status: "PENDING", createdAt: timestamp, updatedAt: timestamp };

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

## 7.3 Block-by-block explanation

### Block 1 — the two responsibilities, named

The header comment assigns the store exactly two jobs:

1. **the shape of the data** — `Task`, its statuses, its ids and timestamps
2. **idempotency** — the key-to-task mapping that turns a duplicate call into a
   replay

The second sentence is the operational argument:

> Every side-effecting operation eventually gets called twice — a retry after a
> timeout, an agent loop that repeats itself, a user who clicks the button again.

Those are the three ways it actually happens, and only one of them is a bug. A
retry after a timeout is *correct behaviour* from a host that cannot tell whether
the first call landed (Chapter 06's `withTimeout` explicitly recommends one retry).
An agent loop repeating itself is normal model behaviour. A user double-clicking is
a user. So the store must assume duplication is the norm, not the exception.

And the closing note is the honest limit:

> State is in-process on purpose: this is the lecture's demo server, and the point
> being taught is the protocol and the boundary, not a database driver.

The `TaskStore` **interface** is what makes that limit cheap to lift. Everything
above the store depends on the interface, not on the `Map` — so swapping in
Postgres means writing a second implementation of five methods and changing one
line in the composition root.

### Block 2 — `Task`, and the fields that are deliberately absent

```ts
export type TaskStatus = "PENDING" | "COMPLETED";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}
```

**What it does:** describes a task.
**How it works:** five fields, and the *absence* of others is as considered as
their presence.

**`TaskStatus` is a string-literal union, not an enum.** It compiles to nothing,
serialises as the readable `"PENDING"`, and matches the `z.enum(["PENDING",
"COMPLETED"])` in `taskService`'s `outputSchema` exactly — which is what lets the
same value satisfy the type checker *and* the runtime schema validator.

**`createdAt` and `updatedAt` are ISO 8601 strings, not `Date` objects.** This
matters more than it looks. A `Date` is not JSON — `JSON.stringify(new Date())`
produces a string, and `JSON.parse` gives back a string — so a `Date` field would
silently become a `string` the moment the task crossed the wire, and the type would
be a lie. Declaring them as strings keeps the type honest on both sides of the
serialisation boundary. It also means the `outputSchema` needs only
`z.string().describe("ISO 8601 …")` rather than a custom date parser.

**Why `updatedAt` and not `completedAt`?** Because `completedAt` would be
*optional* — present only for completed tasks — and an optional field interacts
badly with the SDK's output-schema validation, which is generated with
`additionalProperties: false`. `updatedAt` is always present, always meaningful, and
records the same information (a completed task's `updatedAt` is when it was
completed). One always-present field beats one conditionally-present field.

**`id: number`, not a string or UUID.** Numeric ids are what the tool schemas
declare (`z.number().int().positive()`), and they read well in the model's context:
`Task #1 created`. A UUID would triple the token cost of every id in every message
for no benefit in a single-process demo.

**What is absent: no `owner`, no `tags`, no `priority`.** Every field added here
must also be added to `taskSchema` in `taskService`, to the tool's `outputSchema`,
and to the model's mental model. Fields are not free — they are context budget and
contract surface.

### Block 3 — the command/result types, and why the store reports `replayed`

```ts
export interface CreateTaskCommand {
  title: string;
  /** Optional caller-supplied key. The same key never creates two tasks. */
  idempotencyKey?: string;
}

export interface CreateTaskResult {
  task: Task;
  /** True when the key had already been seen and nothing was written. */
  replayed: boolean;
}
```

**What they do:** name the input and output of the one operation with an
idempotency contract.
**How they work:** a command object in, a result object out.

**`CreateTaskCommand` rather than positional parameters.** `create(title, key)`
would work, but a command object means adding a field later (a due date, a priority)
does not change the method's arity or break call sites. It also makes the call site
self-documenting: `store.create({ title, idempotencyKey })`.

**`idempotencyKey?: string` is optional, and that is the correct default.** A caller
that does not supply a key gets the old, non-idempotent behaviour — which is right,
because *most* creates genuinely are new intentions. Idempotency is a claim the
caller makes ("this is a retry of a specific request"), and the store cannot invent
it. Deriving a key from the title would be wrong: two tasks may legitimately share a
title.

**`replayed: boolean` is the part worth dwelling on.** The store could have returned
just the task, silently, and the caller would never know whether a write happened.
Reporting it explicitly buys three things:

1. **A truthful message.** Chapter 10's handler branches on it:
   `Task #1 already existed (idempotent replay): …` versus `Task #1 created: …`.
   The model is told what actually happened, so it does not report a creation that
   never occurred.
2. **Observability.** A rising replay rate is a signal — it means something upstream
   is retrying, and a metrics dashboard can watch it.
3. **Testability.** `expect(result.replayed).toBe(true)` is a one-line assertion that
   the idempotency contract holds.

This is the general principle: **when an operation's behaviour differs from what the
caller might assume, say so in the return type.**

### Block 4 — the closure: two maps, a clock, and a counter

```ts
export function createTaskStore(options: { maxTasks: number; now?: () => Date }): TaskStore {
  const tasks = new Map<number, Task>();
  const idempotencyKeys = new Map<string, number>();
  const now = options.now ?? (() => new Date());
  let nextId = 1;

  const stamp = (): string => now().toISOString();
```

**What it does:** creates the store's private state and returns the public surface.
**How it works:** a factory returning a closure — the state is unreachable from
outside, and there is no `this` to lose.

**`tasks: Map<number, Task>`** — keyed by id, so `get`, `update` and `remove` are
O(1). The `id` is duplicated inside the value, which is deliberate redundancy: a
consumer iterating `list()` gets a self-contained object without needing the key.

**`idempotencyKeys: Map<string, number>`** — key → task **id**, not key → task. Two
reasons:

1. **Single source of truth.** The task lives in `tasks`; the idempotency map only
   points at it. Storing a second copy of the `Task` object would mean two places to
   update when the task changes, and `update` would have to keep them in sync.
2. **Deletion is handled correctly for free.** `remove` deletes from `tasks`; a later
   lookup through `idempotencyKeys` resolves to an id that is no longer in `tasks`,
   and `create`'s guard (`existing !== undefined`) then falls through and creates a
   new task. That is the right behaviour: deleting a task and re-issuing the same
   request should create it again, not resurrect a deleted one.

**`now = options.now ?? (() => new Date())`** — the clock is injectable. Production
passes nothing and gets the real clock; a test passes
`() => new Date("2026-01-01T00:00:00Z")` and gets deterministic timestamps. This is
the same technique as `RateLimiter.check(key, now)` in Chapter 06, applied to a
different kind of time dependency.

Note the shape: `now` is a **function**, not a `Date`. A captured `Date` would freeze
at construction and every task would share a timestamp.

**`let nextId = 1`** — a monotonic counter captured in the closure. Ids are never
reused: `remove` deletes the task but does not decrement `nextId`. That matters
because a reused id would make a stale reference in the model's context silently
point at a *different* task — the classic ABA problem, and a genuinely dangerous one
inside an agent loop.

**`const stamp = (): string => now().toISOString()`** — one helper so every write
produces a timestamp in the same format. Hoisting it means there is exactly one place
that decides how a timestamp is rendered, so `createdAt` and `updatedAt` can never
disagree about format.

### Block 5 — `create`: replay first, capacity second

```ts
create({ title, idempotencyKey }) {
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
  const task: Task = { id: nextId++, title, status: "PENDING", createdAt: timestamp, updatedAt: timestamp };

  tasks.set(task.id, task);
  if (idempotencyKey !== undefined) {
    idempotencyKeys.set(idempotencyKey, task.id);
  }

  return { task, replayed: false };
},
```

**What it does:** creates a task, or returns the one an earlier identical request
created.
**How it works:** the *order* of the two guards is the most important detail here.

**The replay check comes first**, and the comment says why: *"a retry must not be
able to fail on a full board."* Consider the alternative order. A client sends
`create_task` with a key; the task is created; the response is lost to a timeout; the
client retries. If capacity were checked first and the board had filled up in
between, the retry would fail with `LIMIT_EXCEEDED` — even though the task the client
is asking about **already exists**. The client would then believe its request never
succeeded, while the data says otherwise. Checking replay first makes the retry a
guaranteed success, which is the entire point of idempotency.

**`idempotencyKey !== undefined` rather than a truthiness check.** `if (idempotencyKey)`
would treat `""` as absent. The service's schema rejects empty keys
(`z.string().trim().min(1)`), so the two are equivalent *today* — but `!== undefined`
states the actual condition ("was a key supplied?") rather than relying on a
downstream validator to make it true.

**The two-step lookup, with an explicit `undefined` check:**

```ts
const existingId = idempotencyKeys.get(idempotencyKey);
const existing = existingId === undefined ? undefined : tasks.get(existingId);
```

This could be written `tasks.get(idempotencyKeys.get(key) ?? -1)`, but the explicit
form is better for two reasons. First, `?? -1` invents a sentinel id that could
collide with a real one if ids were ever allowed to be negative. Second, and more
importantly, the two steps *document the two-map design*: a reader sees that the key
map holds ids, not tasks, without looking back at the declarations.

**The capacity check throws a `ToolError`.** The store may know about `ToolError`
because `core/errors.ts` is a leaf module that imports nothing. Note the recovery
sentence: *"Complete or delete some tasks before creating more."* It names two tools
the model actually has, which is what makes it actionable.

**`nextId++` inside the object literal.** The post-increment returns the current value
and then increments, so the first task gets id 1 and the next gets 2. Written this
way, id assignment cannot drift from object construction — there is no window where a
task exists without an id.

**`createdAt: timestamp, updatedAt: timestamp` — the same string, captured once.**
Calling `stamp()` twice would risk the two fields differing by a millisecond, which
would make a brand-new task look like it had been modified.

**The idempotency key is recorded *after* the task is in the map.** Write the
referent before the reference.

### Block 6 — `list`, `get`, `update`, `remove`, `size`

```ts
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
```

**`list()` spreads into a new array.** `tasks.values()` returns an *iterator*, and
`[...it]` materialises it. Without the spread the method would hand back an iterator
that a caller could consume — and consuming it twice would silently yield nothing the
second time. More importantly, the array is a **copy of the references**, so
`list().pop()` cannot remove anything from the store. (The `Task` objects themselves
are still shared, which is why mutation goes through `update`.)

**`update(id, change)` takes a *function*, not a new value.** This is the most
interesting signature in the file. The alternative — `update(id, { status: "COMPLETED" })` —
would require the store to know which fields are settable, how to merge, and how to
distinguish "set to undefined" from "leave alone". A mutator callback sidesteps all
of it:

```ts
store.update(task.id, (current) => {
  current.status = "COMPLETED";
});
```

The store's only jobs are to find the task, apply the change, and stamp `updatedAt`.
The *rule* about what a completed task looks like stays in the service, where
business rules belong. And because the callback receives the live object, the caller
cannot accidentally replace it with a different one.

**The `undefined` return is the not-found signal.** Both `update` and `remove` return
`Task | undefined`, and the service turns `undefined` into a `NOT_FOUND` `ToolError`.
Returning `undefined` rather than throwing keeps the store free of *policy* — the
store reports what happened; the service decides whether it is a failure. That is
also why `create` *does* throw: a full board is a store-level invariant, not a
business rule.

**`updatedAt` is stamped by the store, not the caller.** Centralising it means every
mutation updates the timestamp, and a mutation added later cannot forget.

**`remove` returns the deleted task.** Useful twice over: the handler echoes it in the
result (`Task deleted: #2 Publish the notes.`), and a caller that needs to log or undo
the deletion has the data in hand. Deleting and returning nothing would force a `get`
before the `remove`.

**`size()` exists for the resource layer and for tests.** Nothing in the tool path
needs it — the capacity check reads `tasks.size` directly — but it is the natural way
to assert store behaviour without reaching into private state.

**Why a closure rather than a `class`?** A class would work identically, but the
closure has two small advantages here. It makes `tasks`, `idempotencyKeys` and
`nextId` genuinely private — `private` in TypeScript is compile-time only and is
erased at runtime, whereas closure scope is real. And it removes `this` from the
picture entirely, so a method can be destructured (`const { create } = store`) without
losing its receiver. The factory also matches the style of the rest of `core/`
(`createLogger`, `createMetrics`), which keeps the codebase uniform.

---

## 7.4 Run / verify

The idempotency contract is visible end to end in the demo. The host sends the same
`create_task` twice, with the same key:

```bash
npm run host | sed -n '17,19p'
```

```text
5. selection   -> (stand-in for the model) create_task
   tools/call create_task            -> Task #1 created: Record MCP Video (PENDING).
   tools/call create_task (same key) -> Task #1 already existed (idempotent replay): Record MCP Video (PENDING).
```

Read those two result lines together:

- Both report **`Task #1`** — the same id. A second task was not created.
- The first says **`created`**; the second says **`already existed (idempotent
  replay)`**. The `replayed` flag from `CreateTaskResult` produced that difference,
  and it is why the model is not told a creation happened twice.

The audit trail proves the same thing from the outside, by hashing the arguments:

```bash
npm run host 1>/dev/null 2>/tmp/audit.txt
grep 'create_task' /tmp/audit.txt
```

```text
{"ts":"…","level":"info","event":"audit","host":"task-host","tool":"create_task","decision":"auto","outcome":"ok","argsHash":"57036086e66b5396","durationMs":32}
{"ts":"…","level":"info","event":"audit","host":"task-host","tool":"create_task","decision":"auto","outcome":"ok","argsHash":"57036086e66b5396","durationMs":2}
{"ts":"…","level":"info","event":"audit","host":"task-host","tool":"create_task","decision":"auto","outcome":"ok","argsHash":"fe096691f37c3caa","durationMs":1}
```

The first two lines carry **the same `argsHash`** — they were byte-identical requests.
The third is a different request (`{"title":"Publish the notes"}`), so a different
hash. Chapter 16 covers how the hash is computed; the point here is that the store's
behaviour is independently verifiable from outside the process.

To check the store directly, with a frozen clock:

```bash
npx tsx -e '
import { createTaskStore } from "./src/domain/taskStore.ts";
const store = createTaskStore({ maxTasks: 2, now: () => new Date("2026-01-01T00:00:00.000Z") });
const first = store.create({ title: "Record MCP Video", idempotencyKey: "req-1" });
const again = store.create({ title: "Record MCP Video", idempotencyKey: "req-1" });
console.log("replayed:", again.replayed, "| same id:", first.task.id === again.task.id, "| size:", store.size());
console.log("createdAt:", first.task.createdAt);
try { store.create({ title: "a" }); store.create({ title: "b" }); store.create({ title: "c" }); }
catch (error) { console.log(error.code + ": " + error.message + " " + error.recovery); }
'
```

```text
replayed: true | same id: true | size: 1
createdAt: 2026-01-01T00:00:00.000Z
LIMIT_EXCEEDED: The task board is full (2 tasks). Complete or delete some tasks before creating more.
```

Three things confirmed in three lines:

1. **The replay did not write.** `replayed: true`, the same id, and `size: 1` — one
   task, not two.
2. **The clock is injectable.** `createdAt` is exactly the frozen instant, so a test
   can assert on timestamps without mocking global time.
3. **The capacity guard fires with a recovery sentence**, not a bare error. Note the
   `maxTasks: 2` limit: two creates succeeded (`"a"`, `"b"`) and the third threw —
   which is why the message says *"full (2 tasks)"*.

---

## 7.5 Checkpoint

1. **The store owns the data shape *and* idempotency.** The service owns business
   rules; neither leaks into the other.
2. **The replay check runs before the capacity check.** A retry must never fail on a
   full board, or the client will believe a write never happened while the data says
   otherwise.
3. **The idempotency map stores ids, not tasks.** One source of truth, and deletion
   behaves correctly for free.
4. **Ids are never reused.** A reused id would make a stale reference in the model's
   context point at a different task.
5. **`replayed` is reported, not hidden.** When behaviour differs from what the caller
   might assume, the return type says so.
6. **The clock is a function parameter.** Time is a dependency, and injectable time is
   testable time.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 06 — Core: Execution Guards](./06_Core_Execution_Guards.md)

**Next:** [Chapter 08 — Service: Validated Business Logic](./08_Services_Task_Service.md)




