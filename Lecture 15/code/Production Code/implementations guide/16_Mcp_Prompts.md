# Chapter 16 — MCP: The Prompts Primitive

> **Prompts are the primitive where the USER holds the trigger.** A Prompt is *reuse*: the UI lists it, the user
> picks it, and `prompts/get` returns messages with the arguments substituted. The model does not choose prompts, a
> prompt changes no state, and it has no side effects. This chapter's file is short, and two of its most important
> properties are proved by what it does **not** contain.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/mcp/prompts.ts` (128 lines) |
| **Layer** | `mcp` |
| **Purpose** | Register the prompt menu from `promptService.list()`, passing the **same** `argsSchema` the service validates against, and map failures to protocol errors that keep their class. |
| **Exports** | `registerPrompts()` |
| **Lecture sections** | Ch06 §6.7/6.9 (the primitive, staleness), Ch07 §7.3/7.4 (no model, fail loudly) |
| **Runs** | `npm run lifecycle` step 10 · `GET /prompts` |

---

## Commands

```bash
# the menu, derived from the schemas
npm run lifecycle 2>/dev/null | sed -n '/^10\./,/^11\./p'

# a prompt rendered with no model anywhere in the process
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day&availableHours=4'

# and the two refusals
curl -s 'http://127.0.0.1:8080/prompt?name=nope'
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day'
```

---

## Two properties, proved by absence

The header names them, and both are claims about what the *server process* contains:

> · **No model.** There is no `openai` import anywhere in the server process. `prompts/get` returns messages; the
> model call happens in the host, afterwards (Notes Ch07 §7.3). *"The server starts and serves without an LLM or an
> API key — that property is worth defending."*
>
> · **No live data.** Nothing here reads the task store. The templates tell the model to call `list_tasks` and read
> `task://guidelines`; they do not pre-bake the answer. A prompt that embeds a snapshot is stale a second later
> (Notes Ch06 §6.9).

Both are *negative* claims, which are the hardest kind to verify by reading code — you would have to read everything
else. So they are checkable instead:

```bash
grep -rn 'openai' src/ | grep -v '^src/host/model.ts'
# (nothing — the only import is the dynamic one in host/model.ts)
```

That is the whole argument for keeping the server and host as separate processes: a property like *"the server cannot
call a model"* is enforceable when the server's dependency set makes it true, and unenforceable when it is a
convention.

And note the second claim's *mechanism*, which is the interesting half. `registerPrompts` never calls `deps.tasks`.
Look at what it reads from `deps`: `deps.prompts` and `deps.limiter`, plus `deps.metrics` and `deps.logger`. **The
task service is not in the list**, so no code in this file could embed live data even by accident. That is the
`ServerDeps` split from Chapter 13 paying off — a field that is not read cannot be misused.

---

## `src/mcp/prompts.ts` — the full file

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { PromptError, toAppError } from "../core/errors.js";
import type { ServerDeps } from "./deps.js";
import { toProtocolError } from "./protocol.js";

/**
 * Notes Ch06 §6.7 and Ch07 §7.3 — **The Prompts Primitive**, where the **user**
 * holds the trigger.
 *
 * A Prompt is *reuse*: the UI lists it, the user picks it, and `prompts/get`
 * returns messages with the arguments substituted. The model does not choose
 * prompts, a prompt changes no state, and it has no side effects.
 *
 * Two things this file proves by *not* containing them:
 *
 *  · **No model.** There is no `openai` import anywhere in the server process.
 *    `prompts/get` returns messages; the model call happens in the host,
 *    afterwards (Notes Ch07 §7.3). *"The server starts and serves without an
 *    LLM or an API key — that property is worth defending."*
 *
 *  · **No live data.** Nothing here reads the task store. The templates tell the
 *    model to call `list_tasks` and read `task://guidelines`; they do not
 *    pre-bake the answer. A prompt that embeds a snapshot is stale a second
 *    later (Notes Ch06 §6.9).
 *
 * The registrations are driven from `promptService.list()`, so the menu the
 * server advertises and the menu the service validates against cannot disagree.
 */
