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
