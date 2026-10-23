# Lecture 15 — MCP Server: Resources and Prompts (Production Code)

> **The same three primitives as [Basic Code](../Basic%20Code/README.md), built the way
> a service is built.** One MCP **server** exposing **Tools** (*do*), **Resources**
> (*know*) and **Prompts** (*reuse*), plus a **host** that discovers the catalogue and
> then decides — with a session-scoped ACL, five selection strategies, three context
> budgets and a real error taxonomy — what the model is actually allowed to see.

**Runs offline, with no API key.** Leave `OPENAI_API_KEY` empty and the host prints
*exactly* what it would have sent to a model, so the whole Resource and Prompt half of
the protocol is reproducible on any machine.

```bash
cd "Lecture 15/code/Production Code"
npm install

npm run lifecycle     # the whole flow, step by step  ← start here
npm run server        # the MCP server alone, on http://127.0.0.1:8081/mcp
npm run host          # the HTTP host alone, on http://127.0.0.1:8080
npm run typecheck     # tsc --noEmit
```

---

## What this adds over Basic Code

Basic Code teaches the protocol. This teaches the protocol **plus the four things the
lecture says are now your problem**, because MCP standardises communication and removes
nothing else:

| Concern | Notes | What the code does about it |
| :--- | :--- | :--- |
| **The application chooses the resource** | Ch05 | `services/selectionService.ts` — all five strategies, each recording *why* it fired |
| **Context is a budget you own** | Ch02, Ch05 | `core/guards.ts` — three caps (count, per-body, total) with explicit truncation |
| **Resources are read repeatedly** | Ch04 | `services/resourceService.ts` — process/TTL/no caching, invalidated on every write |
| **Authorisation lives in the handler** | Ch04 | `host/policy.ts` — a session-scoped ACL over the catalogue, run *before* every read |

And the responsibilities Lecture 14 established, carried forward unchanged: validated
config, structured logging, metrics, an error taxonomy, rate limits, timeouts,
idempotency, a consent gate, an audit trail with hashed arguments, and a host that
treats discovery as an inventory rather than a grant.

---

## `npm run lifecycle` — the flow, printed

The walkthrough starts the server itself, then drives the same pipeline the HTTP host
runs, printing the intermediate state at every step. Excerpts from a real run:

```text
1. handshake   -> capabilities are negotiated, not guessed
   server       task-mcp-server v1.0.0
   capabilities completions, logging, prompts, resources, tools
   model        offline — the pipeline runs without one, and that is a feature

2. tools/list  -> 4 discovered, 4 shown to the model
   auto     create_task     no destructive hint
   auto     list_tasks      readOnlyHint is set
   auto     complete_task   no destructive hint
   confirm  delete_task     destructiveHint is set: irreversible, so it needs explicit consent

3. intent      -> list_tasks (Tool) and task://backlog (Resource), side by side
   tools/call list_tasks      -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) …
   resources/read task://backlog -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) …
   identical payloads: YES — the same bytes. The difference is who decided to fetch
   them, not what came back.
```

Step 3 is the whole lecture in three lines. A Tool and a Resource return **byte-identical
text**, because in this codebase they literally call the same renderer. Nothing about the
payload distinguishes them — which is exactly why the distinction cannot be about the
payload. It is about **intent** (Notes Ch02 §2.3).

```text
7. the ACL     -> the same URI, judged by three different sessions
   actor 123   admin=false -> REFUSED  "user-profile" belongs to another user and the session is not an admin
   actor 456   admin=false -> ALLOWED  "user-profile" belongs to the session's own user
   actor 123   admin=true  -> ALLOWED  session is an admin, so "user-profile" is readable

8. selection   -> the application chooses, and every choice carries its reason
   "what is on my plate"
      strategies=[state, retrieval] candidates=2
      chosen: task://projects/fde ← state; task://backlog ← retrieval
   "show me task 2"
      strategies=[state, rule, retrieval] candidates=5
      chosen: task://tasks/2 ← rule; task://projects/fde ← state; task://backlog ← retrieval
   "show me task 2" + the user attached task://summary
      strategies=[user, state, rule, retrieval] top=task://summary (score 1) — an explicit
      choice beats every guess

9. the budget  -> cap the count, cap each body, cap the total — and say so
   limits {"maxResources":2,"maxResourceChars":120,"maxContextChars":200}
   kept 2 block(s), 200 chars, dropped [task://summary]
      task://guidelines    truncated=true  310 -> 174 chars
      task://backlog       truncated=true  191 -> 79 chars
   [truncated: showing the first 120 of 310 characters]
```

