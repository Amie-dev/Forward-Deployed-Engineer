# Chapter 22 — Host: The Model Step & The Audit Trail

> **Two files, and between them the two things a production system is judged on after an incident:** *what exactly did we
> send?* and *who authorised this, and can we prove it?*

---

## File details

| | |
| :--- | :--- |
| **Files** | `src/host/model.ts` (117 lines), `src/host/audit.ts` (136 lines) |
| **Layer** | `host` |
| **Purpose** | `model.ts`: the **only** model call in the project, with an offline path that echoes the prompt. `audit.ts`: a record of every primitive with **hashed arguments and no content**. |
| **Exports** | `ModelReply`, `ModelInput`, `renderPrompt()`, `askModel()` · `AuditAction`, `AuditOutcome`, `AuditDecision`, `AuditRecord`, `AuditEntry`, `AuditLog`, `hashArgs()`, `createAuditLog()` |
| **Lecture sections** | Ch07 §7.3 (the model step), Ch08 §8.6 (the audit trail), Ch06 §"Prompt hygiene" |
| **Runs** | `npm run lifecycle` steps 11, 12, 13 |

---

## Commands

```bash
# the offline path — no key, so the prompt is echoed
npm run lifecycle 2>/dev/null | sed -n '/^11\./,/^12\./p'

# the audit table
npm run lifecycle 2>/dev/null | sed -n '/^12\./,/^13\./p'

# and the same records on the log stream
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep '"event":"audit"' | head -3
```

---

## The model step: the one place a model is involved

This is the claim the whole project is arranged to support, and the header states it as an argument rather than a
feature:

> This file is deliberately the **last** one in the build order, and deliberately the only one that mentions a model at
> all. Everything upstream of it — discovery, selection, authorisation, the budget, `prompts/get` — is ordinary,
> deterministic, testable software. That is the lecture's central claim, and **the file layout is the evidence: if the
> model call can be deleted and the rest still runs, the claim holds.**

That last sentence is a *test*, and it is one you can perform: delete this file, stub `askModel` to return a fixed string,
and every other chapter in this guide still runs. `npm run lifecycle`'s steps 1–10 do exactly that already, because the
offline path never calls a model.

