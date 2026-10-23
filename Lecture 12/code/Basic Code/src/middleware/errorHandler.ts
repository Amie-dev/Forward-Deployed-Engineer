import type { NextFunction, Request, Response } from "express";
import type { ErrorResponse } from "../models/types.js";

/**
 * Chapter 16 — the failure path, in one place.
 *
 * Express has two conventions and this file implements both:
 *   - a 404 handler is ordinary middleware, registered *after* the routes;
 *   - an error handler is identified by having **four** arguments, so the
 *     unused `_next` is required, not decorative.
 */

/** Nothing matched the route table. */
export function notFound(req: Request, res: Response): void {
  const body: ErrorResponse = { error: `No route for ${req.method} ${req.path}` };
  res.status(404).json(body);
}

/**
 * The single error handler. A bad request body is a `400`; anything else is a
 * `500`. The message is passed through because every message in this project is
 * written as an instruction (Chapter 06's ingest error, Chapter 14's validator).
 */
export function errorHandler(
  error: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = error.message.startsWith("Body must be") ? 400 : 500;
  const body: ErrorResponse = { error: error.message };
  res.status(status).json(body);
}