```text
11. GET /plan?hours=4 -> one request, three primitives, three owners
   USER      -> prompts/get plan_day { availableHours: 4 }
   APP       -> selected [state, retrieval] task://projects/fde, task://backlog, task://guidelines (635 chars of 40000)
   MODEL     -> offline: no key, so the assembled request is echoed

12. audit      -> who asked for what, what the host decided, and how it ended
   time         action    target                  decision  outcome  argsHash          ms
   18:17:34.908 prompt    plan_day                allowed   ok       32beeaa846e8d86e  0
   18:17:34.929 resource  task://projects/fde     allowed   ok       23bf90ec7c709d0d  0
   18:17:34.929 resource  task://backlog          allowed   ok       c833edcfbb48c145  0
   18:17:34.929 resource  task://guidelines       allowed   ok       096a7e6630b48696  0
   18:17:34.929 tool      list_tasks              auto      ok       44136fa355b3678a  0
   (arguments are hashed, never stored; resource content is never recorded at all)
```

---

## The HTTP host

`npm run server` + `npm run host`, then:

| Route | What it is |
| :--- | :--- |
| `GET /` | the index — what this host offers, for a human who just curled it |
| `GET /health` | readiness, **proven** by a round trip to `tools/list` (503 if it fails) |
| `GET /metrics` | the in-process counters and latencies |
| `GET /resources` | the catalogue: instances and templates, metadata only |
| `GET /read?uri=…` | one Resource, ACL-checked **before** the read |
| `GET /prompts` | the menu, with each argument's shape |
| `GET /prompt?name=…&…` | one Prompt rendered — **no model is called** |
| `GET /plan?hours=4` | the lecture's end-to-end request |
| `GET /ask?message=…` | the same pipeline with the user's own words |

Session comes from headers so the whole thing is exercisable with `curl` — a real
deployment reads an authenticated session instead, and that substitution is stated
rather than hidden:

| Header | Meaning |
| :--- | :--- |
| `x-actor` | the user id this session acts as (default `123`) |
| `x-projects` | comma-separated project scope, e.g. `fde,media` |
| `x-admin` | `true` to allow reading another user's profile |

```bash
curl -s 'http://127.0.0.1:8080/read?uri=task://summary'
curl -s -H 'x-actor: 456' 'http://127.0.0.1:8080/read?uri=user://456/profile'
curl -s 'http://127.0.0.1:8080/read?uri=user://456/profile'      # 403 — not your profile
curl -s 'http://127.0.0.1:8080/plan?hours=4'
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day'              # 400 — argument missing
curl -s 'http://127.0.0.1:8080/prompt?name=nope'                  # 404 — unknown prompt
```

---

## The file map

Two composition roots, because this is two processes: a **capability provider** and the
**host** that governs it. Both are built from the same layers, in the same direction.

