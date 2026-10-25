# Chapter 04 — Observability — `AgentResponse` and Traces

> **The chapter where the answer stops being the only output.** Chapter 03 of the notes
> makes one claim: *a satisfying answer is not evidence*. This chapter implements the
> response that carries its own evidence, and the middleware that makes a request
> nameable.
>
> This is the file that Chapters 06–09 are all functions of. If the trace contract is
> wrong, every score downstream is wrong in a way no amount of judge-tuning can fix.

---

## File details

| | `src/services/supportAgent.ts` | `src/middleware/requestContext.ts` |
|---|---|---|
| **Lines** | 110 | 30 |
| **Layer** | services | HTTP |
| **Purpose** | the application under test: route → retrieve → tool → answer, traced | give every request a trace id, and log the outcome |
| **Exports** | `SupportAgent`, `buildContext()` | `requestContext` |
| **Imports** | `node:crypto`, `config`, `types`, `knowledgeBase`, `model`, `tools` | `node:crypto`, `express` types |
| **Notes sections** | Ch02 §2.1–2.3, Ch03 §3.3/§3.7 | Ch03 §3.6, §3.8 |

**`buildContext()` is exported** even though only the agent calls it. That is a
deliberate seam: the context string is the contract between retrieval, tools and the
judge, and a contract with a name can be tested. Chapter 03 §3.7's "record the exact
context string, never re-derive it" is easier to honour when the builder is a thing you
can point at.

---

## Commands

```bash
npm start

# Chapter 03 §3.3 — the two outputs of one request.
curl -s -X POST http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"message":"Where is ORD-101?"}' | python3 -m json.tool
```

```json
{
  "answer": "Order ORD-101 has been shipped and is on the way.",
  "retrievedDocuments": [],
  "toolsUsed": ["getOrderStatus"],
  "toolArguments": ["ORD-101"],
  "toolResults": ["Order ORD-101 has been shipped and is on the way."],
  "context": "TOOL RESULT 1: Order ORD-101 has been shipped and is on the way.",
  "trace": { "traceId": "…", "latencyMs": 0, "model": "offline-v1", "promptVersion": "v1" }
}
```

```bash
# Chapter 03 §3.6 — every response is nameable.
curl -s -D - -o /dev/null -X POST http://127.0.0.1:8080/chat \
  -H 'content-type: application/json' -d '{"message":"What is the weather in Paris?"}' | grep -i x-trace-id
#   x-trace-id: 499493d2-6c4a-4e26-8046-e375cd48ebd8

# and the stderr log line for the same request:
#   [trace 499493d2-…] POST /chat 200 3ms
```

---

## `src/services/supportAgent.ts` — the full file