The consequence is that "MCP is not the model" stops being a slogan and becomes a property of the dependency graph.
Chapter 16 verified the server side (`grep -rn 'openai' src/` finds nothing in the server's module graph); this chapter is
the host side, where the model lives — and the boundary is that *one file*.

### Why the key is allowed to be empty

> `hasModelKey` is false when `OPENAI_API_KEY` is unset, and then this function **echoes the assembled prompt instead of
> calling anything**. That is not a stub: it is what makes the Resource and Prompt half of the protocol fully visible on a
> machine with no credentials […] *"the server starts and serves without an LLM or an API key — that property is worth
> defending."*

And the second reason is the one that matters operationally:

> The offline path is also the **honest** one to read: it prints exactly what the model would have received, which is the
> single most useful thing to see when a grounded answer turns out to be wrong.

That is a debugging property, not a demo convenience. When a model answers incorrectly, the first question is *what did
it actually read?* — and in this system the answer is printable without a model, without an API key, and without a
round trip. The assembled prompt is deterministic output of deterministic code, so it can be inspected at will.

---

## `src/host/model.ts` — the full file

```ts
import { env, hasModelKey } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { PromptMessage } from "../services/promptService.js";

/**
 * Notes Ch07 §7.3 — **the one place in the project where a model is involved.**
 *
 * This file is deliberately the *last* one in the build order, and deliberately
 * the only one that mentions a model at all. Everything upstream of it —
 * discovery, selection, authorisation, the budget, `prompts/get` — is ordinary,
 * deterministic, testable software. That is the lecture's central claim, and the
 * file layout is the evidence: if the model call can be deleted and the rest
 * still runs, the claim holds.
 *
 * ## Why the key is allowed to be empty
 *
 * `hasModelKey` is false when `OPENAI_API_KEY` is unset, and then this function
 * **echoes the assembled prompt instead of calling anything**. That is not a
 * stub: it is what makes the Resource and Prompt half of the protocol fully
 * visible on a machine with no credentials, and it is the same property the
 * production checklist asks for — *"the server starts and serves without an LLM
 * or an API key — that property is worth defending."*
 *
 * The offline path is also the *honest* one to read: it prints exactly what the
 * model would have received, which is the single most useful thing to see when a
 * grounded answer turns out to be wrong.
 */

export interface ModelReply {
  text: string;
  /** `model` when a model answered; `offline` when the prompt was echoed instead. */
  source: "model" | "offline";
  model: string;
}

export interface ModelInput {
  /** The assembled system message — the preamble plus the fenced resources. */
  system: string;
  /** The prompt's messages, in order. */
  messages: readonly PromptMessage[];
  logger: Logger;
  metrics: Metrics;
}

/** Renders the request as text, for the offline path and for the audit trail. */
export function renderPrompt(system: string, messages: readonly PromptMessage[]): string {
  const body = messages.map((message) => `${message.role.toUpperCase()}:\n${message.text}`).join("\n\n");

  return `SYSTEM:\n${system}\n\n${body}`;
}

export async function askModel(input: ModelInput): Promise<ModelReply> {
  const { system, messages, logger, metrics } = input;

  if (!hasModelKey) {
    const text = `(offline — no OPENAI_API_KEY, so no model was called)\n\n${renderPrompt(system, messages)}`;

    metrics.count("model.skipped");
    logger.info("model.skipped", { reason: "no API key", messages: messages.length, chars: system.length });

    return { text, source: "offline", model: "none" };
  }

  /**
   * Imported lazily so the module graph of the whole Resource + Prompt path
   * never touches the OpenAI SDK. A server that cannot import a model client
   * cannot accidentally call one.
   */
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI();

  const startedAt = performance.now();

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        ...messages.map((message) => ({ role: message.role, content: message.text })),
      ],
    });

    const text = response.choices[0]?.message.content ?? "";

    metrics.count("model.ok");
    metrics.observe("model.latency_ms", performance.now() - startedAt);
    logger.info("model.call", {
      model: env.OPENAI_MODEL,
      ms: Math.round(performance.now() - startedAt),
      chars: text.length,
      // Token counts when the provider reports them — the number that turns
      // "the context budget felt right" into a measurement.
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    });

    return { text, source: "model", model: env.OPENAI_MODEL };
  } catch (error) {
    /**
     * The model call is the one step that is *expected* to fail transiently, so
     * it is also the one step that degrades rather than throws: a rate limit or a
     * timeout should leave the caller holding the assembled prompt, which is
     * still useful, instead of a stack trace.
     */
    const message = error instanceof Error ? error.message : String(error);

    metrics.count("model.error");
    logger.warn("model.failure", { model: env.OPENAI_MODEL, message });

    return {
      text: `(the model call failed: ${message})\n\nThe prompt that was sent:\n\n${renderPrompt(system, messages)}`,
      source: "offline",
      model: env.OPENAI_MODEL,
    };
  }
}
```

### Block-by-block

**Block 1 — `ModelReply` and `ModelInput` (lines 33–50).**

```ts
export interface ModelReply {
  text: string;
  /** `model` when a model answered; `offline` when the prompt was echoed instead. */
  source: "model" | "offline";
  model: string;
}
```

**`source: "model" | "offline"` is the honest field**, and it exists for the same reason `ResourceRead.source` does
(Chapter 10). A reply that came from a model and a reply that is an echoed prompt look similar in a UI, and a caller
cannot tell them apart — which matters, because one is an answer and the other is a *request*. Naming which happened is
the difference between a system that reports its own state and one that hides it.

The lifecycle prints it directly:

```text
MODEL     -> offline: no key, so the assembled request is echoed
```

`model: string` carries the model name (`"gpt-5.4-mini"`) or `"none"` on the offline path — so an audit record of a
model call can name which model produced it, which is the first thing you need when an answer's quality changes.

```ts
export interface ModelInput {
  system: string;
  messages: readonly PromptMessage[];
  logger: Logger;
  metrics: Metrics;
}
```

Four fields, and the shape mirrors the model API: a system message plus a list of messages. `logger` and `metrics` are
injected rather than imported, the same discipline as `createMcpClient` (Chapter 19) — so the walkthrough's own
logger and metrics receive the model observations, and one run reports everything in one place.

**Block 2 — `renderPrompt` (lines 52–57).**

```ts
export function renderPrompt(system: string, messages: readonly PromptMessage[]): string {
  const body = messages.map((message) => `${message.role.toUpperCase()}:\n${message.text}`).join("\n\n");

  return `SYSTEM:\n${system}\n\n${body}`;
}
```

*Renders the request as text, for the offline path and for the audit trail.* One function, two consumers — and both
consume the *same* rendering, so what an operator reads in offline mode is exactly what the audit trail would show.

`message.role.toUpperCase()` produces `USER:` and `ASSISTANT:` — uppercase labels, which is a small typographic choice
that makes the roles scannable in a wall of text. And it is exported, because a caller that wants to log what was sent
should not re-implement the format.

**Block 3 — the offline branch (lines 59–69).**

```ts
export async function askModel(input: ModelInput): Promise<ModelReply> {
  const { system, messages, logger, metrics } = input;

  if (!hasModelKey) {
    const text = `(offline — no OPENAI_API_KEY, so no model was called)\n\n${renderPrompt(system, messages)}`;

    metrics.count("model.skipped");
    logger.info("model.skipped", { reason: "no API key", messages: messages.length, chars: system.length });

    return { text, source: "offline", model: "none" };
  }
```

**The early return is the first thing the function does** — before the import, before the client, before any setup. So on
a machine with no key, the `openai` package is never even *loaded*, and `model.skipped` is counted rather than
`model.error`.

The metric name is worth noticing: **`model.skipped`, not `model.error`.** Skipping is a *configured* state, not a
failure — and a dashboard that counted it as an error would show a permanent incident on every offline deployment. The
log level is `info` for the same reason.

The logged fields are `messages.length` and `chars: system.length` — the size of what *would* have been sent. So an
operator watching the log sees the prompt sizes even without a model, which is how you notice a context budget drifting
before you are paying for it.

And the text is prefixed with *"(offline — no OPENAI_API_KEY, so no model was called)"* rather than being just the
prompt. That prefix is what makes the echo unambiguous when it appears in a UI — a reader is never left wondering whether
the model really answered with the prompt back.

**Block 4 — the dynamic import, and the property it protects (lines 71–96).**

```ts
/**
 * Imported lazily so the module graph of the whole Resource + Prompt path
 * never touches the OpenAI SDK. A server that cannot import a model client
 * cannot accidentally call one.
 */
const { default: OpenAI } = await import("openai");
const openai = new OpenAI();

const startedAt = performance.now();

try {
  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      ...messages.map((message) => ({ role: message.role, content: message.text })),
    ],
  });
```

**`await import("openai")` — a dynamic import inside the branch that requires a key.** The comment states the property:
*A server that cannot import a model client cannot accidentally call one.* Two things follow:

1. **With no key, the package is never loaded.** Not imported, not parsed, not in memory. So the offline path has a
   genuinely smaller footprint, not just a skipped call.
2. **The static module graph does not include `openai`.** Any tooling that walks imports — a bundler, a dependency
   analyser, a `grep` — sees that this is the only place the SDK appears, and that it appears conditionally.

Note the destructuring: `const { default: OpenAI } = await import("openai")`. A dynamic import of a CJS-style default
export gives the module namespace, so `default` is the class. That is the correct form for this package, and it is the
kind of detail that would be a runtime error rather than a type error if written as `const OpenAI = await import(...)`.

**The message assembly is where the two halves meet:**

```ts
messages: [
  { role: "system", content: system },
  ...messages.map((message) => ({ role: message.role, content: message.text })),
],
```

The **assembled system message** (the preamble plus the fenced blocks — Chapter 21) becomes the `system` role, and the
**prompt's own messages** follow in order. That is the whole handoff: the selection engine's output is the system
context, and the prompt's template is the user turn. The model sees one system message and one user message, and neither
knows which primitive produced it.

**A small inconsistency worth noting:** this file calls `performance.now()` as a **global**, while `mcp/tools.ts`
(Chapter 14) imports it explicitly from `node:perf_hooks`. Both work — `performance` has been a Node global since v16 —
but the two files disagree about how to reach it. Noted rather than changed, because consistency here has no functional
consequence and the guide's job is to describe what the code does.

**Block 5 — the success path, and the token counts (lines 98–112).**

```ts
const text = response.choices[0]?.message.content ?? "";

metrics.count("model.ok");
metrics.observe("model.latency_ms", performance.now() - startedAt);
logger.info("model.call", {
  model: env.OPENAI_MODEL,
  ms: Math.round(performance.now() - startedAt),
  chars: text.length,
  // Token counts when the provider reports them — the number that turns
  // "the context budget felt right" into a measurement.
  promptTokens: response.usage?.prompt_tokens,
  completionTokens: response.usage?.completion_tokens,
});

return { text, source: "model", model: env.OPENAI_MODEL };
```

**`response.choices[0]?.message.content ?? ""`** — a double guard for a wire shape the code does not control. `choices`
could be empty, and `content` can be `null` for a tool-call-only response. The `?? ""` turns both into an empty string,
which is the least surprising value for a caller that expects text.

**The token counts are the interesting fields**, and the comment says why: *the number that turns "the context budget felt
right" into a measurement.* Chapter 04 introduced `context.chars` as the Lecture-15-specific metric; these two are its
ground truth. A deployment that logged both would be able to answer *"how many characters is a token, for our content?"*
— and that ratio is what makes a character-based budget defensible rather than arbitrary.

Both are optional (`usage?.prompt_tokens`), because not every provider reports usage on every response. Logging
`undefined` for a missing field is correct here: it says the provider did not report it, rather than implying zero.

**Block 6 — the failure path, and why this step degrades (lines 113–117).**

```ts
} catch (error) {
  /**
   * The model call is the one step that is *expected* to fail transiently, so
   * it is also the one step that degrades rather than throws: a rate limit or a
   * timeout should leave the caller holding the assembled prompt, which is
   * still useful, instead of a stack trace.
   */
  const message = error instanceof Error ? error.message : String(error);

  metrics.count("model.error");
  logger.warn("model.failure", { model: env.OPENAI_MODEL, message });

  return {
    text: `(the model call failed: ${message})\n\nThe prompt that was sent:\n\n${renderPrompt(system, messages)}`,
    source: "offline",
    model: env.OPENAI_MODEL,
  };
}
```

**The only `try/catch` in the file, and it returns rather than throws.** The reasoning is specific to this step: a model
call is the one operation *expected* to fail transiently (rate limits, timeouts, provider outages), so failing the whole
request would be punishing the user for something outside their control.

And what the caller gets instead is the useful thing: *"The prompt that was sent"* followed by the rendered prompt. That
is the same insight as the offline path — **the assembled prompt is valuable output in its own right**, so a model failure
downgrades to "here is what we would have asked" rather than to a stack trace.

Note `source: "offline"` on this path, which is a slightly loose reuse of the field: the reply did not come from a model,
so `offline` is honest about *where the text came from*, even though the cause was a failure rather than a missing key.
The `model` field still names the model that was attempted, and the `model.error` metric plus the `model.failure` warning
distinguish this case from the no-key case for an operator. **A caller can tell "no model" from "model failed" by reading
the text; a dashboard can tell them apart by the metric name.**

---

## `src/host/audit.ts` — the full file

```ts
import { createHash } from "node:crypto";
import type { Logger } from "../core/logger.js";
import type { TrustTier } from "./policy.js";

/**
 * *"Who is allowed to run this, on whose authority, and how do I prove it after
 * the fact?"*
 *
 * The third clause is the one teams skip, and the one an incident review asks for
 * first. Lecture 15 widens the record: there are now **three** primitives to
 * account for, and a resource read is exactly as interesting as a tool call when
 * the question is *"why did the model know that?"*
 *
 * An audit record answers *who asked for what, what the host decided, and how it
 * ended* — **without storing the arguments or the content.**
 *
 * Both omissions are deliberate and they are different omissions:
 *
 *  · **Arguments are hashed.** They routinely carry a name, an email or a token.
 *    The digest is enough to correlate a retry, spot a replay and prove that two
 *    calls were identical; it is useless for reconstructing the data, and useless
 *    to anyone who steals the log.
 *
 *  · **Resource content is never recorded at all.** A resource body can be a
 *    policy document or a person's workload, and the audit trail's job is to
 *    record *which* URI was read and *why* — the URI and the reason are the
 *    accountable facts; the bytes are not.
 */

/** Which primitive produced the record. */
export type AuditAction = "tool" | "resource" | "prompt";

export type AuditOutcome = "ok" | "error" | "denied";

export type AuditDecision = TrustTier | "allowed" | "blocked";

/**
 * Declared as a type alias rather than an interface on purpose: an object type
 * alias gets an implicit index signature, which is what lets the whole record be
 * handed to the logger's `Record<string, unknown>` fields without a cast.
 */
export type AuditRecord = {
  at: string;
  actor: string;
  action: AuditAction;
  /** Tool name, resource URI, or prompt name. */
  target: string;
  /** What the host decided, before anything ran. */
  decision: AuditDecision;
  outcome: AuditOutcome;
  /** Truncated SHA-256 of the canonicalised arguments — never the arguments. */
  argsHash: string;
  durationMs: number;
  /**
   * The accountable detail: a selection strategy, a byte count, an error code,
   * a refusal reason. Short by construction — this is a record, not a report.
   */
  note?: string;
}

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  target: string;
  decision: AuditDecision;
  outcome: AuditOutcome;
  /** Hashed before it is stored. Never the raw values. */
  args: Record<string, unknown>;
  durationMs: number;
  note?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): AuditRecord;
  entries(): AuditRecord[];
}

/**
 * Canonicalises before hashing, so `{a:1,b:2}` and `{b:2,a:1}` produce the same
 * digest.
 *
 * Without this, *"were these two calls identical?"* — the only question the hash
 * exists to answer — has a wrong answer half the time, because two clients will
 * serialize the same arguments in different key orders.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}

export function createAuditLog(logger: Logger): AuditLog {
  const records: AuditRecord[] = [];

  return {
    record(entry) {
      const record: AuditRecord = {
        at: new Date().toISOString(),
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        decision: entry.decision,
        outcome: entry.outcome,
        argsHash: hashArgs(entry.args),
        durationMs: Math.round(entry.durationMs),
        ...(entry.note === undefined ? {} : { note: entry.note }),
      };

      records.push(record);

      // The same line goes to the audit trail *and* the log stream: one is the
      // queryable record, the other is what an operator sees live.
      logger.info("audit", record);

      return record;
    },

    entries() {
      return [...records];
    },
  };
}
```

### Block-by-block

**Block 7 — the three unions, and what a record answers (lines 14–46).**

```ts
export type AuditAction = "tool" | "resource" | "prompt";
export type AuditOutcome = "ok" | "error" | "denied";
export type AuditDecision = TrustTier | "allowed" | "blocked";
```

The header opens with the question the file answers, and the third clause is the one that matters:

> *"Who is allowed to run this, on whose authority, and **how do I prove it after the fact?**"*
>
> The third clause is the one teams skip, and the one an incident review asks for first. Lecture 15 widens the record:
> there are now **three** primitives to account for, and a resource read is exactly as interesting as a tool call when
> the question is *"why did the model know that?"*

*Why did the model know that?* is the question that makes a Resource read auditable. A tool call mutates state and is
obviously worth recording; a resource read produces no side effect at all — and it is what put the information in front of
the model. **The read is the causal event for the answer.**

The three unions are deliberately different shapes:

| Type | Values | Why |
| :--- | :--- | :--- |
| `AuditAction` | `tool`, `resource`, `prompt` | The **primitive** — three, matching the protocol |
| `AuditOutcome` | `ok`, `error`, `denied` | **`denied` is separate from `error`** — a policy refusal is not a failure |
| `AuditDecision` | `TrustTier` + `allowed` + `blocked` | The tool tiers, plus the resource/prompt vocabulary |

**`denied` being distinct from `error` is a good call.** A tool the policy refused never ran, so it did not fail; an
operator counting errors should not see policy refusals inflating the number, and an operator investigating a refusal
should not have to filter them out of failures.

`AuditDecision` is the one that admits to being a union of two vocabularies: `TrustTier` (`auto`/`confirm`/`denied`) is
the *tool* vocabulary, while `allowed`/`blocked` is what the resource and prompt ACLs produce. Both describe "what the
host decided, before anything ran", so they share a field — at the cost of a type that means different things per action.
That is an honest trade for one field rather than two nullable ones.

**Block 8 — `AuditRecord`, and the two omissions (lines 48–77).**

```ts
export type AuditRecord = {
  at: string;
  actor: string;
  action: AuditAction;
  target: string;
  decision: AuditDecision;
  outcome: AuditOutcome;
  argsHash: string;
  durationMs: number;
  note?: string;
};
```

**Nine fields, and the two that are *absent* are the design.** The header states both omissions and why they are
different:

> · **Arguments are hashed.** They routinely carry a name, an email or a token. The digest is enough to **correlate a
>   retry, spot a replay and prove that two calls were identical**; it is useless for reconstructing the data, and useless
>   to anyone who steals the log.
>
> · **Resource content is never recorded at all.** A resource body can be a policy document or a person's workload, and the
>   audit trail's job is to record **which** URI was read and **why** — the URI and the reason are the accountable facts;
>   the bytes are not.

Read those as a table, because the distinction is the whole point:

| What | Stored as | Why |
| :--- | :--- | :--- |
| Arguments | `argsHash` — truncated SHA-256 | Enough to correlate and compare; useless to reconstruct |
| Resource content | **not stored** | The URI and the reason are the accountable facts; the bytes are not |
| The URI | `target` | *Which* address was read — the accountable fact |
| The reason | `note` | *Why* — a strategy, a byte count, an error code |

**`argsHash` answers exactly three questions and no others:** *is this the same call as that one?* (correlate a retry),
*was this call replayed?* (spot a replay), and *were these two identical?* (a comparison). Every one of them is an
**equality** question, and a hash answers equality questions perfectly while being useless for anything else. That is
precisely the trade being made: full correlatability, zero reconstructability.

The comment on `note` states its scope: *the accountable detail: a selection strategy, a byte count, an error code, a
refusal reason. Short by construction — this is a record, not a report.* So `note` is a **sentence fragment**, not a
narrative, and its optionality (`note?: string`) means a record without one is still complete.

**`AuditRecord` is a type alias rather than an interface**, and the comment explains why — the same reason as
`ToolResult` in Chapter 05:

> Declared as a type alias rather than an interface on purpose: an object type alias gets an implicit index signature,
> which is what lets the whole record be handed to the logger's `Record<string, unknown>` fields without a cast.

That is what makes `logger.info("audit", record)` in Block 11 compile. With an `interface`, the record would not satisfy
the logger's index-signature contract and would need a cast at every call site.

**Block 9 — `canonical`, the function that makes the hash meaningful (lines 79–103).**

```ts
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
```

**The doc comment is the argument, and it is a subtle one:**

> Canonicalises before hashing, so `{a:1,b:2}` and `{b:2,a:1}` produce the same digest.
>
> Without this, *"were these two calls identical?"* — the only question the hash exists to answer — **has a wrong answer
> half the time**, because two clients will serialize the same arguments in different key orders.

That is a real and easily-missed bug. `JSON.stringify` preserves insertion order, so `JSON.stringify({a:1,b:2})` and
`JSON.stringify({b:2,a:1})` produce different strings — and therefore different hashes, for arguments that are
*semantically identical*. The audit trail would then report two different `argsHash` values for a retry, and the one
question the hash exists to answer would be answered **wrong**.

Four details of the implementation:

**The recursion is total.** Three cases: a primitive (`JSON.stringify`), an array (recurse per element), an object (sort,
then recurse per value). Arrays keep their **order** — `[1,2]` and `[2,1]` are different arguments — while object keys are
**sorted**, because key order carries no meaning. That asymmetry is exactly right and easy to get backwards.

**`JSON.stringify(value) ?? "null"`** handles `undefined`, for which `JSON.stringify` returns `undefined` (not a string).
So `canonical(undefined)` is `"null"` rather than a crash. It also means `undefined` and `null` hash identically — a
small collision, and harmless for correlation purposes.

**`JSON.stringify(key)` on the key** — the key is quoted, so a key containing a `:` or a `,` cannot be confused with the
separator. That is what keeps the serialisation unambiguous.

**`localeCompare` for the sort** — the same choice as `snapshot()` (Chapter 04) and `stats().projects` (Chapter 09). Here it
is not about diffability but about **determinism across machines**: `localeCompare` with a fixed locale ordering gives the
same result everywhere, whereas a raw `<` comparison on strings is code-unit order and could differ.

**Block 10 — `hashArgs` (lines 105–107).**

```ts
export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}
```

**One line, three decisions:**

**`sha256`** — a cryptographic hash, because the input is user data and the goal is that it cannot be reversed. A
non-cryptographic hash (a 32-bit checksum) would be faster and would leak: an attacker with a candidate argument could
confirm a guess cheaply.

**`.slice(0, 16)`** — the first 16 hex characters, i.e. 64 bits. That is the interesting choice: it truncates the digest
to keep the log line short and readable, accepting a collision probability of about 1 in 2⁶⁴. For the stated purpose
(*"were these two calls identical?"*) that is far more than enough — and the comment on `argsHash` in `AuditRecord` says
*Truncated SHA-256*, so the truncation is declared rather than hidden.

**`.digest("hex")`** — hex rather than base64, so the value is a plain alphanumeric string that survives being grepped,
quoted, and pasted. The lifecycle's audit table prints 16-character hex digests, which is what makes them usable as
column values.

**Block 11 — `createAuditLog` (lines 109–136).**

```ts
export function createAuditLog(logger: Logger): AuditLog {
  const records: AuditRecord[] = [];

  return {
    record(entry) {
      const record: AuditRecord = {
        at: new Date().toISOString(),
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        decision: entry.decision,
        outcome: entry.outcome,
        argsHash: hashArgs(entry.args),
        durationMs: Math.round(entry.durationMs),
        ...(entry.note === undefined ? {} : { note: entry.note }),
      };

      records.push(record);

      // The same line goes to the audit trail *and* the log stream: one is the
      // queryable record, the other is what an operator sees live.
      logger.info("audit", record);

      return record;
    },

    entries() {
      return [...records];
    },
  };
}
```

**`AuditEntry` (the input) has `args`, `AuditRecord` (the output) has `argsHash`.** That is the boundary in the type
system: a caller can only *supply* arguments, and can only *read back* a digest. **The raw values are never stored**, and
the interface makes that structural rather than conventional — there is no field in which they could be kept.

**`at: new Date().toISOString()`** — the timestamp is stamped by the log, not supplied by the caller. That means a caller
cannot forge or reorder timestamps, and it means the record's `at` is when it was *recorded* rather than when the caller
believed the operation started.

**`Math.round(entry.durationMs)`** — whole milliseconds, the same reasoning as `snapshot()` (Chapter 04): sub-millisecond
precision in a record is noise.

**The conditional spread** — `...(entry.note === undefined ? {} : { note: entry.note })` — omits the key entirely rather
than setting it to `undefined`. That matters because the record goes to `JSON.stringify` (via the logger), and
`JSON.stringify` drops `undefined` values anyway — so the explicit form makes the intent clear and produces the same
output.

**The same record goes to both sinks:**

```ts
logger.info("audit", record);
```

*One is the queryable record, the other is what an operator sees live.* So `records` is the in-process array the
walkthrough prints as a table, and the log line is what a real deployment would ship to a log store. They are the *same
object*, so they cannot disagree — which is the point. A separate "audit log" written by different code than the
operational log is a classic source of two inconsistent histories.

**`entries()` returns a copy** — `[...records]` — the same defensive copy as `TaskStore.list()` (Chapter 07). A caller
cannot push into the audit trail.

And note there is no `close()` or `flush()`: the log is synchronous and in-process, which is honest for a 136-line
implementation. A real deployment would ship the `audit` log lines to durable storage, and the seam for that is already
here — the logger.

---

## Run / verify

### 1. The offline path — a model-free end to end

```bash
npm run lifecycle 2>/dev/null | sed -n '/^11\./,/^12\./p'
```

```text
11. GET /plan?hours=4 -> one request, three primitives, three owners
   USER      -> prompts/get plan_day { availableHours: 4 }
   APP       -> selected [state, retrieval] task://projects/fde, task://backlog, task://guidelines (635 chars of 40000)
   MODEL     -> offline: no key, so the assembled request is echoed
   (offline — no OPENAI_API_KEY, so no model was called) SYSTEM: You are a task management assistant. Use the context below whenever it is relevant to the question. --- task://projects/fde (chosen by state) --- Project: fde Tasks: 2 …(+1020)
```

**The `MODEL` line names its own state**: *offline: no key, so the assembled request is echoed.* That is `ModelReply.source`
reported rather than inferred — and the echoed text is prefixed with *"(offline — no OPENAI_API_KEY, so no model was
called)"*, so a reader of the output is never left wondering whether a model produced that text.

