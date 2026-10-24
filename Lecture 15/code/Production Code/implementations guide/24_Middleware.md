# Chapter 24 — Middleware: Request Context & Errors

> **Two middlewares, and between them the two things that make an HTTP service debuggable:** every request gets an
> identity, and every failure becomes an answer rather than a silence.

---

## File details

| | |
| :--- | :--- |
| **Files** | `src/middleware/requestContext.ts` (90 lines), `src/middleware/errorHandler.ts` (87 lines) |
| **Layer** | `middleware` — the HTTP binding's cross-cutting concerns |
| **Purpose** | `requestContext.ts`: a request id, a session and an access log. `errorHandler.ts`: map any failure to the right status, the right log level and a body a caller can act on. |
| **Exports** | `RequestVariables`, `AppEnv`, `requestContext()` · `errorHandler()` |
| **Lecture sections** | Ch05 §"Filter *before* ranking" (the session), Ch08 §8.6 (observability), Ch03 §3.9 (error shapes) |
| **Runs** | Every HTTP request · `GET /metrics` |

---

## Commands

```bash
npm run server & npm run host & sleep 4

# the request id is echoed in the response and in every log line for that request
curl -s 'http://127.0.0.1:8080/health' | head -c 200

# an inbound id is honoured, so an upstream trace stays one trace
curl -s -H 'x-request-id: my-trace-1' 'http://127.0.0.1:8080/nope'

# the session comes from headers
curl -s -H 'x-actor: 456' -H 'x-projects: fde,media' 'http://127.0.0.1:8080/plan?hours=4' | head -c 200
```

---

## Why a middleware layer at all

The `requestContext` header gives the reason in one sentence:

> Three things happen here and nowhere else, which is the point of a middleware layer — each of them would otherwise be
> **copy-pasted into four controllers and forgotten in the fifth.**

That is the argument for middleware in general, and it is the same shape as Chapter 14's shared `guard` and Chapter 13's
shared `deps`: **make the cross-cutting thing impossible to omit.** A request id that three of four controllers set is
worse than none, because the log stream looks correlated and is not.

---

## `src/middleware/requestContext.ts` — the full file

```ts
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Context, Next } from "hono";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { Session } from "../host/policy.js";

/**
 * The first middleware: give every request an identity, a logger and a session.
 *
 * Three things happen here and nowhere else, which is the point of a middleware
 * layer — each of them would otherwise be copy-pasted into four controllers and
 * forgotten in the fifth.
 *
 *  1. **A request id**, so every line from every layer can be correlated. It is
 *     bound to a *child* logger rather than passed around as a parameter, which
 *     is what makes the correlation automatic instead of optional.
 *
 *  2. **The session.** Notes Ch05 §"Filter *before* ranking" needs an actor, and
 *     the host is the only layer that has one — the MCP server has no session at
 *     all. Deriving it once here means no controller can invent its own, and no
 *     controller can accidentally read it from the model's output.
 *
 *     In a real deployment this comes from an authenticated cookie or a signed
 *     token. It is read from headers here so the demo is exercisable with
 *     `curl`, and that substitution is stated rather than hidden.
 *
 *  3. **Timing and an access log**, on the way out — including for the requests
 *     that threw, because those are the ones whose latency matters.
 */

export interface RequestVariables {
  requestId: string;
  logger: Logger;
  startedAt: number;
  session: Session;
}

/** The Hono environment every route in this application shares. */
export type AppEnv = { Variables: RequestVariables };

/** The default actor, so an unauthenticated `curl` still produces a readable run. */
const DEFAULT_ACTOR = "123";

function sessionFromHeaders(context: Context<AppEnv>): Session {
  const actor = context.req.header("x-actor")?.trim();

  return {
    actor: actor === undefined || actor === "" ? DEFAULT_ACTOR : actor,
    // A comma-separated scope. Absent means "no project scope", which is a
    // deliberate default: the selector should not invent a project the session
    // never named.
    projects: (context.req.header("x-projects") ?? "")
      .split(",")
      .map((project) => project.trim())
      .filter((project) => project !== ""),
    // An explicit opt-in, never inferred from the actor's name or id.
    isAdmin: context.req.header("x-admin") === "true",
  };
}

export function requestContext(options: { logger: Logger; metrics: Metrics }) {
  return async (context: Context<AppEnv>, next: Next): Promise<void> => {
    // Honour an inbound id when a caller or a proxy supplied one, so a trace
    // started upstream stays one trace.
    const requestId = context.req.header("x-request-id")?.trim() || randomUUID().slice(0, 8);
    const logger = options.logger.child({ requestId });
    const startedAt = performance.now();

    context.set("requestId", requestId);
    context.set("logger", logger);
    context.set("startedAt", startedAt);
    context.set("session", sessionFromHeaders(context));

    await next();

    const milliseconds = performance.now() - startedAt;

    options.metrics.observe("http.latency_ms", milliseconds);
    options.metrics.count(`http.status.${context.res.status}`);

    logger.info("http.request", {
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      ms: Math.round(milliseconds),
      actor: context.get("session").actor,
    });
  };
}
```

