# Chapter 21 — Host: Context Assembly

> **This is the file Chapter 05 is really about.** *"MCP does not prescribe how a host selects a Resource"* means
> this code is the application's own responsibility — and so are the four things it has to get right: **select**,
> **authorise again**, **budget**, and **log the why**.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/host/context.ts` (227 lines) |
| **Layer** | `host` — the step that turns a catalogue and a message into the exact text a model will read |
| **Purpose** | Select, re-authorise, read concurrently, budget, fence, and emit one log line that explains the whole decision. |
| **Exports** | `AssembledContext`, `AssembleRequest`, `assembleContext()` |
| **Lecture sections** | Ch05 §"The missing piece"/"Observability", Ch02 §"Size and token budget", Ch04 §"Do not let Resources become a prompt-injection channel" |
| **Runs** | `npm run lifecycle` step 11 · `GET /plan?hours=4` |

---

## Commands

```bash
# the end-to-end request
npm run lifecycle 2>/dev/null | sed -n '/^11\./,/^12\./p'

# the same request through HTTP
npm run server & npm run host &
curl -s 'http://127.0.0.1:8080/plan?hours=4' | head -c 400

# the decision record
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep context.assembled
```

---

## The four responsibilities

The header lists them, and each maps to a specific line in the function below:

| # | Responsibility | Where |
| :---: | :--- | :--- |
| 1 | **Select** — the five strategies | `deps.selection.select(...)` |
| 2 | **Authorise, again** | The loop over `selection.chosen` |
| 3 | **Budget** — count, per body, total | `deps.budget.fit(blocks)` |
| 4 | **Log the why** | The `context.assembled` line |

### Why authorise *again*

This is the chapter's sharpest design decision, and the header defends it directly:

> The selector already filtered by ACL, but the read path checks *again*. Belt and braces is not paranoia here: the
> selector's filter protects the **ranking**, and this one protects the **read**, which is the thing that actually
> touches data.

Two checks, two different jobs, and neither is redundant:

| Check | In | Protects | Why it is needed there |
| :--- | :--- | :--- | :--- |
| Selection-time ACL | `selectionService.admitted` (Chapter 12) | The **ranking** | So a router is never shown a Resource it may not see — *ranking leaks* |
| Read-time ACL | `policy.mayRead` (Chapter 20) | The **read** | Because the read is what touches data |

The second is needed because the first is *not sufficient*: between selection and reading, a URI could have been
constructed by a rule or a router, and `selection.chosen` is a list of addresses the read path is about to dereference.
Checking again at the point of use is the only place where "this is the address we are actually going to read" is known
for certain. **Authorisation at the point of use, not only at the point of decision.**

### A failed read is not a fatal read

The header states the third principle, and it is about failure granularity:

> A failure to read one resource is deliberately **not** fatal. Three resources where one backend is down is a **worse
> answer**, not a failed request — so the reads are settled independently and the failures are named in the log.

That is a product judgement, and it is the right one for a context-assembly step. If a user asks *"plan my day"* and the
guidelines backend is down, the correct outcome is a plan that mentions the guidelines were unavailable — not a 500. The
model is a reasoning engine; give it what you have and tell it what is missing.

---

## `src/host/context.ts` — the full file

```ts
import { contextFence } from "../config/constants.js";
import type { BudgetedBlock, ContextBlock, ContextBudget } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { ResourceRouter, SelectionResult, SelectionService } from "../services/selectionService.js";
import type { PromptMessage } from "../services/promptService.js";
import type { McpClient } from "./client.js";
import type { HostPolicy, Session } from "./policy.js";

