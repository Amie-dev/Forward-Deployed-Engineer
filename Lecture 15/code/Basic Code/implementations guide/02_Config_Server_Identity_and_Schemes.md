# Chapter 02 — Config: Server Identity & Schemes

> **Goal of this chapter:** read the smallest file in the project and see that it already
> contains two of the lecture's biggest ideas — *a server announces only its identity* and
> *a Resource URI is an identifier, not a URL*.
>
> **Lecture chapters:** [02 — Why Resources](../../../notes/02_Why_Resources_Context_as_a_First_Class_Primitive.md)
> and [03 — Resource Discovery, Reading and Anatomy](../../../notes/03_Resource_Discovery_Reading_and_Anatomy.md) (§3.5, URI ≠ URL).

---

## 2.1 File details

| | |
|---|---|
| **Path** | `src/config/config.ts` |
| **Purpose** | every constant the rest of the code imports: identity, URI schemes, ports, model name |
| **Imports** | `dotenv/config` (side-effect only) |
| **Exports** | `serverInfo`, `taskScheme`, `userScheme`, `mcpPort`, `hostPort`, `mcpServerUrl`, `model`, `hasModelKey` |
| **Depends on** | nothing in `src/` — this is the bottom of the dependency graph |
| **Implements** | Lecture 02 (server identity), Lecture 03 §3.5 (schemes), Lecture 01 (ports), Lecture 07 §7.3 (model) |

## 2.2 Commands

Nothing to run on its own — it is imported by everything else. To check it type-checks:

```bash
npm run typecheck
```

---

## 2.3 Full file

**Path:** `src/config/config.ts`

```ts
import "dotenv/config";

/**
 * Chapter 02 — what a client learns about this server at `initialize`.
 *
 * Identity only. There is no model, no prompt and no vendor SDK in this
 * process: an MCP server is a capability provider behind a standard door.
 */
export const serverInfo = {
  name: process.env.MCP_SERVER_NAME ?? "task-mcp-server",
  version: process.env.MCP_SERVER_VERSION ?? "1.0.0",
};

/**
 * Chapter 03 §3.5 — a Resource is *addressable*, so it needs a scheme.
 *
 * `https://` would be a lie here: the client cannot fetch these URIs itself,
 * only this server can resolve them. A custom scheme keeps the address honest
 * and stops a host from trying to dereference something it should not.
 */
export const taskScheme = "task";
export const userScheme = "user";

/**
 * Chapter 01 — the two processes this project runs.
 *
 *   MCP server  → src/index.ts        (Streamable HTTP, the protocol endpoint)
 *   Host / app  → src/routes/index.ts (the HTTP routes a user actually calls)
 */
export const mcpPort = Number(process.env.MCP_PORT ?? 8081);
export const hostPort = Number(process.env.HOST_PORT ?? 8080);
export const mcpServerUrl = process.env.MCP_SERVER_URL ?? `http://127.0.0.1:${mcpPort}/mcp`;

/**
 * Chapter 07 §7.3 — the model call that happens *after* `prompts/get`.
 *
 * `hasModelKey` is what lets the whole project run offline: with no key the
 * client prints the prompt it assembled instead of calling a model, so the
 * Resource and Prompt half of the protocol is still fully visible.
 */
export const model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
export const hasModelKey = Boolean(process.env.OPENAI_API_KEY);
```

---

## 2.4 Block-by-block explanation

### Block 1 — load `.env` before anything reads `process.env`

```ts
import "dotenv/config";
```

- This is an **import for its side effect only** — nothing is bound to a name. `dotenv/config`
  reads `.env` and copies each line into `process.env` at the moment the module is evaluated.
- **How it works:** ES module imports are hoisted and evaluated *before* the importing module's
  body runs. So by the time the `export const serverInfo = …` line below executes, `process.env`
  is already populated. If you put this import second, `serverInfo.name` would be `undefined`
  and fall back to the default — a classic bug worth remembering.

### Block 2 — identity

```ts
export const serverInfo = {
  name: process.env.MCP_SERVER_NAME ?? "task-mcp-server",
  version: process.env.MCP_SERVER_VERSION ?? "1.0.0",
};
```

- These two fields are the *entire* `serverInfo` object handed to `new McpServer(...)` in
  Chapter 07. That is Lecture 02's point made concrete: at `initialize`, the client learns
  **name and version, and nothing else**.
- `??` is the **nullish coalescing** operator: it falls back only when the left side is
  `null` or `undefined`. Because an unset variable is `undefined`, `?? "task-mcp-server"`
  gives you a working default and the project runs with no `.env` at all.
- Note what is *absent*: no model name, no API key, no database URL. A server's identity says
  nothing about what it can do — that is what `tools/list`, `resources/list` and `prompts/list`
  are for (Chapter 03).

### Block 3 — the URI schemes

```ts
export const taskScheme = "task";
export const userScheme = "user";
```

- Two constants instead of the literal strings `"task"` and `"user"` scattered through
  `resources.ts`. Change them here and every URI in the project changes with them.
- **Why not `https://`?** This is Lecture 03 §3.5's "URI ≠ URL". A URL tells you *how to fetch*
  something. A Resource URI only tells you *which* thing it is. `https://guidelines` would
  promise that any HTTP client can dereference it — and that is false: only this server knows
  what "guidelines" means. `task://guidelines` keeps the address honest.
