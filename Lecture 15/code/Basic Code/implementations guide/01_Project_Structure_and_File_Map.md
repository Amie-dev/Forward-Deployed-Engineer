# Chapter 01 — Project Structure & File Map

> **Goal of this chapter:** before reading a single line of TypeScript, understand *the map*:
> every folder, every file, what it is for, and the order in which the files depend on each
> other. This is the "explain the overall file structure" chapter you start from.
>
> **Lecture chapters:** [01 — The Three Primitives and the Control Model](../../../notes/01_The_Three_Primitives_and_the_Control_Model.md)
> and [02 — Why Resources](../../../notes/02_Why_Resources_Context_as_a_First_Class_Primitive.md).

---

## 1.1 What the project is (in one paragraph)

**One MCP server** that exposes all three MCP primitives — **Tools** (*do*, the **model**
holds the trigger), **Resources** (*know*, the **application** holds the trigger) and
**Prompts** (*reuse*, the **user** holds the trigger) — plus **one host** that reads those
Resources, fetches those Prompts and serves the lecture's `GET /plan?hours=4`.

It runs **offline with no API key**: leave `OPENAI_API_KEY` empty and the client prints the
prompt it assembled instead of calling a model, so the whole Resource and Prompt half of the
protocol stays visible on any machine.

---

## 1.2 Prerequisites

| Requirement | Version | Why it is needed |
|---|---|---|
| **Node.js** | `>= 20.0.0` | declared in `package.json` `engines.node`; the code uses ESM, `node:` APIs and top-level `await` |
| **npm** | recent | installs the dependencies and runs the scripts in `package.json` |

Verify before you start:

```bash
node --version    # must print v20.x or newer (this guide was verified on v24.22.0)
npm --version
```

---

## 1.3 The complete file structure

```text
Basic Code/
├── .env                        # local runtime values; gitignored
├── .env.example                # committed template that `.env` is copied from
├── package.json                # project metadata, dependencies, npm scripts
├── package-lock.json           # exact dependency tree npm install resolved
├── tsconfig.json               # TypeScript compiler configuration
├── README.md                   # the project's own overview (short)
├── implementations guide/      # this chapter-wise walkthrough
└── src/
    ├── index.ts                # Chapter 09 — the MCP server process (Streamable HTTP)
    ├── config/
    │   └── config.ts           # Chapter 02 — identity, URI schemes, ports, model
    ├── server/
    │   └── server.ts           # Chapter 07 — createServer(): the "standard door"
    ├── services/
    │   ├── taskService.ts      # Chapter 03 — the data layer (tasks + text views)
    │   └── resourceSelector.ts # Chapter 05 — how the APPLICATION picks a Resource
    ├── tools/
    │   └── tools.ts            # Chapter 07 — Tools: the MODEL holds the trigger
    ├── resources/
    │   └── resources.ts        # Chapter 04 — Resources: the APPLICATION holds it
    ├── prompts/
    │   └── prompts.ts          # Chapter 06 — Prompts: the USER holds the trigger
    ├── client/
    │   └── client.ts           # Chapter 08 — the MCP client + the lifecycle walkthrough
    └── routes/
        └── index.ts            # Chapter 09 — the HTTP host: GET /plan?hours=4
```

`node_modules/` and `dist/` are intentionally **not** listed: `node_modules/` is created by
`npm install`, and `dist/` only appears if you run a build (this project runs from source via
`tsx`, so you never need it).

### File-by-file role

| File | Layer | Owns | Who reads it |
|---|---|---|---|
| `package.json` | project | dependencies + the `npm run …` scripts | npm / you |
| `tsconfig.json` | project | how TypeScript type-checks the source | `tsc`, editors |
| `.env` | project | ports, server identity, model name, API key | `src/config/config.ts` |
| `src/index.ts` | process | the MCP server, bound to Streamable HTTP | the host's client |
| `src/config/config.ts` | config | every constant the rest of the code imports | all of `src/` |
| `src/server/server.ts` | assembly | `createServer()` — declares the three primitives | `src/index.ts` |
| `src/services/taskService.ts` | data | the task store + the text views Resources return | tools, resources |
| `src/services/resourceSelector.ts` | decision | *which* Resources to read for a message | `src/client/client.ts` |
| `src/tools/tools.ts` | primitive | the Tools the **model** may call | MCP `tools/list` |
| `src/resources/resources.ts` | primitive | the Resources the **application** may read | MCP `resources/list` |
| `src/prompts/prompts.ts` | primitive | the Prompts the **user** may select | MCP `prompts/list` |
| `src/client/client.ts` | client | one function per MCP verb + the lifecycle walkthrough | `src/routes/index.ts` |
| `src/routes/index.ts` | host | the HTTP routes, including `GET /plan?hours=4` | a browser / curl |

---

## 1.4 How the files depend on each other