And the echoed content is the payoff the header promised: **exactly what the model would have received**, fences and all.
The single most useful thing to see when a grounded answer turns out to be wrong is the prompt that was sent — and here it
is printable on a machine with no credentials.

### 2. The audit table

```bash
npm run lifecycle 2>/dev/null | sed -n '/^12\./,/^13\./p'
```

```text
12. audit      -> who asked for what, what the host decided, and how it ended
   time         action    target                  decision  outcome  argsHash          ms
   21:24:03.632 prompt    plan_day                allowed   ok       32beeaa846e8d86e  0
   21:24:03.642 resource  task://projects/fde     allowed   ok       23bf90ec7c709d0d  0
   21:24:03.642 resource  task://backlog          allowed   ok       c833edcfbb48c145  0
   21:24:03.642 resource  task://guidelines       allowed   ok       096a7e6630b48696  0
   21:24:03.642 tool      list_tasks              auto      ok       44136fa355b3678a  0
   (arguments are hashed, never stored; resource content is never recorded at all)
```

**Five records, three primitives, and the closing line is the claim:** *arguments are hashed, never stored; resource
content is never recorded at all.*

Read the `action` column: `prompt`, then three `resource`s, then `tool`. That is the whole request in order — the user's
workflow choice, the application's three reads, and the model's one tool call. **Three primitives in one table**, which is
Lecture 15's widening of the audit record made visible: a resource read is exactly as interesting as a tool call when the
question is *"why did the model know that?"*

