# Chapter 09 — Client & Host: The Lifecycle

> **Goal of this chapter:** read the file that ties everything together. This process is the **host**:
> it owns the conversation, spawns **one** MCP **client**, and drives the full lifecycle —
> discovery → selection → invocation → result, then resources, then prompts.
>
> **Lecture chapters:** [03 — MCP vs Tool Calling](../../../notes/03_MCP_vs_Tool_Calling_Complementary_Layers.md)
> ("tool calling decides, MCP delivers"), [04 — Host, Client and Server](../../../notes/04_Host_Client_Server_Architecture.md)
> (the 1:1 rule), [07 — Discovery, Invocation and Lifecycle](../../../notes/07_Discovery_Invocation_and_Lifecycle.md)
> (the numbered steps).

---

## 9.1 File details

| Property | Value |
|---|---|
| **Path** | `src/client/client.ts` |
| **Layer** | host + client (the outermost layer; nothing depends on it) |
| **Purpose** | spawn the server over stdio and print the whole MCP lifecycle |
| **Imports** | `Client`, `StdioClientTransport`, `fileURLToPath` |
| **Exports** | none (it *runs*) |
| **Run by** | `npm run client` → `tsx src/client/client.ts` |
| **Lecture sections** | 03 (selection vs invocation), 04 §4.3/§4.5 (client, 1:1), 07 §7.2–§7.5 |

### The six numbered steps you will see

| Step | Call | Driven by | Lecture |
|---|---|---|---|
| 1 | `tools/list` | discovery | 07 §7.2 |
| 2 | (selection) | the **model** — stubbed deterministically here | 03 / 07 §7.3 |
| 3 | `tools/call create_task` | invocation | 07 §7.4 |
| 4 | `tools/call complete_task` ×2 | invocation + failure (`isError`) | 05 §5.7 / 07 §7.4 |
| 5 | `resources/list` + `resources/read` | the **application** | 06 §6.3 |
| 6 | `prompts/list` + `prompts/get` | the **user** | 06 §6.7 |

---

## 9.2 Commands

```bash
cd "Lecture 14/code/Basic Code"
npm run client     # the whole demo: spawns the server and prints steps 1–6
```

This is the command you run first. It needs no server started in advance — the client **spawns** it.

---

## 9.3 Full file

**Path:** `src/client/client.ts`

```ts
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
```

---

## 9.4 Block-by-block explanation

### Block 1 — the imports

```ts
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
```

**What it does:** brings in the client, the STDIO transport for the client side, and a Node helper
for turning file URLs into filesystem paths.

**How it works:**
- `Client` — the MCP client. It speaks JSON-RPC to **exactly one** server (the 1:1 rule, §4.5).
- `StdioClientTransport` — the client-side transport that **spawns a child process** and talks over
  its stdin/stdout. Note it is imported from the `client/stdio` subpath.
- `fileURLToPath` from `node:url` — needed because ESM has no `__dirname`; you convert
  `import.meta.url` (a `file://` URL) into a real path.

### Block 2 — the module comment (the host's identity)

```ts
/**
 * Chapter 04 — Host, Client and Server.
 *
 * This process is the **host**: it owns the conversation and spawns one MCP
 * **client**. That client speaks to exactly one server (the 1:1 rule) — the
 * server is the capability provider from `src/index.ts`.
 *
 * Chapter 07 — the lifecycle, one numbered step per section below.
 */
```

**What it does:** documentation — but it names the three roles precisely.

**How it works:** it is the written contract for the file: **host** (this process) → **one client**
(the `Client` instance) → **one server** (the spawned `index.ts`). That chain is why the demo is a
faithful model of a real AI application: a host that composes capabilities it does not own.

### Block 3 — resolving paths to the server entry

```ts
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
```

**What it does:** computes (a) the project root and (b) the absolute path of the server entry file,
*relative to this file*.

**How it works:**
- `import.meta.url` is this module's own `file://…/src/client/client.ts` URL.
- `new URL("../..", import.meta.url)` resolves two levels up from `src/client/` → the project root.
- `new URL("../index.ts", import.meta.url)` resolves one level up from `src/client/` → `src/index.ts`.
- `fileURLToPath(...)` converts each URL to a plain filesystem path the OS can use.
- **Why do this at all?** So the client can spawn the server regardless of the current working
  directory — it is location-independent. (Contrast with a hardcoded `"./src/index.ts"`, which
  breaks the moment you run from elsewhere.)

