import type { Request, Response } from "express";
import type { SupportAgent } from "../services/supportAgent.js";

/**
 * Chapter 02 §2.1 — the application's HTTP surface.
 *
 * Look at what it returns: the answer **and** the trace. Chapter 03 §3.3 calls the
 * trace "the second output of every request", and this is where that decision
 * becomes visible in the code.
 *
 * In production the trace would go to a log sink rather than into the response
 * body — Chapter 03 §3.8: exposing it to end users leaks internal ids, prompts and
 * tool arguments. It is in the body here because, for this project, the trace *is*
 * the lesson.
 */
export function chatController(deps: { agent: SupportAgent }) {
  return {
    chat: async (request: Request, response: Response): Promise<void> => {
      const body = request.body as { message?: unknown } | undefined;
      const message = typeof body?.message === "string" ? body.message.trim() : "";

      if (message === "") {
        response.status(400).json({
          error: {
            message: "Body must be { message: string }.",
            recovery:
              'curl -s -X POST localhost:8080/chat -H "content-type: application/json" ' +
              '-d \'{"message":"Where is ORD-101?"}\'',
          },
        });
        return;
      }

      try {
        response.json(await deps.agent.chat(message));
      } catch (error) {
        // A failure should say what to try next, not only that it failed.
        response.status(502).json({
          error: {
            message: (error as Error).message,
            recovery: "Check the model credentials, then retry the same request.",
          },
        });
      }
    },
  };
}
