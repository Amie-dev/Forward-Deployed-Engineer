# Chapter 01 — Project Structure & File Map

> **Goal of this chapter:** before reading a single line of TypeScript, understand *the map*:
> every folder, every file, what it is for, and the order in which the files depend on each
> other. This is the "explain the overall file structure" chapter you start from.
>
> **Lecture chapters:** [01 — The Integration Problem](../../../notes/01_The_Integration_Problem_and_Why_Standards_Win.md)
> and [02 — What MCP Is](../../../notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md).

---

## 1.1 What the project is (in one paragraph)

It is **one MCP server** that exposes all three MCP primitives — **Tools** (*do*),
**Resources** (*know*), **Prompts** (*reuse*) — plus **one host/client** that discovers and
invokes them. It runs **offline with no API key**: instead of an LLM choosing a tool, the
client stands in for the model deterministically, so the full lifecycle
(`tools/list → tools/call → resources/read → prompts/get`) is reproducible on any machine.

That single design choice — *no LLM inside the server* — is the whole point of Lecture 14
Chapter 02: **an MCP server is a capability provider behind a standard door; it needs no
model.**

---

## 1.2 Prerequisites

| Requirement | Version | Why it is needed |
|---|---|---|
| **Node.js** | `>= 20.0.0` | declared in `package.json` `engines.node`; the code uses ESM, `node:url`, and modern syntax |
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
├── .env                        # local runtime values (server name/version/transport); gitignored
├── .env.example                # committed template that `.env` is copied from
├── package.json                # project metadata, dependencies, npm scripts
├── package-lock.json           # exact dependency tree npm install resolved
├── tsconfig.json               # TypeScript compiler configuration
├── README.md                   # the project's own overview (short)
└── src/
    ├── index.ts                # Chapter 08 — STDIO transport binding (the process entry point)
    ├── config/
    │   └── config.ts           # Chapter 02 — server identity, transport, resource URI scheme
    ├── server/
    │   └── server.ts           # Chapter 03 — createServer(): the "standard door"
    ├── services/
    │   └── taskService.ts      # Chapter 04 — the execution layer (business logic)
    ├── tools/
    │   └── tools.ts            # Chapter 05 — Tools: name + description + inputSchema
    ├── resources/
    │   └── resources.ts        # Chapter 06 — Resources: addressable context by URI
    ├── prompts/
    │   └── prompts.ts          # Chapter 07 — Prompts: reusable, user-selected instructions
    └── client/
        └── client.ts           # Chapter 09 — Host/Client: discovery → invocation
```

`node_modules/` and `dist/` are intentionally **not** listed: `node_modules/` is created by
`npm install`, and `dist/` only appears if you run a build (this project runs from source via
`tsx`, so you never need it).

### File-by-file role

| File | Layer | Owns | Who reads it |
|---|---|---|---|
| `package.json` | project | dependencies + the `npm run …` scripts | npm / you |
| `tsconfig.json` | project | how TypeScript type-checks the source | `tsc`, editors |
| `.env` | project | runtime config values (name, version, transport) | `config.ts` (via `dotenv`) |
| `src/config/config.ts` | config | **identity** (name/version), **transport**, **URI scheme** | every other file |
| `src/server/server.ts` | server | assembles the three primitives behind one `McpServer` | `index.ts`, tests |
| `src/services/taskService.ts` | execution | the real task logic (create / list / complete) | `tools.ts` only |
| `src/tools/tools.ts` | primitive | the tool **contracts** the model reads | the MCP client (model) |
| `src/resources/resources.ts` | primitive | read-only policy documents addressed by URI | the MCP client (application) |
| `src/prompts/prompts.ts` | primitive | reusable instruction templates | the MCP client (user) |
| `src/index.ts` | transport | binds `createServer()` to STDIO | the OS / the host |
| `src/client/client.ts` | host | spawns the server and drives the lifecycle | you (`npm run client`) |

### Dependency direction (why the build order matters)

```text
index.ts ──▶ server/server.ts ──▶ tools/tools.ts ──▶ services/taskService.ts
                     │            resources/resources.ts ──▶ config/config.ts
                     │            prompts/prompts.ts
                     └──────────▶ config/config.ts   (serverInfo)

