import { McpServer } from "@modelcontextprotocol/server";
import { serverInfo } from "../config/config.js";
import { registerPrompts } from "../prompts/prompts.js";
import { registerResources } from "../resources/resources.js";
import { registerTools } from "../tools/tools.js";

/**
 * Chapter 02 / Chapter 04 — assemble the capability provider.
 *
 * This is the "standard door": one server process exposing the three primitives,
 * with no knowledge of which host or which model is on the other side.
 */
export function createServer(): McpServer {
  const server = new McpServer(serverInfo);

  registerTools(server); // do    — driven by the model
  registerResources(server); // know  — driven by the application
  registerPrompts(server); // reuse — driven by the user

  return server;
}
