# Chapter 05: Core — The Error Taxonomy

> **Chapter goal:** Keep the two error mechanisms of MCP strictly separate, and make
> every business failure carry the sentence the *model* needs to recover — because
> that sentence lands in the model's context.

---

## 5.1 File details

| | |
| :--- | :--- |
| **Path** | `src/core/errors.ts` |
| **Layer** | core (imports nothing) |
| **Purpose** | Define the `ToolError` taxonomy, the `ToolResult` wire shape, and the `ToolOutcome`/`success`/`failure` helpers that keep handlers free of transport concerns |
| **Imports** | none |
| **Exports** | `type ToolFailureCode`, `class ToolError`, `type TextBlock`, `type ToolResult`, `type ToolOutcome`, `toolSuccess()`, `toolFailure()` |
| **Consumed by** | `src/domain/taskStore.ts`, `src/services/taskService.ts`, `src/core/guards.ts`, `src/mcp/tools.ts` |
| **Lecture sections** | [05 — The Tools Primitive](../../../notes/05_The_Tools_Primitive.md) §5.7 (the two error mechanisms), [03 — MCP vs tool calling](../../../notes/03_MCP_vs_Tool_Calling_Complementary_Layers.md) (tool output is untrusted input) |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# a business failure: isError=true, with recovery text
npm run host | grep -A1 'complete_task id=999'

# a protocol error: the call never happened
npm run host | grep 'tasks/999'
```

---

## 5.2 Full file

```ts
/**
 * Chapter 05 §5.7 — the two error mechanisms, kept deliberately separate.
 *
 *  · A **protocol error** means the call never happened — an unknown tool, a
 *    malformed frame, a missing capability. Nothing executed, and the host may
 *    retry safely.
 *
 *  · A **tool execution error** means the call *ran* and the operation failed.
 *    It travels back as an ordinary result with `isError: true`, and its text
 *    is appended to the model's context — which makes it an instruction
 *    channel, not a stack trace.
 *
 * That second point is why every error below carries a `recovery` sentence.
 * The model reads `content`, so a message that says only `Error` teaches it
 * nothing and it will hallucinate success on the next turn.
 */

/** Business failure classes. Deliberately small — a taxonomy nobody reads is a taxonomy nobody uses. */
export type ToolFailureCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "UNAVAILABLE";

export class ToolError extends Error {
  readonly code: ToolFailureCode;

  /** Written *for the model*: the next thing to try. */
  readonly recovery: string;

  /**
   * True only when a retry cannot duplicate a side effect.
   * A destructive, non-idempotent operation is never retryable, however
   * transient the fault looks.
   */
  readonly retryable: boolean;

  constructor(code: ToolFailureCode, message: string, recovery: string, retryable = false) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.recovery = recovery;
    this.retryable = retryable;
  }
}

export type TextBlock = {
  type: "text";
  text: string;
};

/**
 * The wire shape of a tool result: `content[]` blocks, never a bare value.
 * `structuredContent` is the machine-readable half and must satisfy the tool's
 * declared `outputSchema`.
 *
 * Declared as a type alias rather than an interface on purpose: an object type
 * alias gets an implicit index signature, which is what lets it satisfy the
 * SDK's `{ [x: string]: unknown; content: ... }` callback contract.
 */
export type ToolResult<Structured> = {
  content: TextBlock[];
  structuredContent?: Structured;
  isError?: boolean;
};

/**
 * What a handler computes, before any transport concern is applied.
 *
 * Separating the *outcome* (business meaning) from the *result* (wire shape) is
 * what lets one `guard` wrapper own rate limiting, timeouts, metrics and error
 * mapping for every tool.
 */
export type ToolOutcome<Structured> = {
  /** Prose for the model. Short — this is context, not a report. */
  text: string;
  /** The typed payload the client can validate. */
  structured: Structured;
};

export function toolSuccess<Structured>(outcome: ToolOutcome<Structured>): ToolResult<Structured> {
  return {
    content: [{ type: "text", text: outcome.text }],
    structuredContent: outcome.structured,
  };
}

