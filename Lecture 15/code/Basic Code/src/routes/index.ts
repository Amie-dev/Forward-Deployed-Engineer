/**
 * Chapter 09 — the HOST: the HTTP application a user actually talks to.
 *
 * `GET /plan?hours=4` is the request the lecture runs end to end. Watch the
 * division of labour in it: the USER chose the workflow (the Prompt), the
 * APPLICATION chose the context (the Resources), and the MODEL chooses any tool
 * call. Three primitives, three owners, one request.
 */
import { createServer } from "node:http";

import { hostPort } from "../config/config.js";
import {
  ask,
  connect,
  disconnect,
  getPromptText,
  listPrompts,
  listResources,
  planDay,
  readResource,
} from "../client/client.js";

// One client, opened once, for the whole life of the host.
const connection = await connect();
const { client } = connection;

/**
 * The route table. Each entry is one endpoint; the key is the pathname.
 * `URL` gives us the query string for free, which is how `hours` reaches the
 * Prompt argument.
 */
const routes: Record<string, (url: URL) => Promise<string>> = {
  /* Chapter 03 — discovery of everything the server offers. */
  "/resources": async () => {
    const { resources, resourceTemplates } = await listResources(client);

    return [
      ...resources.map((resource) => `${resource.uri}\n    ${resource.description ?? ""}`),
      ...resourceTemplates.map((template) => `${template.uriTemplate}   (template)`),
    ].join("\n");
  },

  /* Chapter 03 — consumption: read one Resource by URI. */
  "/read": async (url) => readResource(client, url.searchParams.get("uri") ?? "task://guidelines"),

  /* Chapter 06 — what workflows does the server offer? */
  "/prompts": async () =>
    (await listPrompts(client))
      .map((prompt) => `${prompt.name}   ${prompt.description ?? ""}`)
      .join("\n"),

  /* Chapter 07 §7.3 — fetch the Prompt. No model is called by this route. */
  "/prompt": async (url) =>
    getPromptText(client, url.searchParams.get("name") ?? "plan_day", {
      availableHours: url.searchParams.get("hours") ?? "4",
    }),

  /* Chapter 05 — the application selects context, then the model answers. */
  "/ask": async (url) => {
    const message = url.searchParams.get("message");

    if (!message) {
      throw new Error("Query parameter 'message' is required.");
    }

    return ask(client, message);
  },

  /* Chapter 08 — the lecture's end-to-end request: Prompt → (Resources + Tools) → answer. */
  "/plan": async (url) => planDay(client, url.searchParams.get("hours") ?? "4"),
};

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);
  const handler = routes[url.pathname];

  if (!handler) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Not found. Try one of:\n${Object.keys(routes).join("\n")}`);
    return;
  }

  handler(url)
    .then((body) => {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(body);
    })
    .catch((error: Error) => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.message);
    });
});

httpServer.listen(hostPort, "127.0.0.1", () => {
  console.error(`Task host is running at http://127.0.0.1:${hostPort}`);
  console.error(`Try: http://127.0.0.1:${hostPort}/plan?hours=4`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void disconnect(connection);
    httpServer.close();
  });
}