Note the `decision` column carries two vocabularies, exactly as `AuditDecision` predicted: `allowed` for the prompt and
resources (the ACL vocabulary) and `auto` for the tool (the trust-tier vocabulary). And every row's `argsHash` is a
16-character digest — never the arguments.

### 3. The canonicalisation, tested

This is the claim that makes `argsHash` worth having, and it is directly testable:

```ts
import { hashArgs } from "./src/host/audit.js";

// key order does not matter
hashArgs({ a: 1, b: 2 })            // 43258cff783fe703
hashArgs({ b: 2, a: 1 })            // 43258cff783fe703   ← identical

// array order does matter
hashArgs({ ids: [1, 2] })           // eff9df2013c08a13
hashArgs({ ids: [2, 1] })           // b019dc39463ec779   ← different

// nesting is handled recursively
hashArgs({ a: { x: 1, y: 2 }, b: 3 }) === hashArgs({ b: 3, a: { y: 2, x: 1 } })   // true

// different values hash differently
hashArgs({ title: "a" })            // c66a6f9e3a6339f6
hashArgs({ title: "b" })            // db5510a0013cf0eb
```

```text
key order does not matter:
  {a:1,b:2}      -> 43258cff783fe703
  {b:2,a:1}      -> 43258cff783fe703
  equal?         -> true

array order does matter:
  [1,2]          -> eff9df2013c08a13
  [2,1]          -> b019dc39463ec779
  equal?         -> false

nested and mixed:
  nested reorder -> true

length: 16 chars (16 hex = 64 bits)
```

