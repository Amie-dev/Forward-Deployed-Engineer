import { McpServer } from "@modelcontextprotocol/server";

import { serverInfo } from "../config/config.js";
import { registerPrompts } from "../prompts/prompts.js";
import { registerResources } from "../resources/resources.js";
import { registerTools } from "../tools/tools.js";

/**
 * Chapter 01 / Chapter 08 — three primitives, three owners, one standard door.
 *
 * Note what is *not* here: no model, no HTTP, no transport. This factory only
 * declares capabilities, so the very same server can be served over Streamable
 * HTTP (`src/index.ts`) or spawned by a host without changing a line — which is
 * Chapter 01's point that the binding is a detail, not a rewrite.
 */
export function createServer(): McpServer {
  const server = new McpServer(serverInfo);

  registerTools(server); // MODEL holds the trigger        — verbs, schemas, side effects
  registerResources(server); // APPLICATION holds the trigger — nouns, URIs, read-only
  registerPrompts(server); // USER holds the trigger       — message templates

  return server;
}
