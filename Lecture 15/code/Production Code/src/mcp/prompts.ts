import type { McpServer } from "@modelcontextprotocol/server";
import { PromptError, toAppError } from "../core/errors.js";
import type { ServerDeps } from "./deps.js";
import { toProtocolError } from "./protocol.js";

/**
 * Notes Ch06 §6.7 and Ch07 §7.3 — **The Prompts Primitive**, where the **user**
 * holds the trigger.
 *
 * A Prompt is *reuse*: the UI lists it, the user picks it, and `prompts/get`
 * returns messages with the arguments substituted. The model does not choose
 * prompts, a prompt changes no state, and it has no side effects.
 *
 * Two things this file proves by *not* containing them:
 *
 *  · **No model.** There is no `openai` import anywhere in the server process.
 *    `prompts/get` returns messages; the model call happens in the host,
 *    afterwards (Notes Ch07 §7.3). *"The server starts and serves without an
 *    LLM or an API key — that property is worth defending."*
 *
 *  · **No live data.** Nothing here reads the task store. The templates tell the
 *    model to call `list_tasks` and read `task://guidelines`; they do not
 *    pre-bake the answer. A prompt that embeds a snapshot is stale a second
 *    later (Notes Ch06 §6.9).
 *
 * The registrations are driven from `promptService.list()`, so the menu the
 * server advertises and the menu the service validates against cannot disagree.
 */
export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  for (const summary of deps.prompts.list()) {
    const spec = deps.prompts.byName(summary.name);

    if (spec === undefined) {
      // Unreachable in practice — `list()` and `byName()` read the same table —
      // but a missing spec would otherwise register a prompt with no schema.
      throw toProtocolError(
        new PromptError(
          "UNAVAILABLE",
          `Prompt "${summary.name}" is listed but has no specification.`,
          "This is a server-side wiring bug; report it rather than retrying.",
          { httpStatus: 500 },
        ),
      );
    }

    server.registerPrompt(
      summary.name,
      {
        title: summary.title,
        description: summary.description,
        /**
         * The *same* schema the service validates against, so the arguments a
         * client is told about are exactly the arguments that will be accepted.
         * A hand-written second list is how a server ends up advertising an
         * argument it then refuses.
         */
        argsSchema: spec.argsSchema,
      },
      async (args) => {
        /**
         * The limiter applies here even though the render is local, because this
         * call is the entry point to the *expensive* path: what follows a
         * successful `prompts/get` is a model call, and that is the thing a
         * runaway client would be spending.
         *
         * There is deliberately **no timeout guard**. `prompts/get` is a
         * synchronous template render with no I/O, so a timer would add a handle
         * to clear and nothing else. The budget that matters belongs to the LLM
         * call, and that one lives in the host (Notes Ch07 §"budgets").
         */
        const limit = deps.limiter.check(`prompt:${summary.name}`);

        if (!limit.allowed) {
          deps.metrics.count("prompt.error.LIMIT_EXCEEDED");

          throw toProtocolError(
            new PromptError(
              "LIMIT_EXCEEDED",
              `Rate limit reached for ${summary.name}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
              "Wait for the window to pass, then retry once.",
              { retryable: true },
            ),
          );
        }

        try {
          const render = deps.prompts.get(summary.name, args);

          deps.metrics.count("prompt.get");
          deps.metrics.count(`prompt.get.${summary.name}`);
          deps.logger.info("prompt.get", {
            prompt: summary.name,
            version: render.version,
            messages: render.messages.length,
            // The *shape* of the arguments, never their values: a prompt
            // argument can carry anything a user typed (Notes Ch06 §"Prompt
            // hygiene" — no secrets in a log, and none in a prompt either).
            argNames: Object.keys(args),
          });

          return {
            description: render.description,
            messages: render.messages.map((message) => ({
              role: message.role,
              content: { type: "text" as const, text: message.text },
            })),
          };
        } catch (error) {
          const failure = toAppError("prompt", error, summary.name);

          deps.metrics.count("prompt.error");
          deps.metrics.count(`prompt.error.${failure.code}`);
          deps.logger.warn("prompt.failure", {
            prompt: summary.name,
            code: failure.code,
            message: failure.message,
          });

          // A prompt failure is a protocol error, so it travels as one: an
          // unknown name or a bad argument must not be papered over with an
          // empty message list (Notes Ch07 §7.4) — and it must keep its *class*
          // across the wire, or the host can only answer 503.
          throw toProtocolError(failure);
        }
      },
    );
  }
}
