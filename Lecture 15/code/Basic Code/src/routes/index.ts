/**
 * Chapter 09 — the HOST: the HTTP application a user actually talks to.
 *
 * `GET /plan?hours=4` is the request the lecture runs end to end. Watch the
 * division of labour in it: the USER chose the workflow (the Prompt), the
 * APPLICATION chose the context (the Resources), and the MODEL chooses any tool
 * call. Three primitives, three owners, one request.
 *
 * The host is plain Express: one route table, one 404 catch-all, one error
 * handler. Everything protocol-shaped stays behind `../client/client.js` —
 * this file speaks HTTP and nothing else.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";

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
 * `req.query` values are `string | string[] | ParsedQs`, and every route below
 * wants a single string — or nothing. This narrows the type in one place, so a
 * missing (or repeated) parameter becomes `undefined` and the `??` defaults
 * turn it into a sensible value. **No route can crash on a bad query string.**
 */
function query(request: Request, key: string): string | undefined {
  const value = request.query[key];

  return typeof value === "string" ? value : undefined;
}

/**
 * The route table. Each entry is one endpoint; the key is the pathname and the
 * value is a function that turns a request into text. `req.query` is Express's
 * parsed query string, which is how `hours` reaches the Prompt argument.
 */
const routes: Record<string, (request: Request) => Promise<string>> = {
  /* Chapter 03 — discovery of everything the server offers. */
  "/resources": async () => {
    const { resources, resourceTemplates } = await listResources(client);

    return [
      ...resources.map((resource) => `${resource.uri}\n    ${resource.description ?? ""}`),
      ...resourceTemplates.map((template) => `${template.uriTemplate}   (template)`),
    ].join("\n");
  },

  /* Chapter 03 — consumption: read one Resource by URI. */
  "/read": async (request) => readResource(client, query(request, "uri") ?? "task://guidelines"),

  /* Chapter 06 — what workflows does the server offer? */
  "/prompts": async () =>
    (await listPrompts(client))
      .map((prompt) => `${prompt.name}   ${prompt.description ?? ""}`)
      .join("\n"),

  /* Chapter 07 §7.3 — fetch the Prompt. No model is called by this route. */
  "/prompt": async (request) =>
    getPromptText(client, query(request, "name") ?? "plan_day", {
      availableHours: query(request, "hours") ?? "4",
    }),

  /* Chapter 05 — the application selects context, then the model answers. */
  "/ask": async (request) => {
    const message = query(request, "message");

    if (!message) {
      throw new Error("Query parameter 'message' is required.");
    }

    return ask(client, message);
  },

  /* Chapter 08 — the lecture's end-to-end request: Prompt → (Resources + Tools) → answer. */
  "/plan": async (request) => planDay(client, query(request, "hours") ?? "4"),
};

const app: Express = express();

// The raw Node host sent no `X-Powered-By` header; disabling it keeps the
// response surface identical after the swap to Express.
app.disable("x-powered-by");

/**
 * Register the table. Every handler returns text or throws: Express 5 forwards
 * a rejected promise straight to the error handler below, so no route needs a
 * `try`/`catch` of its own.
 */
for (const [path, handler] of Object.entries(routes)) {
  app.get(path, async (request, response) => {
    response.type("text/plain").send(await handler(request));
  });
}

/** The 404 lists the routes, so a wrong URL tells you the right ones. */
app.use((_request, response) => {
  response.status(404).type("text/plain").send(`Not found. Try one of:\n${Object.keys(routes).join("\n")}`);
});

/** The only other status this host has: 500, with the message as the body. */
app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  response.status(500).type("text/plain").send(error.message);
});

const httpServer = app.listen(hostPort, "127.0.0.1", () => {
  console.error(`Task host is running at http://127.0.0.1:${hostPort}`);
  console.error(`Try: http://127.0.0.1:${hostPort}/plan?hours=4`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void disconnect(connection);
    httpServer.close();
  });
}
