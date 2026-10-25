# Lecture 14 — MCP Server from First Principles (Production Code)

> **The same three primitives as [Basic Code](../Basic%20Code/README.md), with the
> concerns Chapter 08 makes non-optional bolted on.** One MCP **server** exposing
> **Tools** (*do*), **Resources** (*know*) and **Prompts** (*reuse*), plus the
> **Host** that discovers them and then refuses to trust them: validated config,
> structured logging, audit, rate limits, timeouts, idempotency, a real error
> taxonomy, resource templates, and a host that enforces consent and tool
> filtering before anything runs.

**Runs offline, with no API key.** A real host would let an LLM choose the tool;
here the host stands in for the model deterministically, so the whole lifecycle —
`initialize` → `tools/list` → `tools/call` → `resources/read` → `prompts/get` —
is reproducible on any machine.

```bash
cd "Lecture 14/code/Production Code"
npm install

npm run host          # host + client: the full lifecycle, printed step by step
npm run server        # the server alone, listening on stdio (waits for a client)
npm run typecheck     # tsc --noEmit
```

`npm run host` prints:

```text
1. connect     -> spawned the server over stdio
2. handshake   -> capabilities: completions, logging, prompts, resources, tools
   instructions: "Task server. Every mutation is keyed by the numeric task id, so call list_tasks first…"

3. tools/list  -> 4 tools discovered
   complete_task  readOnly=false destructive=false idempotent=true
   create_task    readOnly=false destructive=false idempotent=false
   delete_task    readOnly=false destructive=true  idempotent=false
   list_tasks     readOnly=true  destructive=false idempotent=true

4. host policy -> 4 of 4 tools shown to the model
   auto     complete_task  no destructive hint
   auto     create_task    no destructive hint
   confirm  delete_task    destructiveHint is set: irreversible, so it needs explicit consent
   auto     list_tasks     readOnlyHint is set

5. selection   -> (stand-in for the model) create_task
   tools/call create_task            -> Task #1 created: Record MCP Video (PENDING).
   tools/call create_task (same key) -> Task #1 already existed (idempotent replay): Record MCP Video (PENDING).

6. failures    -> tool execution errors (`isError: true`)
   complete_task id=999 -> isError=true No task with id 999. Call list_tasks to read the exact ids, then retry.
   complete_task id=1   -> Task completed: #1 Record MCP Video (COMPLETED).
   complete_task id=1   -> isError=true Task #1 is already COMPLETED. Nothing to do — report the current state instead of retrying.

7. consent     -> delete_task is destructive (Chapter 08 §8.1)
   ? consent DECLINED for delete_task({"id":2})
   x delete_task denied — the server was never called
   delete_task id=2     -> not invoked
   ? consent APPROVED for delete_task({"id":2})
   delete_task id=2     -> Task deleted: #2 Publish the notes.

8. resources   -> resources/list: company://policies/return-policy, company://policies/refund-policy, company://tasks/1
   templates    -> company://tasks/{taskId}
   read company://policies/return-policy -> 97 chars
   read company://tasks/1 -> { "id": 1, "title": "Record MCP Video", "status": "COMPLETED", …
   read company://tasks/999 -> protocol error: Resource not found: company://tasks/999

9. prompts     -> prompts/list: daily_task_briefing, review_pull_request
   prompts/get daily_task_briefing -> You are preparing a task briefing for Aminul. Call list_tasks…

10. audit      -> every decision, with hashed arguments
   time         tool           decision  outcome  argsHash          ms
   11:02:50.737 create_task    auto      ok       57036086e66b5396  33
   11:02:50.741 create_task    auto      ok       57036086e66b5396  2
   11:02:50.743 create_task    auto      ok       fe096691f37c3caa  2
   11:02:50.746 complete_task  auto      error    aa0c17ac393b495d  3
   11:02:50.749 complete_task  auto      ok       037c9214eef74cc3  3
   11:02:50.752 complete_task  auto      error    037c9214eef74cc3  2
   11:02:50.752 delete_task    confirm   denied   9e7e65453739bbc6  0
   11:02:50.758 delete_task    confirm   ok       9e7e65453739bbc6  5
```

Two rows are worth staring at. The two `create_task` calls carry **the same
`argsHash`** — the second was an idempotent replay, not a second task. And
`delete_task` appears **twice with the same hash**, once `denied` and once `ok`,
because the user's answer changed, not the request.

---

## What "production" adds, and why

Every item below exists because Chapter 08 names it as a responsibility the
protocol does **not** remove. Nothing here is decoration.

