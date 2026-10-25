import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import { PromptError } from "../core/errors.js";
import { textOf } from "../host/client.js";
import type { HostDeps } from "../host/deps.js";
import { query } from "../middleware/requestContext.js";

/**
 * Notes Ch06 §6.7 and Ch07 §7.3 — the **user-controlled** primitive.
 *
 * The two routes are `prompts/list` and `prompts/get`, and the single most
 * important thing about this file is what it does **not** do: it never calls a
 * model.
 *
 * That is not a simplification. It is the lecture's sharpest distinction —
 * *`MCP Prompt ≠ LLM Response`* — and the response bodies say so explicitly,
 * because a caller who confuses the two will build a UI that thinks it has an
 * answer when it only has a question.
 *
 *   `GET /prompts`  → what workflows exist, and with which arguments
 *   `GET /prompt`   → the messages for one workflow, with arguments substituted
 *
 * The model call, if there is one, is a *separate* step, taken by a route that
 * chose to take it. `GET /plan` is that route; this one is not.
 */
export function promptController(deps: HostDeps) {
  /**
   * The menu, memoised.
   *
   * The host lists prompts to render its own UI, so it already knows the names —
   * and knowing them is what turns an unknown prompt into a **404 before any
   * call is made**. The alternative is to call the server and try to recover the
   * class from the wire, and that does not work here: the SDK validates the
   * prompt name itself and reports `InvalidParams` (-32602), which is
   * indistinguishable from a genuinely malformed argument.
   *
   * The general lesson is worth keeping: *a host that can predict a failure
   * should predict it, rather than parse the server's error for it.*
   */
  let menu: string[] | undefined;

  const knownPrompts = async (): Promise<string[]> => {
    menu ??= (await deps.client.listPrompts()).map((prompt) => prompt.name);
    return menu;
  };

  return {
    /**
     * The menu.
     *
     * Notes Ch06 §6.6 — a prompt *advertises* its arguments, so a client can
     * render a form instead of making the user guess. That advertisement comes
     * from the server (`prompts/list`), not from a table here, which is what
     * stops the menu and the validator from drifting apart.
     */
    list: async (request: Request, response: Response): Promise<void> => {
      const session = request.session;
      const prompts = await deps.client.listPrompts();

      response.json({
        prompts: prompts.map((prompt) => {
          const decision = deps.policy.mayUsePrompt(prompt.name, session);

          return {
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            // `arguments` is optional in the protocol: a prompt may take none,
            // and reporting `[]` rather than omitting the key keeps a client's
            // form-rendering branch simple.
            arguments: (prompt.arguments ?? []).map((argument) => ({
              name: argument.name,
              description: argument.description,
              required: argument.required ?? false,
            })),
            // The host's own view, which is not the same as the server's: a
            // deployment may offer a prompt the server registers and still
            // refuse to surface it (Notes Ch06 §"Keep the count small").
            offered: decision.allowed,
            ...(decision.allowed ? {} : { reason: decision.reason }),
          };
        }),
        count: prompts.length,
      });
    },

    /**
     * Render one prompt.
     *
     * Every query parameter other than `name` is treated as an argument, so
     * `?name=plan_day&availableHours=4` reads the way the protocol does. The
     * server is the authority on what those arguments must be — it validates and
     * refuses with a message naming the offending field — and this controller
     * deliberately does not duplicate that check. Two validators for one contract
     * is two things to keep in sync.
     */
    get: async (request: Request, response: Response): Promise<void> => {
      const name = query(request, "name")?.trim();

      if (name === undefined || name === "") {
        throw new PromptError(
          "INVALID_INPUT",
          "Query parameter 'name' is required.",
          "Call GET /prompts to read the available names, then pass one as ?name=plan_day.",
        );
      }

      const session = request.session;

      // Predict the failure rather than parse it: an unknown name is a 404, and
      // no round trip is needed to know that.
      const names = await knownPrompts();

      if (!names.includes(name)) {
        deps.metrics.count("prompt.unknown");

        throw new PromptError(
          "NOT_FOUND",
          `Unknown prompt: "${name}".`,
          `Call GET /prompts to read the available names (${names.join(", ")}).`,
        );
      }

      const decision = deps.policy.mayUsePrompt(name, session);

      if (!decision.allowed) {
        deps.metrics.count("prompt.denied");
        throw new PromptError(
          "FORBIDDEN",
          `Refused to render ${name} — ${decision.reason}.`,
          "Use a workflow this deployment offers, or ask an administrator to enable it.",
        );
      }

      const args: Record<string, string> = {};

      for (const [key, value] of Object.entries(request.query)) {
        if (key !== "name" && typeof value === "string") {
          args[key] = value;
        }
      }

      const startedAt = performance.now();
      const rendered = await deps.client.getPrompt(name, args);
      const durationMs = performance.now() - startedAt;

      const messages = rendered.messages.map((message) => ({
        role: message.role,
        text: textOf({ content: [message.content] }),
      }));

      deps.audit.record({
        actor: session.actor,
        action: "prompt",
        target: name,
        decision: "allowed",
        outcome: "ok",
        // The argument *values* are hashed, never stored: a prompt argument is
        // whatever a user typed, which is exactly the kind of thing a log should
        // not keep (Notes Ch06 §"Prompt hygiene" — no secrets in a prompt, and
        // none in the record of it either).
        args,
        durationMs,
        note: `${messages.length} message(s), args: ${Object.keys(args).join(",") || "none"}`,
      });

      response.json({
        name,
        description: rendered.description,
        messages,
        /**
         * Stated in the payload because it is the whole point of the route.
         *
         * A caller that treats `messages` as an answer will build the wrong
         * thing; a caller that reads this field cannot.
         */
        modelCalled: false,
        note:
          "This is a message template, not an answer. prompts/get talks to the MCP server; the LLM call happens afterwards, elsewhere.",
      });
    },
  };
}
