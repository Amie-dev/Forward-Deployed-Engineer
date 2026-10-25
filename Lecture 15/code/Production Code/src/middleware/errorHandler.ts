import type { NextFunction, Request, Response } from "express";
import { AppError, toAppError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";

/**
 * The last middleware: turn whatever went wrong into an HTTP answer.
 *
 * This is where the error taxonomy from `core/errors.ts` finally earns its keep.
 * Every failure already carries a `code`, a `recovery` sentence and an
 * `httpStatus`, so the mapping is a *lookup* rather than a `switch` full of
 * judgement calls — and a failure that arrives without a taxonomy (a genuine
 * bug) is reported as a 500 rather than being dressed up as a 400.
 *
 * Two rules, and they are the ones that keep a production service debuggable:
 *
 *  · **The client gets the message and the recovery; the stack goes to the log.**
 *    A caller can act on *"Unknown resource: task://nope. List the catalogue with
 *    resources/list"*; a caller cannot act on a stack trace, and publishing one
 *    is an information leak.
 *
 *  · **Nothing is swallowed.** An unexpected error is logged at `error` with the
 *    stack, counted, and answered with a 500 — never converted into an empty 200,
 *    which is the failure mode that makes an outage invisible in a dashboard.
 */

export function errorHandler(options: { logger: Logger; metrics: Metrics }) {
  /**
   * Express identifies an error handler by **arity**: four parameters. Dropping
   * the trailing `_next` would silently demote this to ordinary middleware that
   * Express never calls for a failure — and the bug is invisible until something
   * throws, which is the worst possible moment to discover it. The unused
   * parameter is prefixed `_` for the same reason Chapter 08 prefixes its
   * deliberately-unused values.
   */
  return (error: Error, request: Request, response: Response, _next: NextFunction): void => {
    // `requestContext` runs before every route, so a failure raised by a
    // controller always arrives with a logger attached. A failure raised
    // *earlier* — `express.json()` rejecting a malformed body — does not, and the
    // root logger is the honest fallback rather than a crash inside the error
    // handler itself.
    const logger: Logger = request.logger ?? options.logger;
    const failure = toAppError(originOf(request), error, request.path);

    options.metrics.count("http.error");
    options.metrics.count(`http.error.${failure.code}`);

    // A 5xx is our fault and belongs at `error`; a 4xx is the caller's and
    // belongs at `warn`. Splitting them is what lets an operator alert on one
    // without drowning in the other.
    const log = failure.httpStatus >= 500 ? logger.error : logger.warn;

    log("http.failed", {
      method: request.method,
      path: request.path,
      status: failure.httpStatus,
      code: failure.code,
      origin: failure.origin,
      message: failure.message,
      ...(failure.httpStatus >= 500 ? { stack: error.stack } : {}),
    });

    // `failure.httpStatus` is a `number` here, not the narrow union Hono's
    // `context.json(body, status)` demanded — so the `as 400` cast that used to
    // sit on this line is gone. The taxonomy is the only thing that decides the
    // status; Express does not ask for a second opinion.
    response.status(failure.httpStatus).json({
      error: {
        code: failure.code,
        message: failure.message,
        // The recovery sentence is written for the *caller*, so it is exactly
        // the thing an API consumer needs to see.
        recovery: failure.recovery,
        retryable: failure.retryable,
        requestId: request.requestId,
      },
    });
  };
}

/**
 * Which primitive a failure belongs to, inferred from the route.
 *
 * The alternative — threading an origin through every throw — would put protocol
 * bookkeeping inside business logic. The route is the honest place to read it
 * from, because the route is what chose the primitive in the first place.
 */
function originOf(request: Request): AppError["origin"] {
  const path = request.path;

  if (path.startsWith("/read") || path.startsWith("/resources")) {
    return "resource";
  }

  if (path.startsWith("/prompt")) {
    return "prompt";
  }

  return "tool";
}