```ts
import { randomUUID } from "node:crypto";
import { config } from "../config/config.js";
import type { AgentResponse, RetrievedDocument, ToolCall, Trace } from "../domain/types.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { orderIdIn, type ModelClient } from "./model.js";
import { runTool, toolNames } from "./tools.js";

/**
 * Chapter 02 §2.2 — the application under test.
 *
 * Three capabilities, one entry point:
 *
 *   Category A  policy question      retrieval, no tool
 *   Category B  order question       tool, no retrieval
 *   Category C  out of scope         neither, and a refusal
 *
 * Chapter 03's whole argument is visible in `chat()`: it returns **two** things.
 * The caller gets an answer; the tester gets a trace. A satisfying answer is not
 * evidence, and this method is where the evidence is collected.
 */
export class SupportAgent {
  constructor(
    private readonly model: ModelClient,
    private readonly knowledgeBase: KnowledgeBase = new KnowledgeBase(),
  ) {}

  /**
   * Chapter 03 §3.7 — one request, fully recorded.
   *
   * `caseId` is optional and is set only during an eval run. Chapter 03 §3.8 asks
   * for it because a failure has to map back to one readable row of the dataset —
   * "case 6 of the golden dataset" is a bug report; "some request" is not.
   */
  async chat(question: string, caseId?: string): Promise<AgentResponse> {
    const startedAt = Date.now();

    // Chapter 02 §2.2 — routing. An order question is answered from the order
    // tools and deliberately skips retrieval; a policy question is the other way
    // round. The dataset asserts both directions, so this one line is load-bearing:
    // it is what makes "no unexpected source" a meaningful check rather than a
    // check that can never fail.
    const retrieved =
      orderIdIn(question) === undefined ? this.knowledgeBase.search(question) : [];

    const toolCalls: ToolCall[] = [];
    let context = buildContext(retrieved, []);
    let turn = await this.model.answer({ question, context, toolNames });

    if (turn.kind === "tool") {
      // Chapter 02 §2.3 — a tool failure is a *result*, not an exception. The
      // agent has to be told "order not found" so that it can say so.
      const result = runTool(turn.name, turn.argument);
      toolCalls.push({ name: turn.name, argument: turn.argument, result });

      // Chapter 03 §3.7 — the context is assembled once, from retrieval *and*
      // tool results, and then recorded. Re-deriving it later is how you end up
      // judging context the model never saw.
      context = buildContext(retrieved, toolCalls.map((call) => call.result));

      // The second turn withholds the tools, so the model must answer.
      turn = await this.model.answer({ question, context, toolNames: [] });
    }

    if (turn.kind !== "answer") {
      throw new Error("The model requested a tool after the tool-call budget was spent");
    }

    const trace: Trace = {
      traceId: randomUUID(),
      ...(caseId === undefined ? {} : { caseId }),
      question,
      retrievedDocuments: retrieved,
      context,
      toolCalls,
      latencyMs: Date.now() - startedAt,
      model: this.model.version,
      promptVersion: config.promptVersion,
    };

    return {
      answer: turn.content,
      // Chapter 03 §3.4 — ids only, and an empty array is evidence, not missing
      // data: `toolsUsed: []` asserts that the tool path was *not* taken.
      retrievedDocuments: retrieved.map((document) => document.id),
      toolsUsed: toolCalls.map((call) => call.name),
      toolArguments: toolCalls.map((call) => call.argument),
      toolResults: toolCalls.map((call) => call.result),
      context,
      trace,
    };
  }
}

/**
 * Chapter 03 §3.7 — the context builder.
 *
 * It is a function rather than a few lines inside `chat()` for one reason: the
 * context is a *contract* between retrieval, tools and the judge. Everything the
 * judge is allowed to call "evidence" passes through here, so there is exactly one
 * definition of what evidence the model had.
 */
export function buildContext(retrieved: RetrievedDocument[], toolResults: string[]): string {
  const parts = retrieved.map((document) => `SOURCE: ${document.id}\n${document.text}`);

  toolResults.forEach((result, index) => {
    parts.push(`TOOL RESULT ${index + 1}: ${result}`);
  });

  return parts.join("\n\n");
}
```

### Block-by-block

**Block 1 — the routing decision.**

```ts
const retrieved =
  orderIdIn(question) === undefined ? this.knowledgeBase.search(question) : [];
```

One ternary, and it is the most consequential line in the project. It says: **an order
question is answered from the order tools and does not consult the policy corpus; a policy
question is the other way round.**

Why it is written here rather than hidden inside `search()`: the dataset asserts both
directions. `expectedSource: null` on an order case means "no document may be retrieved",
and that is only checkable if the decision is a *behaviour of the agent*. Bury it in
retrieval and the assertion becomes untestable — which is the same as not having it.

**Block 2 — the context is built before the first model call.**

```ts
const toolCalls: ToolCall[] = [];
let context = buildContext(retrieved, []);
let turn = await this.model.answer({ question, context, toolNames });
```

Note the ordering: retrieval happens, then the context is assembled, then the model is
asked. The model never sees raw documents — it sees the context string, and that exact
string is what gets recorded on the trace. Chapter 03 §3.7's rule ("record the context the
model actually saw") is satisfied by construction here, because there is only ever one
context variable and it is both passed to the model *and* stored.

**Block 3 — the tool round, and why the context is rebuilt.**

```ts
if (turn.kind === "tool") {
  const result = runTool(turn.name, turn.argument);
  toolCalls.push({ name: turn.name, argument: turn.argument, result });
  context = buildContext(retrieved, toolCalls.map((call) => call.result));
  turn = await this.model.answer({ question, context, toolNames: [] });
}
```

