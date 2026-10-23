import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

/**
 * Chapter 04 — Host, Client and Server.
 *
 * This process is the **host**: it owns the conversation and spawns one MCP
 * **client**. That client speaks to exactly one server (the 1:1 rule) — the
 * server is the capability provider from `src/index.ts`.
 *
 * Chapter 07 — the lifecycle, one numbered step per section below.
 */

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

async function main(): Promise<void> {
  const client = new Client({ name: "task-host", version: "1.0.0" });

  // The transport is chosen by the host; the server does not know or care which
  // binding it is. Here the client spawns the server over stdio.
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverEntry],
      cwd: projectRoot,
      stderr: "inherit",
    }),
  );

  // 1 · DISCOVERY — `tools/list` (Chapter 07 §7.2). Discovery is a curated act:
  //     only what the server registered is visible, and an absent tool cannot be
  //     called. This is also the catalogue the host caches (§7.8), not a
  //     per-message round trip.
  const { tools } = await client.listTools();
  console.log(`\n1. tools/list -> ${tools.map((tool) => tool.name).join(", ")}`);

  // 2 · SELECTION — tool calling, the one probabilistic step (Chapter 03:
  //     "tool calling decides, MCP delivers"). There is no LLM in this file, so
  //     we stand in for it deterministically.
  const selected = tools.find((tool) => tool.name === "create_task");
  if (!selected) {
    throw new Error("create_task is missing from the catalogue");
  }

  // 3 · INVOCATION — `tools/call` (Chapter 07 §7.4). The model named a tool, not
  //     a server: the host resolves the name to this client.
  const created = await client.callTool({ name: selected.name, arguments: { title: "Record MCP Video" } });
  console.log(`2. tools/call ${selected.name} -> ${text(created)}`);

  // 4 · FAILURE — a tool execution error is a *result* with `isError: true`, not
  //     a protocol error (Chapter 05 §5.7): the call ran, the operation failed,
  //     and the message is written for the model to recover from.
  const failed = await client.callTool({ name: "complete_task", arguments: { title: "No such task" } });
  console.log(`3. tools/call complete_task (unknown title) -> isError=${failed.isError === true} ${text(failed)}`);

  const completed = await client.callTool({ name: "complete_task", arguments: { title: "Record MCP Video" } });
  console.log(`   tools/call complete_task (exact title)   -> ${text(completed)}`);

  // 5 · RESOURCES — `resources/list` + `resources/read` (Chapter 06 §6.3). The
  //     application drives these; the model never asked for them.
  const { resources } = await client.listResources();
  console.log(`\n4. resources/list -> ${resources.map((resource) => resource.uri).join(", ")}`);

  const first = resources[0];
  if (!first) {
    throw new Error("no resources were exposed");
  }

  const read = await client.readResource({ uri: first.uri });
  console.log(`   resources/read ${first.uri} -> ${read.contents.length} content block(s)`);

  // 6 · PROMPTS — `prompts/list` + `prompts/get` (Chapter 06 §6.7). The user
  //     drives these; arguments are substituted server-side.
  const { prompts } = await client.listPrompts();
  console.log(`\n5. prompts/list -> ${prompts.map((prompt) => prompt.name).join(", ")}`);

  const prompt = await client.getPrompt({ name: "review_pull_request", arguments: { prNumber: "42" } });
  console.log(`   prompts/get review_pull_request -> ${JSON.stringify(prompt.messages[0]?.content)}`);

  await client.close();
}

/** Chapter 05 §5.6 — a result is `content[]` blocks, never a bare value. */
function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
