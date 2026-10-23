import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Context, Next } from "hono";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { Session } from "../host/policy.js";

/**
 * The first middleware: give every request an identity, a logger and a session.
 *
 * Three things happen here and nowhere else, which is the point of a middleware
 * layer — each of them would otherwise be copy-pasted into four controllers and
 * forgotten in the fifth.
 *
 *  1. **A request id**, so every line from every layer can be correlated. It is
 *     bound to a *child* logger rather than passed around as a parameter, which
 *     is what makes the correlation automatic instead of optional.
 *
 *  2. **The session.** Notes Ch05 §"Filter *before* ranking" needs an actor, and
 *     the host is the only layer that has one — the MCP server has no session at
 *     all. Deriving it once here means no controller can invent its own, and no
 *     controller can accidentally read it from the model's output.
 *
 *     In a real deployment this comes from an authenticated cookie or a signed
 *     token. It is read from headers here so the demo is exercisable with
 *     `curl`, and that substitution is stated rather than hidden.
 *
 *  3. **Timing and an access log**, on the way out — including for the requests
 *     that threw, because those are the ones whose latency matters.
 */

export interface RequestVariables {
  requestId: string;
  logger: Logger;
  startedAt: number;
  session: Session;
}

/** The Hono environment every route in this application shares. */
export type AppEnv = { Variables: RequestVariables };

/** The default actor, so an unauthenticated `curl` still produces a readable run. */
const DEFAULT_ACTOR = "123";

function sessionFromHeaders(context: Context<AppEnv>): Session {
  const actor = context.req.header("x-actor")?.trim();

  return {
    actor: actor === undefined || actor === "" ? DEFAULT_ACTOR : actor,
    // A comma-separated scope. Absent means "no project scope", which is a
    // deliberate default: the selector should not invent a project the session
    // never named.
    projects: (context.req.header("x-projects") ?? "")
      .split(",")
      .map((project) => project.trim())
      .filter((project) => project !== ""),
    // An explicit opt-in, never inferred from the actor's name or id.
    isAdmin: context.req.header("x-admin") === "true",
  };
}

export function requestContext(options: { logger: Logger; metrics: Metrics }) {
  return async (context: Context<AppEnv>, next: Next): Promise<void> => {
    // Honour an inbound id when a caller or a proxy supplied one, so a trace
    // started upstream stays one trace.
    const requestId = context.req.header("x-request-id")?.trim() || randomUUID().slice(0, 8);
    const logger = options.logger.child({ requestId });
    const startedAt = performance.now();

    context.set("requestId", requestId);
    context.set("logger", logger);
    context.set("startedAt", startedAt);
    context.set("session", sessionFromHeaders(context));

    await next();

    const milliseconds = performance.now() - startedAt;

    options.metrics.observe("http.latency_ms", milliseconds);
    options.metrics.count(`http.status.${context.res.status}`);

    logger.info("http.request", {
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      ms: Math.round(milliseconds),
      actor: context.get("session").actor,
    });
  };
}