- The scheme also carries intent: `task://` is server-owned task data, `user://` is a person.
  When you have twenty Resources, that is a free organisational axis.

### Block 4 — the two processes

```ts
export const mcpPort = Number(process.env.MCP_PORT ?? 8081);
export const hostPort = Number(process.env.HOST_PORT ?? 8080);
export const mcpServerUrl = process.env.MCP_SERVER_URL ?? `http://127.0.0.1:${mcpPort}/mcp`;
```

- `Number(...)` because `process.env` values are **always strings**. `"8081"` would work in
  `listen()` by luck, but `Number` makes the type honest and catches typos as `NaN`.
- `mcpServerUrl` is a **template literal** that reuses `mcpPort`, so the URL and the port can
  never drift apart. If you change `MCP_PORT=9000` in `.env`, the server binds 9000 *and* the
  client dials 9000 — but only because you changed one value.
- This pair of ports is the whole shape of Chapter 09: **8081 speaks MCP, 8080 speaks HTTP to
  a human.**

### Block 5 — the model step

```ts
export const model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
export const hasModelKey = Boolean(process.env.OPENAI_API_KEY);
```

- `hasModelKey` is the switch that makes the project runnable with no API key. In Chapter 08,
  `askModel()` checks it and, when false, returns the assembled prompt instead of calling a
  model.
- **Why this matters for the lecture:** Chapter 07 §7.3 insists that `prompts/get` and the LLM
  call are two separate things. Making the model call *optional* proves it — the project still
  demonstrates `resources/read` and `prompts/get` end to end with no model at all.
- `Boolean("")` is `false` and `Boolean(undefined)` is `false`, so an empty `OPENAI_API_KEY=`
  line in `.env` correctly means "offline".

---

## 2.5 Why this file exists at all

You could inline these constants where they are used. Splitting them out buys three things:

1. **One place to look.** "Why is it 8081?" has exactly one answer.
2. **No cycles.** `config.ts` imports nothing from `src/`, so anything may import it safely.
3. **Testability.** `resources.ts` reads `taskScheme` rather than hard-coding `"task://"`, so a
   test (or a different deployment) can change the scheme in one place.

---

## 2.6 Run / verify

```bash
npm run typecheck     # silent, exit 0

# prove the defaults and the .env values agree
node -e "import('./src/config/config.ts').then(c => console.log(c.serverInfo, c.mcpPort, c.hostPort, c.hasModelKey))"
```

Expected output (with the shipped `.env`):

```text
{ name: 'task-mcp-server', version: '1.0.0' } 8081 8080 false
```

`false` is `hasModelKey` — offline mode, exactly as intended.

---

## 2.7 Checkpoint

1. **Why must `import "dotenv/config"` be the first line?** → imports are evaluated before the
   module body, so `process.env` is populated before `serverInfo` is built.
2. **Why `task://` instead of `https://`?** → the URI identifies a Resource; it does not promise
   that anyone can fetch it. Only this server can resolve `task://guidelines`.
3. **What does `hasModelKey === false` change?** → `askModel()` skips the OpenAI call and returns
   the prompt text, so `resources/read` and `prompts/get` stay demonstrable offline.

**Next:** [Chapter 03 — Task Service: The Data Layer](./03_Task_Service_The_Data_Layer.md)

