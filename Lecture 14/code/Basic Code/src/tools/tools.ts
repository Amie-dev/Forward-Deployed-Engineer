import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { taskService } from "../services/taskService.js";

/**
 * Chapter 05 — The Tools Primitive.
 *
 * A tool is a contract written for a reader who cannot read your code: the
 * model sees exactly three things — `name`, `description`, `inputSchema` — and
 * the description is the prompt. It is not documentation.
 */

/** The result contract shared by the tools that return a task. */
const taskSchema = z.object({
  id: z.number().describe("Server-assigned task id"),
  title: z.string().describe("Exact task title"),
  status: z.enum(["PENDING", "COMPLETED"]),
});

export function registerTools(server: McpServer): void {
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Creates a new task. Use when the user wants to add or remember something to do. Do not use it to read or complete tasks.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Title of the task to create"),
      }),
      // Chapter 05 §5.6 — declaring an outputSchema makes the result a contract
      // the client can validate, not a blob of prose.
      outputSchema: taskSchema,
      // Chapter 05 §5.3 — annotations are hints for host policy, never enforcement.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title }) => {
      const task = taskService.create(title);
      return {
        content: [{ type: "text" as const, text: `Task #${task.id} created: ${task.title} (${task.status})` }],
        structuredContent: task,
      };
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description: "Returns every task with its id, title and status. Read-only; call it before completing a task whose title you do not know exactly.",
      inputSchema: z.object({}),
      outputSchema: z.object({ tasks: z.array(taskSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const tasks = taskService.list();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
        structuredContent: { tasks },
      };
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description: "Marks a pending task as COMPLETED using its exact title. Call list_tasks first when the title is uncertain.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Exact title of the task to complete"),
      }),
      outputSchema: taskSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ title }) => {
      const task = taskService.complete(title);

      // Chapter 05 §5.7 — a *tool execution error*: the call ran and the outcome
      // failed. This is a result with `isError: true`, not a JSON-RPC error, and
      // the text lands in the model's context — so it must say how to recover.
      if (!task) {
        return {
          content: [
            { type: "text" as const, text: `No pending task titled "${title}". Call list_tasks to read the exact titles, then retry.` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Task completed: ${task.title} (${task.status})` }],
        structuredContent: task,
      };
    },
  );
}
