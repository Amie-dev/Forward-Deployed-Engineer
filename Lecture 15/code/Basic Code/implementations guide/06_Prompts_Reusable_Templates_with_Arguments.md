# Chapter 06 — Prompts: Reusable Templates with Arguments

> **Goal of this chapter:** register two Prompts — one with an argument, one without — and pin
> down the sentence the whole lecture turns on: **an MCP Prompt is a message template, not an
> answer.**
>
> **Lecture chapters:** [06 — MCP Prompts: Reusable Interaction Templates](../../../notes/06_MCP_Prompts_Reusable_Interaction_Templates.md)
> and [07 — Prompt Arguments, Discovery and Client Wiring](../../../notes/07_Prompt_Arguments_Discovery_and_Client_Wiring.md).

---

## 6.1 File details

| | |
|---|---|
| **Path** | `src/prompts/prompts.ts` |
| **Purpose** | declare the Prompt catalogue: the workflows a **user** can choose |
| **Imports** | `type McpServer` from `@modelcontextprotocol/server`; `* as z from "zod/v4"` |
| **Exports** | `registerPrompts(server)` |
| **Depends on** | nothing in `src/` — prompts are self-contained templates |
| **Called by** | `src/server/server.ts` |
| **Implements** | Lecture 06 (what a Prompt is, Prompt ≠ LLM response), Lecture 07 (arguments, discovery) |

## 6.2 Commands

```bash
npm run lifecycle     # step 5 lists the prompts, step 6 fetches one
```

---

## 6.3 Full file

