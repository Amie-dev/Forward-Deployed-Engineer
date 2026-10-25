#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
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
 *  1. **The security checks are not optional, and they are now the adapter's
 *     defaults.** A server bound to localhost is still reachable from any web
 *     page in the user's browser, so the `Host` (DNS-rebinding) and `Origin`
 *     (foreign-origin) headers have to be validated. `createMcpExpressApp`
 *     enables both automatically for a localhost bind, which is the point of
 *     using it: the protection is on unless someone deliberately binds
 *     elsewhere or passes an explicit `allowedHosts` / `allowedOrigins` list.
 *     Removing it is now an act, not an omission.
 *
 *  2. **stdout is never written to.** Diagnostics go to stderr through the
 *     logger, because a stdio binding would make stdout the protocol channel and
 *     a stray `console.log` would corrupt a frame. Keeping the discipline here
 *     means the same server code works under either binding.
 */

const log = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME, pid: process.pid });

const handler = createMcpHandler(createServer);
const nodeHandler = toNodeHandler(handler);

const app = createMcpExpressApp({ host: "127.0.0.1" });

// Express would otherwise advertise itself with `X-Powered-By: Express`. A
// server that answers strangers should not volunteer its stack.
app.disable("x-powered-by");

/**
 * The MCP endpoint.
 *
 * `request.body` is passed as the third argument because it is no longer
 * optional: `createMcpExpressApp` installs `express.json()`, which drains the
 * request stream into `request.body`. Without it, `toNodeHandler` would try to
 * read a stream that has already been consumed and see an empty frame.
 */
app.all("/mcp", (request, response) => {
  void nodeHandler(request, response, request.body);
});

const httpServer = app.listen(env.MCP_SERVER_PORT, "127.0.0.1", () => {
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