/**
 * Notes Ch05 §"The missing piece" and Ch02 §"Size and token budget" — **context
 * assembly**: the step that turns a catalogue and a message into the exact text
 * a model will read.
 *
 * This is the file Chapter 05 is really about. *"MCP does not prescribe how a
 * host selects a Resource"* means this code is the application's own
 * responsibility — and so are the four things it has to get right:
 *
 *  1. **Select** — the five strategies, in `selectionService`.
 *  2. **Authorise, again** — the selector already filtered by ACL, but the read
 *     path checks *again*. Belt and braces is not paranoia here: the selector's
 *     filter protects the ranking, and this one protects the *read*, which is
 *     the thing that actually touches data.
 *  3. **Budget** — cap the count, cap each body, cap the total, and say out loud
 *     when something was cut (Notes Ch02 §"Size and token budget").
 *  4. **Log the why** — strategy, candidates, chosen URIs, bytes. Notes Ch05
 *     §"Observability" calls this *"one line you can read at 2 a.m."*, and this
 *     function emits exactly that line.
 *
 * A failure to read one resource is deliberately **not** fatal. Three resources
 * where one backend is down is a worse answer, not a failed request — so the
 * reads are settled independently and the failures are named in the log.
 */

export interface AssembledContext {
  /** The system message: the preamble plus the fenced resource blocks. */
  system: string;
  /** The prompt's own messages, untouched and in order. */
  messages: PromptMessage[];
  /** URIs whose bodies made it into the system message. */
  included: string[];
  /** URIs the budget removed, named rather than forgotten. */
  dropped: string[];
  /** URIs the policy refused before a read was even attempted. */
  refused: string[];
  /** URIs that were selected but failed to read. */
  failed: string[];
  /** URIs whose bodies were cut to fit. */
  truncated: string[];
  /** Characters placed into the system message. */
  chars: number;
  /** Everything the selector decided, for the audit trail. */
  selection: SelectionResult;
}

export interface AssembleRequest {
  message: string;
  /** URIs the user attached explicitly — strategy 1. */
  attached?: readonly string[];
  session: Session;
  /**
   * The prompt's own messages, echoed into the result so a single object
   * describes the entire model input.
   */
  promptMessages?: readonly PromptMessage[];
  /** Strategy 4. Absent in offline mode, and the selection still works. */
  router?: ResourceRouter;
  /** Overrides the configured cap, for a caller that knows better. */
  limit?: number;
}

