import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Chapter 06/07 — Prompts: reusable interaction templates, controlled by the USER.
 *
 * A Prompt is a *message template*, not an answer. `prompts/get` returns the
 * messages to send to the model with the arguments substituted in, and nothing
 * in this file calls a model — that is Chapter 07 §7.3.
 *
 * Note what the templates *say*: they tell the model which Resources to read
 * and which Tools exist. That is how a Prompt cooperates with the other two
 * primitives (Chapter 07 §7.2) without the Prompt knowing anything about them.
 */
export function registerPrompts(server: McpServer): void {
  /* ── with an argument — the template is useless until the user supplies one ── */

  server.registerPrompt(
    "plan_day",
    {
      title: "Plan my day",
      description:
        "Build an ordered plan for the tasks already on the backlog, using the hours the user has available.",
      argsSchema: z.object({
        availableHours: z.string().describe("Number of hours available today, e.g. 4"),
      }),
    },
    ({ availableHours }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me plan my pending tasks for today.

First read my current pending tasks, then apply the task guidelines.

I have ${availableHours} hours available today.

Give me a concise and ordered plan.`,
          },
        },
      ],
    }),
  );

  /* ── without an argument — a Prompt is not required to take any ─────────── */

  server.registerPrompt(
    "review_workload",
    {
      title: "Review my workload",
      description: "Look at the current backlog and say whether it is realistic, and what to drop first.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Review my current workload.

Read my open tasks, then tell me:
1. whether the total is realistic, and
2. which tasks I should drop or defer first, and why.`,
          },
        },
      ],
    }),
  );
}
