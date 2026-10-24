# Chapter 05 — Core: The Error Taxonomy & The Wire Adapter

> **The chapter most likely to be skipped and the one most likely to be missed later.** A
> failure has to survive a process boundary to be useful, and on the way out it loses everything
> except what the protocol carries. These two files are what stop a missing prompt argument and a
> crashed backend from arriving as the same undifferentiated error — and being answered `503`.

---

## File details

| | |
| :--- | :--- |
| **Files** | `src/core/errors.ts` (331 lines), `src/mcp/protocol.ts` (32 lines) |
| **Layer** | `errors.ts` is `core` (no SDK). `protocol.ts` is `mcp` — the only file that wraps the taxonomy in an SDK class. |
| **Purpose** | `errors.ts`: six failure classes, three origins, recovery sentences, and the JSON-RPC mapping. `protocol.ts`: the outbound adapter that puts a failure's class on the wire. |
| **Exports** | `FailureCode`, `FailureOrigin`, `AppError`, `ToolError`, `ResourceError`, `PromptError`, `JSON_RPC`, `jsonRpcCodeFor()`, `failureCodeFor()`, `createAppError()`, `FAILURE_CODES`, `isFailureCode()`, `toAppError()`, `TextBlock`, `ToolResult`, `ToolOutcome`, `toolSuccess()`, `toolFailure()` · `toProtocolError()` |
| **Lecture sections** | Ch03 §3.9 (resource errors), Ch07 §7.4 ("fail loudly"), Ch04 §"Authorisation lives in the handler" |
| **Runs** | `npm run lifecycle` step 6 · `curl` the host's error paths |

---

## Commands

```bash
# a Resource that does not exist — the server's refusal, and its recovery sentence
curl -s 'http://127.0.0.1:8080/read?uri=task://nope'

# a malformed template variable — INVALID_INPUT, not NOT_FOUND
curl -s 'http://127.0.0.1:8080/read?uri=task://tasks/abc'

# an unknown prompt — the host predicts this from its own menu (404)
curl -s 'http://127.0.0.1:8080/prompt?name=nope'

# a known prompt, missing its required argument (400)
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day'
```

---

## The three primitives fail in three different ways

This is the file's opening argument, and it is the reason there is a taxonomy at all rather
than one `AppError` with a message. The header states it as three bullets:

| Primitive | A failure is… | What the caller sees | Why |
| :--- | :--- | :--- | :--- |
| **Tool** | a **result** | `content[]` with `isError: true` | The call *ran* and the operation failed. The text travels as an ordinary reply, so it lands in the model's context and becomes an **instruction channel** — not a stack trace |
| **Resource** | a **protocol error** | a JSON-RPC error | Nothing executed. No model is waiting on a recovery sentence, and `resources/read` has no `isError` channel to put one in (Ch03 §3.9) |
| **Prompt** | a **programming error** | a loud refusal | An unknown prompt name or a missing argument means caller and server **disagree about the contract**. Failing loudly is the only honest response (Ch07 §7.4) |

Read those three together and the design follows. A tool failure is *for the model* — it should
read like an instruction ("the board is full; complete or delete some tasks"). A resource failure
is *for the caller* — it should be a typed protocol error the client can branch on. A prompt
failure is *for the developer* — it means the two sides disagree, and a retry will never help.

Conflating them produces one of two failures, both named in the header:

- **Lying to a model.** Return a tool failure as a protocol error and the model never learns what
  happened; it just sees a broken call and may retry forever.
- **Leaking internals to a user.** Return a resource failure as prose and a database message
  ends up rendered in a UI.

And that is why every error carries a `recovery` sentence **and** an `httpStatus`:

> the first is for the model, the second is for the HTTP layer, and neither is allowed to guess
> the other's audience.

---

## `src/core/errors.ts` — the full file

