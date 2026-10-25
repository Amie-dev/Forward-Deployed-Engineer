import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Chapter 03 §3.6 — every request gets a trace id, and the response carries it.
 *
 * This is the observability discipline in its smallest useful form. Chapter 03
 * §3.8 lists "no ids" as the mistake that makes a failure impossible to
 * correlate with a log line, a user report or an eval result.
 *
 * The id lives in `response.locals` rather than on the request object. That keeps
 * the user channel and the trace channel separate: the header carries the id so a
 * user can quote it, and the trace itself stays out of the response body.
 */
export function requestContext(request: Request, response: Response, next: NextFunction): void {
  const traceId = randomUUID();
  const startedAt = Date.now();

  response.locals.traceId = traceId;
  response.setHeader("x-trace-id", traceId);

  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  response.on("finish", () => {
    console.error(
      `[trace ${traceId}] ${request.method} ${request.path} ${response.statusCode} ${Date.now() - startedAt}ms`,
    );
  });

  next();
}
