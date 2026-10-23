# Lecture 14 — MCP Server from First Principles (Basic Code)

> **The code behind the notes.** One small MCP **server** that exposes all three
> primitives — **Tools** (*do*), **Resources** (*know*), **Prompts** (*reuse*) — plus the
> **Host/Client** that discovers and invokes them. Every file maps to one chapter of
> [`../../notes`](../../notes/README.md).

**Runs offline, with no API key.** A real host would let an LLM choose the tool; here the
client stands in for the model deterministically, so the whole lifecycle —
`tools/list` → `tools/call` → result → `resources/read` → `prompts/get` — is reproducible on
any machine.

```bash
cd "Lecture 14/code/Basic Code"
npm install

npm run client        # host + client: the full lifecycle, printed step by step
npm run server        # the server alone, listening on stdio (waits for a client)
npm run typecheck     # tsc --noEmit
```

`npm run client` prints:

```text
[task-mcp-server] v1.0.0 listening on stdio

1. tools/list -> create_task, list_tasks, complete_task
2. tools/call create_task -> Task #1 created: Record MCP Video (PENDING)
3. tools/call complete_task (unknown title) -> isError=true No pending task titled "No such task". Call list_tasks to read the exact titles, then retry.
   tools/call complete_task (exact title)   -> Task completed: Record MCP Video (COMPLETED)

4. resources/list -> company://policies/return-policy, company://policies/refund-policy
   resources/read company://policies/return-policy -> 1 content block(s)

5. prompts/list -> review_pull_request
   prompts/get review_pull_request -> {"type":"text","text":"You are reviewing pull request #42. ..."}
```

---

## Structure

```text
Basic Code/
├── .env                 # server name / version / transport (gitignored; see .env.example)
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Chapter 04 — STDIO transport binding (the process entry)
│   ├── config/config.ts          # Chapter 02/04/06 — server identity, transport, URI scheme
│   ├── server/server.ts          # Chapter 02 — createServer(): the "standard door"
│   ├── services/taskService.ts   # Chapter 05/07 — the execution layer (business logic)
│   ├── tools/tools.ts            # Chapter 05 — Tools: name + description + inputSchema
│   ├── resources/resources.ts    # Chapter 06 — Resources: addressable context by URI
│   ├── prompts/prompts.ts        # Chapter 06 — Prompts: reusable, user-selected instructions
│   └── client/client.ts          # Chapter 04/07 — Host/Client: discovery → invocation
```

### Chapter map

| Chapter | Where it lives |
|---|---|
| [01 — The integration problem](../../notes/01_The_Integration_Problem_and_Why_Standards_Win.md) | Why this server knows nothing about its host: `server/server.ts` |
| [02 — What MCP is](../../notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md) | `config/config.ts` (identity), `server/server.ts` (capabilities only — no LLM) |
| [03 — MCP vs tool calling](../../notes/03_MCP_vs_Tool_Calling_Complementary_Layers.md) | Step 2 of `client/client.ts`: selection is a model decision, invocation is MCP |
| [04 — Host, Client, Server](../../notes/04_Host_Client_Server_Architecture.md) | `index.ts` (transport), `client/client.ts` (host owns the 1:1 client) |
| [05 — The Tools Primitive](../../notes/05_The_Tools_Primitive.md) | `tools/tools.ts` — description-as-prompt, `inputSchema`, `outputSchema`, `annotations`, `isError` |
| [06 — Resources and Prompts](../../notes/06_Resources_and_Prompts.md) | `resources/resources.ts` (`resources/list`, `resources/read`), `prompts/prompts.ts` (`prompts/list`, `prompts/get`) |
| [07 — The tool lifecycle](../../notes/07_Discovery_Invocation_and_Lifecycle.md) | `client/client.ts` — the numbered steps; `taskService.ts` is the deterministic middle |
| [08 — Security and production](../../notes/08_Security_Production_and_Practical_Architecture.md) | `isError` messages written as recovery instructions; resources are read-only |

---

## Three design decisions worth reading the code for

**1 · The tool contract and the implementation are separate files** (`src/tools/tools.ts` vs `src/services/taskService.ts`)

The model sees `name`, `description` and `inputSchema` — never `taskService`. That is
Chapter 05's whole point: *"a tool is a contract written for a reader who cannot read your
code."* Keeping them in different files makes the boundary impossible to blur by accident.

**2 · The failure path returns a result, not a protocol error** (`complete_task`)

`{"isError": true, "content": [...]}` means *the call ran and the operation failed*, so the
text goes back into the model's context — which makes it an instruction channel. The message
therefore names the fix (`Call list_tasks to read the exact titles, then retry.`) instead of
just reporting `Error`.

**3 · The URI is the resource's identity** (`company://policies/return-policy`)

`https://` would be a lie here: the client cannot fetch it — only this server can. A custom
scheme keeps the address honest and stops a host from trying to dereference something it
should not.

---

## Inspecting the server by hand

```bash
# start it, then paste newline-delimited JSON-RPC on stdin
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | npm run server --silent
```

The `initialize` reply declares `tools`, `resources` and `prompts` capabilities, and
`tools/list` returns the full definitions — schemas and annotations included. To browse it
with a UI instead:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

---

## Swapping the transport

`src/index.ts` is the only transport-aware file in the project. STDIO is the local binding; the
remote one is **Streamable HTTP**, and `createServer()` does not change at all:

```bash
npm install @modelcontextprotocol/express @modelcontextprotocol/node
```

```ts
// Chapter 04 — the same server behind a different door.
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server/server.js";

const handler = createMcpHandler(createServer);
const app = createMcpExpressApp({ host: "127.0.0.1" });
const nodeHandler = toNodeHandler(handler);

app.all("/mcp", (request, response) => {
  void nodeHandler(request, response, request.body);
});

app.listen(8081, "127.0.0.1");
```

That is Chapter 01 in practice: the host depends on the *protocol*, the server on its
*backend*, and nothing depends on a vendor — so the binding is a detail, not a rewrite.