### Block-by-block

**Block 1 — `RequestVariables` and `AppEnv` (lines 32–40).**

```ts
export interface RequestVariables {
  requestId: string;
  logger: Logger;
  startedAt: number;
  session: Session;
}

export type AppEnv = { Variables: RequestVariables };
```

Four variables, and each is something a controller needs but must not compute for itself:

| Variable | Why it is here rather than in a controller |
| :--- | :--- |
| `requestId` | So every line from every layer shares one id |
| `logger` | A **child** logger already bound to that id — so correlation is automatic |
| `startedAt` | The start time, so a controller can report a phase duration |
| `session` | So no controller can invent an identity |

**`AppEnv = { Variables: RequestVariables }`** is Hono's typing mechanism: `Context<AppEnv>` then knows that
`context.get("session")` returns a `Session` and not `unknown`. That is what makes the middleware's `context.set` calls and
the controllers' `context.get` calls type-check against each other — a small piece of plumbing that turns an untyped bag
into a checked contract.

The `logger` variable is the one worth dwelling on, and the header explains why it is a *child* logger rather than the id
being passed around:

> A request id, so every line from every layer can be correlated. It is bound to a **child** logger rather than passed
> around as a parameter, which is what makes the correlation **automatic instead of optional**.

That is Chapter 03's `child()` doing exactly what it was built for. A controller that logs through `context.get("logger")`
gets `requestId` on every line without writing it — and a controller cannot forget, because there is no parameter to
forget to pass.

**Block 2 — `sessionFromHeaders` (lines 42–60).**

```ts
const DEFAULT_ACTOR = "123";

function sessionFromHeaders(context: Context<AppEnv>): Session {
  const actor = context.req.header("x-actor")?.trim();

  return {
    actor: actor === undefined || actor === "" ? DEFAULT_ACTOR : actor,
    projects: (context.req.header("x-projects") ?? "")
      .split(",")
      .map((project) => project.trim())
      .filter((project) => project !== ""),
    isAdmin: context.req.header("x-admin") === "true",
  };
}
```

**The header comment states the substitution rather than hiding it:**

> In a real deployment this comes from an authenticated cookie or a signed token. It is read from headers here so the demo
> is exercisable with `curl`, and **that substitution is stated rather than hidden.**

That honesty matters more than it looks. A reader who saw `x-actor` without the note might reasonably conclude that the
project's authorisation is header-based — which would be a serious flaw. The note makes it clear that the *shape* of the
check is the point (identity arrives from the transport, becomes a `Session`, and the ACL reads it) while the *source* is
a stand-in. Replacing it is a change to this function, not to `policy.ts`.

Three parsing details:

**`actor === undefined || actor === "" ? DEFAULT_ACTOR : actor`** — both absent and empty fall back. An empty
`x-actor:` header is what a client sends when it *tried* to set one, and treating it as an empty actor would produce
`actor: ""` — which then silently fails every ownership check. Falling back to the default makes an unauthenticated
`curl` produce a *readable* run rather than a confusing one.

**`projects` is parsed with split → trim → filter** — the same four-operation normalisation as `csvFromEnv` (Chapter 02),
and for the same reasons: trailing whitespace is invisible, a trailing comma produces an empty segment, and the selection
engine compares project slugs exactly.