export function toolFailure(error: ToolError): ToolResult<never> {
  return {
    content: [{ type: "text", text: `${error.message} ${error.recovery}` }],
    isError: true,
  };
}
```

## 5.3 Block-by-block explanation

### Block 1 — the two mechanisms, named before any code

The header comment is the specification. It states the distinction the whole
chapter turns on:

| | Protocol error | Tool execution error |
| :--- | :--- | :--- |
| **What happened** | The call never happened | The call ran and the operation failed |
| **Examples** | unknown tool, malformed frame, missing capability | task not found, already completed, rate limited |
| **Wire shape** | JSON-RPC `error` object | a normal `result` with `isError: true` |
| **Who sees it** | the host (and the developer) | **the model** |
| **Safe to retry?** | Yes — nothing executed | Only if the operation is idempotent |
| **Text audience** | a human debugging | the model deciding its next move |

The last row is the one that changes how you write code. A protocol error's
message is for an engineer reading a log. A tool execution error's message is
**appended to the model's context** and read by the model on its next turn —
which makes it an *instruction channel*.

That reframing has a direct consequence, stated in the comment:

> A message that says only `Error` teaches the model nothing, and it will
> hallucinate success on the next turn.

This is not speculation. Chapter 07 §7.3 of the lecture lists "no tool selected /
wrong tool selected / right tool, wrong arguments" as the failures of the
probabilistic step — and a failure with no recovery instruction pushes the model
straight back into that step with no new information.

### Block 2 — `ToolFailureCode`, a deliberately short list

```ts
export type ToolFailureCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "UNAVAILABLE";
```

**What it does:** enumerates the five ways a tool call can fail.
**How it works:** it is a string-literal union, not an enum — so it compiles to
nothing, is comparable with `===`, and appears in logs as the readable string
`"NOT_FOUND"` rather than a number.

Why these five, and why so few?

| Code | Meaning | Retryable? | Where it is raised |
| :--- | :--- | :--- | :--- |
| `INVALID_INPUT` | The arguments failed validation | No — fix the arguments | `taskService` (re-validation) |
| `NOT_FOUND` | The addressed thing does not exist | No — read the board first | `taskService`, `taskStore` |
| `CONFLICT` | The request contradicts current state | No — the state already holds | `taskService.complete` |
| `LIMIT_EXCEEDED` | A budget or capacity was hit | Maybe — after a wait | `RateLimiter`, `taskStore` |
| `UNAVAILABLE` | A transient fault or a timeout | Yes — once | `withTimeout`, `toToolError` |

**The list is short on purpose, and the comment says so:** *"a taxonomy nobody
reads is a taxonomy nobody uses."* A 30-code taxonomy looks thorough and
collapses in practice, because nobody remembers whether `TASK_ALREADY_COMPLETED`
is distinct from `STATE_CONFLICT`. Five codes are few enough to hold in your head,
and the `recovery` sentence carries the specificity that a code cannot.

**Notice what is absent: no `INTERNAL_ERROR` and no `UNKNOWN`.** Those are
anti-codes — they describe the *absence* of a diagnosis while looking like one.
Anything genuinely unexpected is mapped to `UNAVAILABLE` with a retry hint
(Block 4 of `src/mcp/tools.ts`), which at least tells the model what to do.

### Block 3 — `ToolError`, an `Error` with two extra fields that matter

```ts
export class ToolError extends Error {
  readonly code: ToolFailureCode;
  readonly recovery: string;
  readonly retryable: boolean;

  constructor(code: ToolFailureCode, message: string, recovery: string, retryable = false) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.recovery = recovery;
    this.retryable = retryable;
  }
}
```

**What it does:** carries a business failure with enough information for two
different audiences at once.
**How it works:** four fields, each with a job.

**`extends Error`** — not a plain object, because this is thrown. Extending
`Error` preserves the stack trace and makes `error instanceof ToolError` work in
the `guard()` catch block (Chapter 10), which is how the wrapper distinguishes a
deliberate business failure from a genuine crash.

**`code: ToolFailureCode`** — for *programmatic* consumers. The host can branch on
it; a metrics dashboard can group by it. It is the machine-readable half.

**`recovery: string`** — for the *model*. Compare the two halves of the same
error:

```text
message:  No task with id 999.
recovery: Call list_tasks to read the exact ids, then retry.
```

The message names the fault. The recovery names the fix, and it names it as an
*action the model can take with the tools it has*. That is the difference between
a model that recovers and a model that apologises.

**`retryable: boolean`** — the safety flag, defaulting to `false`. The default is
the important part: **retrying is opt-in, not opt-out.** A tool that forgot to
consider retryability is therefore non-retryable, which is the safe failure mode.
Opting *in* to a retry requires an explicit `true` at the throw site.

**`this.name = "ToolError"`** — one line that pays off in logs. Without it, an
error's name is `"Error"`, and a log line saying `"name":"Error"` tells you
nothing. Setting it makes the class identifiable in any log aggregator.

**Why `readonly` on all three?** An error that can be mutated after it is thrown
is an error whose meaning can change while it is in flight. `readonly` is
compile-time enforcement of "this is a fact, not a scratchpad".

**Why four positional parameters rather than an options object?** Because the
call sites read as a sentence:

```ts
throw new ToolError("NOT_FOUND", `No task with id ${value}.`, "Call list_tasks to read the exact ids, then retry.");
```

Four positional arguments is the practical limit before an options object becomes
clearer. Beyond that, a reader has to count commas.

### Block 4 — `TextBlock` and `ToolResult`, and the index-signature subtlety

```ts
export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolResult<Structured> = {
  content: TextBlock[];
  structuredContent?: Structured;
  isError?: boolean;
};
```

**What they do:** describe the wire shape of a result.
**How they work:** a result is `content[]` blocks — **never a bare value** — plus
an optional typed payload and an optional error flag.

**`content: TextBlock[]`, not `content: string`.** This is the MCP spec's shape:
content is a *list of typed blocks*, and `"text"` is only one of the possible
types (image, audio, resource link and embedded resource are the others).
Modelling it as an array means adding an image later is a new member of the union,
not a breaking change to every consumer. It also means a result can carry a text
summary *and* a structured payload simultaneously — which is exactly what the
tools do.

**`type: "text"` is a literal type, not `string`.** That single detail is what
makes `TextBlock` assignable to the SDK's content-block union: TypeScript matches
the literal `"text"` against the union's discriminated member. If `type` were
`string`, no member would match and the assignment would fail.

**`structuredContent?: Structured` is the machine-readable half.** The `text` is
for the model; the `structuredContent` is for the client, and it must satisfy the
tool's declared `outputSchema`. Splitting them is what lets a model read prose
while a program reads a schema-validated object — the same two-audience idea as
`ToolError.message` versus `ToolError.recovery`.

**Now the subtlety the comment names.** Both types are declared with `type X = {…}`
rather than `interface X {…}`. That is not a style preference; it is required.

The SDK's tool callback return type is effectively
`{ [x: string]: unknown; content: … }` — it has an **index signature**. TypeScript
grants an *implicit* index signature to object **type aliases**, but **not** to
`interface` declarations:

```ts
interface A { content: string[] }
type B = { content: string[] }