**Path:** `src/prompts/prompts.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Chapter 06/07 — Prompts: reusable interaction templates, controlled by the USER.
 *
 * A Prompt is a *message template*, not an answer. `prompts/get` returns the
 * messages to send to the model with the arguments substituted in, and nothing
 * in this file calls a model — that is Chapter 07 §7.3.
 *
 * Note what the templates *say*: they tell the model which Resources to read
 * and which Tools exist. That is how a Prompt cooperates with the other two
 * primitives (Chapter 07 §7.2) without the Prompt knowing anything about them.
 */
export function registerPrompts(server: McpServer): void {
  /* ── with an argument — the template is useless until the user supplies one ── */

  server.registerPrompt(
    "plan_day",
    {
      title: "Plan my day",
      description:
        "Build an ordered plan for the tasks already on the backlog, using the hours the user has available.",
      argsSchema: z.object({
        availableHours: z.string().describe("Number of hours available today, e.g. 4"),
      }),
    },
    ({ availableHours }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me plan my pending tasks for today.

First read my current pending tasks, then apply the task guidelines.

I have ${availableHours} hours available today.

Give me a concise and ordered plan.`,
          },
        },
      ],
    }),
  );

  /* ── without an argument — a Prompt is not required to take any ─────────── */

  server.registerPrompt(
    "review_workload",
    {
      title: "Review my workload",
      description: "Look at the current backlog and say whether it is realistic, and what to drop first.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Review my current workload.

Read my open tasks, then tell me:
1. whether the total is realistic, and
2. which tasks I should drop or defer first, and why.`,
          },
        },
      ],
    }),
  );
}
```

---

## 6.4 The one sentence this file exists to prove

```text
MCP Prompt  ≠  LLM response
```

- `prompts/get` **returns the question**, fully assembled, with arguments substituted.
- It does **not** call a model, and it does **not** return an answer.

Everything below is a consequence of that. The file has no `openai` import, no `fetch`, no
network call of any kind — and yet it is the entire server half of the Prompt feature.

The client half (turning that question into an answer) is Chapter 08. Keeping them in different
files is the clearest possible way to show they are different steps.

---

## 6.5 Block-by-block explanation

### Block 1 — the imports

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
```

- `import type` again: `McpServer` is only a type here, so it is erased at compile time.
- `import * as z from "zod/v4"` is the **namespace import**. It brings in the whole Zod module
  under the name `z`, which is why schemas read as `z.object({ … })`. The explicit `/v4` subpath
  pins the schema library to Zod 4, whose `.describe()` method turns a field into a description
  the model can read.
- **Note what is missing:** no `../services/…`, no `../resources/…`, no `../config/…`. A Prompt
  file needs nothing but the server and a schema library. That is a real architectural signal:
  Prompts are self-contained text, which is why they are the cheapest primitive to add.

### Block 2 — the registration signature

```ts
server.registerPrompt(
  name,      // "plan_day"
  config,    // { title, description, argsSchema? }
  callback   // (args) => { messages: [...] }
);
```

- **`name`** — `"plan_day"`. This is what `prompts/get` is called with, and what a UI shows in a
  command menu.
- **`config.argsSchema`** — optional. When present, it declares the arguments; when absent, the
  Prompt takes none. That single optional field is the difference between the two registrations
  in this file.
- **`callback`** — receives the **parsed arguments** and returns `{ messages: [...] }`. Unlike a
  Resource callback it is not `async` here, because nothing is awaited. A prompt that read from a
  database would be `async` with no other change.

### Block 3 — the Prompt *with* an argument

```ts
server.registerPrompt(
  "plan_day",
  {
    title: "Plan my day",
    description:
      "Build an ordered plan for the tasks already on the backlog, using the hours the user has available.",
    argsSchema: z.object({
      availableHours: z.string().describe("Number of hours available today, e.g. 4"),
    }),
  },
  ({ availableHours }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me plan my pending tasks for today.

First read my current pending tasks, then apply the task guidelines.

I have ${availableHours} hours available today.

Give me a concise and ordered plan.`,
        },
      },
    ],
  }),
);
```

- `argsSchema: z.object({ availableHours: z.string().describe(…) })` declares **one required
  string argument**. Two consequences:
  1. `prompts/list` will report it, so a client can render a text box and know what to ask for.
  2. The callback's parameter is **typed**. `({ availableHours })` destructures the parsed
     object, and TypeScript knows it is a `string` — no cast, no `any`.
- `.describe("Number of hours available today, e.g. 4")` is not documentation for you. It is
  **part of the protocol surface**: it appears in `prompts/list` and tells a client (or a model
  choosing a prompt) what value to supply. The `e.g. 4` is there because `"4"` and `"four"` are
  both valid strings, and the example removes the ambiguity.
- **Why `z.string()` and not `z.number()`?** Because this is a *message template*. The value is
  interpolated into English prose, and it arrives from a URL query parameter (Chapter 09) where
  everything is already a string. Declaring it as a string keeps the whole path cast-free.
- `role: "user" as const` — the `as const` matters. Without it TypeScript widens `"user"` to
  `string`, which no longer satisfies the `role` union of `"user" | "assistant"`. It is a
  two-word fix for a confusing error message, and it appears on every message in this file.
- `type: "text" as const` does the same job for the content block type.

- **The template body is the lecture's board verbatim:**

  ```text
  Help me plan my pending tasks for today.

  First read my current pending tasks, then apply the task guidelines.

  I have 4 hours available today.

  Give me a concise and ordered plan.
  ```

  - `` ${availableHours} `` is the substitution. It is plain template-literal interpolation —
    there is no special MCP templating language.
  - **"First read my current pending tasks, then apply the task guidelines."** is the
    cooperation clause from Lecture 07 §7.2. The Prompt is telling the *model* to go and use the
    other two primitives: read `task://backlog`, read `task://guidelines`. The Prompt does not
    import them, does not call them, and does not need to know they exist as code — it only
    describes the workflow in words.
  - That is why the templates are written as instructions rather than as bare questions. A bare
    *"plan my day"* would work, but it would leave the model guessing about the rules and the
    hours.

### Block 4 — the Prompt *without* an argument

```ts
server.registerPrompt(
  "review_workload",
  {
    title: "Review my workload",
    description: "Look at the current backlog and say whether it is realistic, and what to drop first.",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Review my current workload.

Read my open tasks, then tell me:
1. whether the total is realistic, and
2. which tasks I should drop or defer first, and why.`,
        },
      },
    ],
  }),
);
```

- **No `argsSchema` key at all.** That is what makes this a zero-argument Prompt. The callback
  takes **no parameter** — `() => ({ … })` — which is honest about the fact that there is nothing
  to receive.
- This is the board's second menu entry (*"Review my workload"*). It exists to show that a Prompt
  is not required to be parameterised. Plenty of real workflows are fixed: *"Summarise this
  thread"*, *"Write release notes"*, *"Explain this error"*.
- The numbered list inside the template is doing real work. It constrains the answer's **shape**,
  which is what makes a Prompt reusable: every run of `review_workload` produces a two-part
  answer you can render the same way.
- Like `plan_day`, it opens with a cooperation clause: *"Read my open tasks, then tell me…"*.

### Block 5 — the two registrations side by side

| | `plan_day` | `review_workload` |
|---|---|---|
| `argsSchema` | `z.object({ availableHours })` | absent |
| callback parameter | `({ availableHours })` | none |
| `prompts/list` reports | one argument | no arguments |
| called as | `getPrompt({ name, arguments: { availableHours: "4" } })` | `getPrompt({ name })` |
| returns | `{ messages: [ one user message ] }` | `{ messages: [ one user message ] }` |

The **return shape is identical**. That is the point: arguments change the *content* of the
template, never the *shape* of the result.

---

## 6.6 Why prompts belong on the server

A fair question: why not keep `plan_day` as a string constant in the client?

Because the **server** owns the workflow, and the workflow has to stay in step with the
capabilities:

- The template says *"read my current pending tasks"* and *"apply the task guidelines"*. Those
  are `task://backlog` and `task://guidelines` — Resources that exist **on this server**. If the
  server's Resource catalogue changes, the Prompt that references it changes in the same
  repository, in the same commit.