export async function assembleContext(
  request: AssembleRequest,
  deps: {
    client: McpClient;
    policy: HostPolicy;
    selection: SelectionService;
    budget: ContextBudget;
    logger: Logger;
    metrics: Metrics;
    maxResourcesPerRequest: number;
  },
): Promise<AssembledContext> {
  const { message, session } = request;
  const limit = request.limit ?? deps.maxResourcesPerRequest;

  const selection = await deps.selection.select({
    message,
    attached: request.attached,
    scope: {
      userId: session.actor,
      projects: session.projects,
      isAdmin: session.isAdmin,
    },
    limit,
    router: request.router,
  });

  const refused: string[] = [];
  const readable: string[] = [];

  // The read-time authorisation pass. The selector already removed what the
  // session may not *see*; this removes what it may not *read*.
  for (const chosen of selection.chosen) {
    const decision = deps.policy.mayRead(chosen.uri, session);

    if (decision.allowed) {
      readable.push(chosen.uri);
      continue;
    }

    refused.push(chosen.uri);
    deps.metrics.count("context.refused");
    deps.logger.warn("context.refused", { uri: chosen.uri, reason: decision.reason });
  }

  /**
   * Reads are settled independently.
   *
   * `Promise.all` would make one broken backend fail the whole request, which
   * turns a degraded answer into no answer — the wrong trade every time.
   */
  const settled = await Promise.allSettled(
    readable.map(async (uri) => {
      const body = await deps.client.read(uri);
      return { uri, body };
    }),
  );

  const blocks: ContextBlock[] = [];
  const failed: string[] = [];

  settled.forEach((outcome, index) => {
    const uri = readable[index] ?? "(unknown)";

    if (outcome.status === "rejected") {
      failed.push(uri);
      deps.metrics.count("context.read_failed");
      deps.logger.warn("context.read_failed", {
        uri,
        message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      return;
    }

    const strategy = selection.chosen.find((chosen) => chosen.uri === uri)?.strategy ?? "unknown";

    blocks.push({ uri, strategy, text: outcome.value.body.text });
  });

  /**
   * Three caps, applied in a fixed order: count → each body → the total.
   *
   * The budget returns *what it did*, not just what survived, which is what
   * makes a truncation explainable instead of mysterious.
   */
  const fit = deps.budget.fit(blocks);

  const system = composeSystem(fit.blocks);
  const truncated = fit.blocks.filter((block) => block.truncated).map((block) => block.uri);

  /**
   * Notes Ch05 §"Observability: log the *why*" — the single line that answers
   * *"why did the model see this?"*, *"was the catalogue even right?"*, *"was
   * the ranker close?"* and *"was it worth the tokens?"*
   *
   * `reasons` is the part that makes it a *decision record* rather than a
   * request log: every URI is paired with the strategy that chose it and the
   * sentence explaining why.
   */
  deps.metrics.count("context.assembled");
  deps.metrics.observe("context.chars", fit.usedChars);
  deps.logger.info("context.assembled", {
    strategies: selection.strategies,
    candidates: selection.candidates,
    chosen: selection.chosen.map((chosen) => chosen.uri),
    included: fit.blocks.map((block) => block.uri),
    dropped: fit.dropped,
    refused,
    failed,
    truncated,
    chars: fit.usedChars,
    reasons: selection.chosen.map((chosen) => `${chosen.uri} ← ${chosen.strategy}: ${chosen.reason}`),
  });

  return {
    system,
    messages: [...(request.promptMessages ?? [])],
    included: fit.blocks.map((block) => block.uri),
    dropped: fit.dropped,
    refused,
    failed,
    truncated,
    chars: fit.usedChars,
    selection,
  };
}

/**
 * Builds the system message: a short preamble, then one fenced block per
 * resource.
 *
 * The fences are **machine-generated** — `--- <uri> (chosen by <strategy>) ---` —
 * and never come from resource content. That matters more than it looks:
 * resource content is untrusted text that gains system-level authority the
 * moment it lands in a prompt, so the boundary between *our* instructions and
 * *their* text has to be drawn by us (Notes Ch04 §"Do not let Resources become a
 * prompt-injection channel").
 *
 * The empty case is written out rather than left blank, because a model given
 * silence invents context and a model told *"none was selected"* does not.
 */
function composeSystem(blocks: readonly BudgetedBlock[]): string {
  const preamble = [
    "You are a task management assistant.",
    "",
    "Use the context below whenever it is relevant to the question.",
  ];

  if (blocks.length === 0) {
    return [...preamble, "", "No additional context was selected for this request."].join("\n");
  }

  const sections = blocks.flatMap((block) => [contextFence(block.uri, block.strategy), block.text, ""]);

  return [...preamble, "", ...sections].join("\n").trimEnd();
}
```

### Block-by-block

**Block 1 — `AssembledContext`, nine fields of honesty (lines 35–57).**

```ts
export interface AssembledContext {
  system: string;
  messages: PromptMessage[];
  included: string[];
  dropped: string[];
  refused: string[];
  failed: string[];
  truncated: string[];
  chars: number;
  selection: SelectionResult;
}
```

**Nine fields, and six of them are lists of URIs.** That ratio is the design: the result does not just say what went into
the prompt, it says what happened to everything else.

| Field | Content |
| :--- | :--- |
| `system` | The preamble plus the fenced blocks — the text the model reads |
| `messages` | The prompt's own messages, untouched and in order |
| `included` | URIs whose bodies made it into the system message |
| `dropped` | URIs the **budget** removed |
| `refused` | URIs the **policy** refused before a read was attempted |
| `failed` | URIs that were selected but **failed to read** |
| `truncated` | URIs whose bodies were **cut** to fit |
| `chars` | Characters placed into the system message |
| `selection` | Everything the selector decided, for the audit trail |

The four failure lists are the interesting part, and they are kept separate because they have four different causes and
four different remedies:

```text
dropped    task://summary      the budget was too tight        → raise the cap, or select less
refused    user://456/profile  the policy said no              → a permissions outcome
failed     task://guidelines   the read threw                  → an infrastructure outcome
truncated  task://backlog      it fit, but only partly         → a budget outcome, and it still landed
```

Collapsing these into one `skipped` list would make a request that hit a dead backend indistinguishable from one that hit
a budget cap — and those go to different people. Note also that `truncated` is *not* a failure list: those URIs **are** in
`included`; they simply arrived shorter than they were sent.

**`messages: PromptMessage[]`** carries the prompt's own messages through untouched — *echoed into the result so a single
object describes the entire model input.* That is why the caller does not need to hold the prompt result and the context
result side by side: one object is the whole model input.

**Block 2 — `AssembleRequest` (lines 59–76).**

```ts
export interface AssembleRequest {
  message: string;
  attached?: readonly string[];
  session: Session;
  promptMessages?: readonly PromptMessage[];
  router?: ResourceRouter;
  limit?: number;
}
```

Six fields, and the last three are each an *override* or an *optional extension*:

| Field | Why optional |
| :--- | :--- |
| `attached` | Strategy 1 — absent when the user attached nothing |
| `promptMessages` | Absent when the request did not come from a prompt (`GET /ask`) |
| `router` | **Absent in offline mode, and the selection still works** |
| `limit` | *Overrides the configured cap, for a caller that knows better* |

The `router` comment is the important one, and it restates Chapter 12's trade: strategy 4 is injected, so a request without
one runs four strategies instead of five. That is what makes the whole pipeline testable with no model — and it is why the
lifecycle's `strategies=[state, rule, retrieval]` never contains `llm`.

`limit` is the *caller's* override rather than a service option, for the same reason `SelectionRequest.limit` is
(Chapter 12): the budget belongs to the request, not to the engine.

**Block 3 — the selection call, and the scope translation (lines 78–104).**

```ts
export async function assembleContext(
  request: AssembleRequest,
  deps: {
    client: McpClient;
    policy: HostPolicy;
    selection: SelectionService;
    budget: ContextBudget;
    logger: Logger;
    metrics: Metrics;
    maxResourcesPerRequest: number;
  },
): Promise<AssembledContext> {
  const { message, session } = request;
  const limit = request.limit ?? deps.maxResourcesPerRequest;

  const selection = await deps.selection.select({
    message,
    attached: request.attached,
    scope: {
      userId: session.actor,
      projects: session.projects,
      isAdmin: session.isAdmin,
    },
    limit,
    router: request.router,
  });
```

**`deps` is an inline object type, not a named interface** — the one place in this project that does that. It is a
judgement call: `assembleContext` has seven dependencies and is called from two places (the walkthrough and the plan
controller), so a named interface would be shared by two callers and read by nobody else. Inline keeps the whole contract
visible at the function signature.

**The scope translation is where `Session` becomes `SelectionScope`:**

```ts
scope: { userId: session.actor, projects: session.projects, isAdmin: session.isAdmin }
```

Three fields, renamed once. `Session.actor` → `SelectionScope.userId` because the policy speaks in terms of *the actor*
(an identity) while the selection engine speaks in terms of *a user id* (a value to compare against a URI variable).
The rename is the only place the two vocabularies meet, and doing it here means neither module has to know the other's
naming.

`limit` is resolved with `??` — the request's override or the configured cap — so the caller can pass `undefined` and get
the default. That is why the field is `limit?: number` rather than required.

**Block 4 — the read-time authorisation pass (lines 106–120).**

```ts
const refused: string[] = [];
const readable: string[] = [];

for (const chosen of selection.chosen) {
  const decision = deps.policy.mayRead(chosen.uri, session);

  if (decision.allowed) {
    readable.push(chosen.uri);
    continue;
  }

  refused.push(chosen.uri);
  deps.metrics.count("context.refused");
  deps.logger.warn("context.refused", { uri: chosen.uri, reason: decision.reason });
}
```

Four lines of logic and three of bookkeeping, and the comment above it states the purpose: *the selector already removed
what the session may not **see**; this removes what it may not **read**.*

The two partitions are the point: `readable` is what proceeds to the read, and `refused` is what does not — and the
refused URIs are **named**. A refusal that is not recorded is a refusal an operator cannot find, and the metric
`context.refused` plus the `warn` line make it visible at both the aggregate and the per-request level.

Note the loop is a plain `for…of` rather than a `filter`, because it has a side effect per element (the metric and the
log). A `filter` with a logging predicate would work and would read worse — the side effect would be buried in an
expression whose purpose appears to be selection.

**Block 5 — the concurrent reads, and `allSettled` (lines 122–152).**

```ts
const settled = await Promise.allSettled(
  readable.map(async (uri) => {
    const body = await deps.client.read(uri);
    return { uri, body };
  }),
);

const blocks: ContextBlock[] = [];
const failed: string[] = [];

settled.forEach((outcome, index) => {
  const uri = readable[index] ?? "(unknown)";

  if (outcome.status === "rejected") {
    failed.push(uri);
    deps.metrics.count("context.read_failed");
    deps.logger.warn("context.read_failed", {
      uri,
      message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    });
    return;
  }

  const strategy = selection.chosen.find((chosen) => chosen.uri === uri)?.strategy ?? "unknown";

  blocks.push({ uri, strategy, text: outcome.value.body.text });
});
```

**`Promise.allSettled` rather than `Promise.all`, and the comment is the argument:**

> `Promise.all` would make one broken backend fail the whole request, which **turns a degraded answer into no answer —
> the wrong trade every time.**

That is the product judgement from the header, expressed as a single API choice. With `Promise.all`, one rejection
propagates and the caller gets nothing; with `allSettled`, every read is reported independently and the surviving bodies
are used. **Three Resources where one backend is down is a worse answer, not a failed request.**

Three details:

**The reads are concurrent.** `readable.map(async …)` starts them all before any is awaited, so a request that needs
three Resources takes as long as the slowest rather than the sum. For a step that sits in front of a model call — where
latency is already the dominant cost — that matters.

**`readable[index] ?? "(unknown)"`** — the index correspondence between `settled` and `readable` is relied upon, and the
`?? "(unknown)"` guards the impossible case. It is a small piece of defensiveness, and it means a bug in that
correspondence produces a legible `"(unknown)"` in a log rather than `undefined`.

**`outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)`** — the same defensive extraction
as Chapter 05's `toAppError`. A rejection reason is `unknown` (anything can be thrown), so both shapes are handled. Note
this path does *not* go through `toAppError` — it does not need to, because a failed read here is not surfaced as an error
to anyone; it is recorded and the request continues. **The taxonomy is for failures that reach a caller; this one reaches
a log line.**

**The `strategy` lookup is the last piece of provenance:**

```ts
const strategy = selection.chosen.find((chosen) => chosen.uri === uri)?.strategy ?? "unknown";
```

So each block carries *which strategy chose it*, which is what `contextFence` needs to write `--- task://backlog (chosen by
retrieval) ---`. The `?? "unknown"` covers a URI that survived the read but is no longer in `selection.chosen` — which
should be impossible, and which produces a fence saying `(chosen by unknown)` rather than `(chosen by undefined)`.

**Block 6 — the budget, and the single log line (lines 154–196).**

```ts
const fit = deps.budget.fit(blocks);

const system = composeSystem(fit.blocks);
const truncated = fit.blocks.filter((block) => block.truncated).map((block) => block.uri);

deps.metrics.count("context.assembled");
deps.metrics.observe("context.chars", fit.usedChars);
deps.logger.info("context.assembled", {
  strategies: selection.strategies,
  candidates: selection.candidates,
  chosen: selection.chosen.map((chosen) => chosen.uri),
  included: fit.blocks.map((block) => block.uri),
  dropped: fit.dropped,
  refused,
  failed,
  truncated,
  chars: fit.usedChars,
  reasons: selection.chosen.map((chosen) => `${chosen.uri} ← ${chosen.strategy}: ${chosen.reason}`),
});
```

**`deps.budget.fit(blocks)` is one call, and it is where three caps are applied** (Chapter 06: count → per-body → total).
The comment above it states why the return value matters: *the budget returns **what it did**, not just what survived,
which is what makes a truncation explainable instead of mysterious.*

**`truncated` is derived from the *result*, not tracked separately:**

```ts
const truncated = fit.blocks.filter((block) => block.truncated).map((block) => block.uri);
```

So the list is always consistent with the blocks that were actually included — it cannot report a truncation that did not
happen, because it reads the same objects the system message was built from.

**The log line is the chapter's fourth responsibility, and its doc comment calls it *"the single line that answers"* four
questions:**

| Question | Field |
| :--- | :--- |
| *"why did the model see this?"* | `included` + `reasons` |
| *"was the catalogue even right?"* | `candidates` + `chosen` |
| *"was the ranker close?"* | `strategies` + `candidates` |
| *"was it worth the tokens?"* | `chars` |

**And `reasons` is what makes it a decision record rather than a request log:**

```ts
reasons: selection.chosen.map((chosen) => `${chosen.uri} ← ${chosen.strategy}: ${chosen.reason}`),
```

Each entry reads like `task://backlog ← retrieval: the message scores 0.50 against this Resource's metadata` — URI,
strategy, and the sentence from Chapter 12. That is *"one line you can read at 2 a.m."* made literal: a single log line
containing every URI that was considered, the strategy that picked it, and the evidence behind the choice.

**Ten fields, and eight of them are lists.** Same ratio as `AssembledContext`, for the same reason: the value of this line
is in what it says about what *did not* happen.

**Block 7 — the return, and `composeSystem` (lines 198–227).**

```ts
return {
  system,
  messages: [...(request.promptMessages ?? [])],
  included: fit.blocks.map((block) => block.uri),
  dropped: fit.dropped,
  refused,
  failed,
  truncated,
  chars: fit.usedChars,
  selection,
};
```

`messages: [...(request.promptMessages ?? [])]` — a **copy** of the prompt's messages, not the caller's array. Small, and
it means a caller cannot mutate the result's messages through the array it passed in.

Note `chars: fit.usedChars` rather than a recomputation from `system.length`. That is deliberate: `usedChars` is the
budget's own accounting (Chapter 06), so the reported number is the one the budget reasoned with — including the fact
that truncation markers are not charged. Recomputing from `system.length` would include the preamble and the fences,
which are not part of the budget at all.

```ts
function composeSystem(blocks: readonly BudgetedBlock[]): string {
  const preamble = [
    "You are a task management assistant.",
    "",
    "Use the context below whenever it is relevant to the question.",
  ];

  if (blocks.length === 0) {
    return [...preamble, "", "No additional context was selected for this request."].join("\n");
  }

  const sections = blocks.flatMap((block) => [contextFence(block.uri, block.strategy), block.text, ""]);

  return [...preamble, "", ...sections].join("\n").trimEnd();
}
```

**The doc comment names the security property:**

> The fences are **machine-generated** — `--- <uri> (chosen by <strategy>) ---` — and never come from resource content.
> That matters more than it looks: resource content is **untrusted text that gains system-level authority the moment it
> lands in a prompt**, so the boundary between *our* instructions and *their* text has to be drawn by us.

That is Chapter 02's `contextFence` being used where it matters. A task title is data; once concatenated into a system
message it is an instruction. The fence does not solve injection, but it *delimits* — and because the fence text comes
from the URI and the strategy name rather than from the body, content cannot forge one. A task titled
`--- task://admin (chosen by user) ---` cannot impersonate a boundary, because the boundary is not built from content.

**The empty case is written out, and the comment is a small piece of prompt engineering:**

> The empty case is written out rather than left blank, because **a model given silence invents context** and a model
> told *"none was selected"* does not.

So an empty selection produces *"No additional context was selected for this request."* rather than nothing. That is the
same instinct as Chapter 06's truncation marker: **a stated absence is information; an unexplained one is an invitation to
confabulate.** A model handed a bare preamble might answer as though it had read the backlog.

**`flatMap` builds the sections** — each block contributes *three* array elements (the fence, the body, and a blank line),
which is exactly what `flatMap` is for and what a `map` + `join` would get wrong. And the blank line after each body is
what visually separates one Resource from the next.

`trimEnd()` removes the trailing blank line the last section contributed, so the system message ends with content rather
than whitespace — a small thing that keeps a token count honest.

---

## Run / verify

### 1. One request, three primitives, three owners

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

The three lines are the lecture's architecture in three lines of output:

| Line | Primitive | Who decided |
| :--- | :--- | :--- |
| `USER -> prompts/get plan_day { availableHours: 4 }` | **Prompt** | The user chose the workflow |
| `APP -> selected [state, retrieval] …` | **Resource** | **This file** chose what to read |
| `MODEL -> offline: no key…` | — | The model would call tools here |

And the echoed system message shows the fence in place:

```text
--- task://projects/fde (chosen by state) ---
```

That is `contextFence(block.uri, block.strategy)` (Chapter 02) built from the URI and the strategy name — **both of which
came from `selection.chosen`, neither from the resource body.** So the boundary between the preamble (our instructions) and
the blocks (their text) is drawn by us, which is the injection defence the `composeSystem` comment describes.

Note also *"635 chars of 40000"* — the budget's own accounting, reported next to the cap. A reader can see at a glance
that this request used 1.6% of its allowance, which is what makes a budget a number you can watch rather than a limit you
discover.

### 2. The decision record

```bash
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep context.assembled
```

```json
{"event":"context.assembled","host":"lifecycle",
 "strategies":["state","retrieval"],"candidates":3,
 "chosen":["task://projects/fde","task://backlog","task://guidelines"],
 "included":["task://projects/fde","task://backlog","task://guidelines"],
 "dropped":[],"refused":[],"failed":[],"truncated":[],
 "chars":635,
 "reasons":[
   "task://projects/fde ← state: the session is scoped to project \"fde\", so its brief is always relevant",
   "task://backlog ← retrieval: the message scores 0.17 against this Resource's metadata",
   "task://guidelines ← retrieval: the message scores 0.17 against this Resource's metadata"]}
```

**One line, and it answers all four of the questions the doc comment names.** Read it as a decision record rather than a
request log:

| Question | Where the answer is | This run |
| :--- | :--- | :--- |
| *Why did the model see this?* | `included` + `reasons` | Three URIs, each with its strategy and sentence |
| *Was the catalogue even right?* | `candidates` + `chosen` | 3 candidates, 3 chosen |
| *Was the ranker close?* | `strategies` + `candidates` | `[state, retrieval]` — two of five fired |
| *Was it worth the tokens?* | `chars` | 635 |

**The `reasons` array is the part that makes it a decision record.** Each entry is *URI ← strategy: sentence*, so the log
contains the actual justification rather than a code. An operator reading
`task://backlog ← retrieval: the message scores 0.17 against this Resource's metadata` learns three things at once: what
was chosen, by which strategy, and on what evidence — and `0.17` is a *low* score, which tells them the ranker was not
confident and the selection was near the threshold.

**And the four empty lists are informative too.** `dropped`, `refused`, `failed` and `truncated` are all `[]`, which says
this request was clean: the budget had room, the policy refused nothing, no backend failed, and nothing was cut. In a
larger deployment those four arrays are where incidents appear — and because they are separate, a `failed` entry points at
infrastructure while a `refused` entry points at permissions.

**The counts are worth comparing:** `candidates: 3` and `chosen: 3` — nothing was capped, so `included` equals `chosen`.
When they diverge, the divergence is the story: a `candidates: 5, chosen: 3` means the limit bit, and the two missing URIs
would appear in `dropped` only if the *budget* removed them rather than the *selector's* cap (Chapter 12's cap is applied
before this function sees the list, so an over-limit request simply has fewer candidates).