| Concern | Where | The failure it prevents |
| :--- | :--- | :--- |
| **Validated config** | `src/config/env.ts` | A bad timeout discovered three turns into a conversation instead of at boot |
| **Structured logging to stderr** | `src/core/logger.ts` | A stray `console.log` corrupting the JSON-RPC stream and killing the connection |
| **Redaction** | `src/core/logger.ts` | PII or a token landing in a log line because tool arguments *are* user data |
| **Metrics** | `src/core/metrics.ts` | Being unable to answer "how often" and "how slow" after an incident |
| **Error taxonomy** | `src/core/errors.ts` | A model that hallucinates success because the error said only `Error` |
| **Rate limiting** | `src/core/guards.ts` | An agent loop spending 400 calls in a minute |
| **Timeouts** | `src/core/guards.ts` | One hung capability stalling the entire host |
| **Idempotency** | `src/domain/taskStore.ts` | A retry creating a second task |
| **Re-validation** | `src/services/taskService.ts` | A hostile client bypassing the schema the model was given |
| **Audit trail** | `src/host/audit.ts` | Being unable to prove who ran what, on whose authority |
| **Consent gate** | `src/host/policy.ts` | An irreversible operation running on the model's authority alone |
| **Tool filtering** | `src/host/policy.ts` | A destructive tool being callable because it was *discoverable* |
| **Annotation-driven retry** | `src/host/client.ts` | A retry duplicating a side effect |
| **Resource templates** | `src/mcp/resources.ts` | Enumerating every instance in code, and a catalogue that drifts from live state |

---

## Structure

```text
Production Code/
├── .env                 # every knob, validated at boot (gitignored; see .env.example)
├── .env.example
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess
├── README.md
├── src/
│   ├── index.ts                    # Chapter 04 — STDIO binding + graceful shutdown
│   ├── config/env.ts               # Chapter 08 — Zod-validated environment, fail fast
│   ├── core/
│   │   ├── logger.ts               # Chapter 08 — structured stderr logging + redaction
│   │   ├── metrics.ts              # Chapter 08 — counters and latency, no vendor
│   │   ├── errors.ts               # Chapter 05 — the two error mechanisms
│   │   └── guards.ts               # Chapter 08 — rate limiter + timeout
│   ├── domain/taskStore.ts         # Chapter 07 — state + idempotency keys
│   ├── services/taskService.ts     # Chapter 05 — validated business logic (no MCP imports)
│   ├── mcp/
│   │   ├── deps.ts                 # the wiring contract shared by the three registrars
│   │   ├── server.ts               # Chapter 02 — createServer(): the "standard door"
│   │   ├── tools.ts                # Chapter 05 — Tools: contract, annotations, outputSchema
│   │   ├── resources.ts            # Chapter 06 — Resources: static + templated
│   │   └── prompts.ts              # Chapter 06 — Prompts: user-driven templates
│   └── host/
│       ├── policy.ts               # Chapter 08 — trust tiers, consent, filtering
│       ├── audit.ts                # Chapter 08 — the record, with hashed arguments
│       └── client.ts               # Chapter 04/07 — the host: the whole lifecycle
└── implementations guide/          # chapter-wise build guide (full source, block by block)
```

### Chapter map

| Chapter | Where it lives |
| :--- | :--- |
| [01 — The integration problem](../../notes/01_The_Integration_Problem_and_Why_Standards_Win.md) | The host depends on the protocol, not on this server: `src/host/client.ts` |
| [02 — What MCP is](../../notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md) | `src/config/env.ts` (identity), `src/mcp/server.ts` (capabilities + instructions, no LLM) |
| [03 — MCP vs tool calling](../../notes/03_MCP_vs_Tool_Calling_Complementary_Layers.md) | `callWithPolicy()` in `src/host/client.ts`: selection is a model decision, invocation is MCP |
| [04 — Host, Client, Server](../../notes/04_Host_Client_Server_Architecture.md) | `src/index.ts` (transport), `src/host/client.ts` (the host owns the 1:1 client) |
| [05 — The Tools Primitive](../../notes/05_The_Tools_Primitive.md) | `src/mcp/tools.ts` — description-as-prompt, schemas, annotations, `isError` |
| [06 — Resources and Prompts](../../notes/06_Resources_and_Prompts.md) | `src/mcp/resources.ts` (static + template), `src/mcp/prompts.ts` |
| [07 — The tool lifecycle](../../notes/07_Discovery_Invocation_and_Lifecycle.md) | `src/host/client.ts` — the numbered steps; `src/domain/taskStore.ts` is the deterministic middle |
| [08 — Security and production](../../notes/08_Security_Production_and_Practical_Architecture.md) | `src/host/policy.ts`, `src/host/audit.ts`, `src/core/guards.ts`, `src/config/env.ts` |

**[🛠️ Implementation guide (01 → 17)](./implementations%20guide/README.md)** — the same
source, chapter by chapter: file details → full source → block-by-block explanation → verification.

---

## Five design decisions worth reading the code for

**1 · The tool contract and the implementation are different files**
(`src/mcp/tools.ts` vs `src/services/taskService.ts`)

