# Chapter 01 — Project Structure & File Map

> **Read this chapter first.** It is the map: where every file lives, which layer it
> belongs to, and — most importantly — **which direction the imports are allowed to
> point**. Every later chapter assumes you know the map, and most of the design decisions
> in this codebase are really decisions about *which layer is allowed to know what*.

---

## File details

| | |
| :--- | :--- |
| **Files covered** | `package.json`, `tsconfig.json`, `.env` |
| **Layer** | project metadata / toolchain |
| **Purpose** | Declare the two entry points, pin the dependency set, and fix the compiler rules that make the rest of the code safe. |
| **Lecture sections** | Ch01 §1.1–1.4 (what MCP standardises, and what it does not), Ch03 §3.1–3.3 (transport bindings), Ch08 (production hardening). |
| **Runs** | `npm install`, `npm run typecheck` |

---

## The shape of the thing: two processes

This project is deliberately **two programs that never import each other**:

```text
┌────────────────────────────────────────────┐        ┌──────────────────────────────────────────┐
│  MCP SERVER            src/index.ts        │        │  HOST            src/routes/index.ts     │
│  http://127.0.0.1:8081/mcp                 │        │  http://127.0.0.1:8080                   │
│                                            │        │                                          │
│  owns:   Tools      Resources    Prompts   │◀───────│  owns:   discovery, ACL, selection,      │
│          taskStore  catalogue    templates  │  MCP   │          budgets, caching policy,        │
│                                            │ over   │          the model call, the audit log   │
│  exposes: capability                       │  HTTP  │                                          │
│           providers                        │        │  exposes: 9 HTTP routes for humans       │
└────────────────────────────────────────────┘        └──────────────────────────────────────────┘
                    │                                                     │
        no API key in scope at all                        the ONLY file that imports `openai`
                                                          is src/host/model.ts
```

That split is the whole point of Lecture 15's framing. The server is a **capability
provider**: it says what exists and answers questions about it. The host is the
**application**: it decides what the model gets to see. Collapsing them into one process
would make the demo shorter and the lesson invisible — because the interesting decisions
(Ch04's authorisation, Ch05's selection, the context budget) all live on the host side and
would be indistinguishable from "the server did it".

Two consequences worth noticing now:

1. **The server cannot call a model.** `openai` is imported in exactly one file,
   `src/host/model.ts`, and dynamically. There is no API key in the server's environment
   handling at all. This is the structural proof of Ch07's rule that `prompts/get` returns
   *text*, not a completion.
2. **The host treats discovery as an inventory, not a grant.** `tools/list` returns four
tools; the host shows the model three, because `delete_task` carries a destructive hint.
   Nothing in the protocol enforces that — it is the host's job, and it lives in
   `src/host/policy.ts`.

---

## The complete file map

33 TypeScript files, 6,275 lines. Laid out by layer, in dependency order:

```text
src/
├── index.ts                          # SERVER ENTRY. Streamable HTTP on :8081 + 2 validators.
│
├── config/
│   ├── env.ts                        # Every knob, validated once, at boot. Exits on bad input.
│   └── constants.ts                  # URI schemes, MIME types, truncationMarker, contextFence.
│
├── core/                             # Transport-agnostic. Imports NO SDK. Pure infrastructure.
│   ├── logger.ts                     # One JSON object per line, to stderr, with redaction.
│   ├── errors.ts                     # The taxonomy + JSON-RPC codes + recovery sentences.
│   ├── metrics.ts                    # Counters and latency, with a time() wrapper.
│   └── guards.ts                     # RateLimiter, withTimeout, createContextBudget.
│
├── domain/                           # State and description. No prose, no protocol.
│   ├── taskStore.ts                  # The data + idempotency keys + maxTasks.
│   └── resourceCatalogue.ts          # Six descriptors, compileTemplate, resolve.
│
├── services/                         # Business logic. Still no protocol.
│   ├── taskService.ts                # Validated commands, typed facts. No prose.
│   ├── resourceService.ts            # static / dynamic / template renderers, TTL cache.
│   ├── promptService.ts              # Three versioned templates. Cannot call a model.
│   └── selectionService.ts           # The five strategies + ACL-before-ranking + bindUri.
│
├── mcp/                              # THE SERVER SIDE OF THE PROTOCOL
│   ├── deps.ts                       # The wiring contract the three registrars share.
│   ├── protocol.ts                   # Failure class ⇄ JSON-RPC code, on the way out.
│   ├── tools.ts                      # Tools — the MODEL holds the trigger.
│   ├── resources.ts                  # Resources — the APPLICATION holds it.
│   ├── prompts.ts                    # Prompts — the USER holds it.
│   └── server.ts                     # createServer(): capabilities + composition root.
│
├── host/                             # THE APPLICATION SIDE
│   ├── client.ts                     # 7 verbs, each with cursor-following pagination.
│   ├── policy.ts                     # Tool tiers · resource ACL · prompt allowlist.
│   ├── context.ts                    # select → authorise → read → budget → fence → log.
│   ├── model.ts                      # THE ONLY MODEL CALL IN THE PROJECT.
│   ├── audit.ts                      # Three primitives, hashed args, never any content.
│   ├── deps.ts                       # The wiring contract the four controllers share.
│   └── lifecycle.ts                  # The scripted walkthrough (npm run lifecycle).
│
├── controllers/                      # THE HOST'S HTTP SURFACE
│   ├── healthController.ts           # GET /  /health  /metrics
│   ├── resourceController.ts         # GET /resources  /read
│   ├── promptController.ts           # GET /prompts  /prompt
│   └── planController.ts             # GET /plan  /ask        ← the lecture's request
│
├── middleware/
│   ├── requestContext.ts             # request id, session, access log, timing.
│   └── errorHandler.ts               # AppError → HTTP status, stack kept in the log only.
│
└── routes/
    └── index.ts                      # HOST ENTRY. Composition root, then the router.
```

### The dependency rule

Arrows point **down only**. A file may import from a layer below it, never from a layer
above it, and never sideways within `mcp/` and `host/` (which is what `deps.ts` in each is
for).

```text
                    index.ts            routes/index.ts
                        │                      │
                        ▼                      ▼
                      mcp/                   host/
                        │                      │
                        ▼                      ▼
                    services/ ◀──── both use these ────▶ services/
                        │
                        ▼
                     domain/
                        │
                        ▼
                      core/  ──▶  config/
```

Why it matters, concretely:

| Rule | Enforced by | Buys you |
| :--- | :--- | :--- |
| `core/` never imports the MCP SDK | nothing imports `@modelcontextprotocol/*` outside `mcp/` and `host/` | The budget, the rate limiter and the error taxonomy are unit-testable and reusable. |
| `domain/` and `services/` never import a transport | no `hono`, no `@hono/node-server`, no SDK | `createServer()` can be bound to STDIO or HTTP with three lines changed. |
| `mcp/` and `host/` never import each other | they are separate processes with separate `deps.ts` | The server genuinely cannot know what the host decides, so the host's decisions are real. |
| `host/` reaches `services/` only through the wire | `src/host/client.ts` speaks JSON-RPC | The host cannot cheat by calling a service directly — what the demo shows is what a real deployment does. |

---

## `package.json` — the two entry points and the pinned dependency set

```json
{
  "name": "lecture-15-mcp-resources-and-prompts-production",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 15 — MCP Server: Resources and Prompts (Production Code). A production-shaped MCP server exposing Tools (model-controlled), Resources (application-controlled) and Prompts (user-controlled) — with validated config, structured logging, metrics, an error taxonomy, execution guards, a five-strategy resource selection engine, context budgets, caching, an audit trail, and a layered host (controllers / middleware / routes) that serves GET /plan?hours=4.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "server": "tsx src/index.ts",
    "host": "tsx src/routes/index.ts",
    "lifecycle": "tsx src/host/lifecycle.ts",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "keywords": [
    "fde",
    "mcp",
    "model-context-protocol",
    "resources",
    "resource-templates",
    "prompts",
    "tools",
    "context-engineering",
    "production",
    "observability",
    "typescript"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "@hono/node-server": "^1.19.17",
    "@modelcontextprotocol/client": "^2.3.1",
    "@modelcontextprotocol/node": "^2.1.1",
    "@modelcontextprotocol/server": "^2.3.1",
    "dotenv": "^16.4.7",
    "hono": "^4.13.13",
    "openai": "^6.0.0",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.13.8",
    "tsx": "^4.23.15",
    "typescript": "^5.9.3"
  }
}
```