```text
src/
├── index.ts                        # MCP SERVER entry: Streamable HTTP on :8081
│
├── config/
│   ├── env.ts                      # every knob, validated once, at boot
│   └── constants.ts                # URI schemes, MIME types, the truncation marker
├── core/                           # transport-agnostic. Imports no SDK.
│   ├── logger.ts                   # one JSON object per line, to stderr, with redaction
│   ├── errors.ts                   # the taxonomy, the JSON-RPC mapping, and recovery sentences
│   ├── metrics.ts                  # counters and latency, with a `time()` wrapper
│   └── guards.ts                   # rate limit · timeout · THE CONTEXT BUDGET
├── domain/
│   ├── taskStore.ts                # state + idempotency. The seam a real store replaces.
│   └── resourceCatalogue.ts        # the descriptor table: what exists, and who may read it
├── services/
│   ├── taskService.ts              # validated commands, typed facts. No prose.
│   ├── resourceService.ts          # renderers + caching + template validation
│   ├── promptService.ts            # versioned templates. Cannot call a model.
│   └── selectionService.ts         # the five strategies, the ACL filter, the ranking
├── mcp/                            # the SERVER side of the protocol
│   ├── deps.ts                     # the wiring contract the three registrars share
│   ├── protocol.ts                 # failure class ⇄ JSON-RPC code, on the way out
│   ├── tools.ts                    # Tools — the MODEL holds the trigger
│   ├── resources.ts                # Resources — the APPLICATION holds it
│   ├── prompts.ts                  # Prompts — the USER holds it
│   └── server.ts                   # createServer(): the composition root
│
├── host/                           # the APPLICATION side
│   ├── client.ts                   # one function per verb, with cursor-following pagination
│   ├── policy.ts                   # tool tiers · resource ACL · prompt allowlist
│   ├── context.ts                  # select → authorise → read → budget → fence → log
│   ├── model.ts                    # THE ONLY MODEL CALL IN THE PROJECT
│   ├── audit.ts                    # three primitives, hashed arguments, no content
│   ├── deps.ts                     # the wiring contract the four controllers share
│   └── lifecycle.ts                # the scripted walkthrough (`npm run lifecycle`)
├── controllers/                    # the host's HTTP surface
│   ├── healthController.ts         # /  /health  /metrics
│   ├── resourceController.ts       # /resources  /read
│   ├── promptController.ts         # /prompts  /prompt
│   └── planController.ts           # /plan  /ask   ← the lecture's request
├── middleware/
│   ├── requestContext.ts           # request id, session, access log, timing
│   └── errorHandler.ts             # AppError → HTTP, with the stack kept in the log
└── routes/
    └── index.ts                    # HOST entry: the composition root, then the router
```

---

## Design highlights

**The same payload, two owners.** `list_tasks` calls `resources.read("task://backlog")`.
Not a copy of the renderer — the renderer. If the two ever disagree, the lifecycle prints
`NO — the renderers have drifted`, and that assertion is the point.

**One catalogue, three readers.** `domain/resourceCatalogue.ts` is a table of six
descriptors. `resourceService` renders from it, `selectionService` ranks it, and
`host/policy.ts` authorises against it — none of them reads a Resource to answer a
question *about* Resources.

**The budget has three stages, in a fixed order:** cap the count → cap each body → cap
the total. Each removes a different failure, and truncation is never silent: a marker
tells the model it received a fragment.

**Authorisation runs before the read, twice.** The selector filters the catalogue by ACL
*so that ranking cannot leak*, and the read path checks again *because the read is what
touches data*. Belt and braces, in that order, for two different reasons.

**A failure keeps its class across the process boundary.** The server encodes the failure
class in the JSON-RPC error code and its recovery sentence in `data`; the host reads both
back. Without that, a missing prompt argument and a crashed backend are indistinguishable,
and both get answered `503` — inviting a caller to retry something no retry can fix.

**A host that can predict a failure predicts it.** An unknown prompt is a `404` decided
from the host's own cached menu, not inferred from the server's error. The SDK reports
`InvalidParams` for an unknown prompt name, which is indistinguishable from a bad
argument — so the host does not try.

**`prompts/get` cannot call a model.** The `openai` import is a dynamic `import()` in
`host/model.ts` and nowhere else. A server that cannot import a model client cannot
accidentally call one, and the server process has no API key in scope at all.

**The two personal-data resources are deliberately un-enumerable.** `user://{userId}/profile`
has no `list` and no `complete` handler, because enumerating every profile — or offering
the set of user ids while someone types one — is an enumeration oracle (Notes Ch04 §4.8).

---

## What was verified, and how

Every number below came from running the code in this directory.

