# Lecture 15 — Production Code · Implementation Guide

> **Read this guide top to bottom and you will have built, file by file, a
> production-shaped MCP server that exposes all three primitives — and the host that
> governs what a model is allowed to see of them.** Every chapter covers one file (or
> one coherent group): what it is, why it exists, the **complete source**, then a
> block-by-block explanation of how each block works, and how to prove it.

This is the companion to the
**[Basic Code guide](../../Basic%20Code/implementations%20guide/README.md)**. Basic Code
teaches the protocol. This guide teaches the protocol *plus* the responsibilities the
lecture says are now yours: choosing the resource, budgeting the context, caching it,
and authorising the read.

---

## Prerequisites

```bash
cd "Lecture 15/code/Production Code"
npm install
npm run typecheck     # tsc --noEmit — must exit 0 before you start
```

Runtime used for every output quoted in this guide:

```text
Node v24.22.0 · tsx 4.23.15 · tsc 5.9.3
@modelcontextprotocol/server 2.3.1 · @modelcontextprotocol/client 2.3.1 · @modelcontextprotocol/node 2.1.1
@modelcontextprotocol/express 2.0.2 · express 5.3.0 · zod 4.6.7
```

---

## The three commands you will use throughout

```bash
npm run lifecycle   # the whole flow, step by step, self-starting  ← start here
npm run server      # the MCP server alone, on http://127.0.0.1:8081/mcp
npm run host        # the HTTP host alone, on http://127.0.0.1:8080
```

`npm run lifecycle` prints 13 numbered steps. Step 3 is the one to read first, because it
is the entire lecture in three lines:

```text
3. intent      -> list_tasks (Tool) and task://backlog (Resource), side by side
   tools/call list_tasks      -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) …
   resources/read task://backlog -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) …
   identical payloads: YES — the same bytes. The difference is who decided to fetch
   them, not what came back.
```

That is not a coincidence and it is not a demo trick: `list_tasks` calls
`resources.read("task://backlog")`. One renderer, two owners. Which is exactly the point
of Chapter 02 of the notes — *the distinction between a Tool and a Resource cannot be
about the payload, because the payload is the same.* It is about **intent**.

---

## How each chapter is structured

Every chapter follows the same six-part shape, so you can follow along mechanically:

1. **File details** — path, layer, purpose, imports/exports, and the lecture section it
   implements.
2. **Commands** — the exact command(s) to exercise this piece in isolation.
3. **Full file** — the complete, verbatim source. Never a snippet.
4. **Block-by-block explanation** — the file split into numbered blocks; for each block,
   *what it does* and *how it works*.
5. **Run / verify** — the command and the output you should see.
6. **Checkpoint** — the two or three things to understand before moving on.

---

## Chapter map

Read top to bottom. The order is the order the code depends on itself:
**config → core → domain → services → the MCP layer → the host → the HTTP surface.**