```ts
/**
 * Notes Ch03 §3.9 and Ch07 §7.4 — the error taxonomy, kept deliberately small.
 *
 * Lecture 15's three primitives fail in three genuinely different ways, and
 * conflating them is how a system ends up either lying to a model or leaking
 * internals to a user:
 *
 *  · A **tool** failure is a *result*. The call ran, the operation failed, and
 *    the text travels back as an ordinary reply with `isError: true` — which
 *    means it lands in the model's context and becomes an instruction channel,
 *    not a stack trace.
 *
 *  · A **resource** failure is a *protocol error*. Nothing executed, no model is
 *    waiting on a recovery sentence, and there is no `isError` channel on
 *    `resources/read` to put one in (Notes Ch03 §3.9).
 *
 *  · A **prompt** failure is a *programming error*. An unknown prompt name or a
 *    missing argument means the caller and the server disagree about the
 *    contract; failing loudly is the only honest response (Notes Ch07 §7.4).
 *
 * That is why every error below carries a `recovery` sentence **and** a status:
 * the first is for the model, the second is for the HTTP layer, and neither is
 * allowed to guess the other's audience.
 */

/**
 * Business failure classes. Deliberately small — a taxonomy nobody reads is a
 * taxonomy nobody uses.
 */
export type FailureCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "FORBIDDEN"
  | "UNAVAILABLE";

/** Which primitive produced the failure. Used for metrics labels and routing. */
export type FailureOrigin = "tool" | "resource" | "prompt";

/** The default HTTP mapping, overridable per call site when a code is context-specific. */
const DEFAULT_STATUS: Record<FailureCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 429,
  FORBIDDEN: 403,
  UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: FailureCode;
  readonly origin: FailureOrigin;

  /** Written *for the model* or the operator: the next thing to try. */
  readonly recovery: string;

  /**
   * True only when a retry cannot duplicate a side effect.
   * A destructive, non-idempotent operation is never retryable, however
   * transient the fault looks.
   */
  readonly retryable: boolean;

  /** The HTTP status the host answers with, when this crosses that boundary. */
  readonly httpStatus: number;

  constructor(
    origin: FailureOrigin,
    code: FailureCode,
    message: string,
    recovery: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.origin = origin;
    this.code = code;
    this.recovery = recovery;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[code];
  }
}

/** A tool execution error — reaches the model as `content` with `isError: true`. */
export class ToolError extends AppError {
  constructor(code: FailureCode, message: string, recovery: string, retryable = false) {
    super("tool", code, message, recovery, { retryable });
  }
}

/**
 * A resource failure — a **protocol error** on the wire (Notes Ch03 §3.9).
 *
 * `FORBIDDEN` is the interesting one: a URI outside the allow-listed schemes, or
 * a resource the session may not read, must be refused *before* a handler runs.
 * A template whose parameter is unchecked is an enumeration oracle (Notes Ch04
 * §"Authorisation and validation live in the handler"), so the refusal is a
 * first-class outcome rather than an afterthought.
 */
export class ResourceError extends AppError {
  constructor(
    code: FailureCode,
    message: string,
    recovery: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super("resource", code, message, recovery, options);
  }
}

/** A prompt failure — a contract violation between caller and server (Notes Ch07). */
export class PromptError extends AppError {
  constructor(
    code: FailureCode,
    message: string,
    recovery: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super("prompt", code, message, recovery, options);
  }
}

/**
 * The JSON-RPC error codes these failures travel as.
 *
 * Written as numbers rather than imported from the SDK on purpose: this module is
 * transport-agnostic, and these values are fixed by the JSON-RPC and MCP
 * specifications rather than by whichever library implements them.
 */
export const JSON_RPC = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  /** The argument is the problem. The caller can fix it, so it is never retryable. */
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP's own code for a resource that does not exist. */
  ResourceNotFound: -32002,
} as const;

/** Failure code → the JSON-RPC code that carries it across the wire. */
export function jsonRpcCodeFor(code: FailureCode): number {
  switch (code) {
    case "INVALID_INPUT":
    case "FORBIDDEN":
    case "CONFLICT":
      // All three are "the caller asked for something the server will not do",
      // and all three are fixed by changing the request rather than by retrying.
      return JSON_RPC.InvalidParams;
    case "NOT_FOUND":
      return JSON_RPC.ResourceNotFound;
    case "LIMIT_EXCEEDED":
    case "UNAVAILABLE":
      return JSON_RPC.InternalError;
  }
}

/**
 * JSON-RPC code → failure code. The inverse of `jsonRpcCodeFor`.
 *
 * Returns `undefined` for codes this taxonomy does not claim, so an unrecognised
 * wire error still falls through to the generic handling rather than being
 * mislabelled.
 */
export function failureCodeFor(wireCode: number): FailureCode | undefined {
  switch (wireCode) {
    case JSON_RPC.InvalidParams:
      return "INVALID_INPUT";
    case JSON_RPC.ResourceNotFound:
      return "NOT_FOUND";
    default:
      return undefined;
  }
}

/** The recovery sentence used when a failure is reclassified from the wire. */
const DEFAULT_RECOVERY: Record<FailureCode, string> = {
  INVALID_INPUT: "Correct the request to match the advertised contract, then retry once.",
  NOT_FOUND: "List what exists before asking for it again.",
  CONFLICT: "Read the current state and report it instead of retrying.",
  LIMIT_EXCEEDED: "Wait for the limit to reset, or reduce the request.",
  FORBIDDEN: "Request access, or use something the session is entitled to.",
  UNAVAILABLE: "Retry once. If it fails again, treat the capability as temporarily unavailable.",
};

/** Builds the right `AppError` subclass for an origin. One place, so none is missed. */
export function createAppError(
  origin: FailureOrigin,
  code: FailureCode,
  message: string,
  recovery?: string,
  retryable = false,
): AppError {
  const text = recovery ?? DEFAULT_RECOVERY[code];

  if (origin === "resource") {
    return new ResourceError(code, message, text, { retryable });
  }

  if (origin === "prompt") {
    return new PromptError(code, message, text, { retryable });
  }

  return new ToolError(code, message, text, retryable);
}

/** Every failure class, as data — so a value that crossed the wire can be validated. */
export const FAILURE_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "LIMIT_EXCEEDED",
  "FORBIDDEN",
  "UNAVAILABLE",
] as const satisfies readonly FailureCode[];

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Anything unexpected becomes a retryable `UNAVAILABLE` — never a protocol error.
 *
 * The call reached a handler, so the caller is owed something it can reason
 * about rather than a connection that dies mid-turn.
 *
 * The reclassification branch is the one that matters in a two-process system. A
 * failure that crossed the wire keeps only what the protocol carries, so the
 * **named class** the server sent is read first and the **JSON-RPC code** second.
 * The name wins because the numeric code is coarser than the taxonomy —
 * `LIMIT_EXCEEDED` and `UNAVAILABLE` both travel as `InternalError`, and only the
 * name tells them apart.
 *
 * Without this, every server-side refusal — a missing argument, an unknown
 * prompt — would arrive as an undifferentiated internal error, and the host would
 * answer `503` and invite the caller to retry something no retry can fix.
 */
export function toAppError(origin: FailureOrigin, error: unknown, label: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  const wireCode = (error as { code?: unknown }).code;
  const data = (error as { data?: { recovery?: unknown; failureCode?: unknown; retryable?: unknown } }).data;

  const named = isFailureCode(data?.failureCode) ? data.failureCode : undefined;
  const mapped = named ?? (typeof wireCode === "number" ? failureCodeFor(wireCode) : undefined);

  if (mapped !== undefined) {
    const recovery = typeof data?.recovery === "string" ? data.recovery : undefined;
    const retryable = data?.retryable === true;

    return createAppError(origin, mapped, message, recovery, retryable);
  }

  if (origin === "tool") {
    return new ToolError(
      "UNAVAILABLE",
      `${label} failed: ${message}`,
      "Retry once. If it fails again, treat this capability as temporarily unavailable.",
      true,
    );
  }

  if (origin === "resource") {
    return new ResourceError(
      "UNAVAILABLE",
      `${label} failed: ${message}`,
      "Retry the read once. If it fails again, report the resource as temporarily unavailable rather than returning empty content.",
      { retryable: true },
    );
  }

  return new PromptError(
    "UNAVAILABLE",
    `${label} failed: ${message}`,
    "Retry once. If it fails again, the prompt catalogue is temporarily unavailable.",
    { retryable: true },
  );
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

export function toolFailure(error: AppError): ToolResult<never> {
  return {
    content: [{ type: "text", text: `${error.message} ${error.recovery}` }],
    isError: true,
  };
}
```

