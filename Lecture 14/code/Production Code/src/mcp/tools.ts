import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ToolError, toolFailure, toolSuccess, type ToolOutcome, type ToolResult } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import { taskSchema } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";

/**
 * Chapter 05 — The Tools Primitive.
 *
 * A tool is a contract written for a reader who cannot read your code. The
 * model sees exactly four things — `name`, `description`, `inputSchema` and, if
 * you declare them, `outputSchema` and `annotations` — and **the description is
 * the prompt, not documentation.** Everything you fail to say, the model will
 * guess, confidently.
 *
 * Every handler below is wrapped in the same four guards, in the same order,
 * because "production" is mostly the discipline of never making an exception:
 *
 *     rate limit  →  validate  →  execute inside a timeout  →  map failure to a result
 */

/**
 * The single place where transport-independent concerns meet a handler.
 *
 * A handler computes an *outcome*; this decides how it reaches the model. Doing
 * it once, here, is why none of the four tools below contains a `try`/`catch`,
 * a timer, a counter or a log call — and why a fifth tool cannot forget one.
 */
async function guard<Structured>(
  deps: ServerDeps,
  tool: string,
  run: () => ToolOutcome<Structured>,
): Promise<ToolResult<Structured>> {
  const startedAt = performance.now();

  try {
    const limit = deps.limiter.check(tool);
    if (!limit.allowed) {
      throw new ToolError(
        "LIMIT_EXCEEDED",
        `Rate limit reached for ${tool}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
        "Wait for the window to pass, or stop retrying and report the current state to the user.",
        true,
      );
    }

    const outcome = await withTimeout(run, deps.timeoutMs, tool);

    deps.metrics.count(`tool.ok.${tool}`);
    deps.logger.info("tool.call", { tool, ms: Math.round(performance.now() - startedAt) });

    return toolSuccess(outcome);
  } catch (error) {
    const failure = toToolError(tool, error);

    deps.metrics.count(`tool.error.${tool}`);
    deps.logger.warn("tool.failure", {
      tool,
      code: failure.code,
      retryable: failure.retryable,
      message: failure.message,
    });

    return toolFailure(failure);
  } finally {
    deps.metrics.observe(`tool.latency_ms.${tool}`, performance.now() - startedAt);
  }
}

/**
 * Anything unexpected becomes a retryable `UNAVAILABLE` — never a protocol
 * error. The call reached the handler, so the model is owed a result it can
 * reason about rather than a connection that dies mid-turn.
 */
function toToolError(tool: string, error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(
    "UNAVAILABLE",
    `${tool} failed: ${message}`,
    "Retry once. If it fails again, treat this capability as temporarily unavailable.",
    true,
  );
}

export function registerTools(server: McpServer, deps: ServerDeps): void {
  /**
   * Annotations are hints for host policy — never enforcement. They tell a host
   * which risk class a tool belongs to, and a host is expected to keep its own
   * view, because a hostile server can mislabel its own tools.
   */
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Adds one task to the board and returns it with a server-assigned id. Use it when the user wants something remembered or scheduled. Do not use it to change or remove an existing task — use complete_task or delete_task with an id from list_tasks. Pass idempotencyKey when a retry must not create a second task.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe("Short, human-readable title of the task to create"),
        idempotencyKey: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "Caller-generated key such as a request id. Re-sending the same key returns the original task instead of creating another",
          ),
      }),
      outputSchema: z.object({
        task: taskSchema,
        replayed: z.boolean().describe("True when the idempotency key had already been used and nothing was written"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, idempotencyKey }) =>
      guard(deps, "create_task", () => {
        const { task, replayed } = deps.service.create({ title, idempotencyKey });

        return {
          text: replayed
            ? `Task #${task.id} already existed (idempotent replay): ${task.title} (${task.status}).`
            : `Task #${task.id} created: ${task.title} (${task.status}).`,
          structured: { task, replayed },
        };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description:
        "Returns tasks with their ids, titles and statuses, optionally filtered by status. Read-only and safe to call at any time. Call it before complete_task or delete_task whenever an id is uncertain — never guess an id.",
      inputSchema: z.object({
        status: z
          .enum(["PENDING", "COMPLETED"])
          .optional()
          .describe("Return only tasks in this state. Omit to read the whole board"),
      }),
      outputSchema: z.object({
        tasks: z.array(taskSchema),
        total: z.number().int().describe("Number of tasks in this result"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status }) =>
      guard(deps, "list_tasks", () => {
        const tasks = deps.service.list({ status });

        return {
          text: tasks.length === 0 ? "No tasks matched." : JSON.stringify(tasks),
          structured: { tasks, total: tasks.length },
        };
      }),
  );



  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description:
        "Marks one PENDING task as COMPLETED by id. Use it when work is finished; use delete_task to remove a task instead of completing it. Idempotent in intent, but completing an already-completed task returns a conflict — read the board rather than retrying.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Id of the task to complete, as returned by list_tasks or create_task"),
      }),
      outputSchema: z.object({ task: taskSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(deps, "complete_task", () => {
        const task = deps.service.complete({ id });

        return {
          text: `Task completed: #${task.id} ${task.title} (${task.status}).`,
          structured: { task },
        };
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete Task",
      description:
        "Permanently removes one task by id. Irreversible — the task is gone and its id is never reused, so prefer complete_task when the user means 'finished' rather than 'remove'. Requires explicit user consent, which the host obtains before calling it.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Id of the task to delete, as returned by list_tasks"),
      }),
      outputSchema: z.object({ deleted: taskSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id }) =>
      guard(deps, "delete_task", () => {
        const task = deps.service.remove({ id });

        return {
          text: `Task deleted: #${task.id} ${task.title}.`,
          structured: { deleted: task },
        };
      }),
  );
}
