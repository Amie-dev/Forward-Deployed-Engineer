import { McpServer } from "@modelcontextprotocol/server";
import { env } from "../config/env.js";
import { RateLimiter } from "../core/guards.js";
import { createLogger } from "../core/logger.js";
import { createMetrics } from "../core/metrics.js";
import { createResourceCatalogue } from "../domain/resourceCatalogue.js";
import { createTaskStore } from "../domain/taskStore.js";
import { createPromptService } from "../services/promptService.js";
import { createResourceService } from "../services/resourceService.js";
import { createTaskService } from "../services/taskService.js";
import type { ServerDeps } from "./deps.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

/**
 * Notes Ch01 §1.6 and Ch08 §8.1 — assemble the capability provider.
 *
 * This is the "standard door": one server process exposing the three primitives,
 * with no knowledge of which host, which model or which transport is on the other
 * side. `createServer` is a **factory**, so the same code serves a Streamable HTTP
 * endpoint today and an in-process test tomorrow.
 */

/**
 * Notes Ch01 §1.6 — the server may hand the client guidance at `initialize`.
 *
 * This is not a system prompt and it is not a substitute for good tool
 * descriptions; it is the one place a server can state a *policy* about itself
 * that would be repetitive in six separate descriptions.
 *
 * Note what it says about the Resources, because this is Lecture 15's whole
 * argument in one sentence: *"the model may read them only through the
 * application"* is not a limitation of the server, it is the primitive's
 * contract.
 */
const INSTRUCTIONS = [
  "Task server exposing three primitives: tools mutate the board, resources are read-only addressable context, and prompts are the recommended workflows.",
  "Every mutation is keyed by the numeric task id, so call list_tasks first to read exact ids — never guess one.",
  "list_tasks and task://backlog return the same body on purpose; which one is appropriate depends on who is deciding, not on what the data is.",
  "create_task adds one task; pass an idempotencyKey when a retry must not create a second task.",
  "complete_task is idempotent in intent, but completing an already-completed task is a conflict, not a retry.",
  "delete_task is destructive and irreversible, and requires explicit user consent.",
].join(" ");

export function createServer(): McpServer {
  // Composition root: the only place that knows how the layers fit together.
  const logger = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME });
  const metrics = createMetrics();

  // Domain → services. Each layer receives the one below it as an argument,
  // which is what keeps every one of them testable without a transport.
  const catalogue = createResourceCatalogue();
  const tasks = createTaskService(createTaskStore({ maxTasks: env.MCP_MAX_TASKS }));
  const resources = createResourceService({ tasks, catalogue, ttlMs: env.MCP_RESOURCE_CACHE_TTL_MS });
  const prompts = createPromptService();

  const limiter = new RateLimiter(env.MCP_RATE_LIMIT_PER_MINUTE);

  const server = new McpServer(
    { name: env.MCP_SERVER_NAME, version: env.MCP_SERVER_VERSION },
    {
      /**
       * Notes Ch01 §1.6 — capabilities are **permissions, not niceties**.
       * Declaring one is a promise that this server answers that capability's
       * requests, and it is the contract a host checks before it calls anything.
       *
       * `resources.subscribe` is deliberately **absent**. Declaring it would
       * make a client willing to call `resources/subscribe`, and this server has
       * no handler for it: the high-level `McpServer` does not register one. A
       * capability flag that promises something the server cannot do is worse
       * than a missing feature, because the host has no way to find out except
       * by failing.
       *
       * The `listChanged` flags are honest: the catalogues *can* move, and the
       * SDK will emit the notification when a registration changes.
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
    tasks,
    resources,
    prompts,
    catalogue,
    limiter,
    toolTimeoutMs: env.MCP_TOOL_TIMEOUT_MS,
    resourceTimeoutMs: env.MCP_RESOURCE_TIMEOUT_MS,
    // Notes Ch03 §3.5 — the allowlist is configuration, so the set of schemes
    // this server will resolve is auditable without reading code.
    allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES),
  };

  registerTools(server, deps); // do    — driven by the model
  registerResources(server, deps); // know  — driven by the application
  registerPrompts(server, deps); // reuse — driven by the user

  logger.info("server.ready", {
    version: env.MCP_SERVER_VERSION,
    resources: catalogue.descriptors().length,
    templates: catalogue.templates().length,
    prompts: prompts.list().length,
    allowedSchemes: [...deps.allowedSchemes],
    toolTimeoutMs: deps.toolTimeoutMs,
    resourceTimeoutMs: deps.resourceTimeoutMs,
    maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
    maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
    resourceCacheTtlMs: env.MCP_RESOURCE_CACHE_TTL_MS,
  });

  return server;
}