### Block 4 — `main()` and creating the client

```ts
async function main(): Promise<void> {
  const client = new Client({ name: "task-host", version: "1.0.0" });
```

**What it does:** wraps the whole lifecycle in one async function and creates the MCP client with a
name and version.

**How it works:**
- `main()` is `async` because every protocol call returns a promise (`await`).
- `new Client({ name: "task-host", version: "1.0.0" })` — the client identifies **itself** (as
  `task-host`) during `initialize`. This is the mirror image of `serverInfo` (Chapter 02): the client
  says who *it* is, the server says who *it* is, and the handshake completes.
- One client is created → the 1:1 rule is structurally enforced: this client will only ever talk to
  the one server it connects to.

### Block 5 — connecting: spawn the server over stdio

```ts
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
```

**What it does:** starts the server as a child process and performs the `initialize` handshake.

**How it works, option by option:**
- **`command: process.execPath`** — the *absolute path to the current Node executable*. Using
  `process.execPath` (instead of the string `"node"`) guarantees the child runs the **same Node** the
  host is running — no PATH surprises.
- **`args: ["--import", "tsx", serverEntry]`** — run the server entry with the `tsx` loader
  pre-imported, so the child can execute TypeScript directly (`--import tsx` is the ESM equivalent of
  `-r tsx`). `serverEntry` is the absolute path to `src/index.ts` from Block 3.
- **`cwd: projectRoot`** — run the child from the project root, so relative resolution inside the
  server behaves the same as when you run `npm run server`.
- **`stderr: "inherit"`** — the child's stderr is passed straight to this terminal, which is why you
  see `[task-mcp-server] v1.0.0 listening on stdio` in the output (Chapter 08, Block 4). stdout is
  **not** inherited — it is captured by the transport as the JSON-RPC channel.
- **`await client.connect(...)`** — this is where the protocol begins: the SDK spawns the process,
  sends `initialize`, receives the server's `serverInfo` + capabilities, and sends the
  `initialized` notification. After this resolves, the client is ready.

> **Chapter 04 in practice:** the *host* chooses the transport. `createServer()` on the other side is
> unchanged whether this is stdio or HTTP.

### Block 6 — step 1: DISCOVERY (`tools/list`)

```ts
  const { tools } = await client.listTools();
  console.log(`\n1. tools/list -> ${tools.map((tool) => tool.name).join(", ")}`);
```

**What it does:** asks the server for its tool catalogue and prints the tool names.

**How it works:**
- `client.listTools()` sends `tools/list` and returns `{ tools: [...] }` — **full definitions**
  (name, description, inputSchema, annotations), not just names.
- `tools.map((tool) => tool.name).join(", ")` extracts the names and joins them with commas, giving
  `create_task, list_tasks, complete_task`.
- **Discovery is a curated act** (§7.2): only what the server registered is visible, and a tool that
  was never registered **cannot be called**. This catalogue is also what a real host would cache
  (§7.8) rather than re-fetching on every message.
- The leading `\n` just adds a blank line so the output is readable.

### Block 7 — step 2: SELECTION (the model's job)

```ts
  const selected = tools.find((tool) => tool.name === "create_task");
  if (!selected) {
    throw new Error("create_task is missing from the catalogue");
  }
```

**What it does:** picks which tool to call.

**How it works:**
- `tools.find(...)` returns the first tool whose name is `create_task`.
- The `if (!selected) throw …` guard is a safety net: if discovery did not include `create_task`,
  the demo fails loudly instead of calling a tool that does not exist.
- **This is the one probabilistic step in a real system** (Chapter 03: *tool calling decides, MCP
  delivers*). Here there is **no LLM**, so the "model decision" is stubbed with a deterministic
  `find`. Swapping this line for an actual model call is the only change a real host would need at
  this step — the MCP half below is identical.

### Block 8 — step 3: INVOCATION (`tools/call`)

```ts
  const created = await client.callTool({ name: selected.name, arguments: { title: "Record MCP Video" } });
  console.log(`2. tools/call ${selected.name} -> ${text(created)}`);
```

**What it does:** calls the selected tool with arguments and prints the result.

**How it works:**
- `client.callTool({ name, arguments })` sends `tools/call` to the server.
- **Crucially, the request names a *tool*, not a *server*** (§7.4): in a multi-server host, the host
  resolves the tool name to the owning client. Here there is only one client, so routing is trivial —
  but the shape is the same.