- A client is the wrong place for it: every host (a CLI, a web app, an IDE plugin) would have to
  re-implement the same workflow, and they would drift.
- And the **user** picks from the menu the server publishes. `prompts/list` is the menu;
  `prompts/get` is the order. Neither makes sense without the server.

That is Lecture 06's *"why prompts belong on the server"*, expressed as a dependency direction:
**Prompts point at Resources; Resources never point at Prompts.**

---

## 6.7 Run / verify

```bash
npm run lifecycle
```

Steps 5 and 6 of the output:

```text
5. prompts/list — which workflows exist?
   plan_day(availableHours)
   review_workload()

6. prompts/get plan_day { availableHours: "4" } — a template, not an answer
   Help me plan my pending tasks for today.

   First read my current pending tasks, then apply the task guidelines.

   I have 4 hours available today.

   Give me a concise and ordered plan.
```

Three things to check in that output:

1. **`plan_day(availableHours)` vs `review_workload()`** — the argument list is printed straight
   from `argsSchema`. That is `prompts/list` doing its job as a menu.
2. **`I have 4 hours available today.`** — the argument was substituted. You passed `"4"`, and
   the template rendered it.
3. **There is no answer.** Step 6 ends with the prompt. No model was consulted, because
   `prompts/get` does not consult one.

To see the *same* prompt fetched over HTTP without any model involvement at all:

```bash
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day&hours=8'
```

Note `hours=8` — change the argument and the rendered template changes.

---

## 6.8 Checkpoint

1. **What does `prompts/get` return?** → `{ messages: [...] }` — a message template with
   arguments substituted. Not an answer.
2. **What makes a Prompt take arguments?** → the optional `argsSchema` in the config object. Omit
   it and the callback takes no parameter.
3. **Why is `role: "user" as const` needed?** → without `as const`, TypeScript widens `"user"` to
   `string`, which no longer matches the `role` union.
4. **How do Prompts cooperate with the other primitives?** → by *describing* them in prose
   ("read my open tasks", "apply the task guidelines"). No imports, no calls.
5. **Which file turns a fetched Prompt into an answer?** → `src/client/client.ts` (Chapter 08),
   in `askModel()` — the only place a model appears.

**Next:** [Chapter 07 — Tools & Server Assembly](./07_Tools_and_Server_Assembly.md)