The default is deliberately **no project scope**, and the comment says why: *the selector should not invent a project the
session never named.* So `x-projects` absent means `[]`, and strategy 2 simply contributes nothing. That is the right
default for a *selection* input: inventing a scope would mean attaching a project brief the user never mentioned.

**`isAdmin: context.req.header("x-admin") === "true"`** — an explicit string comparison, and the comment states the rule:
*an explicit opt-in, never inferred from the actor's name or id.* So `x-admin: 1`, `x-admin: yes` and `x-admin: TRUE` all
yield `false`. Only the exact string enables it.

That strictness is the right call for a privilege flag, and it is the same reasoning as Chapter 02's `booleanFromEnv`
refusing anything but `"true"`/`"false"`: **a privilege check should not be a truthiness check.** `Boolean("false")` is
`true`, and so is `Boolean("0")` — either would be a privilege escalation.

**Block 3 — the middleware itself (lines 62–89).**

```ts
export function requestContext(options: { logger: Logger; metrics: Metrics }) {
  return async (context: Context<AppEnv>, next: Next): Promise<void> => {
    const requestId = context.req.header("x-request-id")?.trim() || randomUUID().slice(0, 8);
    const logger = options.logger.child({ requestId });
    const startedAt = performance.now();

    context.set("requestId", requestId);
    context.set("logger", logger);
    context.set("startedAt", startedAt);
    context.set("session", sessionFromHeaders(context));

    await next();

    const milliseconds = performance.now() - startedAt;

    options.metrics.observe("http.latency_ms", milliseconds);
    options.metrics.count(`http.status.${context.res.status}`);

    logger.info("http.request", {
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      ms: Math.round(milliseconds),
      actor: context.get("session").actor,
    });
  };
}
```

**A factory returning the handler**, rather than a plain function — so the middleware closes over its `logger` and
`metrics`. That is the same shape as every other factory in the project, and it is what lets `routes/index.ts` wire it with
`requestContext({ logger, metrics })` (Chapter 25).

**The inbound request id is honoured**, and the comment explains the point: *so a trace started upstream stays one trace.*
A proxy or a front-end that already assigned an id has it preserved, which is what makes cross-service tracing work.
The `randomUUID().slice(0, 8)` fallback is **8 characters** — enough to be unique within a log stream, short enough to
read and to type into a search box. A full UUID would be 36 characters of noise in every log line.

**The `||` rather than `??`** matters here: an empty `x-request-id:` header is falsy, so it falls through to a generated
id. With `??`, an empty string would be kept and every such request would share the id `""` — silently collapsing the
correlation the id exists to provide.

**All four `context.set` calls happen before `await next()`**, so every downstream layer — the controller, the context
assembler, the client — can read them. That ordering is the middleware contract: set up, then delegate.

**The metrics and the access log happen after `await next()` returns**, which is what makes them complete: by then
`context.res.status` is known. And the comment on the header's third point is worth restating:

> **Timing and an access log**, on the way out — including for the requests that threw, because those are the ones whose
> latency matters.

The "including for the requests that threw" is worth checking against the code. If `next()` throws, does the access log
still run? It does — because Hono's `onError` handler (registered in `routes/index.ts`) runs *inside* the middleware chain
and converts the throw into a response, so `next()` resolves normally and this code continues. That is why the access log
and the error handler are two cooperating middlewares rather than two competing ones: **the error handler is what makes
the access log complete.**

The access log carries `actor` from the session, so the log stream answers *who* as well as *what* — which is the first
question after an incident.

---

## `src/middleware/errorHandler.ts` — the full file