### Block-by-block

**Block 1 — the taxonomy (lines 26–49).**

```ts
export type FailureCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "FORBIDDEN"
  | "UNAVAILABLE";

export type FailureOrigin = "tool" | "resource" | "prompt";

const DEFAULT_STATUS: Record<FailureCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 429,
  FORBIDDEN: 403,
  UNAVAILABLE: 503,
};
```

**Six codes, and the comment justifies the size:** *deliberately small — a taxonomy nobody reads
is a taxonomy nobody uses.* Six is enough to cover every failure this system can produce, and
small enough that a developer can hold all of them in mind while writing a handler. A taxonomy of
forty codes would be more precise and would be consulted by nobody.

Each code has a natural HTTP status, and the mapping is not arbitrary:

| Code | Status | The distinction it draws |
| :--- | :--- | :--- |
| `INVALID_INPUT` | 400 | The request is malformed. The caller can fix it |
| `NOT_FOUND` | 404 | Well-formed, but the thing does not exist |
| `CONFLICT` | 409 | Well-formed and exists, but the current **state** forbids it |
| `LIMIT_EXCEEDED` | 429 | Rate or capacity — *try again later* |
| `FORBIDDEN` | 403 | Exists, and this session may not have it |
| `UNAVAILABLE` | 503 | Not the caller's fault. Transient |

The `CONFLICT` / `INVALID_INPUT` pair is the one worth internalising, because the difference is
*state*. Completing an already-completed task is not a malformed request — the request is
perfectly well-formed, and it is a conflict with reality. Completing task `abc` is malformed. Two
different codes, two different HTTP statuses, two different recoveries: *read the current state*
versus *correct the request*. Collapsing them into one "bad request" loses the only information
the caller needed.

`FailureOrigin` is a separate axis from the code. The code says *what went wrong*; the origin says
*which primitive produced it*. Both are needed: `NOT_FOUND` from a tool and `NOT_FOUND` from a
resource are the same business failure but travel completely differently on the wire — one as
`isError` content, one as a JSON-RPC error.

**Block 2 — `AppError` (lines 51–83).**

```ts
export class AppError extends Error {
  readonly code: FailureCode;
  readonly origin: FailureOrigin;
  readonly recovery: string;
  readonly retryable: boolean;
  readonly httpStatus: number;

  constructor(origin, code, message, recovery, options = {}) {
    super(message);
    this.name = new.target.name;
    ...
  }
}
```

Five fields, all `readonly`, and each answers a question a caller actually has:

| Field | The question it answers |
| :--- | :--- |
| `code` | *What kind* of failure is this? |
| `origin` | *Which primitive* produced it? |
| `recovery` | *What should be done next?* — written for the model or operator |
| `retryable` | *Is trying again safe?* |
| `httpStatus` | *What does the HTTP layer answer?* |

`readonly` matters here in a way it usually does not: an error object is the one thing in a
codebase that gets passed around, inspected and sometimes *rewritten* on its way out. Making the
fields immutable means the taxonomy cannot be silently mutated by an intermediate layer — the
class a handler raised is the class the caller sees.

**`this.name = new.target.name`** is the line that makes the subclass hierarchy real at runtime.
Without it, every instance reports `name === "Error"`, because `Error`'s constructor sets the name
and JavaScript does not auto-derive it for subclasses. `new.target` inside a constructor is the
class that was actually `new`-ed — so `new ToolError(...)` sets `name = "ToolError"`,
`new ResourceError(...)` sets `"ResourceError"`, and so on, with **one** line rather than three
subclass overrides. This is what makes `error.name` usable in a log line or an assertion.

**The `options` bag (lines 68–82).** `retryable` and `httpStatus` are optional and defaulted:

```ts
this.retryable = options.retryable ?? false;
this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[code];
```

`retryable` defaults to **false**, which is the conservative direction and the right one. Retrying
a non-idempotent operation duplicates its side effect; a destructive operation is therefore never
retryable *by default*, however transient the fault looks. Opting **in** to retryability is the
safe design, because forgetting to opt in costs a wasted retry while forgetting to opt out costs
a duplicated deletion.

The field's own comment states the rule precisely:

> True only when a retry cannot duplicate a side effect. A destructive, non-idempotent operation
> is never retryable, however transient the fault looks.

`httpStatus` defaults to the table but is **overridable per call site**, which is the escape hatch
for a context-specific code. The doc comment names it: *overridable per call site when a code is
context-specific.* The concrete case in this codebase is the ACL — a read of another user's profile
is `FORBIDDEN`, whose default is 403, and the host's read path wants exactly 403, so no override is
needed there. The override exists because the next such case will.

**Block 3 — the three subclasses (lines 85–122).**

```ts
export class ToolError extends AppError {
  constructor(code, message, recovery, retryable = false) {
    super("tool", code, message, recovery, { retryable });
  }
}

export class ResourceError extends AppError {
  constructor(code, message, recovery, options = {}) {
    super("resource", code, message, recovery, options);
  }
}

export class PromptError extends AppError {
  constructor(code, message, recovery, options = {}) {
    super("prompt", code, message, recovery, options);
  }
}
```

Three subclasses whose only job is to **fix the origin**. That looks like boilerplate, and it is
doing something specific: it makes the origin a **compile-time** property rather than a runtime
argument.

Compare with the alternative — one class with an origin parameter:

```ts
// the version this codebase does NOT use
throw new AppError("tool", "NOT_FOUND", "No task with id 5.", "List the tasks first.");
//                        ^ easy to get wrong, and the compiler will not tell you
```