```text
                       .env
                        │
                        ▼
                  config/config.ts ────────────┐
                        │                       │
                        ▼                       │
              services/taskService.ts           │
                        │                       │
        ┌───────────────┼───────────────┐       │
        ▼               ▼               ▼       │
   tools/tools.ts  resources/…     prompts/…    │
        │               │               │       │
        └───────────────┼───────────────┘       │
                        ▼                       │
              server/server.ts ◄────────────────┘
                        │
                        ▼
                   index.ts  (the MCP server process)
                        ▲
                        │ Streamable HTTP
                        │
                  client/client.ts
                        │
                        ▼
                 routes/index.ts  (the host)
```

Three things to notice, because they are the architecture of the lecture:

1. **`config/` and `services/` know nothing about MCP.** They are plain data and plain
   constants. That is deliberate: the protocol layer is a thin skin over ordinary code.
2. **The three primitive folders never import each other.** `resources.ts` does not import
   `prompts.ts`. They only meet in `server/server.ts` — which is Chapter 01's point that the
   primitives are *siblings behind one door*, not a pipeline.
3. **`index.ts` and `routes/index.ts` are the only process-aware files.** Everything above
   them could be served over stdio, HTTP or anything else without changing.

---

## 1.5 `package.json` (full file)

**Path:** `Basic Code/package.json`

```json
{
  "name": "lecture-15-mcp-resources-and-prompts",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 15 — MCP Server: Resources and Prompts. The minimal, runnable code behind the notes: one MCP server exposing Tools (model-controlled), Resources (application-controlled) and Prompts (user-controlled), plus the host that reads resources, fetches prompts and serves GET /plan?hours=4.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "server": "tsx src/index.ts",
    "host": "tsx src/routes/index.ts",
    "lifecycle": "tsx src/client/client.ts",
    "typecheck": "tsc --noEmit"
  },
  "keywords": [
    "fde",
    "mcp",
    "model-context-protocol",
    "resources",
    "prompts",
    "tools",
    "typescript"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/client": "^2.3.1",
    "@modelcontextprotocol/node": "^2.1.1",
    "@modelcontextprotocol/server": "^2.3.1",
    "dotenv": "^16.4.7",
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

### Block-by-block explanation

**Block 1 — the package header**

```json
"name": "lecture-15-mcp-resources-and-prompts",
"version": "1.0.0",
"private": true,
"type": "module",
```

- `"type": "module"` is the important line. It makes every file in the project an **ES
  module**, which is why all the imports use `import … from "…"` and why relative imports
  carry a `.js` extension (see §1.7).
- `"private": true` stops an accidental `npm publish`.

**Block 2 — `engines`**

```json
"engines": { "node": ">=20.0.0" }
```

- Declares the minimum runtime. The code uses top-level `await` in `src/routes/index.ts`,
  which is only stable in modern Node.

**Block 3 — the scripts (your map of how to run the project)**

```json
"server": "tsx src/index.ts",
"host": "tsx src/routes/index.ts",
"lifecycle": "tsx src/client/client.ts",
"typecheck": "tsc --noEmit"
```

- `tsx` runs TypeScript directly — there is no build step, so what you read is what runs.
- `server` and `host` are the **two processes** of Chapter 09.
- `lifecycle` is the one-command tour: it starts a server itself and prints every protocol step.
- `typecheck` never emits files; it only checks types.

**Block 4 — the dependencies, and why each one is here**

```json
"@modelcontextprotocol/server": "^2.3.1",   // McpServer, registerTool/Resource/Prompt, ResourceTemplate
"@modelcontextprotocol/client": "^2.3.1",   // Client, StreamableHTTPClientTransport
"@modelcontextprotocol/node":   "^2.1.1",   // toNodeHandler + the localhost Host/Origin validators
"zod":                          "^4.2.0",   // the inputSchema / argsSchema definitions
"dotenv":                       "^16.4.7",  // reads .env into process.env
"openai":                       "^6.0.0"    // the model call in Chapter 07 §7.3 (optional at runtime)
```

- The three `@modelcontextprotocol/*` packages are the **protocol**; `zod` is the **contract**
  (schemas); `openai` is the **model**, and it is the only dependency the code can run without.

**Block 5 — the dev dependencies**

```json
"tsx": "^4.23.15",        // run .ts directly
"typescript": "^5.9.3",   // tsc --noEmit
"@types/node": "^22.13.8" // types for node:http, node:child_process, …
```

---

## 1.6 `tsconfig.json` (full file)

**Path:** `Basic Code/tsconfig.json`

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

### Block-by-block explanation

**Block 1 — the module system**

```json
"target": "ES2022",
"module": "NodeNext",
"moduleResolution": "NodeNext",
```

- `NodeNext` makes TypeScript resolve imports the way Node actually resolves ES modules. This
  is the setting that makes the `.js` extension in `./config/config.js` **required**, not
  optional — see §1.7.

**Block 2 — strictness**

```json
"strict": true,
"forceConsistentCasingInFileNames": true
```

- `strict` is why every function in this project has explicit parameter and return types. On a
  teaching codebase that is a feature: the types document the protocol.

**Block 3 — what is compiled**

```json
"include": ["src/**/*"],
"exclude": ["node_modules", "dist"]
```

- Type-check everything under `src/`; never look inside `node_modules/` or `dist/`.

---

## 1.7 `.env` and `.env.example` (full files)

**Path:** `Basic Code/.env.example` (committed template)

```dotenv
# Lecture 15 — MCP Server: Resources and Prompts
# Copy to `.env` and adjust if needed.