### Block-by-block

**`"type": "module"` (line 6).** The project is ESM. This is not cosmetic: the MCP SDK is
ESM-only, and with `"module": "NodeNext"` in `tsconfig.json` it also forces every relative
import in this codebase to carry a `.js` extension (`./mcp/server.js`) even though the
source file is `server.ts`. That looks wrong the first time and is correct — it is how
TypeScript types a Node ESM import. If you forget one, `npm run typecheck` fails with
"cannot find module", which is the good outcome.

**`"engines": { "node": ">=20.0.0" }` (lines 7–9).** Node 20 is where the SDK's fetch-based
transports and `AbortSignal.timeout` are dependable. It is a statement, not an enforcement —
npm only warns. The real guard is `npm run typecheck` plus the fact that `tsx` will not
load on anything older.

**The five scripts (lines 10–16).**

| Script | Command | What it is for |
| :--- | :--- | :--- |
| `npm run server` | `tsx src/index.ts` | The **MCP server alone**, on `:8081`. It starts the HTTP transport and serves `/mcp`. Nothing else — no routes, no host logic. Useful for pointing the MCP Inspector at it. |
| `npm run host` | `tsx src/routes/index.ts` | The **HTTP host alone**, on `:8080`. It *connects* to a server that must already be running. |
| `npm run lifecycle` | `tsx src/host/lifecycle.ts` | **Start here.** This script *starts its own server child process*, connects a client to it, and drives the whole pipeline with printed intermediate state. It needs no other process running. |
| `npm run dev` | `tsx watch src/index.ts` | Restart the server on file change. |
| `npm run typecheck` | `tsc --noEmit` | Types only, no output. Run this after every chapter. |

The `lifecycle` / `server` + `host` split is worth internalising. `lifecycle` is the
**teaching** path: self-contained, prints everything, exits. `server` + `host` is the
**operating** path: two processes, real HTTP, so you can curl it.

**The dependency set (lines 32–46).** Eight runtime dependencies, and each one is load
bearing:

| Package | Role | Where it appears |
| :--- | :--- | :--- |
| `@modelcontextprotocol/server` | `McpServer`, the transports, the request router | `src/mcp/*`, `src/index.ts` |
| `@modelcontextprotocol/client` | `Client`, the session | `src/host/client.ts`, `src/host/lifecycle.ts` |
| `@modelcontextprotocol/node` | Node bindings for the HTTP transport (request/response adapters) | `src/index.ts` |
| `hono` | The HTTP framework for the host's nine routes | `src/routes/index.ts`, controllers |
| `@hono/node-server` | Binds Hono to `node:http` | `src/routes/index.ts` |
| `zod` | Every input schema — tool args, prompt args, env vars, template variables | throughout |
| `dotenv` | Loads `.env` in the two entry points | `src/config/env.ts` |
| `openai` | The model client | **`src/host/model.ts` only**, via dynamic `import()` |

Note what is *absent*: no test runner, no linter, no build step. `tsx` executes TypeScript
directly, and `tsc --noEmit` is the entire verification story. That is deliberate for a
teaching codebase — every dependency you add is one more thing between the reader and the
protocol — but the `typecheck` script is not optional, because it is the only mechanical
check the project has.

**Why `openai` is a runtime dependency even though the project runs offline.** Because
`src/host/model.ts` imports it *dynamically*, inside the branch that runs only when
`OPENAI_API_KEY` is set. `npm install` installs it; the process never loads it unless there
is a key. That is what lets `npm run lifecycle` work on a machine with no credentials while
still being the real code path.

---

## `tsconfig.json` — the compiler rules that make the rest safe

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Block-by-block

