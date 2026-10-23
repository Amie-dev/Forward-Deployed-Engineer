/**
 * Chapter 08 — the CLIENT: everything the application does with the server.
 *
 * The wrappers below are deliberately one function per MCP verb, so the
 * difference between reading a Resource and fetching a Prompt is visible on the
 * page. `main()` then walks the whole lifecycle in order — and starts the
 * server itself, which is what a real host does.
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { hasModelKey, mcpServerUrl, model } from "../config/config.js";
import { selectResources, type CatalogueEntry } from "../services/resourceSelector.js";

export type Connection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

/** Chapter 08 — step 1 of every host: open one client to one server. */
export async function connect(): Promise<Connection> {
  const client = new Client({ name: "task-host", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl));

  await client.connect(transport);

  return { client, transport };
}

export async function disconnect(connection: Connection): Promise<void> {
  try {
    await connection.transport.terminateSession();
  } catch {
    // No session was established, so there is nothing to terminate.
  }

  await connection.client.close();
}

/* ── Chapter 03 — discovery: what context exists? ─────────────────────────── */

export async function listResources(client: Client) {
  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();

  return { resources, resourceTemplates };
}

/** Chapter 03 — consumption. Discovery is not reading. */
export async function readResource(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });

  return result.contents
    .map((content) => ("text" in content ? content.text : `[${content.mimeType ?? "binary"} content]`))
    .join("\n");
}

/* ── Chapter 06/07 — prompts: what workflows does the server offer? ───────── */

export async function listPrompts(client: Client) {
  const { prompts } = await client.listPrompts();

  return prompts;
}

/**
 * Chapter 07 §7.3 — this returns TEXT, not an answer.
 * `prompts/get` is a server call; the model call happens afterwards.
 */
export async function getPromptText(
  client: Client,
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const result = await client.getPrompt({ name, arguments: args });

  return result.messages
    .map((message) => (message.content.type === "text" ? message.content.text : ""))
    .join("\n");
}

/* ── Chapter 07 §7.3 — the one place a model is involved ──────────────────── */

export async function askModel(message: string, instructions?: string): Promise<string> {
  if (!hasModelKey) {
    // Offline mode: print what would have been sent, so the Resource and Prompt
    // half of the protocol stays visible without an API key.
    return [
      "(offline — no OPENAI_API_KEY, so no model was called)",
      "",
      instructions ? `SYSTEM:\n${instructions}` : "",
      `USER:\n${message}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI();
  const response = await openai.responses.create({ model, instructions, input: message });

  return response.output_text;
}

/**
 * Chapter 05/07 — the Resource flow.
 * The APPLICATION chooses the context, then the model answers.
 */
export async function ask(client: Client, message: string): Promise<string> {
  const { resources } = await listResources(client);
  const catalogue: CatalogueEntry[] = resources.map((resource) => ({
    uri: resource.uri,
    description: resource.description ?? "",
  }));

  const context: string[] = [];

  for (const choice of selectResources(message, catalogue)) {
    const text = await readResource(client, choice.uri);
    context.push(`--- ${choice.uri} (chosen by ${choice.strategy}) ---\n${text}`);
  }

  const instructions = [
    "You are a task management assistant.",
    "Use the context below whenever it is relevant to the question.",
    context.join("\n\n"),
  ].join("\n\n");

  return askModel(message, instructions);
}

/**
 * Chapter 07/08 — the Prompt flow.
 * The USER chooses the workflow, then the model runs it. One line of protocol,
 * one line of model — and they are not the same line.
 */
export async function planDay(client: Client, hours: string): Promise<string> {
  const prompt = await getPromptText(client, "plan_day", { availableHours: hours });

  return askModel(prompt);
}

/* ── the walkthrough: `npm run lifecycle` ─────────────────────────────────── */

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

async function isServerRunning(): Promise<boolean> {
  try {
    await disconnect(await connect());
    return true;
  } catch {
    return false;
  }
}

async function connectWithRetry(): Promise<Connection> {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      return await connect();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Could not reach the MCP server at ${mcpServerUrl}. Start it with: npm run server`);
}

async function main(): Promise<void> {
  // Chapter 08 — a host owns the lifecycle: it starts the server, then talks to it.
  // `detached: true` puts the server in its own process group so the whole
  // `npx → tsx → node` chain can be stopped with one signal below.
  const server = (await isServerRunning())
    ? undefined
    : spawn("npx", ["tsx", "src/index.ts"], { stdio: "inherit", detached: true });

  const connection = await connectWithRetry();
  const { client } = connection;

  try {
    console.log("\n1. resources/list — discovery, not consumption");
    const { resources, resourceTemplates } = await listResources(client);
    for (const resource of resources) {
      console.log(`   ${resource.uri}`);
    }
    for (const template of resourceTemplates) {
      console.log(`   ${template.uriTemplate}   (template)`);
    }

    console.log("\n2. resources/read task://guidelines — a STATIC Resource");
    console.log(indent(await readResource(client, "task://guidelines")));

    console.log("\n3. resources/read task://projects/fde — a TEMPLATED Resource, one definition");
    console.log(indent(await readResource(client, "task://projects/fde")));

    console.log("\n4. resources/read user://123/profile — a second template, same shape");
    console.log(indent(await readResource(client, "user://123/profile")));

    console.log("\n5. prompts/list — which workflows exist?");
    for (const prompt of await listPrompts(client)) {
      const args = prompt.arguments?.map((argument) => argument.name).join(", ") ?? "";
      console.log(`   ${prompt.name}(${args})`);
    }

    console.log('\n6. prompts/get plan_day { availableHours: "4" } — a template, not an answer');
    console.log(indent(await getPromptText(client, "plan_day", { availableHours: "4" })));

    console.log("\n7. the model step, after prompts/get — GET /plan?hours=4 in miniature");
    console.log(indent(await planDay(client, "4")));
  } finally {
    await disconnect(connection);

    // One negative-pid signal stops the server's whole process group.
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
    }
  }
}

// Chapter 08 — run the walkthrough only when this file is executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
