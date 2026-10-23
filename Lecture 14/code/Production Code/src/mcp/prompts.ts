import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Chapter 06 §6.7 — Prompts: reusable instructions.
 *
 * A Prompt is *reuse*, and it is **user-controlled**: the UI lists it, the user
 * picks it, and `prompts/get` returns messages with the arguments substituted.
 * The model does not choose prompts, a prompt changes no state, and it has no
 * side effects.
 *
 * The rule that keeps prompts composable — and the one most implementations
 * break — is that **a prompt never reads live data**. It may *ask the model* to
 * call a tool; it must not pre-bake the answer. The moment a prompt embeds a
 * snapshot of the board, it becomes stale the second after it is fetched and
 * the model starts quoting yesterday's state with total confidence.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "daily_task_briefing",
    {
      title: "Daily Task Briefing",
      description:
        "Asks the model to read the board and propose the single next action. The prompt supplies the instructions; the tool supplies the facts.",
      argsSchema: z.object({
        owner: z.string().min(1).max(60).optional().describe("Optional name to address the briefing to"),
      }),
    },
    ({ owner }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              owner === undefined ? "You are preparing a task briefing." : `You are preparing a task briefing for ${owner}.`,
              "Call list_tasks to read the current board, then answer with at most three bullets:",
              "1. what is still PENDING, 2. what has been COMPLETED, 3. the single next action worth taking.",
              "Never mention a task that list_tasks did not return, and never invent an id.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_pull_request",
    {
      title: "Review Pull Request",
      description: "Asks the model to review a pull request for bugs, maintainability issues and missing tests.",
      argsSchema: z.object({
        prNumber: z.string().min(1).max(10).describe("Pull request number, e.g. 42"),
      }),
    },
    ({ prNumber }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are reviewing pull request #${prNumber}. Check for bugs, maintainability issues and missing tests, then report findings as a short list.`,
          },
        },
      ],
    }),
  );
}