```ts
import type { Context } from "hono";
import { AppError, toAppError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { AppEnv } from "./requestContext.js";

/**
 * The last middleware: turn whatever went wrong into an HTTP answer.
 *
 * This is where the error taxonomy from `core/errors.ts` finally earns its keep.
 * Every failure already carries a `code`, a `recovery` sentence and an
 * `httpStatus`, so the mapping is a *lookup* rather than a `switch` full of
 * judgement calls — and a failure that arrives without a taxonomy (a genuine
 * bug) is reported as a 500 rather than being dressed up as a 400.
 *
 * Two rules, and they are the ones that keep a production service debuggable:
 *
 *  · **The client gets the message and the recovery; the stack goes to the log.**
 *    A caller can act on *"Unknown resource: task://nope. List the catalogue with
 *    resources/list"*; a caller cannot act on a stack trace, and publishing one
 *    is an information leak.
 *
 *  · **Nothing is swallowed.** An unexpected error is logged at `error` with the
 *    stack, counted, and answered with a 500 — never converted into an empty 200,
 *    which is the failure mode that makes an outage invisible in a dashboard.
 */

export function errorHandler(options: { logger: Logger; metrics: Metrics }) {
  return (error: Error, context: Context<AppEnv>): Response => {
    const logger = context.get("logger") ?? options.logger;
    const failure = toAppError(originOf(context), error, context.req.path);

    options.metrics.count("http.error");
    options.metrics.count(`http.error.${failure.code}`);

    // A 5xx is our fault and belongs at `error`; a 4xx is the caller's and
    // belongs at `warn`. Splitting them is what lets an operator alert on one
    // without drowning in the other.
    const log = failure.httpStatus >= 500 ? logger.error : logger.warn;

    log("http.failed", {
      method: context.req.method,
      path: context.req.path,
      status: failure.httpStatus,
      code: failure.code,
      origin: failure.origin,
      message: failure.message,
      ...(failure.httpStatus >= 500 ? { stack: error.stack } : {}),
    });

    return context.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          // The recovery sentence is written for the *caller*, so it is exactly
          // the thing an API consumer needs to see.
          recovery: failure.recovery,
          retryable: failure.retryable,
          requestId: context.get("requestId"),
        },
      },
      failure.httpStatus as 400,
    );
  };
}

/**
 * Which primitive a failure belongs to, inferred from the route.
 *
 * The alternative — threading an origin through every throw — would put protocol
 * bookkeeping inside business logic. The route is the honest place to read it
 * from, because the route is what chose the primitive in the first place.
 */
function originOf(context: Context<AppEnv>): AppError["origin"] {
  const path = context.req.path;

  if (path.startsWith("/read") || path.startsWith("/resources")) {
    return "resource";
  }

  if (path.startsWith("/prompt")) {
    return "prompt";
  }

  return "tool";
}
```

### Block-by-block

**Block 4 — the header, and why the mapping is a lookup (lines 5–23).**

> This is where the error taxonomy from `core/errors.ts` finally earns its keep. Every failure already carries a `code`,
> a `recovery` sentence and an `httpStatus`, so the mapping is a **lookup** rather than a `switch` full of judgement
> calls — and a failure that arrives without a taxonomy (a genuine bug) is reported as a 500 rather than being dressed up
> as a 400.

That contrast is the payoff of Chapter 05's work. Without the taxonomy, an error handler has to *decide* — is this a 400 or
a 500? is this the caller's fault? — at the moment it knows least about the failure. With it, the decision was made where
the failure was raised, and this file performs a lookup.

The second clause is the safety property: **a failure with no taxonomy becomes a 500.** The tempting alternative is to
treat an unrecognised error as a bad request, because most errors in development *are* bad requests — and in production
that would report a server bug as the caller's fault, hiding it from the dashboards that alert on 5xx.

And the two rules:

> · **The client gets the message and the recovery; the stack goes to the log.** A caller can act on *"Unknown resource:
>   task://nope. List the catalogue with resources/list"*; a caller cannot act on a stack trace, and publishing one is an
>   information leak.
>
> · **Nothing is swallowed.** An unexpected error is logged at `error` with the stack, counted, and answered with a 500 —
>   never converted into an empty 200, which is the failure mode that makes an outage invisible in a dashboard.

*Never converted into an empty 200* names a real anti-pattern. A handler that catches everything and returns success
makes every dashboard green while the service is broken — and it is a tempting shortcut because it stops the alerts.

**Block 5 — `errorHandler` (lines 25–60).**

```ts
export function errorHandler(options: { logger: Logger; metrics: Metrics }) {
  return (error: Error, context: Context<AppEnv>): Response => {
    const logger = context.get("logger") ?? options.logger;
    const failure = toAppError(originOf(context), error, context.req.path);

    options.metrics.count("http.error");
    options.metrics.count(`http.error.${failure.code}`);

    const log = failure.httpStatus >= 500 ? logger.error : logger.warn;

    log("http.failed", {
      method: context.req.method,
      path: context.req.path,
      status: failure.httpStatus,
      code: failure.code,
      origin: failure.origin,
      message: failure.message,
      ...(failure.httpStatus >= 500 ? { stack: error.stack } : {}),
    });

    return context.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          recovery: failure.recovery,
          retryable: failure.retryable,
          requestId: context.get("requestId"),
        },
      },
      failure.httpStatus as 400,
    );
  };
}
```

