import type { Request, Response } from "express";
import { CUSTOMERS } from "../domain/data.js";
import type { Session } from "../domain/types.js";
import type { Agent } from "../services/agent.js";

/**
 * Chapter 06 §6.2 / Chapter 08 §8.3 — the request surface.
 *
 * Two things here are the lecture.
 *
 * **The session is built server-side.** The `user` field in the body stands in
 * for an authenticated session; a real deployment would read it from a token.
 * That is the *only* difference, and it is the difference that matters: identity
 * is looked up from the server's records, never taken from the request's
 * arguments. If the model could name its own user, Chapter 07's whole argument
 * about over-permissioned tools would be moot.
 *
 * **The response carries the trace.** In production the trace would go to a log
 * sink — Chapter 09 §9.13's audit log — rather than into the response body. It is
 * in the body here because for this project the trace *is* the lesson: it is the
 * only way to see which layer did what.
 */
export function chatController(deps: { agent: Agent }) {
  return {
    chat: async (request: Request, response: Response): Promise<void> => {
      const body = request.body as
        | { message?: unknown; user?: unknown; confirmationId?: unknown; confirmArgs?: unknown }
        | undefined;

      const message = typeof body?.message === "string" ? body.message.trim() : "";
      const user = typeof body?.user === "string" ? body.user.trim() : "";
      const customer = CUSTOMERS.find((entry) => entry.user === user);

      if (customer === undefined) {
        response.status(401).json({
          error: {
            message: `unknown user "${user}"`,
            recovery: 'Send {"user":"alice","message":"Where is my order ORD-101?"}',
          },
        });
        return;
      }

      const confirmationId = typeof body?.confirmationId === "string" ? body.confirmationId : undefined;

      if (message === "" && confirmationId === undefined) {
        response.status(400).json({
          error: {
            message: "Body must be { user: string, message: string }.",
            recovery:
              'curl -s -X POST localhost:8080/chat -H "content-type: application/json" ' +
              '-d \'{"user":"alice","message":"Where is my order ORD-101?"}\'',
          },
        });
        return;
      }

      const session: Session = { user: customer.user, email: customer.email };

      const confirmation =
        confirmationId === undefined
          ? undefined
          : {
              id: confirmationId,
              args:
                typeof body?.confirmArgs === "object" && body.confirmArgs !== null
                  ? (body.confirmArgs as Record<string, unknown>)
                  : undefined,
            };

      try {
        response.json(await deps.agent.chat(message, session, confirmation));
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
