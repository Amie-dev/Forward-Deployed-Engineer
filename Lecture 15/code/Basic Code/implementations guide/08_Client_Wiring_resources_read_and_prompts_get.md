# Chapter 08 — Client Wiring: `resources/read` & `prompts/get`

> **Goal of this chapter:** build the client that actually consumes what the server offers — and
> in doing so, see the two halves of Chapter 07 §7.3 side by side in one file: **the protocol call
> (`prompts/get`) and the model call (`askModel`) are different lines of code.**
>
> **Lecture chapters:** [07 — Prompt Arguments, Discovery and Client Wiring](../../../notes/07_Prompt_Arguments_Discovery_and_Client_Wiring.md)
> and [08 — Bringing Tools, Resources and Prompts Together](../../../notes/08_Bringing_Tools_Resources_and_Prompts_Together.md).

---

## 8.1 File details

| | |
|---|---|
| **Path** | `src/client/client.ts` |
| **Purpose** | one wrapper per MCP verb, the two flows (`ask`, `planDay`), and the lifecycle walkthrough |
| **Imports** | `node:child_process`, `node:url`, `@modelcontextprotocol/client`, config, `resourceSelector` |
| **Exports** | `Connection` (type); `connect`, `disconnect`, `listResources`, `readResource`, `listPrompts`, `getPromptText`, `askModel`, `ask`, `planDay` |
| **Depends on** | `src/config/config.ts`, `src/services/resourceSelector.ts` |
| **Called by** | `src/routes/index.ts` (the host); also runs standalone via `npm run lifecycle` |
| **Implements** | Lecture 03 (`resources/list`, `resources/read`), Lecture 05 (selection), Lecture 06/07 (`prompts/list`, `prompts/get`), Lecture 07 §7.3 (Prompt ≠ LLM call) |

## 8.2 Commands

```bash
npm run lifecycle            # starts a server itself, then walks the whole lifecycle
```

```bash
# or, against a server you started separately
npm run server               # terminal 1
npx tsx src/client/client.ts # terminal 2
```

---

## 8.3 Full file (part 1 of 2) — connection and the MCP verb wrappers

**Path:** `src/client/client.ts`

```ts
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
```

---

## 8.4 Full file (part 2 of 2) — the model step, the two flows, and the walkthrough

```ts
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
```

---

## 8.5 Block-by-block explanation

### Block 1 — imports and the connection

```ts
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { hasModelKey, mcpServerUrl, model } from "../config/config.js";
import { selectResources, type CatalogueEntry } from "../services/resourceSelector.js";

export type Connection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

export async function connect(): Promise<Connection> {
  const client = new Client({ name: "task-host", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl));

  await client.connect(transport);

  return { client, transport };
}
```

- **Two imports tell you this is the host side.** `node:child_process` (to start the server) and
  `@modelcontextprotocol/client` (to speak to it). A server file would never import either.
- `Client` and `StreamableHTTPClientTransport` are the mirror image of `McpServer` and
  `toNodeHandler`. `Client` is **transport-agnostic**: it does not know it is on HTTP. Swap
  `StreamableHTTPClientTransport` for `StdioClientTransport` and nothing else in this file
  changes — which is Chapter 01's "the binding is a detail".
- `new Client({ name: "task-host", version: "1.0.0" })` sends the **client's** identity at
  `initialize`. So the handshake has two identities: the client announces itself, and the server
  replies with `serverInfo` (Chapter 02). Neither knows anything else about the other.
- `new URL(mcpServerUrl)` converts the string from `.env` into a `URL` object, because the
  transport constructor wants one. This is where Chapter 02's `mcpServerUrl` gets used.
- **`await client.connect(transport)` performs the whole handshake**: open the transport, send
  `initialize`, read the server's capabilities, send `initialized`. After this line resolves, the
  client knows which primitives exist. You never write any of those messages.
- `Connection` bundles the two objects because they must be closed together and in order. It is
  a small type doing real work: `disconnect()` cannot be called with half a connection.

```ts
export async function disconnect(connection: Connection): Promise<void> {
  try {
    await connection.transport.terminateSession();
  } catch {
    // No session was established, so there is nothing to terminate.
  }

  await connection.client.close();
}
```

- `terminateSession()` is HTTP-specific: a Streamable HTTP session is a real server-side resource
  and should be released politely. A stdio transport would not need it.