**The first pair is the bug `canonical` exists to prevent.** Without key sorting, two clients sending semantically
identical arguments would produce different digests, and *"were these two calls identical?"* — the only question the hash
exists to answer — would be answered **wrong half the time**.

**The second pair is the deliberate asymmetry.** Array order is *preserved*, because `[1,2]` and `[2,1]` are different
arguments — an id list in a different order is a different request. So the canonical form sorts object keys and keeps
array order, which is the correct distinction and the opposite of what a naive `JSON.stringify` with a sort would do.

**The nesting case is the recursion working.** `{a:{x:1,y:2},b:3}` and `{b:3,a:{y:2,x:1}}` hash identically, so the
canonicalisation reaches every level rather than only the top.

And **`44136fa355b3678a`** in the audit table is `hashArgs({})` — `list_tasks` takes no arguments, and the empty object
has a stable digest. That is a small correctness detail: an argument-less call still gets a hash, so it still participates
in replay detection.

### 4. The same records on the log stream

```bash
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep '"event":"audit"' | head -2
```

```json
{"ts":"…","level":"info","event":"audit","host":"lifecycle","at":"…","actor":"123","action":"prompt","target":"plan_day","decision":"allowed","outcome":"ok","argsHash":"32beeaa846e8d86e","durationMs":0,"note":"1 message(s), no model call"}
{"ts":"…","level":"info","event":"audit","host":"lifecycle","at":"…","actor":"123","action":"resource","target":"task://projects/fde","decision":"allowed","outcome":"ok","argsHash":"23bf90ec7c709d0d","durationMs":0,"note":"state: the session is scoped to project \"fde\", so its brief is always relevant"}
```