With subclasses, a handler that catches a `ResourceError` and rethrows it as a `ToolError` is a
visible type change, and the origin cannot be passed incorrectly because it is not passed at all.

The signatures differ slightly and the difference is meaningful. `ToolError` takes a bare
`retryable = false`; the other two take an `options` object. That is not inconsistency for its own
sake — `ToolError` is raised from business logic where retryability is the only thing a call site
ever varies, so the shorter signature is the one that gets used correctly. `ResourceError` is
raised in places that also override `httpStatus`, so it needs the bag.

**Block 4 — the JSON-RPC codes (lines 124–162).**

```ts
export const JSON_RPC = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ResourceNotFound: -32002,
} as const;
```

**Written as numbers rather than imported from the SDK, and the comment gives the reason:**
*this module is transport-agnostic, and these values are fixed by the JSON-RPC and MCP
specifications rather than by whichever library implements them.*

That is a real architectural commitment. `-32602` is in the JSON-RPC 2.0 spec; `-32002` is MCP's
own addition for a resource that does not exist. Neither number is an SDK detail, and importing
them from `@modelcontextprotocol/server` would make `core/errors.ts` depend on a transport — which
is exactly the dependency Chapter 01 forbids. Five integers, written out, keeps `core` clean.

**`jsonRpcCodeFor` (lines 164–181).**

```ts
export function jsonRpcCodeFor(code: FailureCode): number {
  switch (code) {
    case "INVALID_INPUT":
    case "FORBIDDEN":
    case "CONFLICT":
      return JSON_RPC.InvalidParams;
    case "NOT_FOUND":
      return JSON_RPC.ResourceNotFound;
    case "LIMIT_EXCEEDED":
    case "UNAVAILABLE":
      return JSON_RPC.InternalError;
  }
}
```

Six codes map onto **four** JSON-RPC codes, and that collapse is the central fact of this chapter.
It is a lossy mapping:

```text
INVALID_INPUT ─┐
FORBIDDEN     ─┼──▶ -32602 InvalidParams
CONFLICT      ─┘

NOT_FOUND     ────▶ -32002 ResourceNotFound

LIMIT_EXCEEDED ─┐
UNAVAILABLE    ─┴──▶ -32603 InternalError
```

The `switch` has **no `default` branch**, and that is deliberate: with `FailureCode` as a closed
union, TypeScript checks exhaustiveness, so adding a seventh failure code produces a compile error
here rather than a silent `undefined` returned at runtime. This is the one place where
`noFallthroughCasesInSwitch` from `tsconfig.json` is doing real work too — the grouped cases need
explicit empty bodies, which is what the stacked `case` labels are.

The comment on the first group explains the grouping: *all three are "the caller asked for
something the server will not do", and all three are fixed by changing the request rather than by
retrying.* That is the *correct* grouping criterion — not "do they look similar" but "does the
caller respond the same way to each".

And this lossiness is exactly why the next function exists.

**Block 5 — `failureCodeFor`, the lossy inverse (lines 183–213).**

```ts
export function failureCodeFor(wireCode: number): FailureCode | undefined {
  switch (wireCode) {
    case JSON_RPC.InvalidParams:
      return "INVALID_INPUT";
    case JSON_RPC.ResourceNotFound:
      return "NOT_FOUND";
    default:
      return undefined;
  }
}
```

Read this against `jsonRpcCodeFor` and the problem becomes concrete. The mapping out collapses six
codes into four; the mapping back can only recover **two** of them:

```text
-32602 InvalidParams     ──▶ INVALID_INPUT     (FORBIDDEN and CONFLICT are lost)
-32002 ResourceNotFound  ──▶ NOT_FOUND         (faithful)
-32603 InternalError     ──▶ undefined         (LIMIT_EXCEEDED and UNAVAILABLE are lost)
-32600 / -32601 / other  ──▶ undefined         (not ours)
```

So a JSON-RPC code alone is **not enough** to reconstruct a failure class. A `FORBIDDEN` that
crossed the wire comes back as `INVALID_INPUT` — wrong, and wrong in a way that matters, because
the recovery sentence for `INVALID_INPUT` says *correct the request* while the one for `FORBIDDEN`
says *request access*. The host would tell the user to fix a request that was never the problem.

That is precisely the bug this design fixes, and the fix is to stop relying on the code alone:

> A failure that crossed the wire keeps only what the protocol carries, so the **named class** the
> server sent is read first and the **JSON-RPC code** second. The name wins because the numeric
> code is coarser than the taxonomy.

`failureCodeFor` is therefore the **fallback**, not the primary path — which is why it returns
`undefined` rather than guessing. The doc comment says why that matters: *an unrecognised wire
error still falls through to the generic handling rather than being mislabelled.* Returning
`INVALID_INPUT` as a default would be worse than returning nothing, because it would assert a
recovery that may be exactly wrong.

**Block 6 — `DEFAULT_RECOVERY` and `createAppError` (lines 215–245).**

```ts
const DEFAULT_RECOVERY: Record<FailureCode, string> = {
  INVALID_INPUT: "Correct the request to match the advertised contract, then retry once.",
  NOT_FOUND: "List what exists before asking for it again.",
  CONFLICT: "Read the current state and report it instead of retrying.",
  LIMIT_EXCEEDED: "Wait for the limit to reset, or reduce the request.",
  FORBIDDEN: "Request access, or use something the session is entitled to.",
  UNAVAILABLE: "Retry once. If it fails again, treat the capability as temporarily unavailable.",
};
```

Six sentences, and each is a **specific next action** rather than an apology. Compare:

```text
"An error occurred."                    ← says nothing; the model retries blindly
"List what exists before asking again." ← says what to do; the model can comply
```

The second is the whole point of the field. A recovery sentence is consumed by a *model* as often
as by a human, and a model given a concrete instruction will follow it — call `list_tasks`, see the
real ids, and stop guessing. A model given "an error occurred" will retry the same thing.

Note the vocabulary: the sentences say *list*, *read*, *request access*, *reduce the request* —
verbs that name a tool or an action the caller actually has. That is not stylistic. A recovery
sentence the caller cannot execute is a sentence that will be ignored.

