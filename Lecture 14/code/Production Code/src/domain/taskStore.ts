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
