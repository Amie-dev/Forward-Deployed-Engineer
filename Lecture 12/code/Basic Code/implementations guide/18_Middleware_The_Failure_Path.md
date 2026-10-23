# Chapter 18 — Middleware: The Failure Path

> **Goal of this chapter:** read the two functions that handle *everything that
> goes wrong*. One 404 for an unknown route, and one error handler for a thrown
> error — so the failure path is written once instead of in every controller.
>
> **Lecture chapters:** all of them, with the notes' rule that *error messages are
> instructions*.

---

## 18.1 File details

| Property | Value |
|---|---|
| **Path** | `src/middleware/errorHandler.ts` |
| **Layer** | failure path |
| **Purpose** | the 404 and the single error handler |
| **Imports** | `Request`/`Response`/`NextFunction` (types), `ErrorResponse` (models) |
| **Exports** | `notFound`, `errorHandler` |
| **Imported by** | `app.ts` |
| **Lecture sections** | 05 §"fail loudly" (the same convention, over HTTP) |

### The two Express conventions this file implements

| Convention | Rule |
|---|---|
| a 404 handler | ordinary middleware, registered **after** the routes |
| an error handler | identified by having **four** arguments — so `_next` is required |

---

## 18.2 Commands

```bash
cd "Lecture 12/code/Basic Code"
npm run dev

# 404 — nothing matched the route table
curl -s -w '\n%{http_code}\n' localhost:3100/nope

# 400 — the body failed validation in the controller
curl -s -w '\n%{http_code}\n' -X POST localhost:3100/ask \
  -H 'content-type: application/json' -d '{}'
```

---

## 18.3 Full file

**Path:** `src/middleware/errorHandler.ts`

```ts
import type { NextFunction, Request, Response } from "express";
import type { ErrorResponse } from "../models/types.js";

/**
 * Chapter 16 — the failure path, in one place.
 *
 * Express has two conventions and this file implements both:
 *   - a 404 handler is ordinary middleware, registered *after* the routes;
 *   - an error handler is identified by having **four** arguments, so the
 *     unused `_next` is required, not decorative.
 */

/** Nothing matched the route table. */
export function notFound(req: Request, res: Response): void {
  const body: ErrorResponse = { error: `No route for ${req.method} ${req.path}` };
  res.status(404).json(body);
}

/**
 * The single error handler. A bad request body is a `400`; anything else is a
 * `500`. The message is passed through because every message in this project is
 * written as an instruction (Chapter 06's ingest error, Chapter 14's validator).
 */
export function errorHandler(
  error: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = error.message.startsWith("Body must be") ? 400 : 500;
  const body: ErrorResponse = { error: error.message };
  res.status(status).json(body);
}
```

---

## 18.4 Block-by-block explanation

**Block 1 — the two conventions, stated up front**

```ts
/**
 * Express has two conventions and this file implements both:
 *   - a 404 handler is ordinary middleware, registered *after* the routes;
 *   - an error handler is identified by having **four** arguments, so the
 *     unused `_next` is required, not decorative.
 */
```

- The second line is the one that trips people up. Express inspects `fn.length`: a
  function with four parameters is an error handler, one with three is ordinary
  middleware. Delete `_next` "because it is unused" and the handler silently
  becomes a normal middleware that never runs on an error.
- The first line explains why `notFound` is registered after `routes` in
  `app.ts`: middleware runs in registration order, so a catch-all must be last
  among the normal handlers.

**Block 2 — `notFound`**

```ts
export function notFound(req: Request, res: Response): void {
  const body: ErrorResponse = { error: `No route for ${req.method} ${req.path}` };
  res.status(404).json(body);
}
```

- The message names the **method and the path** — the two things a caller needs to
  fix the request. `No route for GET /nope` is actionable; `Not found` is not.
- `const body: ErrorResponse = …` annotates the value so it cannot drift from the
  contract in `models/types.ts`. This is the same shape the error handler returns,
  so a client parses one error format.
- No `next()` call: the response is finished, so the chain stops here.

**Block 3 — `errorHandler` and the status mapping**

```ts
export function errorHandler(error: Error, _req: Request, res: Response, _next: NextFunction): void {
  const status = error.message.startsWith("Body must be") ? 400 : 500;
  const body: ErrorResponse = { error: error.message };
  res.status(status).json(body);
}
```

- **The status mapping is one ternary.** A message beginning `Body must be` comes
  from the controller's validator (Chapter 16) and is the caller's fault → `400`.
  Everything else is ours → `500`. That is a deliberately blunt rule: with one
  validator in the project, a prefix is a sufficient contract, and the prefix is
  visible in both files.
- `error.message` is passed through **unmodified**. Every message in this project
  is written as an instruction — Chapter 06's
  `Ingest error: chunk … is missing category/tenant/acl metadata`, Chapter 16's
  `Body must be { question: string } …` — so the caller gets a fix, not a code.
- Note what is *not* here: no `console.error`, no stack trace, no leaking of the
  prompt. A `500` in a retrieval system can carry the corpus in its message, so the
  safe default is to return the message the code deliberately wrote and nothing
  more.
- `_req` and `_next` are unused but required — the underscore prefix documents
  that, and Block 1 explains why `_next` cannot be removed.

**Why one handler and not six**

| Alternative | Cost |
|---|---|
| `try/catch` in every controller | six copies of the status mapping; one will disagree |
| `throw` with a status attached | the domain layer would need to know about HTTP |
| **one handler + a message prefix** | the domain stays HTTP-free; one place decides status codes |

The middle row is the important one: `services/` must not import Express. Keeping
the status decision in `middleware/` is what preserves the layer direction from
Chapter 01.

---

## 18.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run dev &

curl -s -w '\n%{http_code}\n' localhost:3100/nope
curl -s -w '\n%{http_code}\n' -X POST localhost:3100/ask \
  -H 'content-type: application/json' -d '{}'
```

Expected:

```text
{"error":"No route for GET /nope"}
404
{"error":"Body must be { question: string } with a non-empty question."}
400
```

---

## 18.6 Checkpoint

1. **How does Express recognise an error handler?** By its argument count — four
   parameters. That is why `_next` must stay.
2. **Where is the 404 handler registered, and why there?** After the routes in
   `app.ts`, because middleware runs in registration order.
3. **Why is the status mapping a prefix check rather than a thrown status?** So
   `services/` never has to know about HTTP status codes.

**Next:** [Chapter 19 — The app and the server entry](./19_The_App_and_the_Server_Entry.md)