```ts
export function createAppError(origin, code, message, recovery?, retryable = false): AppError {
  const text = recovery ?? DEFAULT_RECOVERY[code];

  if (origin === "resource") {
    return new ResourceError(code, message, text, { retryable });
  }

  if (origin === "prompt") {
    return new PromptError(code, message, text, { retryable });
  }

  return new ToolError(code, message, text, retryable);
}
```

A **factory** rather than a class, because the origin is only known at runtime on this path — it
arrives as a parameter from the caller that caught the error. The class hierarchy from Block 3 is
what lets the factory pick a real subclass instead of constructing a bare `AppError`.

The doc comment states the reason for centralising it: *one place, so none is missed.* Three
`if` branches in one function, rather than three places in the codebase each deciding how to build
an error for its own origin.

The `recovery ?? DEFAULT_RECOVERY[code]` line is the fallback chain: a **specific** recovery
sentence if the server supplied one, the **generic** one for the code otherwise. That ordering is
what makes the wire adapter valuable — see Block 8.

**Block 7 — `FAILURE_CODES` and `isFailureCode` (lines 247–259).**

```ts
export const FAILURE_CODES = [
  "INVALID_INPUT", "NOT_FOUND", "CONFLICT", "LIMIT_EXCEEDED", "FORBIDDEN", "UNAVAILABLE",
] as const satisfies readonly FailureCode[];
```

The `as const satisfies readonly FailureCode[]` pairing is worth reading carefully, because it does
two opposite things at once and both are needed:

- **`as const`** preserves the literal types, so `FAILURE_CODES` is a tuple of six specific
  strings rather than `string[]`.
- **`satisfies readonly FailureCode[]`** *checks* that the tuple is a valid list of failure codes,
  **without widening** the type to `readonly FailureCode[]`.

With `: readonly FailureCode[]` instead, the literal types would be erased and the runtime array
would still work — but the check would be one-directional. With `satisfies`, adding a seventh
member to the `FailureCode` union and forgetting to add it here is a compile error, because the
tuple no longer *satisfies* the union. **The runtime list and the compile-time union cannot
drift.**

```ts
export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value);
}
```

A **type guard**, and its job is validating untrusted data. This is the function that makes Block 8
possible: `data.failureCode` arrives off the wire as `unknown`, and this is what turns it into a
narrowed `FailureCode` (or `undefined`) before it is trusted.

The `as readonly string[]` cast is needed because `includes` on a tuple of literals is typed to
accept only those literals, and here we are deliberately asking "is this *arbitrary* string one of
them". The guard's return type `value is FailureCode` is what does the narrowing at the call site.

The doc comment names the purpose: *every failure class, as data — so a value that crossed the wire
can be validated.* This is the runtime mirror of the compile-time union, and the two are kept in
step by `satisfies`.

**Block 8 — `toAppError`, the reclassification (lines 261–282).**

```ts
export function toAppError(origin: FailureOrigin, error: unknown, label: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  const wireCode = (error as { code?: unknown }).code;
  const data = (error as { data?: { recovery?: unknown; failureCode?: unknown; retryable?: unknown } }).data;

  const named = isFailureCode(data?.failureCode) ? data.failureCode : undefined;
  const mapped = named ?? (typeof wireCode === "number" ? failureCodeFor(wireCode) : undefined);

  if (mapped !== undefined) {
    const recovery = typeof data?.recovery === "string" ? data.recovery : undefined;
    const retryable = data?.retryable === true;

    return createAppError(origin, mapped, message, recovery, retryable);
  }
  ...
}
```

This is the function that closes the loop, and it is the single most important block in the
chapter. Walk the five steps:

**1. Already one of ours → return it unchanged.** `error instanceof AppError` short-circuits. This
is the common case *within* a process, and it means the taxonomy is never re-derived from a value
that already carries it.

**2. Extract a message defensively.** `error instanceof Error ? error.message : String(error)`.
The `catch` binds `unknown` (thanks to `useUnknownInCatchVariables` in `tsconfig.json`), and a
`throw "a string"` is legal JavaScript. `String(error)` handles it without a crash.

**3. Read the wire fields as `unknown`.** Note the casts: `(error as { code?: unknown }).code` and
the `data` shape. Nothing here is trusted — `error` came from a transport, so `code` might be a
string, `data` might be an array, and `failureCode` might be anything. The cast asserts a *shape to
look at*, not a *type to believe*.

**4. The precedence line — this is the fix.**

```ts
const named = isFailureCode(data?.failureCode) ? data.failureCode : undefined;
const mapped = named ?? (typeof wireCode === "number" ? failureCodeFor(wireCode) : undefined);
```

`named ?? ...` — **the name wins over the numeric code**, and `failureCodeFor` is only consulted
when there is no usable name. Block 5 showed why: the numeric code is coarser than the taxonomy, so
`FORBIDDEN` and `CONFLICT` both arrive as `InvalidParams` and `LIMIT_EXCEEDED` and `UNAVAILABLE` both
arrive as `InternalError`. Trusting the code would silently downgrade them.

And because both are validated — `isFailureCode` for the name, `typeof === "number"` for the code —
a malformed value falls through to the generic path rather than being believed.

**5. Build the error with the server's own recovery sentence.**

```ts
const recovery = typeof data?.recovery === "string" ? data.recovery : undefined;
return createAppError(origin, mapped, message, recovery, retryable);
```

This is where `protocol.ts` pays off. The server wrote a *specific* recovery sentence —
`"No resource is registered for task://nope. Call resources/list to see what exists."` — and it
travelled in `data.recovery`. Because `createAppError` prefers a supplied recovery over
`DEFAULT_RECOVERY`, the host hands the caller **the sentence the server wrote**, not a generic one
it invented. That is the difference between an error message that names the real problem and one
that says "resource not found".

**The fallthrough (lines 258–281).** If neither the name nor the code is recognised, the error
becomes a retryable `UNAVAILABLE` — with a different sentence per origin:

| Origin | Message | Recovery | Retryable |
| :--- | :--- | :--- | :--- |
| `tool` | `{label} failed: {message}` | "Retry once. If it fails again, treat this capability as temporarily unavailable." | yes |
| `resource` | `{label} failed: {message}` | "Retry the read once. If it fails again, **report the resource as temporarily unavailable rather than returning empty content**." | yes |
| `prompt` | `{label} failed: {message}` | "Retry once. If it fails again, the prompt catalogue is temporarily unavailable." | yes |

The resource sentence carries the most information, and it is worth quoting in full because it
encodes a design decision:

> **report the resource as temporarily unavailable rather than returning empty content**

Returning empty content for a failed read is the tempting shortcut, and it is the worst option: the
model receives an empty document, concludes the resource *is* empty, and answers from that
conclusion. The recovery sentence forbids it explicitly. A stated failure is recoverable; a silent
empty read is not.

The doc comment states the governing rule: *anything unexpected becomes a retryable `UNAVAILABLE` —
never a protocol error. The call reached a handler, so the caller is owed something it can reason
about rather than a connection that dies mid-turn.*

**Block 9 — the result types (lines 284–330).**

```ts
export type ToolResult<Structured> = {
  content: TextBlock[];
  structuredContent?: Structured;
  isError?: boolean;
};
```

The wire shape of a tool result. The comment explains the `type` alias choice, and it is a
genuinely subtle TypeScript point:

> Declared as a type alias rather than an interface on purpose: an object type alias gets an
> implicit index signature, which is what lets it satisfy the SDK's
> `{ [x: string]: unknown; content: ... }` callback contract.

An `interface` does **not** get an implicit index signature; a `type` alias of an object literal
does. The SDK's tool callback is typed with an index signature, so an interface would fail to
satisfy it and require a cast. The alias avoids the cast — a real, load-bearing reason for a
choice that otherwise looks arbitrary.

```ts
export type ToolOutcome<Structured> = {
  text: string;
  structured: Structured;
};
```

**This is the separation the whole file has been building toward**, and its comment names it:
separating the *outcome* (business meaning) from the *result* (wire shape). A handler computes a
`ToolOutcome` — prose and a typed payload — and never touches `content[]`, `isError` or
`structuredContent`. That is what lets one `guard` wrapper own rate limiting, timeouts, metrics and
error mapping for every tool (Chapter 14): the wrapper speaks wire, the handler speaks business.

Note `text`'s comment: *prose for the model. Short — this is context, not a report.* A tool result
lands in the model's context window, so every character competes with the user's actual question.

```ts
export function toolSuccess<Structured>(outcome: ToolOutcome<Structured>): ToolResult<Structured> {
  return { content: [{ type: "text", text: outcome.text }], structuredContent: outcome.structured };
}

export function toolFailure(error: AppError): ToolResult<never> {
  return { content: [{ type: "text", text: `${error.message} ${error.recovery}` }], isError: true };
}
```

Two constructors, and the failure one is the interesting one. Look at what it puts in the text:

```ts
text: `${error.message} ${error.recovery}`
```

**Message *and* recovery, concatenated.** The message says what happened; the recovery says what to
do next. Both go to the model, because a model that learns only what happened will guess at a
remedy, and a model that is told the remedy will take it. This single line is how the taxonomy's
recovery sentences reach the model at all — the tool path, as opposed to the protocol path.

`toolFailure` returns `ToolResult<never>` rather than `ToolResult<Structured>`. That is the
correct type: a failure has **no** structured payload — `structuredContent` is absent — and
`never` is the type that says so, while still being assignable to any `ToolResult<S>` the caller
expected. And `isError: true` is what tells the SDK (and the client) to treat this as a failed call
rather than a successful one carrying bad news.

---

## `src/mcp/protocol.ts` — the full file

```ts
import { ProtocolError } from "@modelcontextprotocol/server";
import { jsonRpcCodeFor, type AppError } from "../core/errors.js";

/**
 * The server-side half of the wire adapter.
 *
 * A refusal raised by a handler has to survive a process boundary to be useful,
 * and on the way out it loses everything except what the protocol carries. So the
 * failure's **class** is encoded in the JSON-RPC error code — the one field the
 * wire preserves — and its **recovery sentence** goes into `data`.
 *
 * Why this matters more than it looks: without it, a missing prompt argument and
 * a crashed backend are indistinguishable to the host. Both arrive as an
 * unclassified error, both get answered `503`, and the caller is invited to retry
 * something that no number of retries can fix. Notes Ch07 §7.4 asks for failures
 * that *"fail loudly on an unknown prompt, a missing argument or an empty message
 * list"* — this is what makes "loudly" survive the trip.
 *
 * The numeric codes themselves live in `core/errors.ts`, not here, because they
 * are fixed by the JSON-RPC and MCP specifications rather than by this SDK. This
 * module's only job is to wrap them in the class the transport understands.
 */
export function toProtocolError(error: AppError): Error {
  return new ProtocolError(jsonRpcCodeFor(error.code), error.message, {
    // `data` is carried verbatim, so the host can hand the caller the *specific*
    // instruction the server wrote rather than a generic one it invented.
    recovery: error.recovery,
    failureCode: error.code,
    origin: error.origin,
    retryable: error.retryable,
  });
}
```

### Block-by-block

**Block 1 — the import (lines 1–2).**

```ts
import { ProtocolError } from "@modelcontextprotocol/server";
import { jsonRpcCodeFor, type AppError } from "../core/errors.js";
```

Note the direction: `mcp/protocol.ts` imports **from** `core/errors.ts`, and `core/errors.ts`
imports nothing from the SDK. The dependency points one way, and the SDK class lives on the `mcp`
side. That is what lets `core/errors.ts` be transport-agnostic and still have its codes used on the
wire.

Also note `import { ..., type AppError }` — an inline type-only import. `AppError` is used only as
a type here, so it is erased at compile time and does not create a runtime import cycle.