| # | Guide chapter | File(s) covered | Lecture chapter |
| :---: | :--- | :--- | :--- |
| 01 | [Project Structure & File Map](./01_Project_Structure_and_File_Map.md) | whole project, `package.json`, `tsconfig.json`, `.env` | 01 / 03 |
| 02 | [Config: Validated Environment & Shared Vocabulary](./02_Config_Validated_Environment_and_Constants.md) | `src/config/env.ts`, `src/config/constants.ts` | 01 / 03 |
| 03 | [Core: Structured Logging & Redaction](./03_Core_Structured_Logging.md) | `src/core/logger.ts` | 08 |
| 04 | [Core: Metrics Without a Vendor](./04_Core_Metrics.md) | `src/core/metrics.ts` | 05 / 08 |
| 05 | [Core: The Error Taxonomy & the Wire Adapter](./05_Core_Error_Taxonomy_and_Wire_Adapter.md) | `src/core/errors.ts`, `src/mcp/protocol.ts` | 03 / 07 |
| 06 | [Core: Rate Limit, Timeout and the Context Budget](./06_Core_Guards_Rate_Timeout_Budget.md) | `src/core/guards.ts` | 02 / 05 / 07 |
| 07 | [Domain: The Task Store & Idempotency](./07_Domain_Task_Store.md) | `src/domain/taskStore.ts` | 04 |
| 08 | [Domain: The Resource Catalogue](./08_Domain_Resource_Catalogue.md) | `src/domain/resourceCatalogue.ts` | 03 / 04 |
| 09 | [Service: Validated Business Logic](./09_Service_Task_Service.md) | `src/services/taskService.ts` | 02 / 04 |
| 10 | [Service: Static, Dynamic and Templated Resources](./10_Service_Resource_Service.md) | `src/services/resourceService.ts` | 03 / 04 |
| 11 | [Service: Reusable Prompt Templates](./11_Service_Prompt_Service.md) | `src/services/promptService.ts` | 06 / 07 |
| 12 | [Service: How the Application Chooses a Resource](./12_Service_Selection_Service.md) | `src/services/selectionService.ts` | 05 |
| 13 | [MCP: The Wiring Contract](./13_Mcp_Wiring_Contract.md) | `src/mcp/deps.ts` | 01 |
| 14 | [MCP: The Tools Primitive](./14_Mcp_Tools.md) | `src/mcp/tools.ts` | 02 |
| 15 | [MCP: The Resources Primitive](./15_Mcp_Resources.md) | `src/mcp/resources.ts` | 03 / 04 |
| 16 | [MCP: The Prompts Primitive](./16_Mcp_Prompts.md) | `src/mcp/prompts.ts` | 06 / 07 |
| 17 | [MCP: Server Assembly](./17_Mcp_Server_Assembly.md) | `src/mcp/server.ts` | 01 / 08 |
| 18 | [Entry: The MCP Server over Streamable HTTP](./18_Entry_Mcp_Server_Http.md) | `src/index.ts` | 03 / 08 |
| 19 | [Host: The Client & Its Verb Wrappers](./19_Host_Client.md) | `src/host/client.ts` | 03 / 07 |
| 20 | [Host: Policy — Tools, Resources, Prompts](./20_Host_Policy.md) | `src/host/policy.ts` | 04 / 05 / 06 |
| 21 | [Host: Context Assembly](./21_Host_Context_Assembly.md) | `src/host/context.ts` | 02 / 05 / 08 |
| 22 | [Host: The Model Step & The Audit Trail](./22_Host_Model_and_Audit.md) | `src/host/model.ts`, `src/host/audit.ts` | 07 / 08 |
| 23 | [Host: The Wiring Contract](./23_Host_Wiring_Contract.md) | `src/host/deps.ts` | 04 |
| 24 | [Middleware: Request Context & Errors](./24_Middleware.md) | `src/middleware/requestContext.ts`, `src/middleware/errorHandler.ts` | 08 |
| 25 | [Controllers & Router](./25_Controllers_and_Router.md) | the four controllers, `src/routes/index.ts` | 08 |
| 26 | [The Lifecycle Walkthrough](./26_Lifecycle_Walkthrough.md) | `src/host/lifecycle.ts` | 08 |

---

## The build order, and why

```text
01 structure          → know the map before walking the streets
02 config/            → every knob validated once, at boot; the shared vocabulary of the
                        resource layer (schemes, MIME types, the truncation marker)
03 core/logger.ts     → stdout is the protocol channel, so every log line goes to stderr
04 core/metrics.ts    → counters and latency, including the numbers the SELECTION path needs
05 core/errors.ts     → the taxonomy, and how a failure keeps its class across a process
                        boundary — the difference between a 400 and a 503
06 core/guards.ts     → the three budgets. THE CONTEXT BUDGET IS THE ONE LECTURE 15 ADDS.
07 domain/taskStore   → state plus idempotency keys (a retry must not duplicate)
08 domain/catalogue   → the descriptor table: six Resources, described once, read by three
                        different layers without any of them reading content
09 services/taskService      → validated commands and typed facts. No prose.
10 services/resourceService  → the renderers, the cache, and template validation
11 services/promptService    → versioned templates. Cannot call a model.
12 services/selectionService → THE CHAPTER-05 FILE: five strategies, ACL before ranking
13 mcp/deps.ts        → the wiring contract, so primitives are testable without a transport
14 mcp/tools.ts       → the MODEL's primitive, and the identity with task://backlog
15 mcp/resources.ts   → the APPLICATION's primitive: static, dynamic, templated
16 mcp/prompts.ts     → the USER's primitive, and proof that the server needs no LLM
17 mcp/server.ts      → createServer(): capabilities, instructions, composition root
18 index.ts           → binds the assembled server to Streamable HTTP + the two validators
19 host/client.ts     → one function per verb, with cursor-following pagination
20 host/policy.ts     → tool tiers · resource ACL · prompt allowlist
21 host/context.ts    → select → authorise → read → budget → fence → log the why
22 host/model+audit   → THE ONLY MODEL CALL, and the record of every decision
23 host/deps.ts       → the wiring contract the four controllers share
24 middleware/        → request id, session, access log, AppError → HTTP
25 controllers+routes → the host's surface, and the router that is only a router
26 host/lifecycle.ts  → the scripted walkthrough: the control model, made visible
```

