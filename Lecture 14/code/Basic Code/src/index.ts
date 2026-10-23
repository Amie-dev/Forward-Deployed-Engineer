#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { serverInfo } from "./config/config.js";
import { createServer } from "./server/server.js";

/**
 * Chapter 04 — the transport binding.
 *
 * STDIO: the host spawns this file as a child process and the two exchange
 * JSON-RPC over stdin/stdout. The same `createServer()` factory would be served
 * over Streamable HTTP instead by swapping only this line.
 *
 * STDIO rule (Chapter 04): **stdout is the protocol channel**. Anything written
 * there that is not JSON-RPC corrupts the stream — so diagnostics go to stderr.
 */
serveStdio(createServer, {
  onerror: (error) => console.error(`[${serverInfo.name}] ${error.message}`),
});

console.error(`[${serverInfo.name}] v${serverInfo.version} listening on stdio`);
