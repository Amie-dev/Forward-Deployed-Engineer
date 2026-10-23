import type { Context } from "hono";
import { AppError, toAppError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { AppEnv } from "./requestContext.js";

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
  return (error: Error, context: Context<AppEnv>): Response => {
    const logger = context.get("logger") ?? options.logger;
    const failure = toAppError(originOf(context), error, context.req.path);

    options.metrics.count("http.error");
    options.metrics.count(`http.error.${failure.code}`);

    // A 5xx is our fault and belongs at `error`; a 4xx is the caller's and
    // belongs at `warn`. Splitting them is what lets an operator alert on one
    // without drowning in the other.
    const log = failure.httpStatus >= 500 ? logger.error : logger.warn;

    log("http.failed", {
      method: context.req.method,
      path: context.req.path,
      status: failure.httpStatus,
      code: failure.code,
      origin: failure.origin,
      message: failure.message,
      ...(failure.httpStatus >= 500 ? { stack: error.stack } : {}),
    });

    return context.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          // The recovery sentence is written for the *caller*, so it is exactly
          // the thing an API consumer needs to see.
          recovery: failure.recovery,
          retryable: failure.retryable,
          requestId: context.get("requestId"),
        },
      },
      failure.httpStatus as 400,
    );
  };
}

/**
 * Which primitive a failure belongs to, inferred from the route.
 *
 * The alternative — threading an origin through every throw — would put protocol
 * bookkeeping inside business logic. The route is the honest place to read it
 * from, because the route is what chose the primitive in the first place.
 */
function originOf(context: Context<AppEnv>): AppError["origin"] {
  const path = context.req.path;

  if (path.startsWith("/read") || path.startsWith("/resources")) {
    return "resource";
  }

  if (path.startsWith("/prompt")) {
    return "prompt";
  }

  return "tool";
}
