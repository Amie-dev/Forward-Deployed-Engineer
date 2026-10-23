#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { env } from "./config/env.js";
import { createLogger } from "./core/logger.js";
import { createServer } from "./mcp/server.js";

/**
 * Notes Ch03 §3.1 — the transport binding.
 *
 * Streamable HTTP: the host reaches this process at `POST /mcp`. The server
 * itself (`src/mcp/server.ts`) knows nothing about it, so swapping this file is
 * the only change a different binding would need — which is Chapter 01 in
 * practice: the host depends on the *protocol*, the server on its *backend*, and
 * nothing depends on a vendor.
 *
 * Two things about this file are load-bearing rather than incidental:
 *
 *  1. **The security validators are not optional.** A server bound to localhost
 *     is still reachable from any web page in the user's browser, so the `Host`
 *     and `Origin` headers have to be checked. `localhostHostValidation()` and
 *     `localhostOriginValidation()` are the SDK's DNS-rebinding and
 *     foreign-origin defences, and removing them turns a local server into a
 *     remote one.
 *
 *  2. **stdout is never written to.** Diagnostics go to stderr through the
 *     logger, because a stdio binding would make stdout the protocol channel and
 *     a stray `console.log` would corrupt a frame. Keeping the discipline here
 *     means the same server code works under either binding.
 */

const log = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME, pid: process.pid });

const handler = createMcpHandler(createServer);
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createHttpServer((request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  void nodeHandler(request, response);
});

httpServer.listen(env.MCP_SERVER_PORT, "127.0.0.1", () => {
  log.info("server.listening", {
    transport: "streamable-http",
    url: env.MCP_SERVER_URL,
    version: env.MCP_SERVER_VERSION,
  });
});

/**
 * Graceful shutdown.
 *
 * A container orchestrator sending SIGTERM wants the in-flight turn to finish and
 * the log stream to be flushed, not a half-written frame. The `shuttingDown`
 * guard matters because a second signal — or the same one delivered twice —
 * would otherwise run `close()` while the first is still draining.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info("server.shutdown", { signal });

    httpServer.close();
    void handler.close().finally(() => process.exit(0));
  });
}
