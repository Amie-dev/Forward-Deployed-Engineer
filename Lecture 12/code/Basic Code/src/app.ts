import cors from "cors";
import express, { type Express } from "express";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { routes } from "./routes/index.js";

/**
 * Chapter 17 — the app.
 *
 * The order of the four `use` calls *is* the file:
 *   1. middleware every request needs (CORS, JSON body parsing),
 *   2. the route table,
 *   3. the failure path — 404 first, then the error handler.
 *
 * `createApp()` returns the app instead of listening, so the entry point owns
 * the port and a test could own the app.
 */
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