declare const a: A;
declare const b: B;

const x: Record<string, unknown> = a;  // ✗ error: index signature missing in type 'A'
const y: Record<string, unknown> = b;  // ✓ fine — type aliases get one implicitly
```

So `interface ToolResult {…}` produces this compiler error at every
`registerTool` call:

```text
Index signature for type 'string' is missing in type 'ToolResult<{ task: Task; }>'.
```

The fix is one keyword. It is worth knowing because the error message points at
the *call site* rather than the declaration, and the natural instinct is to look
in the wrong file.

**`isError?: boolean`** is optional, and its *absence* means success. That matters:
the SDK's contract is `isError?: boolean`, so omitting it is the correct "no
error" — a client checking `result.isError === true` is doing the right thing,
and a client checking `!result.isError` is also right.

### Block 5 — `ToolOutcome`: the separation that makes `guard()` possible

```ts
export type ToolOutcome<Structured> = {
  /** Prose for the model. Short — this is context, not a report. */
  text: string;
  /** The typed payload the client can validate. */
  structured: Structured;
};
```

**What it does:** describes what a handler *computes*, before any transport
concern is applied.
**How it works:** it is the pair `(text, structured)` — deliberately *not* the same
shape as `ToolResult`, and the difference is the whole design.

Look at what `ToolOutcome` does **not** have:

- no `content[]` array — the handler should not know the wire encoding
- no `isError` — a handler that succeeded does not set an error flag
- no failure path at all — failure leaves by **throwing**, not by returning

That last point is the key. A handler's contract becomes:

> Return a `ToolOutcome` if it worked. **Throw a `ToolError` if it did not.**

One way in, one way out. Because failures are exceptions rather than return
values, the handler body has no `if (failed) return {...}` branches — you can see
this in `src/mcp/tools.ts`, where `complete_task` is three lines:

```ts
const task = deps.service.complete({ id });
return { text: `Task completed: #${task.id} ${task.title} (${task.status}).`, structured: { task } };
```

The `NOT_FOUND` and `CONFLICT` paths are simply absent from the handler, because
`taskService.complete` throws them. That is what "business logic lives in the
service" looks like when it is actually true.

`ToolResult` is then assembled **once**, by the guard, from either an outcome
(success) or a `ToolError` (failure). No handler ever constructs a wire shape.

**"Short — this is context, not a report."** The comment constrains the content.
The `text` field is appended to the model's context window; a paragraph of JSON
there is context budget spent on something the model could have asked for. Note
what the tools actually return: `Task #1 created: Record MCP Video (PENDING).` —
one sentence, with the id and the state, because those are the two facts the model
needs to act next.

### Block 6 — `toolSuccess` and `toolFailure`, the only two ways out

