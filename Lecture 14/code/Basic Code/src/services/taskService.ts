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