# Chapter 02 — what the client learns about this server at `initialize`.
MCP_SERVER_NAME=task-mcp-server
MCP_SERVER_VERSION=1.0.0

# Chapter 01 — the MCP server process (Streamable HTTP).
MCP_PORT=8081
MCP_SERVER_URL=http://127.0.0.1:8081/mcp

# Chapter 09 — the application/host process: the `GET /plan?hours=4` endpoint.
HOST_PORT=8080

# Chapter 07 §7.3 — the LLM step that happens AFTER `prompts/get`.
# Leave OPENAI_API_KEY empty to run fully offline: the client then prints the
# prompt it assembled instead of calling a model.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
```

**Path:** `Basic Code/.env` (your local copy — gitignored, same content)

```dotenv
# Lecture 15 — MCP Server: Resources and Prompts
# Copy to `.env` and adjust if needed.

# Chapter 02 — what the client learns about this server at `initialize`.
MCP_SERVER_NAME=task-mcp-server
MCP_SERVER_VERSION=1.0.0

# Chapter 01 — the MCP server process (Streamable HTTP).
MCP_PORT=8081
MCP_SERVER_URL=http://127.0.0.1:8081/mcp

# Chapter 09 — the application/host process: the `GET /plan?hours=4` endpoint.
HOST_PORT=8080

# Chapter 07 §7.3 — the LLM step that happens AFTER `prompts/get`.
# Leave OPENAI_API_KEY empty to run fully offline: the client then prints the
# prompt it assembled instead of calling a model.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
```

### Block-by-block explanation

**Block 1 — identity**

```dotenv
MCP_SERVER_NAME=task-mcp-server
MCP_SERVER_VERSION=1.0.0
```

- These become `serverInfo` in `config.ts` (Chapter 02). They are everything the client learns
  about the server at `initialize` — **name and version, nothing more.**

**Block 2 — the MCP server process**

```dotenv
MCP_PORT=8081
MCP_SERVER_URL=http://127.0.0.1:8081/mcp
```

- `MCP_PORT` is the port `src/index.ts` binds. `MCP_SERVER_URL` is what the client dials.
  Keeping both in `.env` is what lets the host point at a server on another machine without
  editing a `.ts` file.

**Block 3 — the host process**

```dotenv
HOST_PORT=8080
```

- The port `src/routes/index.ts` listens on — the one you put in a browser.

**Block 4 — the model step**

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
```

- Left empty on purpose. Chapter 07 §7.3 is *"`getPrompt` talks to the server; the LLM call
  happens afterwards"* — with no key you still see the first half in full, and the code prints
  the assembled prompt in place of the answer.

> **Why a `.env` at all?** So ports, identity and the model name are *configuration*, not
> *code*. The same source can be a local server or a remote one without editing a `.ts` file —
> Chapter 01's "the binding is a detail, not a rewrite".

---

## 1.8 What is intentionally missing

| Not present | Why |
|---|---|
| `dist/` | the project runs from source with `tsx`; nothing is built |
| a database | `taskService` keeps tasks in an array in memory (Chapter 03) |
| an MCP SDK call inside `services/` | the data layer must stay protocol-agnostic |
| a `build` script | not needed; `typecheck` is the only compiler step |
| a framework (Express/Fastify) | `node:http` is enough for four routes, and it keeps the host readable |

---

## 1.9 Run / verify

```bash
cd "Lecture 15/code/Basic Code"
npm install          # if you have not already
npm run typecheck    # should print nothing and exit 0
npm run lifecycle    # should print the seven numbered steps from the guide README
```

Expected: `typecheck` is silent (no errors) and `lifecycle` prints steps 1–7, ending with the
offline model step.

---

## 1.10 Checkpoint

Before moving on, you should be able to answer:

1. **Which file would you edit to move the MCP server to another port** without touching any
   TypeScript? → `.env` (`MCP_PORT` and `MCP_SERVER_URL`).
2. **Which folder does the model never see** but which does the real work? →
   `src/services/` (`taskService.ts` holds the data; `resourceSelector.ts` makes the decision).
3. **Why do imports end in `.js` when the files are `.ts`?** → ESM + `NodeNext` resolution
   import the *emitted* file name; `tsx` maps it back to `.ts`.
4. **How many processes does this project run?** → two: the MCP server (`src/index.ts`) and the
   host (`src/routes/index.ts`). `npm run lifecycle` starts the first for you.

**Next:** [Chapter 02 — Config: Server Identity & Schemes](./02_Config_Server_Identity_and_Schemes.md)