- **The `try`/`catch` with no binding** (`catch {` — no `(error)`) is deliberate. Whether a
  session existed is not interesting; the only goal is to not let cleanup throw.
- The order matters: terminate the session *first*, then close the client. Closing the client
  first would leave the transport's session dangling on the server.

### Block 2 — discovery vs consumption

```ts
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
```

- **`listResources` makes two protocol calls, not one.** This is the part people miss:
  `resources/list` returns fixed URIs only, and `resources/templates/list` returns the patterns.
  Chapter 04 §Block 6 explained why they are separate; here is the client paying that cost.
- Destructuring `const { resources } = …` picks one field out of the result object. The full
  result also carries an optional `nextCursor` for pagination, which this small catalogue never
  needs.
- Returning `{ resources, resourceTemplates }` keeps the two apart in the type system. A caller
  that treats a template as a readable URI will not compile.
- **`readResource` is a separate function from `listResources` on purpose.** Chapter 03's
  headline is *"discovery is not consumption"*, and the cleanest way to say that in code is two
  functions with two names. Listing five Resources costs nothing; reading all five would cost
  five round trips.
- `client.readResource({ uri })` takes an **object**, not a bare string — the protocol's
  `ReadResourceRequest.params` is `{ uri }`, and the SDK mirrors it. Being able to see that shape
  in your code is half the value of using the SDK's own types.
- The `.map(...)` has to handle **two kinds of content**:
  - `"text" in content` — the TypeScript narrowing idiom. If the object has a `text` property it
    is `TextResourceContents`, and `content.text` is a `string`.
  - Otherwise it is `BlobResourceContents` (base64 binary), so we produce a readable placeholder.
    This project only registers text Resources, but the branch documents the protocol's other half.
- `.join("\n")` collapses the `contents` **array** into one string. `contents` is an array because
  one read may legitimately return several blocks; this client's callers want a single prompt
  fragment, so it flattens here rather than at every call site.

### Block 3 — prompts: discovery and fetch

```ts
export async function listPrompts(client: Client) {
  const { prompts } = await client.listPrompts();

  return prompts;
}

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
```

- `listPrompts` is the exact analogue of `listResources`: one call, one destructured field.
  `prompts/list` returns each prompt's `name`, `description` and `arguments`, which is the whole
  menu a UI needs (Chapter 06 §6.7).
- `getPromptText` returns a **`string`**, not the `messages` array. The narrowing happens here so
  callers never deal with content blocks.
- **Note the naming.** It is `getPromptText`, not `getPromptAnswer`. The name is a small but
  deliberate guard against the confusion Chapter 07 §7.3 warns about: this function returns the
  *text of the prompt*, and nothing has been generated yet.
- `args: Record<string, string>` — a plain string map, matching Chapter 06's `z.string()` argument
  schema. It is passed straight through as `arguments: args`.
- The `.map(...)` differs slightly from `readResource`'s: prompt messages are `PromptMessage[]`
  with a discriminated `content.type`, so the check is
  `content.type === "text" ? content.text : ""`. Non-text blocks become an empty string and are
  dropped by the join. In this project every message is text, so the branch never fires — but it
  is the honest way to write it.

### Block 4 — the only place a model appears

```ts
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
```

- **This is the whole of Chapter 07 §7.3, in one function.** Everything above it is MCP. This is
  the model. Two different systems, two different credentials, two different failure modes — and
  they are separated by a function boundary rather than tangled together.
- The **offline branch** is what makes the project runnable with no API key. It returns the exact
  text that *would* have been sent, labelled. Because `askModel` is the single choke point, one
  `if` covers every flow.
- `instructions ? … : ""` — the SYSTEM block is only included when there is one. `/plan` calls
  `askModel(prompt)` with no instructions, so it prints only the USER half. `/ask` passes both.
- `.filter(Boolean)` drops the empty strings, so the offline text has no stray blank lines when
  `instructions` is absent. `Boolean("")` is `false`, which is exactly what `.filter` needs.
- **`await import("openai")` is a dynamic import.** The OpenAI SDK is only loaded when a key is
  present, so the offline path never pays for it. It also keeps the model dependency off the
  module's startup path, which is why the project boots instantly.