**`"target": "ES2022"`, `"lib": ["ES2022"]`.** Node 20+ runs ES2022 natively, so nothing is
down-levelled and nothing is polyfilled. `lib` is set explicitly rather than left to
include the DOM: if `fetch` or `AbortSignal` is available it is because Node provides it,
and a file that accidentally relies on a browser global fails at typecheck instead of at
runtime.

**`"module": "NodeNext"`, `"moduleResolution": "NodeNext"`.** The strictest correct pairing
for ESM on Node. Two consequences you will see throughout the codebase:

- Relative imports end in `.js` (`import { createServer } from "./mcp/server.js"`).
- Package imports resolve through `exports` maps, so `@modelcontextprotocol/server` gives
you the root export and nothing deeper.

**`"strict": true`.** Turns on the whole family — `strictNullChecks`, `noImplicitAny`,
`strictFunctionTypes`, `useUnknownInCatchVariables`, and the rest. The one that earns its
keep here is `useUnknownInCatchVariables`: every `catch (error)` in this project binds
`unknown`, which is why `toAppError()` in `src/core/errors.ts` exists and why error handling
is uniform instead of a scattering of `(error as Error).message`.

**`"noUncheckedIndexedAccess": true` — the rule that shapes this codebase the most.**
With it on, `array[0]` has type `T | undefined` and `record[key]` has type `V | undefined`.
TypeScript will not let you index into anything without acknowledging that the key might
not be there.

That is not pedantry in an MCP server, because MCP is **mostly lookup**: a URI against a
catalogue, a prompt name against a menu, a strategy name against an implementation, a task
id against a store. Every one of those is a place where "not found" is a real, common,
client-triggerable outcome — and every one of them is a place where an unchecked index
would turn a `404` into a `TypeError`. You will see the pattern in the code:

```ts
const descriptor = catalogue.find((entry) => entry.uriTemplate === uri);
if (!descriptor) {
  throw new ResourceError("NOT_FOUND", `No resource is registered for ${uri}`);
}
// from here on, `descriptor` is narrowed to non-undefined
```

Notice that the compiler *forces* the `if (!descriptor)` branch to exist. That branch is
where the recovery sentence lives, which is why this codebase's error messages are so
uniform: they are the same shape because the same compiler rule demanded them.

**`"noImplicitOverride": true`.** Subclassing `AppError` in `src/core/errors.ts` — every
subclass must say `override` explicitly. Cheap, and it catches a whole class of silent
mistakes when a base class grows a method.

**`"noFallthroughCasesInSwitch": true`.** The selection engine and the error classifier are
both `switch`-heavy. This makes a forgotten `break` a compile error rather than a subtle
wrong-answer bug.

**`"exactOptionalPropertyTypes": false`.** Deliberately off. With it on, `{ foo?: string }`
and `{ foo: string | undefined }` become different types, which fights with the MCP SDK's
optional result fields and with the way this codebase builds result objects incrementally.
It is a real strictness win in a closed codebase and a real friction cost against a
third-party type surface; this project takes the friction.

**`"declaration": true`, `"sourceMap": true`, `"resolveJsonModule": true`.** The build is
unused in practice (`tsx` runs the source), but declaring them means `npm run build`-style
emission would work if someone wanted it, and `resolveJsonModule` lets a future version
read a JSON fixture without a loader.

---

## `.env` — the knobs, grouped by the decision they control

```bash
# Working copy of `.env.example` — every value is validated at boot by
# `src/config/env.ts`. See `.env.example` for the full commentary.

MCP_SERVER_NAME=task-mcp-server
MCP_SERVER_VERSION=1.0.0

MCP_SERVER_PORT=8081
MCP_HOST_PORT=8080
MCP_SERVER_URL=http://127.0.0.1:8081/mcp

MCP_LOG_LEVEL=info

MCP_TOOL_TIMEOUT_MS=5000
MCP_RESOURCE_TIMEOUT_MS=2000
MCP_RATE_LIMIT_PER_MINUTE=60

MCP_MAX_RESOURCES_PER_REQUEST=3
MCP_MAX_RESOURCE_CHARS=20000
MCP_MAX_CONTEXT_CHARS=40000

MCP_RESOURCE_CACHE_TTL_MS=30000

MCP_ALLOWED_RESOURCE_SCHEMES=task,user

MCP_MAX_TASKS=1000

MCP_HOST_ALLOW_DESTRUCTIVE=true
MCP_HOST_REQUIRE_CONSENT=true
MCP_HOST_ALLOWED_PROMPTS=

OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
```

