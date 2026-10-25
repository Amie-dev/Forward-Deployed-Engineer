#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { mcpPort, serverInfo } from "./config/config.js";
import { createServer as createMcpServer } from "./server/server.js";

/**
 * Chapter 01 — the transport binding.
 *
 * Streamable HTTP: the host reaches this process at `POST /mcp`. The server
 * itself (`src/server/server.ts`) knows nothing about it, so swapping this file
 * is the only change a different binding would need.
 *
 * Express is the binding, and `createMcpExpressApp` is why that costs four lines
 * instead of forty. Chapter 08's security point is still enforced — DNS-rebinding
 * (`Host`) and foreign-origin (`Origin`) validation both apply — but it is now
 * enforced *by the adapter*, because the app is bound to a localhost address and
 * the adapter turns those checks on automatically. That is not a downgrade: a
 * server bound to localhost is still reachable from any web page in the user's
 * browser, so the protection has to be impossible to forget. Hand-wiring
 * `localhostHostValidation()` and `localhostOriginValidation()` is still
 * available when you want to see them; the default is to have them.
 */
const handler = createMcpHandler(createMcpServer);
const nodeHandler = toNodeHandler(handler);

const app = createMcpExpressApp({ host: "127.0.0.1" });

/**
 * Express advertises itself with `X-Powered-By: Express` unless told not to. The
 * previous hand-wired Node binding sent no such header, and a server that
 * answers strangers should not volunteer its stack — so it goes off, exactly as
 * it does in the host (`src/routes/index.ts`) and in Lecture 06's `app.ts`.
 */
app.disable("x-powered-by");

/**
 * `request.body` is passed explicitly, and it is not optional.
 *
 * `createMcpExpressApp` installs `express.json()`, which consumes the request
 * stream to populate `request.body`. `toNodeHandler` would otherwise try to read
 * that same stream and find it already drained — so the third argument is how the
 * parsed body is handed across. (Express's `next` callback is ignored if it ever
 * arrives here; the adapter never mistakes a function for a body.)
 */
app.all("/mcp", (request, response) => {
  void nodeHandler(request, response, request.body);
});

const httpServer = app.listen(mcpPort, "127.0.0.1", () => {
  // Diagnostics go to stderr so they never mix with anything a host reads.
  console.error(
    `[${serverInfo.name}] v${serverInfo.version} MCP endpoint on http://127.0.0.1:${mcpPort}/mcp`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handler.close();
    httpServer.close();
  });
}