- `const { default: OpenAI } = await import(…)` — a dynamic `import()` resolves to a **module
  namespace object**, so the default export lives at `.default`. Destructuring with a rename gives
  us `OpenAI` exactly as a static `import OpenAI from "openai"` would.
- `openai.responses.create({ model, instructions, input: message })` is the Responses API. Note
  that `instructions` is a **separate field** from `input`, not a system message prepended to the
  user's text. Passing `undefined` is fine — the field is simply omitted.
- `response.output_text` is the convenience accessor for the concatenated assistant text.

### Block 5 — the Resource flow

```ts
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
```

- **This function is the Resource half of the lecture, in eleven lines.** Trace the order:
  1. `listResources(client)` — ask the server what exists (**discovery**).
  2. `.map(...)` — convert the protocol's `Resource[]` into Chapter 05's `CatalogueEntry[]`.
  3. `selectResources(message, catalogue)` — **the application decides** (Chapter 05).
  4. `readResource(client, choice.uri)` — fetch each chosen one (**consumption**).
  5. `askModel(message, instructions)` — only *now* does a model appear.
- **Step 2 is the adapter that keeps Chapter 05 clean.** `resourceSelector.ts` must not import
  the MCP SDK, so the translation from `Resource` to `CatalogueEntry` happens here, in the client.
  That is why `CatalogueEntry` is structurally compatible: `{ uri, description }` exists on both.
- `resource.description ?? ""` guards against an optional field. Chapter 04 always sets a
  description, but the protocol does not require it.
- The `context` header `` `--- ${choice.uri} (chosen by ${choice.strategy}) ---` `` is the reason
  Chapter 05's `strategy` field exists. In offline mode you read it directly; with a model, it
  also tells the model *why* a block of text is present, which measurably improves how it uses it.
- `context.join("\n\n")` — a double newline between blocks, so the model sees clear boundaries.
  A single `\n` would run the guidelines straight into the backlog.
- **Order is preserved** by the loop: `selectResources` returns rules-first, then retrieval, and
  the context is assembled in that order. The rules appear *before* the data they govern.
- The final `askModel(message, instructions)` puts the **user's** message in `input` and the
  assembled context in `instructions`. That split is what makes the context read as standing
  instructions rather than as something the user said.

### Block 6 — the Prompt flow

```ts
export async function planDay(client: Client, hours: string): Promise<string> {
  const prompt = await getPromptText(client, "plan_day", { availableHours: hours });

  return askModel(prompt);
}
```

- **Six lines. Two systems.** This is the clearest statement of Chapter 07 §7.3 in the whole
  project:
  - Line 1 is **MCP**: `prompts/get` over the protocol, `name` + `arguments`, returns a template.
  - Line 3 is **the model**: the OpenAI API, no MCP involved.
  - They are separated by a blank line, and neither knows about the other.
- **Compare `planDay` with `ask`:**

  | | `ask` (Resource flow) | `planDay` (Prompt flow) |
  |---|---|---|
  | Who chose the workflow? | the user, implicitly (a free-text question) | the **user**, explicitly (`plan_day`) |
  | Who chose the context? | the **application** (`selectResources`) | the **model**, guided by the prompt's prose |
  | Protocol calls | `resources/list` + N × `resources/read` | one `prompts/get` |
  | Model input | user message + assembled instructions | the rendered template, as the user message |

- In `planDay` the model receives the prompt as the **`input`**, with no `instructions`. That is
  because a Prompt is already a user message — Chapter 06 registered it with
  `role: "user"`. Passing it as `instructions` would misrepresent who is speaking.
- **`askModel(prompt)` is called with one argument**, so `instructions` is `undefined` and the
  offline output shows only the `USER:` block. You can see that in step 7 of the walkthrough
  versus step 6 of the `/ask` output.
- `{ availableHours: hours }` — the key must match Chapter 06's `argsSchema` field name exactly.
  A typo would be caught by the schema at the server, not silently ignored.
- **Where do the Resources come in?** They do not — not directly. The *prompt text* says
  *"First read my current pending tasks, then apply the task guidelines"*, so the model is
  expected to call `list_tasks` and/or read the Resources itself. That is the cooperation from
  Chapter 07 §7.2: **the Prompt delegates, it does not fetch.**

### Block 7 — the walkthrough plumbing

```ts
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}
```