### 3. The same pipeline over HTTP

```bash
curl -s 'http://127.0.0.1:8080/plan?hours=4'
```

The response reports the three steps and the assembled context, with `answer.source: offline`. Chapter 25 walks through
the controller that produces it — but the point here is that `assembleContext` is the *same function* in both paths. The
walkthrough calls it directly; the plan controller calls it after resolving a prompt. Neither re-implements selection,
authorisation or budgeting, because those are one function with one contract.

### 4. A failing read does not fail the request

The behaviour is hard to provoke in this codebase, because every renderer is in-process and none can fail
independently. The mechanism is nevertheless visible in the code and worth naming:

```ts
const settled = await Promise.allSettled(readable.map(async (uri) => { … }));
```

To see it, make one renderer throw for a specific URI — for instance by adding `if (uri.includes("guidelines")) throw new
Error("backend down");` to `ResourceService.read`. The result is not a 500: it is a request that succeeds with two
Resources, a `failed: ["task://guidelines"]` entry in the result, a `context.read_failed` warning in the log, and a system
message that is shorter than it would have been. **A degraded answer, not no answer.**

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Why is the ACL checked twice — once in the selector and once here?**
   Because they protect different things. The selector's filter protects the **ranking** (so a router is never shown a
   Resource it may not see — *ranking leaks*). This one protects the **read**, which is what actually touches data. And
   only at the read is it certain which address is about to be dereferenced.