client/client.ts ──(spawns over stdio)──▶ index.ts
```

- **Nothing depends on the client** — the client is the outermost layer, the host.
- **`config.ts` is a leaf** — it is imported by everyone and imports almost nothing.
- **`taskService.ts` knows nothing about MCP** — it is plain business logic (Chapter 04's point).

That is Chapter 01's architectural claim made concrete: the host depends on the *protocol*,
the server depends on its *backend*, and the two meet at a standard boundary.

---

## 1.4 Commands

Run everything from the project root:

```bash
cd "Lecture 14/code/Basic Code"
```

| Command | What it does | When to use it |
|---|---|---|
| `npm install` | installs dependencies from `package.json` | once, first time |
| `npm run client` | runs `tsx src/client/client.ts` — host + client, prints the whole lifecycle | to see the protocol in action |
| `npm run server` | runs `tsx src/index.ts` — server alone, waits on stdio | to inspect the server by hand |
| `npm run dev` | `tsx watch src/index.ts` — server with auto-reload | while editing server code |
| `npm run typecheck` | `tsc --noEmit` — type-checks, emits nothing | after any edit |

> **`tsx` vs `tsc`.** `tsx` runs TypeScript directly (no build step). `tsc --noEmit` is the
> type-checker. There is no `npm run build` because the project is designed to run from source.

---

## 1.5 `package.json` (full file)

**Path:** `Basic Code/package.json`

```json
{
  "name": "lecture-14-mcp-server-basics",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 14 — MCP Server from First Principles: the minimal, runnable code behind the notes. One MCP server exposing Tools (do), Resources (know) and Prompts (reuse), plus the Host/Client that discovers and invokes them.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "server": "tsx src/index.ts",
    "client": "tsx src/client/client.ts",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "keywords": [
    "fde",
    "mcp",
    "model-context-protocol",
    "tools",
    "resources",
    "prompts",
    "typescript"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/client": "^2.3.1",
    "@modelcontextprotocol/server": "^2.3.1",
    "dotenv": "^16.4.7",
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

**Block 1 — identity and packaging**

```json
"name": "lecture-14-mcp-server-basics",
"version": "1.0.0",
"private": true,
```

- `name` / `version` — the package identity (used by npm, not by MCP).
- `private: true` — prevents an accidental `npm publish`. This is teaching code, not a library.

**Block 2 — module system**

```json
"type": "module",
```

- Tells Node to treat every `.js`/`.ts` file as an **ES module** (`import`/`export`), not
  CommonJS (`require`). This is why every relative import in `src/` ends in `.js`
  (e.g. `./server/server.js`) even though the files are `.ts` — under ESM the *emitted* name is
  what you import, and `tsx` resolves `.js` → `.ts` for you.

**Block 3 — the engine floor**

```json
"engines": { "node": ">=20.0.0" }
```

- Declares the minimum Node version. `npm` warns if you violate it. Node 20 is the floor for
  the ESM + `node:` APIs the project uses.

**Block 4 — the four scripts (this is your entire workflow)**

```json
"scripts": {
  "server": "tsx src/index.ts",
  "client": "tsx src/client/client.ts",
  "dev": "tsx watch src/index.ts",
  "typecheck": "tsc --noEmit"
}
```

- `server` — start the MCP server process (Chapter 08).
- `client` — start the host + client (Chapter 09); this is the demo you run first.
- `dev` — same as `server` but auto-restarts on file change.
- `typecheck` — run the TypeScript compiler in *check-only* mode (`--noEmit`), so it reports
  type errors without writing any files.

**Block 5 — runtime dependencies**

```json
"dependencies": {
  "@modelcontextprotocol/client": "^2.3.1",
  "@modelcontextprotocol/server": "^2.3.1",
  "dotenv": "^16.4.7",
  "zod": "^4.2.0"
}
```

- `@modelcontextprotocol/server` — the SDK that provides `McpServer`, `serveStdio` and the
  `registerTool` / `registerResource` / `registerPrompt` methods.
- `@modelcontextprotocol/client` — the SDK that provides `Client` and `StdioClientTransport`.
- `dotenv` — loads `.env` into `process.env` (used by `config.ts`).
- `zod` — the schema library used to declare `inputSchema`, `outputSchema` and `argsSchema`.
  The `^` prefix means "compatible with 2.3.1 / 16.4.7 / 4.2.0 and up (same major)".

**Block 6 — development-only tools**

```json
"devDependencies": {
  "@types/node": "^22.13.8",
  "tsx": "^4.23.15",
  "typescript": "^5.9.3"
}
```

- `@types/node` — Node type definitions (so `process`, `console`, `node:url` type-check).
- `tsx` — the TypeScript runner used by the scripts (no build step).
- `typescript` — the compiler behind `tsc` and `tsx`.

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

**Block 1 — language level and module system**

```json
"target": "ES2022",
"module": "NodeNext",
"moduleResolution": "NodeNext",
"lib": ["ES2022"],
```

- `target: ES2022` — the JavaScript version the compiler assumes/emits.
- `module: NodeNext` + `moduleResolution: NodeNext` — match Node's real ESM rules. This is why
  imports use the explicit `.js` extension; NodeNext *requires* the emitted extension.
- `lib: ["ES2022"]` — the built-in type library (no DOM, because this is Node, not a browser).

**Block 2 — where code goes**

```json
"outDir": "./dist",
"rootDir": "./src",
```

- `rootDir: ./src` — the source tree starts at `src/`.
- `outDir: ./dist` — where `tsc` would emit JS (used only if you build; the scripts use `tsx`).

**Block 3 — strictness and interop**

```json
"strict": true,
"esModuleInterop": true,
"skipLibCheck": true,
"forceConsistentCasingInFileNames": true,
```

- `strict: true` — turns on the full set of type-safety checks (`strictNullChecks`, `noImplicitAny`, …).
  This is why `complete()` must return `Task | undefined` and the tool must handle the `undefined`.
- `esModuleInterop` — lets ESM-style imports work cleanly with CommonJS packages.
- `skipLibCheck` — don't type-check `.d.ts` files inside dependencies (faster, and avoids noise).
- `forceConsistentCasingInFileNames` — prevents `Config.ts` vs `config.ts` bugs on case-insensitive filesystems.

**Block 4 — extra output**

```json
"declaration": true,
"sourceMap": true,
"resolveJsonModule": true
```

- `declaration` — emit `.d.ts` type declarations if you build.
- `sourceMap` — emit source maps for debugging.
- `resolveJsonModule` — allow `import data from "./x.json"`.

**Block 5 — which files are compiled**

```json
"include": ["src/**/*"],
"exclude": ["node_modules", "dist"]
```

- `include` — type-check everything under `src/`.
- `exclude` — never look inside `node_modules/` or `dist/`.

---

## 1.7 `.env` and `.env.example` (full files)

**Path:** `Basic Code/.env.example` (committed template)

```dotenv
# Lecture 14 — MCP Server from First Principles
# Copy to `.env` (see `.env.example`) and adjust if needed.

MCP_SERVER_NAME=task-mcp-server
MCP_SERVER_VERSION=1.0.0

# Chapter 04 — STDIO is the local transport: the client spawns this process
# and speaks JSON-RPC over stdin/stdout.
MCP_TRANSPORT=stdio
```

**Path:** `Basic Code/.env` (your local copy — gitignored, same content)

```dotenv
# Lecture 14 — MCP Server from First Principles
# Copy to `.env` (see `.env.example`) and adjust if needed.

MCP_SERVER_NAME=task-mcp-server
MCP_SERVER_VERSION=1.0.0

# Chapter 04 — STDIO is the local transport: the client spawns this process
# and speaks JSON-RPC over stdin/stdout.
MCP_TRANSPORT=stdio
```

### Block-by-block explanation

**Block 1 — server identity**

```dotenv
MCP_SERVER_NAME=task-mcp-server
MCP_SERVER_VERSION=1.0.0
```

- These two values become `serverInfo` in `config.ts` (Chapter 02). They are what the client
  learns about the server at `initialize` — **name and version, nothing more.**

**Block 2 — transport**

```dotenv
MCP_TRANSPORT=stdio
```

- Selects the binding. `stdio` = the client spawns this process and talks JSON-RPC over
  stdin/stdout. Changing this to `http` is what a remote deployment would do (Chapter 04).

> **Why a `.env` at all?** So identity and transport are *configuration*, not *code*. The same
> source can be the local server or the remote one without editing a `.ts` file — that is
> Chapter 01's "the binding is a detail, not a rewrite".

---

## 1.8 What is intentionally missing

| Not present | Why |
|---|---|
| `dist/` | the project runs from source with `tsx`; nothing is built |
| a database | `taskService` keeps tasks in memory (Chapter 04) |
| an LLM SDK / API key | the client stands in for the model deterministically |
| a `build` script | not needed; `typecheck` is the only compiler step |

---

## 1.9 Run / verify

```bash
cd "Lecture 14/code/Basic Code"
npm install          # if you have not already
npm run typecheck    # should print nothing and exit 0
npm run client       # should print the lifecycle shown in the README
```

Expected: `typecheck` is silent (no errors) and `client` prints the six numbered steps.

---

## 1.10 Checkpoint

Before moving on, you should be able to answer:

1. **Which file would you edit to rename the server** without touching any TypeScript? → `.env`
   (`MCP_SERVER_NAME`).
2. **Which file does the model never see** but which does the real work? → `src/services/taskService.ts`.
3. **Why do imports end in `.js` when the files are `.ts`?** → ESM + `NodeNext` resolution
   import the emitted file name; `tsx` maps it back to `.ts`.

**Next:** [Chapter 02 — Config: Server Identity & Transport](./02_Config_Server_Identity_and_Transport.md)


