import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Chapter 09 §9.13 — every request gets an id, and the log line carries it.
 *
 * This is the smallest useful piece of security observability, and it is the
 * same requirement Chapter 03 of the observability lecture made: without an id,
 * a security event cannot be joined to a user report, a trace, or a refund that
 * should not exist. Chapter 09 §9.13 asks for the audit log to be *complete*;
 * an id on every request is the precondition for that.
 *
 * The id goes in a response header rather than in the body, so the user channel
 * and the trace channel stay separate: a user can quote the id, and the trace
 * itself stays on the server.
 */
export function requestContext(request: Request, response: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const startedAt = Date.now();

  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);

  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  response.on("finish", () => {
    console.error(
      `[request ${requestId}] ${request.method} ${request.path} ${response.statusCode} ${Date.now() - startedAt}ms`,
    );
  });

  next();
}