export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  for (const summary of deps.prompts.list()) {
    const spec = deps.prompts.byName(summary.name);

    if (spec === undefined) {
      // Unreachable in practice — `list()` and `byName()` read the same table —
      // but a missing spec would otherwise register a prompt with no schema.
      throw toProtocolError(
        new PromptError(
          "UNAVAILABLE",
          `Prompt "${summary.name}" is listed but has no specification.`,
          "This is a server-side wiring bug; report it rather than retrying.",
          { httpStatus: 500 },
        ),
      );
    }

    server.registerPrompt(
      summary.name,
      {
        title: summary.title,
        description: summary.description,
        /**
         * The *same* schema the service validates against, so the arguments a
         * client is told about are exactly the arguments that will be accepted.
         * A hand-written second list is how a server ends up advertising an
         * argument it then refuses.
         */
        argsSchema: spec.argsSchema,
      },
      async (args) => {
        /**
         * The limiter applies here even though the render is local, because this
         * call is the entry point to the *expensive* path: what follows a
         * successful `prompts/get` is a model call, and that is the thing a
         * runaway client would be spending.
         *
         * There is deliberately **no timeout guard**. `prompts/get` is a
         * synchronous template render with no I/O, so a timer would add a handle
         * to clear and nothing else. The budget that matters belongs to the LLM
         * call, and that one lives in the host (Notes Ch07 §"budgets").
         */
        const limit = deps.limiter.check(`prompt:${summary.name}`);

        if (!limit.allowed) {
          deps.metrics.count("prompt.error.LIMIT_EXCEEDED");

          throw toProtocolError(
            new PromptError(
              "LIMIT_EXCEEDED",
              `Rate limit reached for ${summary.name}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
              "Wait for the window to pass, then retry once.",
              { retryable: true },
            ),
          );
        }

        try {
          const render = deps.prompts.get(summary.name, args);

          deps.metrics.count("prompt.get");
          deps.metrics.count(`prompt.get.${summary.name}`);
          deps.logger.info("prompt.get", {
            prompt: summary.name,
            version: render.version,
            messages: render.messages.length,
            // The *shape* of the arguments, never their values: a prompt
            // argument can carry anything a user typed (Notes Ch06 §"Prompt
            // hygiene" — no secrets in a log, and none in a prompt either).
            argNames: Object.keys(args),
          });

          return {
            description: render.description,
            messages: render.messages.map((message) => ({
              role: message.role,
              content: { type: "text" as const, text: message.text },
            })),
          };
        } catch (error) {
          const failure = toAppError("prompt", error, summary.name);

          deps.metrics.count("prompt.error");
          deps.metrics.count(`prompt.error.${failure.code}`);
          deps.logger.warn("prompt.failure", {
            prompt: summary.name,
            code: failure.code,
            message: failure.message,
          });

          // A prompt failure is a protocol error, so it travels as one: an
          // unknown name or a bad argument must not be papered over with an
          // empty message list (Notes Ch07 §7.4) — and it must keep its *class*
          // across the wire, or the host can only answer 503.
          throw toProtocolError(failure);
        }
      },
    );
  }
}
```

### Block-by-block

**Block 1 — the imports (lines 1–4).**

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { PromptError, toAppError } from "../core/errors.js";
import type { ServerDeps } from "./deps.js";
import { toProtocolError } from "./protocol.js";
```

**Four imports, and no `zod`.** That is notable: this registrar declares no schema of its own, because it reuses
`spec.argsSchema` from the service. Compare `mcp/tools.ts` (Chapter 14), which imports `zod` because tool schemas are
local to the protocol layer. Here there is nothing to declare.

`McpServer` and `ServerDeps` are type-only; `PromptError`, `toAppError` and `toProtocolError` are values. Four lines,
and the file's whole dependency surface is visible.

**Block 2 — the registration loop (lines 25–45).**

```ts
export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  for (const summary of deps.prompts.list()) {
    const spec = deps.prompts.byName(summary.name);

    if (spec === undefined) {
      throw toProtocolError(
        new PromptError(
          "UNAVAILABLE",
          `Prompt "${summary.name}" is listed but has no specification.`,
          "This is a server-side wiring bug; report it rather than retrying.",
          { httpStatus: 500 },
        ),
      );
    }

    server.registerPrompt(/* … */);
  }
}
```

**The loop is driven from `promptService.list()`**, and the header states the consequence:

> The registrations are driven from `promptService.list()`, so the menu the server advertises and the menu the service
> validates against cannot disagree.

That is the same single-source-of-truth discipline as `argumentsOf` (Chapter 11) and `metadataOf` (Chapter 15), at the
registration layer. Three prompts, and no prompt is named in this file.

**The `spec === undefined` guard is a wiring check, and the comment is honest about it:**

> Unreachable in practice — `list()` and `byName()` read the same table — but a missing spec would otherwise register
> a prompt with no schema.

This is the same instinct as Chapter 10's boot-time invariant, at a smaller scale. `list()` and `byName()` both read
the same `byName` Map inside `createPromptService` (Chapter 11), so a name from `list()` must be found by `byName()`.
The guard exists because the *alternative* — proceeding with an `undefined` spec — would register a prompt with no
`argsSchema`, which is a protocol-level problem that would surface as a client-side crash.

Note the failure shape: `UNAVAILABLE` with `{ httpStatus: 500 }` and a recovery sentence aimed at a developer —
*"This is a server-side wiring bug; report it rather than retrying."* Same pattern as the renderer's `default` branch
(Chapter 10). And note it is thrown at **registration** time, which happens in `createServer()` — so in practice the
server would refuse to start rather than serve a broken prompt.

**Block 3 — the `argsSchema` comment (lines 49–58).**

```ts
server.registerPrompt(
  summary.name,
  {
    title: summary.title,
    description: summary.description,
    /**
     * The *same* schema the service validates against, so the arguments a
     * client is told about are exactly the arguments that will be accepted.
     * A hand-written second list is how a server ends up advertising an
     * argument it then refuses.
     */
    argsSchema: spec.argsSchema,
  },
  /* … */
);
```

**`argsSchema: spec.argsSchema` — the object, not a copy, not a re-derivation.** That one line is what makes Chapter
11's "single source of truth" claim true all the way to the wire.

The alternative is the failure the comment names: a hand-written second list. Written out, the bug looks like this:

```text
prompts/list  advertises  availableHours  (required)
                                ↓
prompts/get   validates against a schema that requires  hours
                                ↓
the client renders a form for availableHours and the server rejects it
```

The user's experience is that the recommended workflow does not work, and the cause is two lists that were correct on
the day they were written. Passing the same object makes the divergence impossible — not unlikely, impossible, because
there is only one object.

The SDK derives the advertised argument list from `argsSchema` itself, which means this file does not even call
`argumentsOf` — the *service* does that for its own `list()` summary (Chapter 11), and the SDK does it again from the
schema for the protocol. Two derivations from one schema, which is fine: both are functions of the same source.

**Block 4 — the limiter, and the timeout that is deliberately absent (lines 60–88).**

```ts
async (args) => {
  const limit = deps.limiter.check(`prompt:${summary.name}`);

  if (!limit.allowed) {
    deps.metrics.count("prompt.error.LIMIT_EXCEEDED");

    throw toProtocolError(
      new PromptError(
        "LIMIT_EXCEEDED",
        `Rate limit reached for ${summary.name}; a slot frees in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
        "Wait for the window to pass, then retry once.",
        { retryable: true },
      ),
    );
  }
  ...
}
```

**The limiter applies, and the comment explains why that is not redundant for a local render:**

> The limiter applies here even though the render is local, because **this call is the entry point to the *expensive*
> path**: what follows a successful `prompts/get` is a model call, and that is the thing a runaway client would be
> spending.

That is the argument, and it is worth following. A `prompts/get` is nearly free — a string template with substitutions
(Chapter 11). So limiting it looks pointless. But the *reason* a client calls it is to get a prompt to send to a model,
and a model call is the most expensive operation in the system. So `prompts/get` is the cheapest place to stand in front
of the expensive thing.

That reframes what a rate limit is *for* here. It is not protecting the server's CPU — it is protecting the operator's
bill, and it does so at the first point where intent is visible. **A limiter on the cheap step that precedes an
expensive one is a limiter on the expensive one, applied earlier.**

**And there is no timeout guard, with the reasoning stated:**

> There is deliberately **no timeout guard**. `prompts/get` is a synchronous template render with no I/O, so a timer
> would add a handle to clear and nothing else. The budget that matters belongs to the LLM call, and that one lives in
> the host (Notes Ch07 §"budgets").

That is the same reasoning as Chapter 13's missing `promptTimeoutMs`. Three primitives, and only two have timeouts,
because only two can be slow. Adding a timer here would be worse than useless: it would allocate a handle per call,
require a `clearTimeout` on every path, and never fire.

And note the two limits differ in **class**: the tool path's `LIMIT_EXCEEDED` is a `ToolError` (an `isError` result),
while this one is a `PromptError` (a protocol error). Same code, different origin, different wire shape — the taxonomy
again.

The `{ retryable: true }` is correct here where it was `true` positionally for tools: a rate limit genuinely is worth
retrying, and the recovery sentence says when (*"Wait for the window to pass, then retry once"*).

**Block 5 — the success path, and the argument redaction (lines 90–112).**

```ts
try {
  const render = deps.prompts.get(summary.name, args);

  deps.metrics.count("prompt.get");
  deps.metrics.count(`prompt.get.${summary.name}`);
  deps.logger.info("prompt.get", {
    prompt: summary.name,
    version: render.version,
    messages: render.messages.length,
    argNames: Object.keys(args),
  });

  return {
    description: render.description,
    messages: render.messages.map((message) => ({
      role: message.role,
      content: { type: "text" as const, text: message.text },
    })),
  };
} catch (error) { /* … */ }
```

**`argNames: Object.keys(args)` is the most careful line in the file**, and its comment is the reason:

> The *shape* of the arguments, never their values: a prompt argument can carry anything a user typed (Notes Ch06
> §"Prompt hygiene" — no secrets in a log, and none in a prompt either).

So the log records `["availableHours"]`, never `"4"`. That is a small thing with a real failure behind it: a prompt
argument is free text a user typed, and a user may well type something they should not have. The logger's own key-based
redaction (Chapter 03) would catch a field *named* `token`, but it cannot catch a secret in a field named `project`.
Logging names instead of values sidesteps the whole problem — and the information an operator actually needs (which
prompt, which arguments were supplied) is preserved.

**`version: render.version`** — the prompt's version travels into the log line. That is what makes Chapter 11's
versioning operationally useful: an incident can be correlated with the exact prompt text that produced it.

**The return maps the service's messages into the protocol's shape:**

```ts
messages: render.messages.map((message) => ({
  role: message.role,
  content: { type: "text" as const, text: message.text },
})),
```

This is the one place where the service's `PromptMessage` (`{ role, text }`) becomes the protocol's message
(`{ role, content: { type: "text", text } }`). **A projection at the boundary**, exactly like `metadataOf` in Chapter
15 — the internal shape stays simple and the wire shape is constructed once, here.

The `as const` on `"text"` is needed so the literal type survives into the protocol's discriminated union rather than
widening to `string`. A small annotation with a type-level purpose.

**Block 6 — the failure path (lines 113–127).**

```ts
} catch (error) {
  const failure = toAppError("prompt", error, summary.name);

  deps.metrics.count("prompt.error");
  deps.metrics.count(`prompt.error.${failure.code}`);
  deps.logger.warn("prompt.failure", {
    prompt: summary.name,
    code: failure.code,
    message: failure.message,
  });

  throw toProtocolError(failure);
}
```

The comment states both halves of the requirement:

> A prompt failure is a protocol error, so it travels as one: an unknown name or a bad argument must not be papered
> over with an empty message list (Notes Ch07 §7.4) — and **it must keep its *class* across the wire, or the host can
> only answer 503.**

*Or the host can only answer 503* is the bug that was actually found by running the code, and it is the reason
`protocol.ts` exists (Chapter 05). Before `data.failureCode` was sent, an unknown prompt name and a missing argument
were indistinguishable to the host, and both became a 503 — inviting a caller to retry something no retry could fix.

Note the ordering in this file mirrors `readThrough` (Chapter 15) exactly: `toAppError` reclassifies, the metrics and
log record, `toProtocolError` encodes, and the result is **thrown**. Same three steps, same order, both resource-side
and prompt-side — because both are protocol-error primitives.

And note what is *not* logged here: the arguments. The failure log carries `prompt`, `code` and `message` — no `args`,
not even names. On the failure path the reason for the failure is the interesting thing, and the message already names
the offending field (Chapter 11's `Invalid arguments for prompt "plan_day" — availableHours: …`).

---

## Run / verify

### 1. "No model" — the negative claim, checked

```bash
grep -rn 'openai' src/
```

```text
src/mcp/prompts.ts:16:        *  · **No model.** There is no `openai` import anywhere in the server process.
src/controllers/healthController.ts:34:   model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline (no OPENAI_API_KEY)",
src/controllers/healthController.ts:73:   model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline",
src/host/model.ts:70:   const { default: OpenAI } = await import("openai");
src/host/model.ts:71:   const openai = new OpenAI();
src/host/model.ts:76:   const response = await openai.chat.completions.create({
```

Six hits, and reading them is the verification:

| Hit | Kind | Does it put a model in the server process? |
| :--- | :--- | :--- |
| `mcp/prompts.ts:16` | A **comment** in this file | No — it is the claim, not a call |
| `controllers/healthController.ts:34,73` | **String literals** for reporting (`"openai:gpt-5.4-mini"`) | No — the host *reports* which model it would use |
| `host/model.ts:70–76` | The **dynamic import** and the call | Only in the host, only when a key exists |

So the claim holds in the form that matters: **there is no `import` of a model client anywhere in the server's module
graph.** The two health-controller hits are the host telling an operator which model is configured — a string, not a
dependency.

And the import is **dynamic** — `await import("openai")` inside a function — which means the module is loaded only when
that line runs. With no `OPENAI_API_KEY`, it never runs, and `openai` is never loaded into memory. That is what makes
`npm run lifecycle` work on a machine with no credentials.

### 2. A prompt rendered with no model in the picture

```bash
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day&availableHours=4'
```

```json
{"name":"plan_day",
 "description":"Build an ordered plan for the tasks already on the backlog, using the hours the user has available. The prompt supplies the instructions; list_tasks supplies the facts.",
 "messages":[{"role":"user","content":{"type":"text","text":"Help me plan my pending tasks for today.\n\nFirst read my current pending tasks using the list_tasks tool, then apply the guidelines in the task://guidelines resource.\n\nI have 4 hours available today.\n\nGive me a concise and ordered plan. Do not invent tasks: every task you mention must have come from list_tasks."}}],
 "modelCalled":false,
 "note":"This is a message template, not an answer. prompts/get talks to the MCP server; the LLM call happens afterwards, elsewhere."}
```

Note the wire shape the handler built: `"content":{"type":"text","text":"…"}` — the protocol's message, projected
from the service's `{ role, text }` in Block 5. And `modelCalled: false`, which the host states explicitly so a caller
does not have to infer it.

### 3. The arguments are logged by name, never by value

```bash
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep prompt.get
```

```json
{"ts":"2026-10-23T20:52:03.034Z","level":"info","event":"prompt.get","server":"task-mcp-server","prompt":"plan_day","version":"1.0.0","messages":1,"argNames":["availableHours"]}
```

`"argNames":["availableHours"]` — **the name, not `"4"`.** The line carries everything an operator needs (which
prompt, which version, how many messages, which arguments were supplied) and nothing a user typed. Same discipline as
Chapter 03's key-based redaction, applied where redaction cannot reach: a field named `project` could contain anything.

`"version":"1.0.0"` is the other field worth noticing — Chapter 11's prompt version reaching the log, so an incident
can be correlated with the exact prompt text that produced it.

### 4. The two refusals keep their class

```bash
curl -s 'http://127.0.0.1:8080/prompt?name=nope'
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day'
```

```json
{"error":{"code":"NOT_FOUND","message":"Unknown prompt: \"nope\".","recovery":"Call GET /prompts to read the available names (plan_day, review_workload, weekly_plan).","retryable":false,"requestId":"8c16aa68"}}
{"error":{"code":"INVALID_INPUT","message":"Invalid arguments for prompt plan_day: availableHours: Invalid input: expected string, received undefined","recovery":"Correct the request to match the advertised contract, then retry once.","retryable":false,"requestId":"a1bd7267"}}
```

**404 and 400** — not two 503s. That is `toProtocolError(failure)` doing its job: the failure's *class* is encoded in
the JSON-RPC code and its name in `data.failureCode`, and the host reads both back (Chapter 05). Without it, the
comment in Block 6 would be describing this exact symptom: *"the host can only answer 503."*

And the first recovery sentence lists the **real menu** — `plan_day, review_workload, weekly_plan` — generated from
`[...byName.keys()]` in the service (Chapter 11). A host that got this 404 can fix its own copy of the menu.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Which two properties does this file prove by absence, and how can a negative claim be checked?**
   *No model* and *no live data*. By grepping: `grep -rn 'openai' src/` shows only a comment, two reporting strings in
   the host's health controller, and the dynamic import in `host/model.ts`. And `registerPrompts` reads `deps.prompts`
   and `deps.limiter` — **not `deps.tasks`** — so no code here could embed live data even by accident.

2. **Why is `argsSchema` passed as the service's own object?**
   So the arguments a client is told about are exactly the arguments that will be accepted. A hand-written second list
   is how a server ends up advertising an argument it then refuses — the client renders a field, the server rejects it.

3. **Why does a rate limiter apply to a local, near-free template render?**
   Because `prompts/get` is the **entry point to the expensive path**: what follows is a model call. Limiting the cheap
   step that precedes an expensive one is limiting the expensive one, applied earlier — at the first point where
   intent is visible.

4. **Why is there no timeout guard here?**
   Because `prompts/get` is a synchronous render with no I/O — a timer would add a handle to clear and never fire. The
   budget that matters belongs to the LLM call, which lives in the host.

5. **Why log `argNames` rather than `args`?**
   Because a prompt argument is free text a user typed, and the logger's key-based redaction cannot catch a secret in a
   field named `project`. Names give an operator what they need; values are the part that can hurt.

6. **Why must a prompt failure keep its class across the wire?**
   Because otherwise an unknown prompt name and a missing argument are indistinguishable to the host, and both get
   answered `503` — inviting a caller to retry something no retry can fix. `toProtocolError` encodes the class in the
   JSON-RPC code and the name in `data.failureCode`.

7. **What does the `spec === undefined` guard protect against, given it is unreachable?**
   Registering a prompt with **no schema**, which is a protocol-level problem a client would crash on. It fires at
   registration — inside `createServer()` — so the server refuses to start rather than serving a broken prompt.

---

**[← Chapter 15: The Resources Primitive](./15_Mcp_Resources.md)** · **[Chapter 17: Server Assembly →](./17_Mcp_Server_Assembly.md)**