**Block 2 — the doc comment (lines 4–22).** This is the argument for the whole design, and it is
worth reading as prose rather than as documentation:

> A refusal raised by a handler has to survive a process boundary to be useful, and on the way out
> it loses everything except what the protocol carries. So the failure's **class** is encoded in the
> JSON-RPC error code — the one field the wire preserves — and its **recovery sentence** goes into
> `data`.

> Why this matters more than it looks: without it, a missing prompt argument and a crashed backend
> are indistinguishable to the host. Both arrive as an unclassified error, both get answered `503`,
> and the caller is invited to retry something that no number of retries can fix.

That second paragraph is the *observed bug* this file was written to fix, and it was found by
running the code: a bad prompt argument was returning `503` because the host had no way to tell a
`400`-class failure from a `503`-class one across the wire.

**Block 3 — `toProtocolError` (lines 23–32).**

```ts
export function toProtocolError(error: AppError): Error {
  return new ProtocolError(jsonRpcCodeFor(error.code), error.message, {
    recovery: error.recovery,
    failureCode: error.code,
    origin: error.origin,
    retryable: error.retryable,
  });
}
```

Four things travel, and each is read back by `toAppError`:

| Field | Read back as | Purpose |
| :--- | :--- | :--- |
| the **code** (positional) | `wireCode` | The fallback classification |
| `recovery` | `data.recovery` | The server's own next-step sentence, carried verbatim |
| `failureCode` | `data.failureCode` | **The primary classification** — the name the code cannot preserve |
| `origin` | (logged) | Which primitive failed, for diagnostics |
| `retryable` | `data.retryable` | Whether a retry is safe |

The comment on the `data` block is the design statement: *`data` is carried verbatim, so the host
can hand the caller the **specific** instruction the server wrote rather than a generic one it
invented.*

`failureCode` is the field that makes the round trip lossless. The JSON-RPC code collapses six
classes into four; the name does not. Sending both means a client that only understands JSON-RPC
still gets a correct (if coarser) classification, while this host gets an exact one.

The return type is `Error`, not `ProtocolError`, and that is deliberate: the caller only needs to
know it is throwable. Naming the concrete class would tempt a call site to depend on it, and the
whole point is that the SDK type stays on this side of the boundary.

---

## Run / verify

### 1. The failure classes, as the host reports them

With `npm run server` and `npm run host` running:

```bash
curl -s 'http://127.0.0.1:8080/read?uri=task://nope'
curl -s 'http://127.0.0.1:8080/read?uri=task://tasks/abc'
curl -s 'http://127.0.0.1:8080/prompt?name=nope'
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day'
curl -s 'http://127.0.0.1:8080/read?uri=user://456/profile'
```

```json
{"error":{"code":"NOT_FOUND","message":"Refused to read task://nope — the URI does not match any advertised Resource.","recovery":"Call GET /resources to read the advertised URIs, then retry with one of them.","retryable":false,"requestId":"dac1da9a"}}
{"error":{"code":"INVALID_INPUT","message":"The task URI must carry a positive integer id, not \"abc\".","recovery":"List the catalogue with resources/list, or read task://tasks/{id} with a numeric id.","retryable":false,"requestId":"6881018d"}}
{"error":{"code":"NOT_FOUND","message":"Unknown prompt: \"nope\".","recovery":"Call GET /prompts to read the available names (plan_day, review_workload, weekly_plan).","retryable":false,"requestId":"8c16aa68"}}
{"error":{"code":"INVALID_INPUT","message":"Invalid arguments for prompt plan_day: availableHours: Invalid input: expected string, received undefined","recovery":"Correct the request to match the advertised contract, then retry once.","retryable":false,"requestId":"a1bd7267"}}
{"error":{"code":"FORBIDDEN","message":"Refused to read user://456/profile — \"user-profile\" belongs to another user and the session is not an admin.","recovery":"Read a Resource the session is entitled to, or ask an administrator for access.","retryable":false,"requestId":"c18ee97b"}}
```

Five responses, and the shapes are identical: `code`, `message`, `recovery`, `retryable`,
`requestId`. That uniformity is the taxonomy working — every failure in the system is
representable in the same five fields.

**The second response is the one that proves the wire adapter.** Its message and recovery are
written by the **server**, at `src/services/resourceService.ts:204-205`:

```ts
`The task URI must carry a positive integer id, not "${raw ?? ""}".`,
"List the catalogue with resources/list, or read task://tasks/{id} with a numeric id.",
```

```bash
grep -rn 'must carry a positive integer id' src/
# src/services/resourceService.ts:204:  `The task URI must carry a positive integer id, not "${raw ?? ""}".`,
```

Those two strings crossed a process boundary and came back intact. The message travelled as the
JSON-RPC error message; the recovery travelled in `data.recovery`. Without `protocol.ts` the host
would have had to invent a recovery sentence for a problem only the server understood.

**Contrast the fourth response.** `plan_day` with no arguments carries
*"Correct the request to match the advertised contract, then retry once."* — which is
`DEFAULT_RECOVERY.INVALID_INPUT` verbatim, from `errors.ts`. No specific sentence was supplied for
this path, so the generic one was used. **Both branches of the `recovery ?? DEFAULT_RECOVERY[code]`
fallback appear in the same five responses**, which is exactly what you want to see when verifying
a fallback chain.

### 2. The same URI, refused by two different layers

Lifecycle step 6 reads URIs the raw client cannot get:

```bash
npm run lifecycle 2>/dev/null | sed -n '/^6\./,/^7\./p'
```

```text
6. failures    -> a missing Resource is a protocol error, not an isError result
   task://tasks/999         -> No task with id 999.
   task://nope              -> Resource not found: task://nope
   file:///etc/passwd       -> Resource not found: file:///etc/passwd
```

Note the difference from the HTTP responses above. `task://nope` here says
*"Resource not found: task://nope"* — the **SDK's** message, not the host's
*"Refused to read task://nope — the URI does not match any advertised Resource."*

Both are correct, and the difference is *which layer refused*:

