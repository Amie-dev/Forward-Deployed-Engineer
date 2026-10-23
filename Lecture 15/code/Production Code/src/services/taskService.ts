import * as z from "zod/v4";
import { ToolError } from "../core/errors.js";
import type { CreateTaskResult, Task, TaskPriority, TaskStatus, TaskStore } from "../domain/taskStore.js";

/**
 * The execution layer.
 *
 * The model never sees this file. It sees only the contract in
 * `src/mcp/tools.ts`. Two rules make this layer trustworthy:
 *
 *  1. **Re-validate everything.** The `inputSchema` the host showed the model is
 *     a hint to the model, not a guarantee to you: a buggy or hostile client can
 *     send anything it likes. The validation here is the only validation that
 *     counts.
 *
 *  2. **A failure is an instruction.** Every throw carries a recovery sentence,
 *     because on the tool path the text ends up in the model's context and the
 *     model's next move is decided by it.
 *
 * This service deliberately returns **typed facts, not prose**. Turning a task
 * list into a paragraph is the resource layer's job (Notes Ch03 §3.7: the same
 * data is a tool result, a text resource and a JSON document, and those are
 * three different renderings of one truth).
 */

/** The single source of truth for what a title may be. */
export const taskTitle = z
  .string()
  .trim()
  .min(1, "title must not be empty")
  .max(120, "title must be at most 120 characters");

export const taskId = z.number().int().positive("id must be a positive integer");

export const taskPriority = z.enum(["high", "normal"]);

export const statusFilter = z.enum(["PENDING", "COMPLETED"]);

export const idempotencyKey = z.string().trim().min(1).max(64, "idempotencyKey must be at most 64 characters");

/** Notes Ch04 §"Validate and constrain dynamic URIs" — a project id is a slug, not free text. */
export const projectId = z
  .string()
  .trim()
  .min(1, "projectId must not be empty")
  .max(40, "projectId must be at most 40 characters")
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "projectId must be a slug: letters, digits, dash or underscore");

/** The `{userId}` template variable. Kept deliberately narrow. */
export const userId = z
  .string()
  .trim()
  .min(1, "userId must not be empty")
  .max(40, "userId must be at most 40 characters")
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "userId must be a slug: letters, digits, dash or underscore");

/** The `outputSchema` shared by the tools that return a task — one definition, not four. */
export const taskSchema = z.object({
  id: z.number().int().positive().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]).describe("Current lifecycle state"),
  priority: z.enum(["high", "normal"]).describe("Importance, as set at creation"),
  projectId: z.string().describe("Project the task belongs to"),
  owner: z.string().describe("User id that owns the task"),
  createdAt: z.string().describe("ISO 8601 timestamp of creation"),
  updatedAt: z.string().describe("ISO 8601 timestamp of the last change"),
});

export interface TaskStats {
  total: number;
  pending: number;
  completed: number;
  highPriority: number;
  projects: string[];
}

export interface TaskService {
  create(input: {
    title: unknown;
    priority?: unknown;
    projectId?: unknown;
    owner?: unknown;
    idempotencyKey?: unknown;
  }): CreateTaskResult;
  list(input?: { status?: unknown }): Task[];
  /** Completes a pending task. Already-completed is a `CONFLICT`, not a retry. */
  complete(input: { id: unknown }): Task;
  /** Destructive and irreversible. */
  remove(input: { id: unknown }): Task;
  /** Non-throwing lookup, for callers that own their own not-found handling. */
  find(id: unknown): Task | undefined;
  /** Open work, optionally narrowed to one owner — the `task://backlog` view. */
  open(owner?: string): Task[];
  /** Every task in one project — the `task://projects/{projectId}` view. */
  inProject(projectId: string): Task[];
  /** Every task one user owns — the `user://{userId}/profile` view. */
  ownedBy(owner: string): Task[];
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

/**
 * Non-throwing, **coercing** lookup for the resource path.
 *
 * URI template variables arrive as strings — the template grammar has no types —
 * so `task://tasks/1` hands us `"1"`, not `1`. The tool path stays strict on
 * purpose (the model is given a numeric schema and must honour it); this path has
 * to meet the URI where it actually is. The coercion is bounded and positive, so
 * it is a parse rather than a permissive `Number()`.
 */
export function coercePositiveInt(value: unknown): number | undefined {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function createTaskService(store: TaskStore): TaskService {
  const openTasks = (tasks: readonly Task[]): Task[] => tasks.filter((task) => task.status === "PENDING");

  return {
    create({ title, priority, projectId: project, owner, idempotencyKey: key }) {
      const cleanTitle = parseOrThrow(
        taskTitle,
        title,
        "Send a non-empty title of at most 120 characters.",
      );

      const cleanPriority =
        priority === undefined
          ? undefined
          : parseOrThrow(taskPriority, priority, 'Set priority to "high" or "normal", or omit it.');

      const cleanProject =
        project === undefined
          ? undefined
          : parseOrThrow(projectId, project, 'Use a short slug such as "fde", or omit it.');

      const cleanOwner =
        owner === undefined ? undefined : parseOrThrow(userId, owner, 'Use a short user id such as "123", or omit it.');

      const cleanKey =
        key === undefined
          ? undefined
          : parseOrThrow(idempotencyKey, key, "Send a key of at most 64 characters, or omit it entirely.");

      return store.create({
        title: cleanTitle,
        priority: cleanPriority,
        projectId: cleanProject,
        owner: cleanOwner,
        idempotencyKey: cleanKey,
      });
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
        throw new ToolError("NOT_FOUND", `No task with id ${value}.`, "Call list_tasks to read the exact ids, then retry.");
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
        throw new ToolError("NOT_FOUND", `No task with id ${value}.`, "Call list_tasks to read the exact ids, then retry.");
      }

      return task;
    },

    find(id) {
      const value = coercePositiveInt(id);
      return value === undefined ? undefined : store.get(value);
    },

    open: (owner) => {
      const tasks = openTasks(store.list());
      return owner === undefined ? tasks : tasks.filter((task) => task.owner === owner);
    },

    inProject: (project) => store.list().filter((task) => task.projectId === project),

    ownedBy: (owner) => store.list().filter((task) => task.owner === owner),

    stats() {
      const tasks = store.list();
      const pending = openTasks(tasks);

      return {
        total: tasks.length,
        pending: pending.length,
        completed: tasks.length - pending.length,
        highPriority: pending.filter((task) => task.priority === "high").length,
        projects: [...new Set(tasks.map((task) => task.projectId))].sort(),
      };
    },
  };
}