```ts
export function toolSuccess<Structured>(outcome: ToolOutcome<Structured>): ToolResult<Structured> {
  return {
    content: [{ type: "text", text: outcome.text }],
    structuredContent: outcome.structured,
  };
}

export function toolFailure(error: ToolError): ToolResult<never> {
  return {
    content: [{ type: "text", text: `${error.message} ${error.recovery}` }],
    isError: true,
  };
}
```

**What they do:** convert a domain outcome or a domain error into a wire result.
**How they work:** two functions, mirroring the two mechanisms.

**`toolSuccess`** wraps the text in a one-element content array and passes the
structured payload through untouched. Note the `type: "text"` literal — because
`TextBlock` types it as the literal `"text"`, TypeScript narrows the object
literal correctly and no `as const` is needed (compare `Basic Code`, which had to
write `{ type: "text" as const, text }` because it had no such type).

**`toolFailure` concatenates `message` and `recovery` into one string:**

```text
No task with id 999. Call list_tasks to read the exact ids, then retry.
```

One string, because `content` is what the model reads — splitting them into two
blocks would present the fault and the fix as two separate observations rather
than one instruction. The space between them is load-bearing; without it the
sentence runs together.

**`ToolResult<never>` on `toolFailure` is deliberate.** A failure carries no
`structuredContent`, so the generic parameter is uninhabited — `never` says
exactly that. It also makes the return type assignable to *any*
`ToolResult<Structured>`, so a failure can be returned from a handler whose
success path has a specific output type. TypeScript's `never` is the bottom type;
it is assignable to everything.

**Neither function ever writes `isError: false`.** Success is the *absence* of the
flag, which keeps the success payload minimal on the wire.

**Why are these functions here rather than in `mcp/tools.ts`?** Because they
encode the *contract*, and the contract is the thing `core/errors.ts` owns. The
tool layer imports them; it does not define them. That is what lets a future
transport (Streamable HTTP, a test harness) reuse the same result shape without
importing anything from `mcp/`.

---

## 5.4 Run / verify

Both mechanisms are exercised by the demo. Watch the **tool execution error**
first — the call ran, the operation failed, and the text is a recovery
instruction:

```bash
npm run host | grep 'complete_task id=999'
```

```text
   complete_task id=999 -> isError=true No task with id 999. Call list_tasks to read the exact ids, then retry.
```

Three things to notice in that one line:

1. `isError=true` — the call **happened** and returned a result.
2. The message names the fault: `No task with id 999.`
3. The recovery names the fix, as an action the model can take:
   `Call list_tasks to read the exact ids, then retry.`

Now the **conflict** — the same shape, a different diagnosis, and a recovery that
explicitly says *do not retry*:

```bash
npm run host | grep -A1 'complete_task id=1'
```

```text
   complete_task id=1   -> Task completed: #1 Record MCP Video (COMPLETED).
   complete_task id=1   -> isError=true Task #1 is already COMPLETED. Nothing to do — report the current state instead of retrying.
```

Compare the two recovery sentences. `NOT_FOUND` says *go read the board and try
again*. `CONFLICT` says *stop, report the state*. A single generic error message
could not produce either, and a model given `Error: conflict` would do the one
thing that is definitely wrong: retry.

Finally the **protocol error** — a different mechanism entirely. Reading a
resource that does not exist executes nothing, so there is no `isError` channel
and the failure arrives as a JSON-RPC error:

```bash
npm run host | grep 'tasks/999'
```

```text
   read company://tasks/999 -> protocol error: Resource not found: company://tasks/999
```

Note the two words in that output: `protocol error`. It is not an `isError`
result, because there is no model waiting on a recovery instruction — the
*application* asked for a resource that is not there, and the application gets an
exception.

---

## 5.5 Checkpoint

1. **Two mechanisms, never mixed.** A protocol error means the call never
   happened (retry-safe, no side effects). A tool execution error means the call
   ran and the operation failed (`isError: true`, not retry-safe by default).
2. **Tool error text is an instruction channel.** It lands in the model's context,
   so it must carry a `recovery` sentence naming the next action — not just a
   fault.
3. **`retryable` defaults to `false`.** Retrying is opt-in, so a throw site that
   forgot to think about it fails safe.
4. **Handlers throw, they do not return failures.** That is why no tool handler
   contains an error branch, and why the wire shape is assembled in exactly one
   place.
5. **`ToolResult` and `TextBlock` must be type aliases, not interfaces.** An
   interface has no implicit index signature and cannot satisfy the SDK's callback
   contract.
6. **The taxonomy has five codes on purpose.** `INTERNAL_ERROR` and `UNKNOWN` are
   anti-codes; anything unexpected becomes a retryable `UNAVAILABLE`.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 04 — Core: Metrics Without a Vendor](./04_Core_Metrics.md)

**Next:** [Chapter 06 — Core: Execution Guards](./06_Core_Execution_Guards.md)