- Pure presentation: split on newlines, prefix every line with three spaces, rejoin. It exists so
  multi-line protocol output stays visually nested under its step number.
- Note the `\n` inside the split — `split("\n")` on a `\n`-joined string round-trips exactly.

```ts
async function isServerRunning(): Promise<boolean> {
  try {
    await disconnect(await connect());
    return true;
  } catch {
    return false;
  }
}
```

- **A probe, not a check.** There is no port scanner here — it simply tries to connect and reports
  whether that worked. If `connect()` resolves, a server is there; if it throws, one is not.
- It calls `disconnect()` on the way out so the probe does not leak a session on the server. That
  is the reason `disconnect` exists as its own function rather than being inlined into `main`.
- **Why probe at all?** So the walkthrough works whether or not you already ran `npm run server`.
  Without it, spawning a second server would hit `EADDRINUSE`.

```ts
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
```

- **A retry loop, because a spawned process takes time to bind its port.** `spawn` returns
  immediately; the server needs a few hundred milliseconds before it accepts connections.
- `40 × 250 ms` = up to 10 seconds. Generous for a local process, short enough to fail fast if
  something is genuinely wrong.
- `await new Promise((resolve) => setTimeout(resolve, 250))` is the idiom for "sleep" in
  JavaScript. There is no `sleep()` built in; wrapping `setTimeout` in a Promise is the standard
  way, and `await`ing it pauses the loop without blocking the event loop.
- The final `throw` is a **useful** error: it names the URL and the fix. Same principle as
  Chapter 03's `completeTask` failure message.

```ts
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
    // … the seven steps …
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
```

- **The `? :` decides whether this process owns the server's lifetime.** If one is already
  running, `server` is `undefined` and the walkthrough leaves it alone. Otherwise it spawns one —
  and becomes responsible for stopping it.
- `spawn("npx", ["tsx", "src/index.ts"], { stdio: "inherit", detached: true })`:
  - `stdio: "inherit"` — the server's stderr (its startup banner) appears in the same terminal, so
    you see *both* sides of the conversation.
  - `detached: true` — the child gets **its own process group**. Without this, `npx` spawns `tsx`,
    which spawns `node`, and killing `npx` leaves the grandchild holding port 8081. This is a real
    bug you would hit on the second run.
- `try` / `finally` guarantees the cleanup runs even if a step throws. There is no `catch`, so a
  failure still surfaces as a rejection — you just get a tidy shutdown first.
- `process.kill(-server.pid, "SIGTERM")` — the **negative pid** means "signal the whole process
  group". That is the counterpart to `detached: true`, and it is what stops `npx`, `tsx` and
  `node` together.
- The `try`/`catch` around it handles the race where the process already exited: signalling a
  dead group throws `ESRCH`, and the fallback `server.kill()` is harmless.
- **This is Chapter 08's "a host owns the lifecycle"** made literal: start the server, use it,
  stop it. A real host (an IDE, a desktop app) does exactly this.

### Block 8 — run only when executed directly

```ts
// Chapter 08 — run the walkthrough only when this file is executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
```

- **This is the guard that lets one file be both a library and a script.** `src/routes/index.ts`
  imports `ask`, `planDay`, `connect` and friends from this module; if `main()` ran on import, the
  host would start a walkthrough every time it booted.
- `process.argv[1]` is the path of the file Node was asked to run. `pathToFileURL(...).href`
  converts it to a `file://` URL, because that is the form `import.meta.url` uses. When they match,
  *this module is the program* — so run `main()`.
- The `process.argv[1] &&` check guards against `node -e` style invocations where there is no
  entry file.
- `void main()` — the `void` operator explicitly discards the returned Promise. It tells the
  reader (and the linter) *"this is deliberately not awaited; a top-level await is not what I
  want here"*. Without it, a rejected Promise would surface as an unhandled rejection warning;
  with it, the intent is stated.
- **The alternative** would be a separate `src/client/lifecycle.ts`. Keeping it in one file is
  deliberate: the walkthrough *is* the demonstration of the client's own API, and having the
  script call the very functions the host calls proves the API is usable.

---

## 8.6 The two flows, side by side

This is the diagram to hold in your head after reading this file.

