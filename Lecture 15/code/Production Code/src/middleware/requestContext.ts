import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
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

/**
 * The per-request values, declared onto Express's own `Request`.
 *
 * Hono carried these in an `AppEnv` type parameter threaded through every
 * `Context<AppEnv>`. Express has no equivalent, so the shape is attached by
 * **module augmentation** — the same technique `@modelcontextprotocol/express`
 * uses to add `req.auth`. The payoff is that `request.session` type-checks in
 * every controller with no generic to pass along, and the compiler still refuses
 * a property that was never declared.
 *
 * The augmentation lives here because this file is what *populates* the values;
 * putting it next to the writer is what keeps the two from drifting.
 */
declare module "express-serve-static-core" {
  interface Request extends RequestVariables {}
}

/** The default actor, so an unauthenticated `curl` still produces a readable run. */
const DEFAULT_ACTOR = "123";

function sessionFromHeaders(request: Request): Session {
  const actor = request.header("x-actor")?.trim();

  return {
    actor: actor === undefined || actor === "" ? DEFAULT_ACTOR : actor,
    // A comma-separated scope. Absent means "no project scope", which is a
    // deliberate default: the selector should not invent a project the session
    // never named.
    projects: (request.header("x-projects") ?? "")
      .split(",")
      .map((project) => project.trim())
      .filter((project) => project !== ""),
    // An explicit opt-in, never inferred from the actor's name or id.
    isAdmin: request.header("x-admin") === "true",
  };
}

/**
 * Read one query parameter as a string — or nothing.
 *
 * Express types `request.query[key]` as `string | string[] | ParsedQs`: a
 * repeated parameter arrives as an array, a bracketed one as an object. Every
 * route in this application wants *one string or nothing*, so the narrowing
 * happens once, here, rather than six times across the controllers — and a
 * caller who sends `?uri=a&uri=b` gets `undefined` instead of an array that
 * would reach the policy layer as an unhandled type.
 *
 * This is deliberately the *same* function as the Basic Code host's helper, so
 * the behaviour of a malformed query string is a property of the application
 * rather than a per-project decision.
 */
export function query(request: Request, key: string): string | undefined {
  const value = request.query[key];

  return typeof value === "string" ? value : undefined;
}

export function requestContext(options: { logger: Logger; metrics: Metrics }) {
  return (request: Request, response: Response, next: NextFunction): void => {
    // Honour an inbound id when a caller or a proxy supplied one, so a trace
    // started upstream stays one trace.
    const requestId = request.header("x-request-id")?.trim() || randomUUID().slice(0, 8);
    const logger = options.logger.child({ requestId });
    const startedAt = performance.now();

    request.requestId = requestId;
    request.logger = logger;
    request.startedAt = startedAt;
    request.session = sessionFromHeaders(request);

    /**
     * The access log runs on `finish`, not after `next()`.
     *
     * This is the one place the Express version has to differ from the Hono one.
     * Hono's middleware could `await next()` and then read `context.res.status`,
     * because Hono owns the whole chain. Express middleware calls `next()` and
     * returns immediately — the controller is still producing the response — so
     * reading `response.statusCode` at that point would log the default `200`
     * for every failure and turn the access log into a lie.
     *
     * `finish` fires when the last byte is handed to the socket, which is when
     * the status is genuinely final. It also covers a streamed response, which a
     * `.then()` after `next()` would not.
     */
    response.on("finish", () => {
      const milliseconds = performance.now() - startedAt;

      options.metrics.observe("http.latency_ms", milliseconds);
      options.metrics.count(`http.status.${response.statusCode}`);

      logger.info("http.request", {
        method: request.method,
        path: request.path,
        status: response.statusCode,
        ms: Math.round(milliseconds),
        actor: request.session.actor,
      });
    });

    next();
  };
}