- `arguments: { title: "Record MCP Video" }` must satisfy the tool's `inputSchema`
  (`title: string, min 1`) from Chapter 05.
- The result is a `content[]` structure, so `text(created)` (Block 13) extracts the human-readable
  part → `Task #1 created: Record MCP Video (PENDING)`.

### Block 9 — step 4: FAILURE and then success (`complete_task`)

```ts
  const failed = await client.callTool({ name: "complete_task", arguments: { title: "No such task" } });
  console.log(`3. tools/call complete_task (unknown title) -> isError=${failed.isError === true} ${text(failed)}`);

  const completed = await client.callTool({ name: "complete_task", arguments: { title: "Record MCP Video" } });
  console.log(`   tools/call complete_task (exact title)   -> ${text(completed)}`);
```

**What it does:** deliberately calls `complete_task` with a **wrong** title (to show the failure
path), then with the **exact** title (to show success).

**How it works:**
- **First call, `"No such task"`** — the server's `taskService.complete` returns `undefined`, so the
  tool returns a result with `isError: true` (Chapter 05, Block 6). Note this is **not** an exception:
  `await client.callTool(...)` resolves normally. The client inspects the *result*.
  - `failed.isError === true` prints the flag.
  - `${text(failed)}` prints the recovery message: `No pending task titled "No such task". Call
    list_tasks to read the exact titles, then retry.` — a message written to be fed back to the model.
- **Second call, `"Record MCP Video"`** — the exact title matches the pending task, so it succeeds and
  prints `Task completed: Record MCP Video (COMPLETED)`.
- **Why both?** This pair *is* Chapter 05 §5.7 made visible: a failed operation is a **result**
  (`isError: true`), not a protocol error — so a real host can hand the text to the model and let it
  recover.

### Block 10 — step 5: RESOURCES (`resources/list` + `resources/read`)

```ts
  const { resources } = await client.listResources();
  console.log(`\n4. resources/list -> ${resources.map((resource) => resource.uri).join(", ")}`);

  const first = resources[0];
  if (!first) {
    throw new Error("no resources were exposed");
  }

  const read = await client.readResource({ uri: first.uri });
  console.log(`   resources/read ${first.uri} -> ${read.contents.length} content block(s)`);
```

**What it does:** lists the resources the server exposes and reads the first one by URI.

**How it works:**
- `client.listResources()` sends `resources/list` → `{ resources: [...] }`. Each item carries its
  `uri`, `name`, `title`, `description` and `mimeType` (Chapter 06).
- `resources.map((r) => r.uri).join(", ")` prints the **URIs** — the identity of each resource:
  `company://policies/return-policy, company://policies/refund-policy`.
- The `if (!first) throw …` guard prevents reading a resource that does not exist.
- `client.readResource({ uri: first.uri })` sends `resources/read` **with the URI** → returns
  `{ contents: [...] }`. `read.contents.length` is `1` because each policy is a single text block.
- **Who drives this?** The **application** — the model never asked for these policies. That is the
  Resource control model in action (Chapter 06 §6.8).

### Block 11 — step 6: PROMPTS (`prompts/list` + `prompts/get`)

```ts
  const { prompts } = await client.listPrompts();
  console.log(`\n5. prompts/list -> ${prompts.map((prompt) => prompt.name).join(", ")}`);

  const prompt = await client.getPrompt({ name: "review_pull_request", arguments: { prNumber: "42" } });
  console.log(`   prompts/get review_pull_request -> ${JSON.stringify(prompt.messages[0]?.content)}`);
```

**What it does:** lists the available prompts and fetches one with an argument substituted.

**How it works:**
- `client.listPrompts()` sends `prompts/list` → `{ prompts: [...] }` (here: just `review_pull_request`).
- `client.getPrompt({ name, arguments })` sends `prompts/get`. The `arguments: { prNumber: "42" }`
  satisfy the prompt's `argsSchema` (Chapter 07).
- The server substitutes `42` into its template and returns `{ messages: [...] }`. The client prints
  the first message's `content`:
  `{"type":"text","text":"You are reviewing pull request #42. …"}`.
- `JSON.stringify(...)` renders the content block as one line; `prompt.messages[0]?.content` uses
  **optional chaining** (`?.`) so that if there were no messages, this would print `undefined`
  instead of throwing.