The `argsHash` values match the table exactly — because the table is printed from the same objects (Block 11's *one record,
two sinks*). And the second record's `note` carries the **selection reason** from Chapter 12, so the audit trail records
not only *which* URI was read but *why it was chosen*.

That is the answer to *"why did the model know that?"* — a URI, the strategy, and the sentence. And no content: the note
names the reason, not the bytes.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Why is the model call in exactly one file, and what does that buy?**
   Because *if the model call can be deleted and the rest still runs, the claim holds.* Steps 1–10 of the walkthrough
already run without a model, so "MCP is not the model" is a property of the dependency graph rather than a slogan.

2. **Why is the `openai` import dynamic?**
   So the module graph of the Resource and Prompt path never touches it — *a server that cannot import a model client
   cannot accidentally call one.* With no key, the package is never even loaded.

3. **Why is `model.skipped` a separate metric from `model.error`?**
   Because skipping is a **configured** state, not a failure. Counting it as an error would show a permanent incident on
   every offline deployment.

4. **Why does the model failure path return rather than throw?**
   Because a model call is the one step *expected* to fail transiently. Failing the request would punish the user for
   something outside their control — and the assembled prompt is still useful, so the caller gets *"the prompt that was
   sent"* instead of a stack trace.

5. **What are the two omissions in an audit record, and why are they different?**
   Arguments are **hashed** (enough to correlate a retry and prove two calls identical; useless to reconstruct). Resource
   content is **not stored at all** (the URI and the reason are the accountable facts; the bytes are not).