`MCP_HOST_ALLOWED_PROMPTS=` is empty on purpose: empty means **every** prompt the server
advertises is available. The prompt allowlist only becomes a filter once you put something
in it. You will meet it in Chapter 20.

### Block-by-block: what each group of knobs controls

The values are validated in Chapter 02. Here is what they *mean*:

**Identity (lines 4–5) — `MCP_SERVER_NAME`, `MCP_SERVER_VERSION`.** These are the
`serverInfo` the client sees during `initialize`, and they are what appears in
`npm run lifecycle` step 1. They are config rather than constants because a real deployment
stamps a build version here.

**Ports and URL (lines 7–9) — `MCP_SERVER_PORT=8081`, `MCP_HOST_PORT=8080`,
`MCP_SERVER_URL`.** Two ports because two processes. `MCP_SERVER_URL` is the URL the *host*
uses to reach the server — it is separate from `MCP_SERVER_PORT` even though they currently
agree, because the host and server could be on different machines and the port it *listens*
on is not the port you *dial*.

**Logging (line 11) — `MCP_LOG_LEVEL=info`.** One of `debug | info | warn | error`. Set it
to `debug` to see the selection engine's reasoning about *rejected* candidates.

**Execution guards (lines 13–15).** Three different timeouts and limits, and the
distinction matters:

| Knob | Value | Guards against |
| :--- | :--- | :--- |
| `MCP_TOOL_TIMEOUT_MS` | 5000 | A tool handler that hangs — the client is left waiting, the model has no recourse |
| `MCP_RESOURCE_TIMEOUT_MS` | 2000 | A *renderer* that hangs. Lower than tools, because a Resource read is a lookup, not a computation |
| `MCP_RATE_LIMIT_PER_MINUTE` | 60 | One client monopolising the server |

**The three context budgets (lines 17–19) — the numbers Lecture 15 adds.**

| Knob | Value | Caps |
| :--- | :--- | :--- |
| `MCP_MAX_RESOURCES_PER_REQUEST` | 3 | *How many* Resources one request may attach |
| `MCP_MAX_RESOURCE_CHARS` | 20000 | *Each* body, individually |
| `MCP_MAX_CONTEXT_CHARS` | 40000 | The *total*, across all attached Resources |

Three caps, not one, because they fail differently. A count cap stops a runaway selector;
a per-body cap stops one huge document from crowding out the others; a total cap stops
many medium documents from doing the same. Chapter 06 implements them **in that fixed
order** — count, then per-body, then total — because each stage removes a failure the
next stage cannot see.

These three are also **cross-validated** in Chapter 02: if
`MCP_MAX_RESOURCE_CHARS > MCP_MAX_CONTEXT_CHARS`, the per-resource cap can never bind, and
the server refuses to start rather than silently running with a cap that does nothing.

**Caching (line 21) — `MCP_RESOURCE_CACHE_TTL_MS=30000`.** Thirty seconds. Resources are
read repeatedly and mostly change slowly (Ch04), so this is the default. Static Resources
ignore it entirely; dynamic ones use it; the write path invalidates it.

**The scheme allowlist (line 23) — `MCP_ALLOWED_RESOURCE_SCHEMES=task,user`.** The only
schemes this deployment will serve. Defence in depth rather than the first gate: the SDK's
router rejects an unknown URI before any handler runs, so `file:///etc/passwd` never
reaches this check. It still matters — it is what stops a *registered* descriptor from
being served under a scheme the deployment did not intend (Ch03 §3.9).

**State bounds (line 25) — `MCP_MAX_TASKS=1000`.** The task store is in-process (Ch07), so
it needs a ceiling. Past it, `create_task` fails with a typed error instead of growing
until the process dies.

**Host policy (lines 27–29) — the three knobs that exist only on the host side.**

