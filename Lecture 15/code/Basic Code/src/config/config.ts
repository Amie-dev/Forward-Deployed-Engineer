import "dotenv/config";

/**
 * Chapter 02 — what a client learns about this server at `initialize`.
 *
 * Identity only. There is no model, no prompt and no vendor SDK in this
 * process: an MCP server is a capability provider behind a standard door.
 */
export const serverInfo = {
  name: process.env.MCP_SERVER_NAME ?? "task-mcp-server",
  version: process.env.MCP_SERVER_VERSION ?? "1.0.0",
};

/**
 * Chapter 03 §3.5 — a Resource is *addressable*, so it needs a scheme.
 *
 * `https://` would be a lie here: the client cannot fetch these URIs itself,
 * only this server can resolve them. A custom scheme keeps the address honest
 * and stops a host from trying to dereference something it should not.
 */
export const taskScheme = "task";
export const userScheme = "user";

/**
 * Chapter 01 — the two processes this project runs.
 *
 *   MCP server  → src/index.ts        (Streamable HTTP, the protocol endpoint)
 *   Host / app  → src/routes/index.ts (the HTTP routes a user actually calls)
 */
export const mcpPort = Number(process.env.MCP_PORT ?? 8081);
export const hostPort = Number(process.env.HOST_PORT ?? 8080);
export const mcpServerUrl = process.env.MCP_SERVER_URL ?? `http://127.0.0.1:${mcpPort}/mcp`;

/**
 * Chapter 07 §7.3 — the model call that happens *after* `prompts/get`.
 *
 * `hasModelKey` is what lets the whole project run offline: with no key the
 * client prints the prompt it assembled instead of calling a model, so the
 * Resource and Prompt half of the protocol is still fully visible.
 */
export const model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
export const hasModelKey = Boolean(process.env.OPENAI_API_KEY);
