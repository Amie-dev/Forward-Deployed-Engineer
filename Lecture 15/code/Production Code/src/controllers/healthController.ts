import type { Context } from "hono";
import { env, hasModelKey } from "../config/env.js";
import type { HostDeps } from "../host/deps.js";
import type { AppEnv } from "../middleware/requestContext.js";

/**
 * Liveness, readiness and the numbers.
 *
 * A health endpoint is where the two halves of this project meet in the most
 * useful way: it is the only place that can answer *"is the server reachable,
 * which capabilities did it advertise, and is a model even configured?"* without
 * a user asking a question.
 *
 * The distinction between the two routes is deliberate:
 *
 *  · `GET /` is the **index** — what this host offers, in prose, for a human who
 *    has just curled it and has no idea what to try.
 *  · `GET /health` is **readiness** — it actually calls `tools/list` against the
 *    server, because a process that is listening but cannot reach its capability
 *    provider is not ready, and a health check that only proves the HTTP server
 *    is up is the kind of check that passes during an outage.
 */

export function healthController(deps: HostDeps) {
  const startedAt = Date.now();

  return {
    /** The index. Cheap, static, and the first thing a human reads. */
    index: (context: Context<AppEnv>): Response =>
      context.json({
        host: "task-host",
        version: env.MCP_SERVER_VERSION,
        server: env.MCP_SERVER_URL,
        model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline (no OPENAI_API_KEY)",
        routes: [
          { method: "GET", path: "/", description: "this index" },
          { method: "GET", path: "/health", description: "readiness, with live capability counts" },
          { method: "GET", path: "/resources", description: "the catalogue: resources and templates" },
          { method: "GET", path: "/read?uri=<uri>", description: "read one Resource (policy-checked)" },
          { method: "GET", path: "/prompts", description: "the prompt menu, with argument shapes" },
          { method: "GET", path: "/prompt?name=<name>&...", description: "render one Prompt (no model call)" },
          { method: "GET", path: "/plan?hours=4", description: "the end-to-end request: prompt + context + model" },
          { method: "GET", path: "/metrics", description: "the in-process counters and latencies" },
        ],
        headers: {
          "x-actor": "the user id this session acts as (default 123)",
          "x-projects": "comma-separated project scope, e.g. fde,media",
          "x-admin": '"true" to allow reading another user\'s profile',
        },
      }),

    /**
     * Readiness, proven rather than asserted.
     *
     * The round trip to `tools/list` is the check. It is the cheapest call that
     * exercises the whole chain — session, transport, handshake, capability
     * negotiation — and if it fails, the honest answer is 503.
     */
    health: async (context: Context<AppEnv>): Promise<Response> => {
      const logger = context.get("logger");

      try {
        const [resources, prompts, tools] = await Promise.all([
          deps.client.listResources(),
          deps.client.listPrompts(),
          deps.client.listTools(),
        ]);

        return context.json({
          status: "ready",
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          server: { url: env.MCP_SERVER_URL, version: env.MCP_SERVER_VERSION },
          model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline",
          capabilities: {
            resources: resources.resources.length,
            resourceTemplates: resources.templates.length,
            prompts: prompts.length,
            tools: tools.length,
          },
          limits: {
            ...deps.limits,
            maxTasks: env.MCP_MAX_TASKS,
            resourceCacheTtlMs: env.MCP_RESOURCE_CACHE_TTL_MS,
            allowedSchemes: env.MCP_ALLOWED_RESOURCE_SCHEMES,
          },
          metrics: deps.metrics.snapshot(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        deps.metrics.count("health.unready");
        logger.error("health.unready", { message });

        return context.json({ status: "unready", reason: message }, 503);
      }
    },

    /** The raw counter snapshot — the thing a scrape would read. */
    metrics: (context: Context<AppEnv>): Response =>
      context.json({
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        metrics: deps.metrics.snapshot(),
      }),
  };
}