| Path | Who refuses first | Message |
| :--- | :--- | :--- |
| Raw client → server | The SDK's URI router, before any handler | `Resource not found: …` |
| HTTP host | The host's own catalogue check | `Refused to read … does not match any advertised Resource.` |

The host refuses first because it holds its own copy of the catalogue (Chapter 25) — so the round
trip never happens. That is the "a host that can predict a failure predicts it" principle from the
main README, visible as a message difference.

And the third line is the important one for the notes' security argument: `file:///etc/passwd` is
refused by the SDK's router **before** the scheme allowlist is ever consulted. The allowlist is
defence in depth, not the first gate — which is exactly what Chapter 02's comments claim.

### 3. A tool failure is a result, not a protocol error

The first row of the table at the top of this chapter, demonstrated. Two `complete_task` calls on
the same task, then a `delete_task` on an id that does not exist:

```bash
# after the server is up
npx tsx -e '
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const c = new Client({ name: "probe", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8081/mcp")));
  console.log(JSON.stringify(await c.callTool({ name: "complete_task", arguments: { id: 2 } })));
  console.log(JSON.stringify(await c.callTool({ name: "complete_task", arguments: { id: 2 } })));
  console.log(JSON.stringify(await c.callTool({ name: "delete_task", arguments: { id: 999 } })));
  await c.close();
'
```

```json
{"content":[{"type":"text","text":"Task completed: #2 Review pull request (COMPLETED)."}],"structuredContent":{"task":{"id":2,"title":"Review pull request","status":"COMPLETED",...}}}
{"content":[{"type":"text","text":"Task #2 is already COMPLETED. Nothing to do — report the current state instead of retrying."}],"isError":true}
{"content":[{"type":"text","text":"No task with id 999. Call list_tasks to read the exact ids, then retry."}],"isError":true}
```

Three results, all HTTP 200, all valid `tools/call` replies. Four things to notice:

**The failure is `isError: true`, not a thrown error.** The call *ran*; the operation failed. The
reply is a normal result with a flag — which means the SDK delivers it as content and the model
reads it as context. Nothing about the transport broke.

**There is no `structuredContent` on a failure.** Compare line 1 (which has it) with lines 2 and 3
(which do not). That is `toolFailure()` returning `ToolResult<never>` — a failure has no typed
payload, and the type says so.

**The text is `message` + `recovery`, concatenated.** Line 2 is the money shot:

```text
Task #2 is already COMPLETED. Nothing to do — report the current state instead of retrying.
└────────── message ──────────┘ └──────────────── recovery ────────────────────────────────┘
```

The message says what happened; the recovery says what to do next — and it is a *CONFLICT* recovery,
not a *NOT_FOUND* one: *report the current state instead of retrying*, not *list what exists*. That
is the taxonomy distinguishing two failures that a single "bad request" code would have merged.

**Line 3 is the same shape for a different class.** `delete_task 999` is `NOT_FOUND`, and its
recovery is *call list_tasks to read the exact ids* — the `DEFAULT_RECOVERY.NOT_FOUND` sentence,
because no specific one was supplied. Same wire shape, different business meaning, and the model can
tell them apart.

That last point is the reason the recovery sentence is worth the effort. A model that receives
`isError: true` with only "No task with id 999" will retry 999. A model that receives
"Call list_tasks to read the exact ids, then retry" will call `list_tasks` — which is the
behaviour you actually wanted.

### 4. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

The `satisfies readonly FailureCode[]` on `FAILURE_CODES` and the exhaustive `switch` in
`jsonRpcCodeFor` (no `default`) are the two compile-time guarantees here. To see them work, add a
seventh member to the `FailureCode` union and run the typecheck: you get an error in
`jsonRpcCodeFor` (*"not all code paths return a value"*), and — if you added it to the union but not
to `FAILURE_CODES` — an error on the tuple as well. The taxonomy cannot be extended halfway.

---

## Checkpoint

1. **Why do a tool failure and a resource failure travel differently?**
   A tool failure is a *result* — the call ran, so it comes back as `content[]` with `isError: true`,
   which lands in the model's context as an instruction channel. A resource failure is a *protocol
   error* — nothing executed, and `resources/read` has no `isError` channel to put a sentence in.

2. **What is lost in the failure-code → JSON-RPC-code mapping, and what recovers it?**
   Six classes collapse to four codes: `FORBIDDEN` and `CONFLICT` both become `InvalidParams`;
   `LIMIT_EXCEEDED` and `UNAVAILABLE` both become `InternalError`. The **name** recovers it — sent as
   `data.failureCode` and read back before the numeric code (`named ?? failureCodeFor(wireCode)`).

3. **Why does `toAppError` prefer the name over the code?**
   Because the numeric code is coarser than the taxonomy. Trusting the code alone would turn a
   `FORBIDDEN` into an `INVALID_INPUT` and hand the caller a recovery sentence telling them to fix a
   request that was never wrong.

4. **Why is `retryable` false by default?**
   Because retrying a non-idempotent operation duplicates its side effect. Opting *in* to
   retryability costs a wasted retry when forgotten; opting *out* costs a duplicated deletion.

5. **What does `toolFailure` put in the text, and why both parts?**
   `` `${error.message} ${error.recovery}` ``. The message says what happened; the recovery says
   what to do next. A model told only what happened will guess at a remedy; a model told the remedy
   will take it.

6. **What is the resource-specific recovery sentence forbidding, and why does it matter?**
   *"report the resource as temporarily unavailable rather than returning empty content."* Returning
   empty content makes the model conclude the resource *is* empty and answer from that conclusion. A
   stated failure is recoverable; a silent empty read is not.

7. **Why is `ToolResult` a type alias rather than an interface?**
   An object type alias gets an implicit index signature, which is what lets it satisfy the SDK's
   `{ [x: string]: unknown; content: ... }` callback contract. An interface would need a cast.

---

**[← Chapter 04: Metrics](./04_Core_Metrics.md)** · **[Chapter 06: Execution Guards →](./06_Core_Guards_Rate_Timeout_Budget.md)**