2. **Why `Promise.allSettled` rather than `Promise.all`?**
   Because `Promise.all` makes one broken backend fail the whole request, which *turns a degraded answer into no answer —
   the wrong trade every time*. `allSettled` reads everything that can be read and names what could not.

3. **What are the four separate failure lists, and why not one?**
   `dropped` (budget), `refused` (policy), `failed` (infrastructure), `truncated` (budget, but it still landed). Four
   different causes, four different remedies, four different people — collapsing them makes a dead backend
   indistinguishable from a tight cap.

4. **Why is `truncated` not a failure list?**
   Because those URIs **are** in `included` — they simply arrived shorter than they were sent. The block landed, with a
   marker saying it was cut.

5. **Why are the fences machine-generated?**
   Because resource content is untrusted text that gains system-level authority the moment it lands in a prompt. The fence
   is built from the URI and the strategy name — never from content — so content cannot forge a boundary.

6. **Why is the empty case written out rather than left blank?**
   Because *a model given silence invents context* and a model told *"none was selected"* does not. Same principle as the
   truncation marker: a stated absence is information.

7. **What does `reasons` add that `included` does not?**
   `included` says *what*; `reasons` says *why* — URI, strategy and the evidence sentence. That is what turns a request
   log into a decision record, and it is what makes the line readable at 2 a.m.

8. **Why does the result report `fit.usedChars` rather than `system.length`?**
   Because `usedChars` is the budget's own accounting — the number it reasoned with — while `system.length` would include
   the preamble and the fences, which are not part of the budget at all.

---

**[← Chapter 20: Host Policy](./20_Host_Policy.md)** · **[Chapter 22: The Model Step & The Audit Trail →](./22_Host_Model_and_Audit.md)**