> **Note on chapter numbering.** This guide numbers chapters by *file/build order*
> (Chapter 01 is the file-structure overview). The "Lecture chapter" column maps each
> guide chapter back to the corresponding chapter in
> [`../../../notes`](../../../notes/README.md).

---

## The four ideas this guide keeps coming back to

**1. The application chooses the resource, not the model.** The model can *call* a tool;
it cannot *fetch* a resource, because nothing in `resources/read` is triggered by the
model. So if the application does not fetch it, the model never sees it. That makes
selection — Chapter 12 — a correctness problem, not a convenience.

**2. Context is a budget you own.** Chapter 06 implements three caps in a fixed order
(count → per-body → total). Truncation is never silent, because a model that does not know
it received a fragment will reason about the fragment as if it were the whole.

**3. A capability flag is a promise.** `src/mcp/server.ts` declares only what it answers.
There is no `resources/subscribe`, so the flag is absent. A host that trusts a flag it
cannot use fails in a way it cannot diagnose.

**4. A failure keeps its class across the wire.** Chapter 05 is the file most likely to be
skipped and the one most likely to be missed later. Without it, a missing prompt argument
and a crashed backend both arrive as "something went wrong" and both get answered `503` —
inviting a caller to retry something no retry can fix.

---

## Verification, reproduced

Every output quoted in this guide came from running the code in this directory.

| Check | Command | Expected |
| :--- | :--- | :--- |
| Types | `npm run typecheck` | exit **0** |
| Full flow | `npm run lifecycle` | 13 steps, exit **0** |
| Tool/Resource identity | `npm run lifecycle` step 3 | `identical payloads: YES — the same bytes` |
| The ACL | `npm run lifecycle` step 7 | same URI, three sessions, two answers |
| Five strategies | `npm run lifecycle` step 8 | `user`, `state`, `rule`, `retrieval` all fire |
| The budget | `npm run lifecycle` step 9 | 3 in, 2 kept, 1 dropped, 2 truncated |
| Readiness | `curl :8080/health` | `9 resources · 3 templates · 3 prompts · 4 tools` |
| End-to-end | `curl ':8080/plan?hours=4'` | 3 steps, `answer.source: offline` |
| Unknown prompt | `curl ':8080/prompt?name=nope'` | **404** |
| Missing argument | `curl ':8080/prompt?name=plan_day'` | **400** |
| Unknown URI | `curl ':8080/read?uri=task://nope'` | **404** |
| Another user's data | `curl ':8080/read?uri=user://456/profile'` | **403** |
| Own data | `curl -H 'x-actor: 456' ':8080/read?uri=user://456/profile'` | **200** |

A `Makefile`-free reproduction of the last six, with the server running:

```bash
npm run server &
npm run host &
sleep 3

for url in \
  'http://127.0.0.1:8080/health' \
  'http://127.0.0.1:8080/resources' \
  'http://127.0.0.1:8080/read?uri=task://summary' \
  'http://127.0.0.1:8080/prompts' \
  'http://127.0.0.1:8080/plan?hours=4' ; do
  printf '%-52s -> %s\n' "$url" "$(curl -s -o /dev/null -w '%{http_code}' "$url")"
done

printf '%-52s -> %s\n' 'read?uri=user://456/profile' \
  "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8080/read?uri=user://456/profile')"
printf '%-52s -> %s\n' 'prompt?name=plan_day' \
  "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8080/prompt?name=plan_day')"
printf '%-52s -> %s\n' 'prompt?name=nope' \
  "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8080/prompt?name=nope')"
```

---

## How to read a chapter

Each chapter opens with a **file details** table. Use the *Layer* row to place the file:
`config` and `core` know nothing about MCP; `domain` and `services` know nothing about
transports; `mcp` and `host` are where the protocol appears; `controllers`, `middleware`
and `routes` are the HTTP binding.

That ordering is not decoration. It is what makes the same `createServer()` work behind
Streamable HTTP here and STDIO with three lines changed (see the main
[README](../README.md#swapping-the-transport)) — and it is what lets the lifecycle
walkthrough drive the real pipeline instead of a mock.

---

**[← Production Code README](../README.md)** ·
**[Basic Code guide →](../../Basic%20Code/implementations%20guide/README.md)** ·
**[Lecture 15 notes →](../../notes/README.md)**
