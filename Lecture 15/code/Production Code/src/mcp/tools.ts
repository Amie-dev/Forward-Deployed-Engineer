import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { URI_SCHEME } from "../config/constants.js";
import { ToolError, toolFailure, toolSuccess, toAppError, type ToolOutcome, type ToolResult } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import { taskSchema } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";

/**
 * Notes Ch01 §1.2–1.4 — **The Tools Primitive**, where the **model** holds the
 * trigger.
 *
 * A tool is a contract written for a reader who cannot read your code. The model
 * sees exactly four things — `name`, `description`, `inputSchema` and, if you
 * declare them, `outputSchema` and `annotations` — and **the description is the
 * prompt, not documentation.** Everything you fail to say, the model will guess,
 * confidently.
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
 * it once, here, is why none of the tools below contains a `try`/`catch`, a
 * timer, a counter or a log call — and why a fifth tool cannot forget one.
 */
async function guard<Structured>(
  deps: ServerDeps,
  tool: string,
  run: () => ToolOutcome<Structured> | Promise<ToolOutcome<Structured>>,
): Promise<ToolResult<Structured>> {
  const startedAt = performance.now();

  try {
    const limit = deps.limiter.check(`tool:${tool}`);

    if (!limit.allowed) {
      throw new ToolError(
        "LIMIT_EXCEEDED",
        `Rate limit reached for ${tool}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
        "Wait for the window to pass, or stop retrying and report the current state to the user.",
        true,
      );
    }

    const outcome = await withTimeout(run, deps.toolTimeoutMs, tool, "tool");

    deps.metrics.count(`tool.ok.${tool}`);
    deps.logger.info("tool.call", { tool, ms: Math.round(performance.now() - startedAt) });

    return toolSuccess(outcome);
  } catch (error) {
    const failure = toAppError("tool", error, tool);

    deps.metrics.count(`tool.error.${tool}`);
    deps.metrics.count(`tool.error.${tool}.${failure.code}`);
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

/** The resource whose body `list_tasks` returns. Named once, so the identity is checkable. */
const BACKLOG_URI = `${URI_SCHEME.task}://backlog`;


export function registerTools(server: McpServer, deps: ServerDeps): void {
  /**
   * Annotations are hints for host policy — never enforcement. They tell a host
   * which risk class a tool belongs to, and a host is expected to keep its own
   * view, because a server's own assessment of its danger is exactly the claim a
   * compromised server would lie about.
   */
  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Adds one task to the backlog. Use it when the user asks for something to be remembered or scheduled. Pass an idempotencyKey when a retry must not create a second task.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe("Short imperative title, e.g. 'Review pull request'"),
        priority: z.enum(["high", "normal"]).optional().describe("Importance. Defaults to normal"),
        projectId: z.string().optional().describe("Project slug, e.g. 'fde'. Defaults to 'inbox'"),
        owner: z.string().optional().describe("User id that owns it, e.g. '123'"),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Caller-supplied key. The same key never creates a second task"),
      }),
      outputSchema: z.object({
        task: taskSchema,
        replayed: z.boolean().describe("True when nothing was written"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, priority, projectId, owner, idempotencyKey }) =>
      guard(deps, "create_task", () => {
        const { task, replayed } = deps.tasks.create({ title, priority, projectId, owner, idempotencyKey });

        /**
         * A write moved the state the resources render from, so every cached
         * body is now wrong.
         *
         * Invalidating here — at the write, in one place — is what stops a
         * `task://backlog` read from serving yesterday's board. This is the
         * cost of caching resources at all, and paying it explicitly is the
         * whole difference between a cache and a bug (Notes Ch04 §"Freshness,
         * caching and versioning").
         */
        deps.resources.invalidate();

        return {
          text: replayed
            ? `Task #${task.id} already existed (idempotent replay): ${task.title} (${task.status}).`
            : `Task #${task.id} created: ${task.title} (${task.priority} priority, project ${task.projectId}).`,
          structured: { task, replayed },
        };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Returns every open task with its id, title, priority, project and owner. Read-only and safe to call at any time. Call it before complete_task or delete_task whenever an id is uncertain — never guess an id.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        tasks: z.array(taskSchema),
        total: z.number().int().describe("Number of open tasks in this result"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      guard(deps, "list_tasks", () => {
        const tasks = deps.tasks.open();

        /**
         * Notes Ch02 §2.4 — the teaching point of the whole lecture, made
         * literal: this tool returns **exactly** the body of the
         * `task://backlog` Resource, because it *is* that body.
         *
         * Same payload, different owner. The model decides to call this; the
         * application decides to read that. Nothing about the bytes
         * distinguishes them — which is precisely why the distinction cannot be
         * about the bytes. It is about **intent** (Notes Ch02 §2.3).
         */
        const { text } = deps.resources.read(BACKLOG_URI);

        return { text, structured: { tasks, total: tasks.length } };
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description:
        "Marks one PENDING task as COMPLETED by id. Use it when work is finished; use delete_task to remove a task instead of completing it. Idempotent in intent, but completing an already-completed task returns a conflict — read the board rather than retrying.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Id of the task to complete, as returned by list_tasks"),
      }),
      outputSchema: z.object({ task: taskSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(deps, "complete_task", () => {
        const task = deps.tasks.complete({ id });
        deps.resources.invalidate();

        return { text: `Task completed: #${task.id} ${task.title} (${task.status}).`, structured: { task } };
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
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
        const task = deps.tasks.remove({ id });
        deps.resources.invalidate();

        return { text: `Task deleted: #${task.id} ${task.title}.`, structured: { deleted: task } };
      }),
  );
}