- **Who drives this?** The **user** (the UI would show a menu). The model does not pick prompts.

### Block 12 — closing the connection

```ts
  await client.close();
}
```

**What it does:** shuts down the client and the server child process.

**How it works:** `client.close()` ends the session and terminates the spawned server process. Without
it, the child would linger and the Node process might not exit. It is the counterpart to
`client.connect(...)` in Block 5 — every connection has a teardown.

### Block 13 — the `text()` helper

```ts
/** Chapter 05 §5.6 — a result is `content[]` blocks, never a bare value. */
function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}
```

**What it does:** pulls the human-readable text out of a tool result so the console output is clean.

**How it works:**
- **`result: { content?: unknown }`** — the parameter is typed minimally: "something that *may* have a
  `content` field". This keeps the helper usable for any result shape.
- `result.content ?? []` — fall back to an empty array when there is no content.
- `as Array<{ type: string; text?: string }>` — a **type assertion** narrowing the `unknown` to the
  block shape we expect, so the next lines type-check.
- `.filter((block) => block.type === "text")` — keep only text blocks (a result could also carry
  images, audio or embedded resources).
- `.map((block) => block.text ?? "")` — take each block's text, defaulting to `""`.
- `.join(" ")` — concatenate with a space.
- **Why it exists:** Chapter 05 §5.6 — **a result is `content[]` blocks, never a bare value.** The
  client must extract what it wants; it cannot assume a plain string.

### Block 14 — top-level error handling

```ts
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

**What it does:** runs `main()` and handles any unhandled rejection.

**How it works:**
- `main()` returns a promise; `.catch(...)` attaches a handler so a failure anywhere in the lifecycle
  (a missing tool, a missing resource, a transport error) is reported instead of crashing with an
  unhandled rejection.
- `console.error(error)` prints to **stderr** (the host is not a protocol channel here, but it is
  still the right stream for diagnostics).
- `process.exitCode = 1` marks the process as failed **without** killing it abruptly — pending I/O
  can still flush. (This is preferred over `process.exit(1)`.)

---

## 9.5 Run / verify

```bash
cd "Lecture 14/code/Basic Code"
npm run client
```

Expected output (this is the whole lifecycle on one screen):

```text
[task-mcp-server] v1.0.0 listening on stdio

1. tools/list -> create_task, list_tasks, complete_task
2. tools/call create_task -> Task #1 created: Record MCP Video (PENDING)
3. tools/call complete_task (unknown title) -> isError=true No pending task titled "No such task". Call list_tasks to read the exact titles, then retry.
   tools/call complete_task (exact title)   -> Task completed: Record MCP Video (COMPLETED)

4. resources/list -> company://policies/return-policy, company://policies/refund-policy
   resources/read company://policies/return-policy -> 1 content block(s)

5. prompts/list -> review_pull_request
   prompts/get review_pull_request -> {"type":"text","text":"You are reviewing pull request #42. Check for bugs, maintainability issues and missing tests, then report findings as a short list."}
```

Every line maps to a block above: the stderr banner (Chapter 08) → Block 6 → Block 8 → Block 9 →
Block 10 → Block 11.

---

## 9.6 Checkpoint

1. **Which three roles are in this one file?** The **host** (this process), the **client** (the
   `Client` instance), and — spawned, not imported — the **server**.
2. **Which step is the only probabilistic one, and where does it happen?** Selection (Block 7); in a
   real host it is the model's decision, stubbed here with `find`.
3. **What are the three control models shown end-to-end?** Tools driven by the model (Blocks 6–9),
   Resources by the application (Block 10), Prompts by the user (Block 11).

---

## Where to go next

You have now read the whole project, file by file, in dependency order. To go deeper:

- **The notes** — [`../../../notes/README.md`](../../../notes/README.md) and the
  [Complete Consolidated Notes](../../../notes/Lecture_14_Complete_Notes.md) for the reasoning behind
  every design decision here.
- **Swap the transport** — replace `serveStdio` in `src/index.ts` (Chapter 08) with the Streamable-HTTP
  handler from the [project README](../README.md). Nothing else changes.
- **Add a capability** — add a fourth tool in `src/tools/tools.ts` (Chapter 05) and watch it appear in
  `tools/list` on the next `npm run client` — *dynamic discovery*, with no client change.

**Back to:** [Implementation Guide index](./README.md) · [Basic Code README](../README.md)






