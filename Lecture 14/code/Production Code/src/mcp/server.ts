import { McpServer } from "@modelcontextprotocol/server";
import { env } from "../config/env.js";
import { RateLimiter } from "../core/guards.js";
import { createLogger } from "../core/logger.js";
import { createMetrics } from "../core/metrics.js";
import { createTaskStore } from "../domain/taskStore.js";
import { createTaskService } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

/**
 * Chapter 02 / Chapter 04 — assemble the capability provider.
 *
 * This is the "standard door": one server process exposing the three
 * primitives, with no knowledge of which host, which model or which transport
 * is on the other side. `createServer` is a **factory**, so the same code serves
 * a stdio child process today and a Streamable HTTP handler tomorrow.
 */

/**
 * Chapter 02 — the server may hand the client guidance at `initialize`.
 *
 * This is not a system prompt and it is not a substitute for good tool
 * descriptions; it is the one place a server can state a *policy* about itself
 * ("mutations are keyed by id", "this operation needs consent") that would be
 * repetitive in four separate descriptions.
 */
const INSTRUCTIONS = [
  "Task server. Every mutation is keyed by the numeric task id, so call list_tasks first to read exact ids and titles.",
  "create_task adds one task; pass an idempotencyKey when a retry must not create a second task.",
  "list_tasks is read-only and safe to call at any time.",
  "complete_task is idempotent, but completing an already-completed task is a conflict, not a retry.",
  "delete_task is destructive and irreversible, and requires explicit user consent.",
].join(" ");

export function createServer(): McpServer {
  // Composition root: the only place that knows how the layers fit together.
  const logger = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME });
  const metrics = createMetrics();
  const service = createTaskService(createTaskStore({ maxTasks: env.MCP_MAX_TASKS }));
  const limiter = new RateLimiter(env.MCP_RATE_LIMIT_PER_MINUTE);

  const server = new McpServer(
    { name: env.MCP_SERVER_NAME, version: env.MCP_SERVER_VERSION },
    {
      /**
       * Chapter 04 — capabilities are **permissions, not niceties**. Declaring
       * one is a promise that this server answers that capability's requests,
       * and it is the contract the host checks before it calls anything.
       *
       * `logging` lets the server emit `notifications/message`; the `listChanged`
       * flags let it tell a client that a catalogue moved.
       */
      capabilities: {
        logging: {},
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );

  const deps: ServerDeps = {
    logger,
    metrics,
    service,
    limiter,
    timeoutMs: env.MCP_TOOL_TIMEOUT_MS,
  };

  registerTools(server, deps); // do    — driven by the model
  registerResources(server, deps); // know  — driven by the application
  registerPrompts(server); // reuse — driven by the user

  logger.info("server.ready", {
    version: env.MCP_SERVER_VERSION,
    transport: env.MCP_TRANSPORT,
    timeoutMs: deps.timeoutMs,
    rateLimitPerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
    maxTasks: env.MCP_MAX_TASKS,
  });

  return server;
}