Four lines that encode Chapter 02 §2.3 and Chapter 03 §3.4:

| Line | Why |
| :--- | :--- |
| `runTool(...)` | the tool runs for real — nothing is mocked, because the tool *is* the system under test |
| `toolCalls.push({ name, argument, result })` | name, argument and result are recorded **together**, which is what later lets a failure distinguish "wrong tool" from "right tool, wrong argument" |
| `context = buildContext(...)` | the tool result becomes part of the evidence, so a tool-derived claim can be judged faithful |
| `toolNames: []` | **the tool budget is enforced by the model interface**, not by a counter |

That last row is worth pausing on. The second call offers *no tools*, so a compliant model
physically cannot loop. The alternative — a `while (rounds < 3)` loop — would need a
counter, an exit condition and a failure mode; passing an empty list needs nothing.

**Block 4 — the guard that should never fire.**

```ts
if (turn.kind !== "answer") {
  throw new Error("The model requested a tool after the tool-call budget was spent");
}
```

This is a *contract violation* guard, not a normal path. With the offline model it is
unreachable; with a real model it is the honest response to "the model called a tool it was
not offered".

Note it **throws** where `runTool` deliberately **returns**. That difference is the
principle from Chapter 03: a *tool* failure is evidence about the agent, so it becomes a
result the agent can be graded on. A *protocol* failure is a bug in the harness — and a
harness bug must not be silently scored as an agent failure. It must stop the run.

**Block 5 — the trace, and the spread that makes `caseId` optional.**

```ts
const trace: Trace = {
  traceId: randomUUID(),
  ...(caseId === undefined ? {} : { caseId }),
  question,
  retrievedDocuments: retrieved,
  context,
  toolCalls,
  latencyMs: Date.now() - startedAt,
  model: this.model.version,
  promptVersion: config.promptVersion,
};
```

The spread is not stylistic. Under `strict`, `caseId?: string` and
`caseId: string | undefined` are different things: the first means "may be absent", the
second means "present, and possibly undefined". The conditional spread is how you produce
the first. It matters because a trace carrying `"caseId": undefined` is a trace that lies
about being an eval run.

`model: this.model.version` and `promptVersion` are recorded *here*, per request, rather
than read from config at report time. A trace that cannot say which model produced it
cannot be compared with anything — Chapter 03 §3.8's "no ids, no versions".

**Block 6 — the two views of the same evidence.**

```ts
return {
  answer: turn.content,
  retrievedDocuments: retrieved.map((document) => document.id),
  toolsUsed: toolCalls.map((call) => call.name),
  toolArguments: toolCalls.map((call) => call.argument),
  toolResults: toolCalls.map((call) => call.result),
  context,
  trace,
};
```

Every field is a projection of `retrieved` or `toolCalls`, so there is no second place for
the truth to live. `retrievedDocuments` is ids only because that is what the checks
compare; the full objects (with rank and score) stay in `trace`, where the report and a
human can read them.

**Block 7 — `buildContext()`.**

```ts
export function buildContext(retrieved: RetrievedDocument[], toolResults: string[]): string {
  const parts = retrieved.map((document) => `SOURCE: ${document.id}\n${document.text}`);
  toolResults.forEach((result, index) => { parts.push(`TOOL RESULT ${index + 1}: ${result}`); });
  return parts.join("\n\n");
}
```

The labels are the point. `SOURCE: return-policy` and `TOOL RESULT 1:` are *addressing
information*: they tell the model where a fact came from, and they tell a human reading a
trace which document produced which sentence. Chapter 06's judge compares claims against
this string, and Chapter 07's `evidenceOf` strips exactly these prefixes back off — so the
two agree about what counts as evidence because they share one format.

This is also the function that had a real bug during development. An early version dropped
every `TOOL RESULT` line from the evidence, which left tool-answered cases with *no*
evidence and collapsed their faithfulness scores. The bug is worth remembering because it
is the characteristic failure of this layer: the trace was right, but the *projection* of
the trace that the judge saw was wrong — and no amount of judge tuning fixes a missing
input.

---