| Knob | Default | What it does |
| :--- | :--- | :--- |
| `MCP_HOST_ALLOW_DESTRUCTIVE` | `true` | If `false`, destructive tools are **never shown to the model at all** — not hidden, not warned about, absent from `tools/list` |
| `MCP_HOST_REQUIRE_CONSENT` | `true` | Destructive tools need an explicit consent callback before they run |
| `MCP_HOST_ALLOWED_PROMPTS` | empty | Empty means all. Non-empty turns the prompt menu into an allowlist |

These live on the host, and the server has no idea they exist. That is the design: the
server's job is to describe honestly, and the host's job is to decide. Flip
`MCP_HOST_ALLOW_DESTRUCTIVE=false` and re-run the lifecycle to watch step 2 change from
`4 discovered, 4 shown` to `4 discovered, 3 shown`.

**Model (lines 31–32).** `OPENAI_API_KEY` empty means offline echo mode — the host prints
the assembled request instead of sending it. `OPENAI_MODEL` is read only when a key exists.

---

## Run / verify

```bash
cd "Lecture 15/code/Production Code"
npm install
npm run typecheck
```

Expected: **no output at all**, and exit code `0`.

```bash
npm run typecheck; echo "typecheck exit: $?"
```

```text
typecheck exit: 0
```

`tsc --noEmit` printing nothing *is* the pass signal — it reports errors and nothing else.
If you see any output, it is a failure. Confirm the exit code rather than eyeballing it:

```bash
npm run typecheck > /dev/null 2>&1 && echo PASS || echo FAIL
```

Then confirm the whole project is wired up and runs:

```bash
npm run lifecycle 2>/dev/null | head -12
```

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
```

If those three lines appear, the file map above is complete and correct.

### Two failure modes worth provoking now

**A broken import path.** In any file, change `from "./mcp/server.js"` to
`from "./mcp/server"` (drop the extension) and run `npm run typecheck`:

```text
src/index.ts(3,32): error TS2835: Relative import paths need explicit file extensions in
  ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'.
  Did you mean './mcp/server.js'?
```

That error message is the whole reason `"module": "NodeNext"` is worth its friction: it
tells you exactly what to write.

**An unchecked index.** Add `const first = [1, 2, 3][0];` and then `first.toFixed(2)` to any
file, and `npm run typecheck` reports:

```text
Object is possibly 'undefined'.
```

That is `noUncheckedIndexedAccess` doing the work. Every "not found" branch in
`services/` and `domain/` exists because this rule made the alternative impossible to
write.

---

## Checkpoint

Before moving on, you should be able to answer these without re-reading:

1. **Which process can call a model, and how is that enforced structurally?**
   Only the host. `openai` is imported in exactly one file, `src/host/model.ts`, via a
   dynamic `import()` inside the branch that requires a key. The server never imports it
   and never reads `OPENAI_API_KEY`.

2. **Why are there two ports?**
   Because there are two processes with two jobs. The server (`:8081`) provides
   capabilities; the host (`:8080`) governs them. `MCP_SERVER_PORT` is where the server
   listens; `MCP_SERVER_URL` is what the host dials. They agree today and are still
   separate knobs, because they are different facts.

3. **What is the dependency rule, in one sentence?**
   Imports point downward only: `config` → `core` → `domain` → `services` → `mcp`/`host` →
   `controllers`/`routes`. Nothing below `mcp/` and `host/` imports a transport, and those
   two never import each other.

4. **Why three context budgets instead of one total?**
   Because they fail differently. Count stops a runaway selector, per-body stops one huge
   document, total stops many medium ones. And they are applied in that order, because each
   stage removes a failure the next cannot see.

5. **Which of the three primitives does the server's own capability list commit to, and
   which does it deliberately omit?**
   It declares `tools`, `resources`, `prompts`, `completions` and `logging`. It omits
   `resources.subscribe`, because the server registers no subscription handler — and a
   capability flag is a promise a host cannot verify except by failing.

---

**[← Guide README](./README.md)** · **[Chapter 02: Config →](./02_Config_Validated_Environment_and_Constants.md)**