**`context.get("logger") ?? options.logger`** — the request-scoped child logger when the middleware ran, the root logger
otherwise. The fallback matters because `onError` can fire for a request that failed *before* `requestContext` set
anything (a malformed request Hono rejected early). So the handler degrades to the root logger rather than throwing on a
`undefined`.

**`toAppError(originOf(context), error, context.req.path)`** — Chapter 05's reclassifier, given three things: an origin
inferred from the route, the raw error, and the path as a label. The `label` appears in the message
(`{label} failed: {message}`) for an unclassifiable error, so the path is what makes a generic 500 traceable.

**The metric pair** is `http.error` plus `http.error.{code}` — the same two-level counting as the tool guard
(Chapter 14), so failures can be watched in aggregate or broken down by class.

**The log level is chosen by status, and the comment is the operational argument:**

```ts
const log = failure.httpStatus >= 500 ? logger.error : logger.warn;
```

> A 5xx is our fault and belongs at `error`; a 4xx is the caller's and belongs at `warn`. **Splitting them is what lets an
> operator alert on one without drowning in the other.**

That is the difference between an alertable log stream and a noisy one. A system where every 404 is logged at `error`
produces an alerting channel nobody reads — and the first symptom is that real 500s get missed.

**The stack is conditional:**

```ts
...(failure.httpStatus >= 500 ? { stack: error.stack } : {}),
```

So a 4xx log line has no stack, and a 5xx line has one. That is the first rule enforced: the stack is *only* in the log,
and only when it is the server's fault — which keeps a caller-caused error from burying a real bug in noise.

**The response body has five fields**, and it is the *same shape* as the server's protocol-error `data` (Chapter 05):

| Field | Purpose |
| :--- | :--- |
| `code` | The failure class — what a client branches on |
| `message` | What went wrong |
| `recovery` | **What to do next** — the sentence the server or host wrote |
| `retryable` | Whether a retry is safe |
| `requestId` | The correlation id, so a caller can quote it in a support request |

**`requestId` in the body is the underrated field.** A user reporting a problem can paste the id, and an operator can find
the exact request in the log stream — including every line from every layer, because the id is on the child logger. That
turns a support conversation from "around 3pm" into a lookup.

**The `as 400` cast** is a Hono typing workaround worth naming: `context.json(body, status)` types `status` as a union of
specific literals rather than `number`, so a runtime-computed status needs an assertion. The cast asserts nothing about
the *value* — it is the first member of the union, chosen because it is the smallest valid one — it merely satisfies the
signature. A reader should know this is a library typing gap rather than a claim about the status.

**Block 6 — `originOf`, inferring the primitive from the route (lines 62–87).**

```ts
function originOf(context: Context<AppEnv>): AppError["origin"] {
  const path = context.req.path;

  if (path.startsWith("/read") || path.startsWith("/resources")) {
    return "resource";
  }

  if (path.startsWith("/prompt")) {
    return "prompt";
  }

  return "tool";
}
```

The doc comment is the argument for inferring rather than threading:

> The alternative — threading an origin through every throw — would put **protocol bookkeeping inside business logic**. The
> route is the honest place to read it from, because the route is what chose the primitive in the first place.

That is a good instinct. An origin parameter on every `throw` would mean every service method carried a fact about *which
HTTP route* called it — which the service has no business knowing, and which would be wrong the moment a service were
called from two routes.

The route, by contrast, *is* the choice: `GET /read` reads a Resource, `GET /prompt` renders a Prompt, everything else is a
tool-adjacent path. So the inference is not a guess; it is reading the fact from the place that decided it.