```text
── ask()  — the RESOURCE flow ─────────────────────────────
   user message
        │
        ▼
   resources/list          ← discovery (the application asks what exists)
        │
        ▼
   selectResources()       ← THE APPLICATION DECIDES  (Chapter 05)
        │
        ▼
   resources/read  ×N      ← consumption
        │
        ▼
   instructions + message
        │
        ▼
   askModel()              ← the MODEL, and only here

── planDay()  — the PROMPT flow ───────────────────────────
   user picks "Plan my day" and types 4 hours
        │
        ▼
   prompts/get             ← THE USER'S CHOICE, rendered by the server
        │
        ▼
   prompt text
        │
        ▼
   askModel()              ← the MODEL, and only here
```

**Both flows end in the same function**, `askModel`. That is the point of the file's structure:
Resources and Prompts are two *ways of assembling what to send*; the model call is a single,
shared, final step. Mixing the two up is the mistake Chapter 07 §7.3 is written to prevent.

---

## 8.7 Run / verify

```bash
npm run lifecycle
```

Verified output, complete:

```text
[task-mcp-server] v1.0.0 MCP endpoint on http://127.0.0.1:8081/mcp

1. resources/list — discovery, not consumption
   task://guidelines
   task://backlog
   task://summary
   task://projects/{projectId}   (template)
   user://{userId}/profile   (template)

2. resources/read task://guidelines — a STATIC Resource
   Task Management Guidelines:

   1. Deep work tasks should preferably be done before 12 PM.
   2. Meetings should preferably be scheduled after 2 PM.
   3. Urgent tasks should be completed on the same day.
   4. Keep a maximum of three high-priority tasks per day.
   5. Complete high-priority tasks before low-priority tasks.

3. resources/read task://projects/fde — a TEMPLATED Resource, one definition
   Project: fde
   Tasks: 2

   - [open] Write MCP notes
   - [open] Review pull request

4. resources/read user://123/profile — a second template, same shape
   User: 123
   Open tasks: 2 of 2

   - [open] Write MCP notes
   - [open] Review pull request

5. prompts/list — which workflows exist?
   plan_day(availableHours)
   review_workload()

6. prompts/get plan_day { availableHours: "4" } — a template, not an answer
   Help me plan my pending tasks for today.

   First read my current pending tasks, then apply the task guidelines.

   I have 4 hours available today.

   Give me a concise and ordered plan.

7. the model step, after prompts/get — GET /plan?hours=4 in miniature
   (offline — no OPENAI_API_KEY, so no model was called)
   USER:
   Help me plan my pending tasks for today.

   First read my current pending tasks, then apply the task guidelines.

   I have 4 hours available today.

   Give me a concise and ordered plan.
```

Three things to verify:

1. **Steps 1–4 all happened without a model.** Discovery and reading are pure protocol.
2. **Step 6 produced a question, not an answer.** No model was consulted by `prompts/get`.
3. **Step 7 is labelled offline** and contains no `SYSTEM:` block — because `planDay` calls
   `askModel(prompt)` with no instructions.

Set `OPENAI_API_KEY` in `.env` and re-run: step 7 becomes a real day plan, and steps 1–6 are
byte-for-byte identical. That is the strongest possible proof that the protocol and the model are
independent.

---

## 8.8 Checkpoint

1. **How many protocol calls does `listResources` make?** → two: `resources/list` and
   `resources/templates/list`.
2. **Why is `readResource` a separate function from `listResources`?** → because discovery is not
   consumption — listing is free, reading costs a round trip.
3. **What is the only function in the project that calls a model?** → `askModel()`.
4. **Which line in `planDay` is MCP, and which is the model?** → line 1 is `prompts/get` (MCP);
   the `askModel(prompt)` call is the model.
5. **Why does `askModel` use `await import("openai")`?** → so the SDK is only loaded when a key
   exists, keeping the offline path dependency-free.
6. **Why is `spawn` called with `detached: true` and killed with a negative pid?** → so the whole
   `npx → tsx → node` process group can be stopped, rather than orphaning the server on port 8081.
7. **Why the `import.meta.url === pathToFileURL(process.argv[1]).href` guard?** → so this module can
   be imported as a library by the host without running the walkthrough.

**Next:** [Chapter 09 — Entry Point & Routes: `GET /plan?hours=4`](./09_Entry_Point_and_Routes_GET_plan_hours_4.md)