6. **Why must arguments be canonicalised before hashing?**
   Because `JSON.stringify` preserves key order, so `{a:1,b:2}` and `{b:2,a:1}` would produce different digests for
   identical arguments — and *"were these two calls identical?"* would be answered wrong half the time.

7. **Why are object keys sorted but array order preserved?**
   Because key order carries no meaning while array order does: `[1,2]` and `[2,1]` are different arguments. Sorting
   keys makes semantically identical calls hash alike; preserving array order keeps distinct calls distinct.

8. **Why is the digest truncated to 16 hex characters?**
   To keep the log line short, accepting a ~1-in-2⁶⁴ collision probability. For an equality question that is more than
   enough — and the truncation is declared in the type's comment rather than hidden.

9. **Why does the same record go to both the array and the log?**
   *One is the queryable record, the other is what an operator sees live.* They are the same object, so they cannot
   disagree — unlike a separate "audit log" written by different code, which is a classic source of two inconsistent
   histories.

10. **Why is `AuditRecord` a type alias rather than an interface?**
    Because an object type alias gets an implicit index signature, which is what lets the record be handed to the
    logger's `Record<string, unknown>` fields without a cast.

---

**[← Chapter 21: Context Assembly](./21_Host_Context_Assembly.md)** · **[Chapter 23: The Host Wiring Contract →](./23_Host_Wiring_Contract.md)**