The fallback is `"tool"`, which is correct for this host's remaining routes (`/plan` and `/ask` both end in a tool-ish
pipeline) — and it is the *conservative* choice, because `tool` origin produces a `ToolError`, whose failures are results
rather than protocol errors. Note the type is `AppError["origin"]` — an indexed access rather than a re-declared union, so
a fourth origin would flow through automatically (the same idiom as `withTimeout`'s parameter in Chapter 06).

**One honest limitation:** the inference is by path prefix, so it is coupled to the route table in Chapter 25. A route
renamed without updating this function would misclassify its failures' origins. That is a small, contained coupling — and
it is visible, because both files are short and the prefixes are literal strings.

---

## Run / verify

### 1. The inbound request id is honoured

```bash
curl -s -H 'x-request-id: my-trace-1' 'http://127.0.0.1:8080/health' > /dev/null
grep -o '"requestId":"my-trace-1"[^}]*}' /tmp/hj.log
```

```json
{"requestId":"my-trace-1","method":"GET","path":"/health","status":200,"ms":88,"actor":"123"}
```

**The supplied id survived**, which is the whole point: a trace started upstream stays one trace. And the access log line
shows all five fields — `requestId`, `method`, `path`, `status`, `ms`, `actor` — from a *single* log call, with the id and
the actor injected by the middleware rather than passed by the route.

Compare a request with no id:

```json
{"requestId":"a767a899","method":"GET","path":"/health","status":200,"ms":68,"actor":"123"}
{"requestId":"53842658","method":"GET","path":"/nope","status":404,"ms":0,"actor":"123"}
```

Eight-character generated ids — short enough to read, unique enough to search. And note the second line: **a 404 still gets
an access log**, because the route-level `notFound` handler converts it into a response inside the middleware chain. That
is the *"including for the requests that threw"* promise kept — the failing requests are the ones whose latency you want.

### 2. A thrown error, and the five-field body

```bash
curl -s 'http://127.0.0.1:8080/read?uri=task://nope'
```

```json
{"error":{"code":"NOT_FOUND","message":"Refused to read task://nope — the URI does not match any advertised Resource.","recovery":"Call GET /resources to read the advertised URIs, then retry with one of them.","retryable":false,"requestId":"b2770a39"}}
```

Five fields, and each was decided before this handler ran: the `code` and `recovery` by `policy.mayRead` (Chapter 20), the
`retryable` by the taxonomy (Chapter 05), and the `requestId` by the middleware. **This handler made no judgement calls** —
which is the header's claim that the mapping is a *lookup* rather than a `switch` full of decisions.

And its log line:

```json
{"event":"http.failed","host":"task-host","requestId":"b2770a39","method":"GET","path":"/read","status":404,"code":"NOT_FOUND","origin":"resource","message":"Refused to read task://nope — the URI does not match any advertised Resource."}
```

Three things to notice:

**`origin: "resource"`** — `originOf` inferred the primitive from the path `/read`, correctly. The failure is attributed to
the Resource path without any service having been told which route called it.

**There is no `stack` field.** The status is 404, so the conditional spread omitted it — the first rule (*the stack goes to
the log*) enforced in the direction that matters: a caller-caused error does not bury a real bug in noise.

**`requestId` matches the response body exactly**, so a user quoting the id from the response leads an operator straight to
this line — and to every other line from the same request, because the id is on the child logger.

### 3. An honest inconsistency: the route-level 404

```bash
curl -s 'http://127.0.0.1:8080/nope'
```

```json
{"error":{"code":"NOT_FOUND","message":"No route for GET /nope.","recovery":"Call GET / for the index of available routes."}}
```

**Three fields, not five** — no `retryable` and, more importantly, **no `requestId`**. That is a real inconsistency, and it
has a specific cause: this response comes from `app.notFound(...)` in `routes/index.ts` (Chapter 25), which is Hono's
*route-not-found* hook, not from `errorHandler`. It builds its body by hand.

The consequences are worth stating plainly:

| Path | Body fields | Has `requestId`? |
| :--- | :--- | :--- |
| A thrown failure → `errorHandler` | `code`, `message`, `recovery`, `retryable`, `requestId` | **yes** |
| No matching route → `app.notFound` | `code`, `message`, `recovery` | **no** |

So the one failure a *new* client is most likely to hit first — a wrong path — is the one whose body cannot be correlated
to a log line. The access log still has the id (`"path":"/nope","status":404` with its generated `requestId`), so the
information is not lost; it is simply not in the response.

**The fix is one line**: have `app.notFound` throw an `AppError` instead of returning a body, so `errorHandler` produces
the response and both shapes become one. It is documented rather than changed here because the guide's job is to describe
what the code does — and because this is exactly the kind of inconsistency that a "does every response look the same?"
review is for.

### 4. The metrics, split by status

```bash
curl -s http://127.0.0.1:8080/metrics | python3 -c 'import json,sys; m=json.load(sys.stdin)["metrics"]; [print(k,v) for k,v in m.items() if k.startswith("http")]'
```

```text
http.latency_ms.avg 23
http.latency_ms.count 3
http.latency_ms.max 68
http.status.200 1
http.status.404 2
```

Five numbers, and the pair that matters is `latency_ms` and `status.*`:

- **`http.latency_ms`** is observed by the middleware *after* `next()` resolves, so it includes the whole request —
  including the ones that failed. `avg: 23` with `max: 68` shows the spread across three requests.
- **`http.status.NNN`** is a *labelled* counter built by appending the status — the same cheap-labels technique as
  Chapter 04. So a dashboard can alert on `http.status.500` without a metric per route.

Note `http.error` is **absent** from this list, because the 404s here came from `notFound` and from the policy — and only
the second went through `errorHandler`. So `http.error.404` would be 1 while `http.status.404` is 2. **The two counters
measure different things**, which is worth knowing before building a dashboard on either: `status.*` counts every
response, `error.*` counts failures that reached the error handler.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

The `AppEnv` type is what the typecheck is really enforcing here: `context.get("session")` in `errorHandler` and in every
controller returns a `Session` because `requestContext` declared it in `RequestVariables`. Change that declaration and the
compiler finds every reader.

---

## Checkpoint

1. **Why a middleware layer rather than each controller doing this?**
   Because otherwise each of the three concerns would be *copy-pasted into four controllers and forgotten in the fifth*.
   Same argument as the shared `guard` (Chapter 14) and the shared `deps` (Chapter 13).

2. **Why is the request id bound to a child logger rather than passed as a parameter?**
   Because that makes correlation **automatic instead of optional** — a controller logs through `context.get("logger")` and
   gets the id without writing it, and cannot forget to pass it.

3. **Why is `isAdmin` an exact `=== "true"` comparison?**
   Because a privilege flag must not be a truthiness check: `Boolean("false")` is `true`, and so is `Boolean("0")` — either
   would be a privilege escalation. Same reasoning as `booleanFromEnv` in Chapter 02.

4. **Why does an absent `x-projects` mean no scope rather than a default?**
   Because *the selector should not invent a project the session never named.* Inventing a scope would attach a project
   brief the user never mentioned.

5. **Why does an unrecognised error become a 500 rather than a 400?**
   Because most errors in development *are* bad requests, and treating that as the rule would report a server bug as the
   caller's fault — hiding it from the dashboards that alert on 5xx.

6. **Why is the log level chosen by status?**
   *A 5xx is our fault and belongs at `error`; a 4xx is the caller's and belongs at `warn`.* Splitting them lets an operator
   alert on one without drowning in the other — and a stream where every 404 is an error is a stream nobody reads.

7. **What is conditional about the failure log line, and why?**
   The `stack` — included only for 5xx. That enforces the first rule (*the stack goes to the log*) in the direction that
   matters: a caller-caused error does not bury a real bug in noise.

8. **Why is the origin inferred from the route rather than threaded through every throw?**
   Because threading it would put *protocol bookkeeping inside business logic* — and the route is the honest place to read
   it from, since the route is what chose the primitive. A service that carried an origin would be wrong the moment it were
   called from two routes.

9. **What inconsistency does this chapter document?**
   `app.notFound` returns a three-field body with no `requestId`, while `errorHandler` returns five fields. The one-line fix
   is to have `notFound` throw an `AppError` so `errorHandler` produces both responses.

10. **Why do `http.status.404` and `http.error.404` differ?**
    Because they measure different things: `status.*` counts every response the middleware saw, while `error.*` counts only
    failures that reached the error handler. A route-level 404 is counted by the first and not the second.

---

**[← Chapter 23: The Host Wiring Contract](./23_Host_Wiring_Contract.md)** · **[Chapter 25: Controllers & Router →](./25_Controllers_and_Router.md)**
