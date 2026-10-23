import "dotenv/config";

/**
 * Chapter 02 — What MCP Is.
 *
 * An MCP Server is a capability provider behind a standard door. These two
 * fields are everything a client learns about it at `initialize`: there is no
 * model, no prompt and no vendor SDK in this process.
 */
export const serverInfo = {
  name: process.env.MCP_SERVER_NAME ?? "task-mcp-server",
  version: process.env.MCP_SERVER_VERSION ?? "1.0.0",
};

/**
 * Chapter 04 — the transport.
 *
 * STDIO is the local binding (a child process speaking JSON-RPC over
 * stdin/stdout); Streamable HTTP is the remote one. The server's code is the
 * same either way — only the binding changes.
 */
export const transport = process.env.MCP_TRANSPORT ?? "stdio";

/**
 * Chapter 06 §6.2 — a Resource is *addressable* context, so it needs a scheme.
 * `https://` is only honest when the client can fetch the URI itself, so we use
 * a custom scheme for content only this server can read.
 */
export const policyScheme = "company";