## `src/middleware/requestContext.ts` — the full file

```ts
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Chapter 03 §3.6 — every request gets a trace id, and the response carries it.
 *
 * This is the observability discipline in its smallest useful form. Chapter 03
 * §3.8 lists "no ids" as the mistake that makes a failure impossible to
 * correlate with a log line, a user report or an eval result.
 *
 * The id lives in `response.locals` rather than on the request object. That keeps
 * the user channel and the trace channel separate: the header carries the id so a
 * user can quote it, and the trace itself stays out of the response body.
 */
export function requestContext(request: Request, response: Response, next: NextFunction): void {
  const traceId = randomUUID();
  const startedAt = Date.now();

  response.locals.traceId = traceId;
  response.setHeader("x-trace-id", traceId);

  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  response.on("finish", () => {
    console.error(
      `[trace ${traceId}] ${request.method} ${request.path} ${response.statusCode} ${Date.now() - startedAt}ms`,
    );
  });

  next();
}
```

### Block-by-block

**Block 1 — why `response.locals` and not `request.traceId`.**

```ts
response.locals.traceId = traceId;
response.setHeader("x-trace-id", traceId);
```

Express types `locals` as an open record, so this assignment needs no module augmentation
and no cast. Putting the id on `request` would need eight lines of ambient type
declaration for one string.

More importantly, the two lines do two different jobs:

| Line | Channel | Purpose |
| :--- | :--- | :--- |
| `response.locals.traceId` | internal | so a controller or error handler can log the same id |
| `setHeader("x-trace-id")` | user | so a user can quote an id in a support ticket |

Chapter 03 §3.8's "keep the trace off the user channel" is honoured: the user gets an
*identifier*, never the trace itself.

**Block 2 — logging on `finish`, not on entry.**

```ts
const startedAt = Date.now();
response.on("finish", () => {
  console.error(`[trace ${traceId}] ${request.method} ${request.path} ${response.statusCode} ${Date.now() - startedAt}ms`);
});
next();
```

The listener is attached on the way in and fires on the way out, so a single line carries
the method, the path, the status *and* the duration. That is the minimum useful access log:
a request you cannot name, time and outcome is a request you cannot debug.

`next()` is called **after** the listener is registered, and unconditionally. A middleware
that fails to call `next()` hangs the request — the classic Express bug — and it is avoided
here by making `next()` the last statement rather than a branch.

**Block 3 — stderr, not stdout.**

```ts
console.error(...)
```

`console.error` writes to stderr, leaving stdout free for anything that reads the program's
output. That matters in `cli.ts` (Chapter 09), where the *report* goes to stdout and the
exit code is the verdict. Mixing diagnostics into stdout would corrupt any pipeline that
pipes the report somewhere.

---

## Checkpoint

1. **Why does `chat()` return the trace instead of logging it?**
   Because the trace is an *output of the system*, not a side effect. Chapters 06–09 are
   functions of `AgentResponse`; a trace that only exists in a log file cannot be asserted
   on, and an assertion you cannot write is a behaviour you cannot test.

2. **Why is `caseId` optional rather than always present?**
   Because production traffic has no dataset row. Making it optional is what lets one trace
   format serve both the eval and the server — and Chapter 03 §3.8's "no ids" is precisely
   the failure of systems that only ever had the production shape.

3. **Why is the tool budget enforced by passing `toolNames: []`?**
   Because it needs no state. A counter-based loop needs a limit, an exit path and a
   failure mode; an empty tool list makes looping impossible at the interface.

4. **Why does `buildContext` label its parts?**
   So the evidence is attributable. `SOURCE: return-policy` lets a human — and the judge's
   `evidenceOf` — tell where a claim came from, and a claim with no source is a claim you
   cannot judge.

5. **What is the difference between the `throw` in `chat()` and the `return` in `runTool`?**
   The `return` is about the *agent's* behaviour (a missing order is something the agent
   should report), so it becomes scorable evidence. The `throw` is about the *harness* (the
   model broke the tool contract), so it stops the run rather than producing a misleading
   score.

---

**[Chapter 05: The Golden Dataset →](./05_The_Golden_Dataset.md)**
