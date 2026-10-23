#!/usr/bin/env node
import { createServer } from "node:http";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
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
 * The two validators below are Chapter 08's security point, and they are not
 * optional: a server bound to localhost is still reachable from any web page in
 * the user's browser, so the Host and Origin headers have to be checked.
 */
const handler = createMcpHandler(createMcpServer);
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer((request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  void nodeHandler(request, response);
});

httpServer.listen(mcpPort, "127.0.0.1", () => {
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
