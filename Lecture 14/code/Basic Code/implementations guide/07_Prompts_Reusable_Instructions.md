# Chapter 07 — Prompts: Reusable Instructions

> **Goal of this chapter:** read the file that exposes *reusable instructions*. A **Prompt** is
> **user-controlled**: the UI lists it, the **user** picks it, and `prompts/get` returns messages
> with the arguments substituted. The model does not choose prompts, and a prompt changes no state.
>
> **Lecture chapter:** [06 — Resources and Prompts](../../../notes/06_Resources_and_Prompts.md) (§6.7 prompts).

---

## 7.1 File details

| Property | Value |
|---|---|
| **Path** | `src/prompts/prompts.ts` |
| **Layer** | MCP primitive — **Prompts** (*reuse*) |
| **Purpose** | expose a reusable, parameterised instruction template |
| **Imports** | `McpServer` (type-only), `zod/v4` |
| **Exports** | `registerPrompts(server)` |
| **Imported by** | `src/server/server.ts` |
| **Protocol methods** | `prompts/list` (discovery), `prompts/get` (retrieval) |
| **Lecture sections** | 06 §6.7 |

### The control model, completed

| Primitive | Intent | Driven by |
|---|---|---|
| Tools | *do* | the **model** |
| Resources | *know* | the **application** |
| **Prompts** | **reuse** | the **user** ← this chapter |

---

## 7.2 Commands

```bash
cd "Lecture 14/code/Basic Code"

npm run client    # prints: 5. prompts/list -> review_pull_request
                  #          prompts/get review_pull_request -> {"type":"text","text":"You are reviewing pull request #42. …"}

# Raw protocol: list prompts, then get one with an argument substituted
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"prompts/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"review_pull_request","arguments":{"prNumber":"42"}}}' \
  | npm run server --silent
```

---

## 7.3 Full file

**Path:** `src/prompts/prompts.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Chapter 06 §6.7 — Prompts: reusable instructions.
 *
 * A Prompt is *reuse*, and it is **user-controlled**: the UI lists it, the user
 * picks it, and `prompts/get` returns messages with the arguments substituted.
 * The model does not choose prompts, and a prompt changes no state.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "review_pull_request",
    {
      title: "Review Pull Request",
      description: "Asks the model to review a pull request for bugs and maintainability issues.",
      argsSchema: z.object({
        prNumber: z.string().describe("Pull request number, e.g. 42"),
      }),
    },
    ({ prNumber }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are reviewing pull request #${prNumber}. Check for bugs, maintainability issues and missing tests, then report findings as a short list.`,
          },
        },
      ],
    }),
  );
}
```

---

## 7.4 Block-by-block explanation

### Block 1 — the imports

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
```

**What it does:** brings in the server type and the schema builder.

**How it works:**
- `import type { McpServer }` — type-only; erased at compile time.
- `zod` is used here for `argsSchema` — the same schema library as Chapter 05, but note the
  difference: a tool has an **`inputSchema`** (arguments to an action), a prompt has an
  **`argsSchema`** (values to substitute into text). Same idea, different purpose.

### Block 2 — register the prompt and its arguments

```ts
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "review_pull_request",
    {
      title: "Review Pull Request",
      description: "Asks the model to review a pull request for bugs and maintainability issues.",
      argsSchema: z.object({
        prNumber: z.string().describe("Pull request number, e.g. 42"),
      }),
    },
```

**What it does:** registers a prompt named `review_pull_request` that takes one argument, `prNumber`.

**How it works:**
- **`"review_pull_request"`** — the prompt's name, used by `prompts/get`.
- **`title`** — a display label for the UI menu where the user picks the prompt.
- **`description`** — tells the **user** (and the UI) what the prompt is for.
- **`argsSchema`** — `z.object({ prNumber: z.string()… })` declares the substitution variables. The
  SDK validates the arguments the client supplies against this schema. The `.describe(...)` documents
  the field ("Pull request number, e.g. 42").
- Note there is **no handler side effect** here — registration only declares the prompt; nothing runs
  until a user selects it and the client calls `prompts/get`.

### Block 3 — the handler (arguments → messages)

```ts
    ({ prNumber }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are reviewing pull request #${prNumber}. Check for bugs, maintainability issues and missing tests, then report findings as a short list.`,
          },
        },
      ],
    }),
  );
}
```

**What it does:** returns the concrete **messages** for this prompt, with `prNumber` substituted in.

**How it works:**
- The handler is **synchronous** here (no `async`) — it just builds and returns a value; no I/O.
- `({ prNumber }) => …` destructures the validated arguments. The SDK has already checked them
  against `argsSchema`.
- It returns an object with a **`messages` array** — the same shape as a conversation turn. Each
  message has:
  - **`role: "user"`** — the instruction is delivered as if the user wrote it. (Prompts can also
    return `assistant` messages, e.g. a few-shot example; this one returns a single user turn.)
  - **`content`** — a content block; here `{ type: "text", text: … }`.
  - The template literal `` `… #${prNumber}. …` `` **substitutes** the argument into the text. This
    server-side substitution is the point of a Prompt: the *client* only sends `prNumber: "42"`; the
    *server* owns the exact wording of the instruction.
- **Nothing is stored or changed.** Calling `prompts/get` repeatedly returns the same messages for
  the same arguments — a prompt is a template, not an action.

> **Why this is *reuse*, and why the user drives it:** the wording ("Check for bugs, maintainability
> issues and missing tests…") lives once, on the server, and every host that connects can offer it in
> a menu. The user decides *whether* to use it; the model never selects a prompt on its own.

---

## 7.5 Run / verify

```bash
cd "Lecture 14/code/Basic Code"
npm run client
```

Relevant output:

```text
5. prompts/list -> review_pull_request
   prompts/get review_pull_request -> {"type":"text","text":"You are reviewing pull request #42. Check for bugs, maintainability issues and missing tests, then report findings as a short list."}
```

The `#42` in the text proves Block 3's substitution ran with the argument the client supplied.

---

## 7.6 Checkpoint

1. **Who drives a Prompt?** The **user** (via the UI), not the model.
2. **What does the client send vs what the server owns?** The client sends only the *arguments*
   (`prNumber: "42"`); the server owns the *wording* of the instruction.
3. **What does `prompts/get` return?** A `messages` array — conversation-shaped turns ready to send
   to the model. It changes no state.

**Next:** [Chapter 08 — Entry Point: STDIO Transport](./08_Entry_Point_STDIO_Transport.md)

