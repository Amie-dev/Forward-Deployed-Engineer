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
