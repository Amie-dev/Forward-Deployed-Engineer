# Chapter 12: MCP — Prompts

> **Chapter goal:** Expose reusable, *user-selected* instructions — and keep them pure
> templates that ask the model to call a tool rather than baking in live data.

---

## 12.1 File details

| | |
| :--- | :--- |
| **Path** | `src/mcp/prompts.ts` |
| **Layer** | mcp (imports the SDK type and `zod/v4`) |
| **Purpose** | Register two prompts — `daily_task_briefing` and `review_pull_request` — as argument-substituting templates |
| **Imports** | `type McpServer`, `zod/v4` |
| **Exports** | `registerPrompts()` |
| **Consumed by** | `src/mcp/server.ts` |
| **Lecture sections** | [06 — Resources and Prompts](../../../notes/06_Resources_and_Prompts.md) §6.6 (the control model), §6.7 (prompts) |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the catalogue and one substituted prompt
npm run host | sed -n '39,40p'
```

---

## 12.2 Full file

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Chapter 06 §6.7 — Prompts: reusable instructions.
 *
 * A Prompt is *reuse*, and it is **user-controlled**: the UI lists it, the user
 * picks it, and `prompts/get` returns messages with the arguments substituted.
 * The model does not choose prompts, a prompt changes no state, and it has no
 * side effects.
 *
 * The rule that keeps prompts composable — and the one most implementations
 * break — is that **a prompt never reads live data**. It may *ask the model* to
 * call a tool; it must not pre-bake the answer. The moment a prompt embeds a
 * snapshot of the board, it becomes stale the second after it is fetched and
 * the model starts quoting yesterday's state with total confidence.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "daily_task_briefing",
    {
      title: "Daily Task Briefing",
      description:
        "Asks the model to read the board and propose the single next action. The prompt supplies the instructions; the tool supplies the facts.",
      argsSchema: z.object({
        owner: z.string().min(1).max(60).optional().describe("Optional name to address the briefing to"),
      }),
    },
    ({ owner }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              owner === undefined ? "You are preparing a task briefing." : `You are preparing a task briefing for ${owner}.`,
              "Call list_tasks to read the current board, then answer with at most three bullets:",
              "1. what is still PENDING, 2. what has been COMPLETED, 3. the single next action worth taking.",
              "Never mention a task that list_tasks did not return, and never invent an id.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_pull_request",
    {
      title: "Review Pull Request",
      description: "Asks the model to review a pull request for bugs, maintainability issues and missing tests.",
      argsSchema: z.object({
        prNumber: z.string().min(1).max(10).describe("Pull request number, e.g. 42"),
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

## 12.3 Block-by-block explanation

### Block 1 — the control model, and the one rule

The header comment states the three properties of a prompt, and the third is the design
constraint:

> A Prompt is *reuse*, and it is **user-controlled**: the UI lists it, the user picks it, and
> `prompts/get` returns messages with the arguments substituted. The model does not choose
> prompts, a prompt changes no state, and it has no side effects.

Put the three primitives side by side, because Chapter 06 §6.6 turns on exactly this table:

| Primitive | Verb | Driven by | Discovery | Retrieval | Side effects |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tools** | *do* | the **model** | `tools/list` | `tools/call` | usually yes |
| **Resources** | *know* | the **application** | `resources/list`, `resources/templates/list` | `resources/read` | no |
| **Prompts** | *reuse* | the **user** | `prompts/list` | `prompts/get` | no |

The three drivers are the point. A tool is chosen by the model, a resource is fetched by the
application, and a prompt is picked by the **user** — usually from a slash-command menu in the
host's UI. That is why `prompts/get` takes *arguments* rather than being a fixed string: the
user picks the template, then supplies the specifics.

**The rule that most implementations break:**

> **a prompt never reads live data.** It may *ask the model* to call a tool; it must not
> pre-bake the answer. The moment a prompt embeds a snapshot of the board, it becomes stale the
> second after it is fetched and the model starts quoting yesterday's state with total
> confidence.

This is a strong claim, and it is worth being precise about why. A prompt handler *could*
call `deps.service.list()` and embed the board — the SDK would happily allow it. The result
would be a prompt that looks better in a demo and fails in production for three reasons:

1. **It goes stale immediately.** The prompt is fetched once, at the moment the user selects
   it. The board changes; the prompt does not. The model then reasons over a snapshot with no
   indication that it is old.
2. **It duplicates the tool contract.** The board's format would be defined in two places —
   the tool's `outputSchema` and the prompt's text — and they would drift.
3. **It removes the model's chance to notice.** A prompt that says "call `list_tasks`" gives
   the model a tool result it can cite, with ids it can reuse. A prompt that embeds the board
   gives it prose with no provenance.

Notice the shape of the instruction that follows the rule: *"Call list_tasks to read the
current board."* The prompt supplies the **instructions**; the tool supplies the **facts**.
That division is the whole design, and it is why the description of `daily_task_briefing`
says so explicitly: *"The prompt supplies the instructions; the tool supplies the facts."*

### Block 2 — `registerPrompts(server)`, and the dependency that is absent

```ts
export function registerPrompts(server: McpServer): void {
```

**What it does:** registers the prompts.
**How it works:** takes only the server — **no `ServerDeps`**.

This is the only registrar of the three that needs no dependencies, and the signature is
evidence for the rule above. Compare:

| Registrar | Signature | Why |
| :--- | :--- | :--- |
| `registerTools` | `(server, deps)` | needs the service, logger, metrics, limiter, timeout |
| `registerResources` | `(server, deps)` | needs the service — the template reads live state |
| `registerPrompts` | `(server)` | needs **nothing** — a prompt reads no data |

A reviewer can read that table and immediately see that prompts are pure. If a future change
adds `deps` to this signature, it is a signal that the "never reads live data" rule has been
broken — which is exactly the kind of thing a signature should make visible.

### Block 3 — `daily_task_briefing`: a prompt that asks for a tool call

```ts
server.registerPrompt(
  "daily_task_briefing",
  {
    title: "Daily Task Briefing",
    description:
      "Asks the model to read the board and propose the single next action. The prompt supplies the instructions; the tool supplies the facts.",
    argsSchema: z.object({
      owner: z.string().min(1).max(60).optional().describe("Optional name to address the briefing to"),
    }),
  },
  ({ owner }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            owner === undefined ? "You are preparing a task briefing." : `You are preparing a task briefing for ${owner}.`,
            "Call list_tasks to read the current board, then answer with at most three bullets:",
            "1. what is still PENDING, 2. what has been COMPLETED, 3. the single next action worth taking.",
            "Never mention a task that list_tasks did not return, and never invent an id.",
          ].join("\n"),
        },
      },
    ],
  }),
);
```

**What it does:** returns one user message instructing the model to read the board and summarise
it.
**How it works:** `registerPrompt(name, { title, description, argsSchema }, buildCallback)`.

**`argsSchema` is the prompt's input contract**, and `owner` is `.optional()` — so `prompts/get`
works with or without it. The `.describe()` is the UI hint: an inspector renders argument forms
from this schema, so the description is what a *user* reads in the picker, not what the model
reads.

**The callback destructures `{ owner }` and returns `{ messages: [...] }`.** The return type is a
`GetPromptResult` — a list of messages, exactly like a chat history. Note what this means: **a
prompt can return more than one message**, including an `assistant` turn. A prompt could
therefore supply a few-shot example (a `user` message followed by an `assistant` reply) before
the real instruction. This one returns a single `user` message, which is the common case.

**`role: "user" as const` and `type: "text" as const`.** The `as const` assertions are needed
here, and the reason is the same one Chapter 05 covered for `TextBlock`: the SDK's types are
discriminated unions, and a plain string literal widens to `string` without the assertion. The
`TextBlock` type alias in `core/errors.ts` avoided this for tool results by typing the field as
the literal; here the object is inline, so the assertion does the job.

**The text is built with an array and `.join("\n")`, not a template literal with embedded
newlines.** Two reasons: the conditional `owner` line is a clean ternary rather than an inline
`${...}` that would leave a blank line when absent, and each instruction is a separately
readable string. The `\n` join produces the same bytes as a multi-line template literal, with
better source formatting.

**The four lines are doing four different jobs:**

| Line | Job |
| :--- | :--- |
| "You are preparing a task briefing for Aminul." | **Role and context** — including the optional name |
| "Call list_tasks to read the current board, then answer with at most three bullets:" | **The action** — names the tool explicitly, and caps the output |
| "1. what is still PENDING, 2. what has been COMPLETED, 3. the single next action worth taking." | **The shape of the answer** — numbered, so the model produces three sections |
| "Never mention a task that list_tasks did not return, and never invent an id." | **The anti-hallucination clause** |

The last line is the one worth dwelling on, and it is the clause most prompts omit. It
pre-empts the two specific failure modes of a board summary: inventing a task, and inventing an
id. Compare it with a generic "do not hallucinate", which names no failure and is therefore
unactionable. **Naming the exact failure mode is what makes the guardrail work** — the same
principle as the recovery sentences in Chapter 05, applied to a prompt.

Note also that "at most three bullets" is a *budget*. Without it, a model given a twenty-task
board will happily summarise all twenty, and the briefing becomes a second copy of `list_tasks`
— more tokens, less signal.

### Block 4 — `review_pull_request`: the purest possible prompt

```ts
server.registerPrompt(
  "review_pull_request",
  {
    title: "Review Pull Request",
    description: "Asks the model to review a pull request for bugs, maintainability issues and missing tests.",
    argsSchema: z.object({
      prNumber: z.string().min(1).max(10).describe("Pull request number, e.g. 42"),
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
```

**What it does:** substitutes one argument into a fixed instruction.
**How it works:** the same registration shape, with one required argument.

This prompt is carried over from the **Basic Code** version of this server, deliberately, and it
earns its place by contrast. Look at what it does *not* do: it does not call a tool, it does not
read the repository, it does not know what the pull request contains. It is pure instruction —
and that is a legitimate prompt.

The three primitives cover three needs, and this prompt covers a need with no tool behind it:

| Need | Primitive | Example |
| :--- | :--- | :--- |
| Do something | Tool | `create_task` |
| Know something | Resource | `company://policies/return-policy` |
| **Reuse an instruction** | **Prompt** | `review_pull_request` |

There is no `review_pull_request` *tool*, because there is nothing for the server to execute —
the work happens in the model, using the diff the host already has in context. The prompt's
contribution is the **checklist**: "bugs, maintainability issues and missing tests". That is
institutional knowledge, encoded once and reused by every developer who selects it.

**`prNumber` is typed `z.string()`, not `z.number()`.** Argument values arrive as strings from a
UI form, and a pull request "number" is an identifier rather than a quantity — nobody subtracts
one PR from another. Typing it as a number would force a parse and buy nothing. The `.max(10)`
bound is there because an unbounded string in a prompt is a token-injection vector: a
100,000-character "PR number" would be inserted straight into the instruction.

**The description is written for the user, not the model.** `prompts/list` is what a host renders
in a menu, so this string is what a developer reads when deciding whether to pick it. That is a
different audience from a tool description — which is why it says "Asks the model to review…"
rather than "Use when…".

---

## 12.4 Run / verify

The catalogue and one substituted prompt:

```bash
npm run host | sed -n '39,40p'
```

```text
9. prompts     -> prompts/list: daily_task_briefing, review_pull_request
   prompts/get daily_task_briefing -> You are preparing a task briefing for Aminul. Call list_tasks to read the current board, then answer with at most three bullets: 1…
```

The `owner: "Aminul"` argument from the demo was substituted into the first line, and the
instruction that follows names `list_tasks` rather than embedding a board. **Nothing about the
current tasks appears in the prompt** — the rule from Block 1, visible in the output.

Confirm the substitution and the optional case directly:

```bash
npx tsx -e '
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
(async () => {
  const client = new Client({ name: "probe", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "src/index.ts"], stderr: "ignore",
  }));

  const list = await client.listPrompts();
  console.log("prompts/list:");
  for (const prompt of list.prompts) {
    const args = (prompt.arguments ?? []).map((a) => a.name).join(", ");
    console.log(`  ${prompt.name.padEnd(22)} args: ${args || "(none)"}`);
  }

  const withOwner = await client.getPrompt({ name: "daily_task_briefing", arguments: { owner: "Aminul" } });
  console.log("\nwith owner :", withOwner.messages[0].content.text.split("\n")[0]);

  const withoutOwner = await client.getPrompt({ name: "daily_task_briefing", arguments: {} });
  console.log("no owner   :", withoutOwner.messages[0].content.text.split("\n")[0]);

  const review = await client.getPrompt({ name: "review_pull_request", arguments: { prNumber: "42" } });
  console.log("review     :", review.messages[0].content.text);

  await client.close();
})();
'
```

```text
prompts/list:
  daily_task_briefing    args: owner
  review_pull_request    args: prNumber

with owner : You are preparing a task briefing for Aminul.
no owner   : You are preparing a task briefing.
review     : You are reviewing pull request #42. Check for bugs, maintainability issues and missing tests, then report findings as a short list.
```

Four things confirmed:

1. **`prompts/list` publishes the argument names** — `owner` and `prNumber` — derived from
   `argsSchema`. That is how a host knows what form to render.
2. **The argument is substituted** — `Aminul` appears in the first line.
3. **An optional argument can be omitted**, and the ternary produced the owner-less variant rather
   than a blank. This is the case the `owner === undefined` check exists for.
4. **`review_pull_request` is pure instruction** — no tool call, no server state, just a checklist
   with `#42` substituted in.

> **Note that no prompt read the board.** The only way to see the tasks is `list_tasks`, which is
> a tool. A prompt that embedded them would have produced a longer, more impressive output — and
> would have been wrong the moment a task changed.

---

## 12.5 Checkpoint

1. **Prompts are user-driven.** The model does not choose them, they change no state, and
   `prompts/get` substitutes arguments into a template.
2. **A prompt never reads live data.** It asks the model to call a tool; the tool supplies the
   facts. A snapshot in a prompt is stale the second after it is fetched.
3. **`registerPrompts(server)` needs no `ServerDeps`** — the signature is the proof that prompts
   are pure, and a future change to it is a signal the rule was broken.
4. **`argsSchema` is a UI contract.** Its `.describe()` values are read by a user in a picker, and
   its optionality decides whether the argument can be omitted.
5. **A prompt can return several messages**, including an `assistant` turn — which is how few-shot
   examples are supplied.
6. **Name the failure mode in the guardrail.** "Never invent an id" works; "do not hallucinate"
   does not.
7. **A prompt with no tool behind it is legitimate.** `review_pull_request` exists because the
   checklist is institutional knowledge, and the work happens in the model.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 11 — MCP: Resources & Templates](./11_Mcp_Resources.md)

**Next:** [Chapter 13 — MCP: Server Assembly](./13_Mcp_Server_Assembly.md)



