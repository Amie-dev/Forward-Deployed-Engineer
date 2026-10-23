import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Chapter 06 §6.7 — Prompts: reusable instructions.
 *
 * A Prompt is *reuse*, and it is **user-controlled**: the UI lists it, the user
 * picks it, and `prompts/get` returns messages with the arguments substituted.
 * The model does not choose prompts, and a prompt changes no state.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "review_pull_request",
    {
      title: "Review Pull Request",
      description: "Asks the model to review a pull request for bugs and maintainability issues.",
      argsSchema: z.object({
        prNumber: z.string().describe("Pull request number, e.g. 42"),
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
