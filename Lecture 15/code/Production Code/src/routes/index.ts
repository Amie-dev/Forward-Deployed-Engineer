#!/usr/bin/env node
import express, { type Express, type Request, type Response } from "express";

import { env } from "../config/env.js";
import { createContextBudget } from "../core/guards.js";
import { createLogger } from "../core/logger.js";
import { createMetrics } from "../core/metrics.js";
import { healthController } from "../controllers/healthController.js";
import { planController } from "../controllers/planController.js";
import { promptController } from "../controllers/promptController.js";
import { resourceController } from "../controllers/resourceController.js";
import { createResourceCatalogue } from "../domain/resourceCatalogue.js";
import { createAuditLog } from "../host/audit.js";
import { createMcpClient } from "../host/client.js";
import type { HostDeps } from "../host/deps.js";
import { createHostPolicy, type ConsentHandler } from "../host/policy.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestContext } from "../middleware/requestContext.js";
import { createSelectionService } from "../services/selectionService.js";

/**
 * Notes Ch04 — **Host, Client and Server.**
 *
 * This process is the **host**: it owns the conversation, the policy and the user
 * experience, and it opens exactly one MCP **client** to exactly one server. The
 * server is the capability provider from `src/index.ts`, and it knows nothing
 * about this file.
 *
 * The file has two jobs, and separating them is what the layering is for:
 *
 *  1. **Compose** — build the dependency graph once, here, and hand it to the
 *     controllers. This is the host's composition root, the mirror of
 *     `mcp/server.ts`.
 *  2. **Route** — map a path to a controller method. That is genuinely all a
 *     router should do, and the routes below are one line each because every
 *     decision already lives somewhere else.
 *
 * Nothing in `controllers/` imports anything from this file, which is the
 * testability claim made concrete: a controller can be constructed from a
 * `HostDeps` object with no HTTP server, no port and no child process.
 */

const logger = createLogger(env.MCP_LOG_LEVEL, { host: "task-host" });
const metrics = createMetrics();

/**
 * The consent gate.
 *
 * **Denying by default is the only safe default**, and it is also the honest one
 * for this surface: the HTTP host never calls a tool — it reads Resources and
 * renders Prompts — so this handler is never reached in normal operation.
 *
 * A real host renders a dialog and awaits a click. The scripted, deterministic
 * version used by `npm run lifecycle` is injected there instead, which is why
 * this is a parameter rather than a hard-coded `confirm()`.
 */
const requestConsent: ConsentHandler = async ({ tool, args }) => {
  logger.warn("consent.not_implemented", {
    tool,
    args: Object.keys(args),
    note: "the HTTP host does not invoke tools; use npm run lifecycle for the scripted gate",
  });

  return false;
};

/** The composition root: build every layer once, in dependency order. */
async function createHost(): Promise<{ deps: HostDeps; close: () => Promise<void> }> {
  const client = await createMcpClient({ url: env.MCP_SERVER_URL, logger, metrics });

  /**
   * The host keeps its *own* copy of the catalogue.
   *
   * It is not fetched from the server, and that is deliberate: the ACL has to run
   * **before** a read, and asking the server "may I read this?" would be a round
   * trip that answers the wrong question — the server has no session. The
   * descriptor table is shared *source*, not shared state, so the two processes
   * agree on shape without either trusting the other's answer about ownership.
   */
  const catalogue = createResourceCatalogue();

  const policy = createHostPolicy({
    allowDestructive: env.MCP_HOST_ALLOW_DESTRUCTIVE,
    requireConsent: env.MCP_HOST_REQUIRE_CONSENT,
    allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES),
    catalogue,
    allowedPrompts: env.MCP_HOST_ALLOWED_PROMPTS,
    requestConsent,
    logger,
  });

  const budget = createContextBudget({
    maxResources: env.MCP_MAX_RESOURCES_PER_REQUEST,
    maxResourceChars: env.MCP_MAX_RESOURCE_CHARS,
    maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
  });

  const selection = createSelectionService({ catalogue });
  const audit = createAuditLog(logger);

  const deps: HostDeps = {
    client,
    policy,
    selection,
    budget,
    audit,
    logger,
    metrics,
    limits: {
      maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
      maxResourceChars: env.MCP_MAX_RESOURCE_CHARS,
      maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
    },
  };

  return { deps, close: () => client.close() };
}

const { deps, close } = await createHost();

const health = healthController(deps);
const resources = resourceController(deps);
const prompts = promptController(deps);
const plan = planController(deps);

const app: Express = express();

// Express would otherwise advertise itself with `X-Powered-By: Express`. The
// Hono binding sent no such header, and swapping the framework should not change
// the bytes on the wire — so it goes off.
app.disable("x-powered-by");

/**
 * Middleware first, in the order it must run.
 *
 * `app.use(requestContext(...))` with no path matches every request — the
 * Express spelling of Hono's `app.use("*", …)`. (Express 5 routes on
 * path-to-regexp v8, where a bare `"*"` is no longer a valid pattern; omitting
 * the path is both correct and clearer.)
 */
app.use(requestContext({ logger, metrics }));

/**
 * The route table. Each line is a path and a controller method — no logic, which
 * is the point of having controllers at all.
 */
app.get("/", health.index);
app.get("/health", health.health);
app.get("/metrics", health.metrics);

// Notes Ch03 §3.1 — discovery is not consumption.
app.get("/resources", resources.list);
app.get("/read", resources.read);

// Notes Ch06/07 — the user's primitive, and never a model call.
app.get("/prompts", prompts.list);
app.get("/prompt", prompts.get);

// Notes Ch08 §8.2 — one request, three primitives, three owners.
app.get("/plan", plan.plan);
app.get("/ask", plan.ask);

/**
 * The 404, as a catch-all registered *after* every route.
 *
 * Hono had `app.notFound(...)` for this. Express has no dedicated hook, and does
 * not need one: an ordinary two-argument `app.use` runs only when nothing above
 * it matched, which is the same behaviour with one fewer API to learn.
 */
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});

/**
 * The error handler, last — and its *position* is load-bearing.
 *
 * Hono's `app.onError(...)` could be registered above the routes, because Hono
 * keeps a raised error out of the middleware chain until it unwinds. Express
 * matches in registration order, so an error handler placed above the routes
 * would never see a failure they raised; it has to come after them. The four
 * parameters are what mark it as an error handler rather than ordinary
 * middleware, and Chapter 24 takes that apart.
 */
app.use(errorHandler({ logger, metrics }));

const httpServer = app.listen(env.MCP_HOST_PORT, "127.0.0.1", () => {
  logger.info("host.listening", {
    url: `http://127.0.0.1:${env.MCP_HOST_PORT}`,
    server: env.MCP_SERVER_URL,
    model: env.OPENAI_API_KEY === "" ? "offline" : env.OPENAI_MODEL,
  });
});

/**
 * Graceful shutdown, in the right order: stop accepting requests, then close the
 * MCP session. Closing the client first would fail the requests already in
 * flight, which is the opposite of graceful.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("host.shutdown", { signal });

    httpServer.close(() => {
      void close().finally(() => process.exit(0));
    });
  });
}