The model sees `name`, `description`, `inputSchema`, `outputSchema` and
`annotations` — never `taskService`. Keeping them apart makes Chapter 05's
boundary impossible to blur by accident, and it is what lets the service be
unit-tested with no transport and no model.

**2 · One `guard()` wrapper owns every cross-cutting concern** (`src/mcp/tools.ts`)

Rate limit → validate → execute inside a timeout → map the failure to a result,
in that order, in one function. None of the four handlers contains a `try`,
a timer, a counter or a log call — and a fifth tool *cannot forget one*.

**3 · Failures are results, and their text is written for the model**

`{"isError": true, "content": [...]}` means *the call ran and the operation
failed*, so the text lands in the model's context — which makes it an
instruction channel. Every `ToolError` therefore carries a `recovery` sentence
(`"Call list_tasks to read the exact ids, then retry."`) rather than just a
fault. A `resources/read` miss is the opposite: a **protocol error**, because
nothing executed and no model is waiting to recover.

**4 · Annotations are hints; the host is the enforcement point**

`destructiveHint` comes from the server and a hostile server can mislabel its own
tools. So the host classifies every discovered tool *itself* and can reach three
verdicts — auto-approve, ask the user, or **never show it to the model**. The
third is the cheapest real control in the architecture: an absent tool cannot be
called by a model that was never told it exists.

**5 · Idempotency is a key, not a hope**

`create_task` accepts a caller-supplied `idempotencyKey`. The same key returns the
original task with `replayed: true` instead of writing a second one — which is
why two identical `tools/call`s appear once in the audit trail with one hash.

---

## Honest limits — documented rather than hidden

- **State is in-process.** Restart the server and the board is empty. The lesson
  is the protocol and the boundary, not a database driver.
- **The rate limiter and the timeout are wired but not exercised by the demo.**
  Both are live on every call (`guard()`), but a 4-call demo never trips a
  60-per-minute limit or a 5-second budget. Their behaviour is documented in
  Chapter 06 of the guide rather than demonstrated.
- **`sendLoggingMessage` is available and unused.** The server declares the
  `logging` capability, so a host could call `logging/setLevel` and receive
  `notifications/message`; the demo prints to stderr instead, which is easier to
  read in a terminal.
- **Resource subscriptions are not implemented.** `McpServer` does not register
  `resources/subscribe` for you — declaring the `subscribe` capability makes the
  *client* willing, not the *server* able. The high-level API exposes
  `server.server.sendResourceUpdated(...)` but no matching request handler, so a
  correct implementation has to reach for the low-level `Server`. That is a real
  finding, not an oversight, and it is why the demo stops at
  `resources/templates/list`.
- **Tools cannot be registered after `connect()`.** The SDK raises
  `ALREADY_CONNECTED` ("Cannot register capabilities after connecting to
  transport"), so dynamic discovery means declaring the catalogue up front and
  using `sendToolListChanged()` to announce a change — not growing the catalogue
  at runtime.

---

## Inspecting the server by hand

```bash
# start it, then paste newline-delimited JSON-RPC on stdin
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npm run server --silent
```

The `initialize` reply declares `logging`, `tools`, `resources`, `prompts` and
`completions`, and carries the server's `instructions`. `tools/list` returns the
full definitions — schemas and annotations included. To browse it with a UI:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts

# one method, no UI — `--protocol-era modern` exercises a 2026-07-28 client
# (`server/discover`); the Inspector's default is the *legacy* 2025-era handshake.
npx @modelcontextprotocol/inspector --cli npx tsx src/index.ts --protocol-era modern --method tools/list
```

To see the other policy branch — the one where a destructive tool is never shown
to the model at all:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host
# 4. host policy -> 3 of 4 tools shown to the model
#    denied   delete_task    destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false
```

To watch the config guard fire:

```bash
MCP_TOOL_TIMEOUT_MS=abc npm run server
# [config] refusing to start — invalid environment:
#   - MCP_TOOL_TIMEOUT_MS: Invalid input: expected number, received NaN
```

---

## Swapping the transport

`src/index.ts` is the only transport-aware file in the project. STDIO is the
local binding; the remote one is **Streamable HTTP**, and `createServer()` does
not change at all:

```bash
npm install @modelcontextprotocol/express @modelcontextprotocol/node express
```

```ts
// Chapter 04 — the same server behind a different door.
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./mcp/server.js";

const handler = createMcpHandler(createServer);
const app = createMcpExpressApp({ host: "127.0.0.1" });
const nodeHandler = toNodeHandler(handler);

app.all("/mcp", (request, response) => {
  void nodeHandler(request, response, request.body);
});

app.listen(8081, "127.0.0.1");
```

That is Chapter 01 in practice: the host depends on the *protocol*, the server on
its *backend*, and nothing depends on a vendor — so the binding is a detail, not
a rewrite.
