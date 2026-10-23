#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { env } from "./config/env.js";
import { createLogger } from "./core/logger.js";
import { createServer } from "./mcp/server.js";

/**
 * Chapter 04 — the transport binding.
 *
 * STDIO: the host spawns this file as a child process and the two exchange
 * JSON-RPC over stdin/stdout. The same `createServer()` factory would be served
 * over Streamable HTTP instead by swapping only this file — which is Chapter 01
 * in practice: the host depends on the *protocol*, the server on its *backend*,
 * and nothing depends on a vendor.
 *
 * STDIO rule (Chapter 04): **stdout is the protocol channel.** Anything written
 * there that is not JSON-RPC corrupts the stream, so every diagnostic goes to
 * stderr — which is why this file never calls `console.log`.
 */

const log = createLogger(env.MCP_LOG_LEVEL, { server: env.MCP_SERVER_NAME, pid: process.pid });

const handle = serveStdio(createServer, {
  onerror: (error) => log.error("transport.error", { message: error.message }),
});

log.info("server.listening", { transport: env.MCP_TRANSPORT, version: env.MCP_SERVER_VERSION });

/**
 * Chapter 08 — graceful shutdown.
 *
 * A host may close the pipe at any moment; the transport notices and the
 * process exits on its own. Handling signals explicitly is for the *other* half
 * of the problem: a container orchestrator sending SIGTERM wants the in-flight
 * turn to finish and the audit trail to be flushed, not a half-written frame.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log.info("server.shutdown", { signal });
    void handle.close().finally(() => process.exit(0));
  });
}