| Check | Command | Result |
| :--- | :--- | :--- |
| Types | `npm run typecheck` | `tsc --noEmit` exits **0** |
| Full flow | `npm run lifecycle` | 13 numbered steps, exit **0** |
| Capability negotiation | `npm run lifecycle` step 1 | `completions, logging, prompts, resources, tools` |
| Tool/Resource identity | `npm run lifecycle` step 3 | `identical payloads: YES — the same bytes` |
| The ACL | `npm run lifecycle` step 7 | the same URI, three sessions, two answers |
| Five strategies | `npm run lifecycle` step 8 | `user`, `state`, `rule`, `retrieval` all fire; `llm` is injected |
| The budget | `npm run lifecycle` step 9 | 3 blocks in, 2 kept, 1 dropped, 2 truncated, marker present |
| Readiness | `GET /health` | `9 resources · 3 templates · 3 prompts · 4 tools` |
| End-to-end | `GET /plan?hours=4` | 3 steps, 635 chars of context, `answer.source: offline` |
| Unknown prompt | `GET /prompt?name=nope` | **404** `NOT_FOUND`, with the menu in `recovery` |
| Missing argument | `GET /prompt?name=plan_day` | **400** `INVALID_INPUT`, naming `availableHours` |
| Unknown URI | `GET /read?uri=task://nope` | **404** `NOT_FOUND` |
| Another user's data | `GET /read?uri=user://456/profile` | **403** `FORBIDDEN` |
| Own data | `GET /read?uri=user://456/profile` + `x-actor: 456` | **200** |
| Admin override | same URI + `x-admin: true` | **200** |
| Malformed template variable | `GET /read?uri=task://tasks/abc` | **400** `INVALID_INPUT`, with the server's recovery sentence |

---

## Honest limits — documented rather than hidden

- **State is in-process.** The task store is a `Map`. The interface is the seam a real
  store replaces; nothing above `domain/` imports it directly.
- **`resources/subscribe` is not declared.** The server advertises only what it answers,
  and the high-level `McpServer` registers no `resources/subscribe` handler. A capability
  flag that promises something the server cannot do is worse than a missing feature,
  because the host has no way to find out except by failing.
- **Strategy 4 (LLM routing) is injected, not wired.** `selectionService` accepts a
  `ResourceRouter` and enforces the rule that it may only choose from the shortlist it was
  shown — but the walkthrough does not pass one, because doing so would need a model inside
  the selection path. That is the trade-off Notes Ch05 §5.5 warns about, made explicit.
- **The ACL is header-driven.** A real host reads an authenticated session. The header is
  a stand-in so the whole surface is exercisable with `curl`.
- **The server's scheme allowlist is defence in depth, not the first gate.** The SDK's own
  router rejects an unknown URI before a handler runs, so `file:///etc/passwd` never
  reaches the scheme check. The allowlist still matters: it is what stops a *registered*
  descriptor from being served under a scheme this deployment did not intend.
- **The consent gate in the HTTP host denies by default.** It is never reached in normal
  operation, because the HTTP surface reads Resources and renders Prompts and does not
  invoke tools. The scripted gate used by `npm run lifecycle` is the one that exercises
  both branches.
- **The cache is invalidated by the write path, not by a TTL alone.** Every mutating tool
  calls `resources.invalidate()`. That is correct and simple for one process; a
  multi-process deployment would need `notifications/resources/list_changed` instead.

---

## Inspecting by hand

```bash
# the raw protocol: paste newline-delimited JSON-RPC on stdin
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}' \
  | npx tsx src/index.ts

# browse it with a UI
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

To watch the config guard fire:

```bash
MCP_MAX_RESOURCE_CHARS=99999999 npm run server
# [config] refusing to start — invalid environment:
#   - MCP_MAX_RESOURCE_CHARS: must not exceed MCP_MAX_CONTEXT_CHARS, or the per-resource cap can never bind
```

To see the policy branch where a destructive tool is never shown to the model at all:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run lifecycle
# 2. tools/list  -> 4 discovered, 3 shown to the model
#    denied   delete_task     destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false
```

---

## Swapping the transport

`src/index.ts` is the only transport-aware file on the server side. Streamable HTTP is
this binding; STDIO is another, and `createServer()` does not change at all:

```ts
// Notes Ch03 — the same server behind a different door.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./mcp/server.js";

serveStdio(createServer);
```

That is Chapter 01 in practice: the host depends on the *protocol*, the server on its
*backend*, and nothing depends on a vendor — so the binding is a detail, not a rewrite.

---

**Build it chapter by chapter:** **[`implementations guide/`](./implementations%20guide/README.md)** —
25 chapters, each with the complete source of every file and a block-by-block explanation
of how it works.
