# Chapter 09 — Controller & Routes: The `/chat` Contract

> **Goal of this chapter:** build the HTTP surface — and keep it *thin*. The controller
> validates and delegates; the router decides the URL shape. Neither one knows anything about
> images or models, because Chapter 07.5 says the application **packages** the request and never
> **interprets** it.
>
> **Lecture chapter:** [07 — The End-to-End Multimodal Pipeline](../../../notes/07_The_End_To_End_Multimodal_Pipeline.md), §7.5.

---

## 9.1 File details

| | |
|---|---|
| **Path A** | `src/controllers/chatController.js` |
| **Purpose A** | validate the request, delegate to the service, render the response |
| **Imports A** | `config` |
| **Exports A** | `health`, `chat`, `clear` (all Express handlers) |
| **Path B** | `src/routes/index.js` |
| **Purpose B** | declare the URL surface and the middleware order |
| **Imports B** | `express` (`Router`), `chatController`, `upload` + `rejectOversizedRequest` |
| **Exports B** | `createRouter(chatService)` |
| **Who imports them** | `src/index.js` imports `createRouter`; nothing imports the controller but the router |
| **Depends on** | `src/config/config.js`, `src/middleware/upload.js` |

**Commands**

```bash
cd "Lecture 16/code/Basic Code"
npm start
curl -s http://127.0.0.1:8080/health
```

---

## 9.2 Full file — the controller

**Path:** `src/controllers/chatController.js`

```js
// Lecture 16 · Chapter 07.5 — the HTTP layer.
//
// It validates, it delegates, it renders. It contains NO image logic and NO model
// logic, because the application's job is to get the right bytes to the provider and
// to handle the answer responsibly — not to understand the picture.
import { config } from '../config/config.js';

// Chapter 08 — a cheap liveness probe that also reports the limits actually in force.
export function health(request, response) {
  response.json({
    ok: true,
    model: config.model,
    patchSize: config.patchSize,
    maxImageTokens: config.maxImageTokens,
    modelConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
}

// Chapter 07.5 — the board's contract: Client --/chat--> LLM, "Text / Image -> Text".
export function chat(chatService) {
  return async (request, response, next) => {
    const message = request.body?.message;
    if (typeof message !== 'string' || message.trim() === '') {
      return response.status(400).type('text').send('The message field is required.');
    }
    try {
      // `request.file` is undefined for a text-only turn, which is exactly the
      // "Text / Image" half of the contract: one route, two shapes.
      response.type('text').send(await chatService.chat(message, request.file));
    } catch (error) {
      next(error);
    }
  };
}

// Chapter 07.6 — drop the conversation, and every image in it.
export function clear(chatService) {
  return async (request, response, next) => {
    try {
      await chatService.clearHistory();
      response.status(200).end();
    } catch (error) {
      next(error);
    }
  };
}
```

---

## 9.3 Full file — the routes

**Path:** `src/routes/index.js`

```js
// Lecture 16 · Chapter 07.5 — the whole HTTP surface. Three routes, one contract.
import { Router } from 'express';
import * as chatController from '../controllers/chatController.js';
import { rejectOversizedRequest, upload } from '../middleware/upload.js';

export function createRouter(chatService) {
  const router = Router();

  // Chapter 08 — what limits are in force right now?
  router.get('/health', chatController.health);

  // The board's contract: Client --/chat--> LLM, "Text / Image -> Text".
  // Order matters: reject an oversized request first, then parse the multipart body,
  // then hand a validated message + image to the controller.
  router.post(
    '/chat',
    rejectOversizedRequest,
    upload.single('image'),
    chatController.chat(chatService),
  );

  // Chapter 07.6 — reset the conversation (and drop the images with it).
  router.delete('/chat', chatController.clear(chatService));

  return router;
}
```

---

## 9.4 Block-by-block explanation — the controller

**Block 1 — `health`**

```js
export function health(request, response) {
  response.json({
    ok: true,
    model: config.model,
    patchSize: config.patchSize,
    maxImageTokens: config.maxImageTokens,
    modelConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
}
```

- **What it does:** a plain liveness probe that also reports the limits in force.
- Reporting `patchSize` and `maxImageTokens` turns an operational question ("what is this
  deployment actually configured to accept?") into one `curl`. Chapter 08's whole cost argument
  is about *knowing* your budget; this endpoint makes the budget inspectable instead of
  implicit.
- `modelConfigured` is a **boolean**, not the key. The client learns *whether* a model is wired
  up, never *what the credential is*. Chapter 08.4's "no secrets in the response" rule.
- `Boolean(process.env.OPENAI_API_KEY)` collapses `undefined` and `''` to `false`, so an empty
  `.env` entry correctly reports "not configured".
- Note there is no `try`/`catch`: this handler cannot throw, so it needs no error path. Adding
  one would be noise.

**Block 2 — `chat(chatService)`: a handler factory**

```js
export function chat(chatService) {
  return async (request, response, next) => {
    ...
  };
}
```

- **What it does:** returns an Express handler. `chat` is *not* itself a handler — calling it
  with the service produces one.
- **Why a factory instead of a module-level singleton.** The service is created once in
  `src/index.js` and passed down. The controller therefore has **no import** of `chatService`,
  which is what lets `app.test.js` build an app with a *fake* client and run the whole HTTP path
  without a network call. Dependency injection, in about four lines.
- This is the same shape as Lecture 15's `client.ts` receiving an MCP client: the caller owns
  the wiring, the callee owns the logic.

**Block 3 — validation, and the one field that must exist**

```js
const message = request.body?.message;
if (typeof message !== 'string' || message.trim() === '') {
  return response.status(400).type('text').send('The message field is required.');
}
```

- `request.body?.message` — the optional chaining matters: for a `multipart/form-data` request
  with no fields at all, `request.body` can be an empty object, and for a malformed request it
  can be `undefined`. Without `?.` this line would throw a `TypeError` and the client would get
  a `502` for what is really their own `400`.
- **Both halves of the check are needed.** `typeof message !== 'string'` rejects a missing field
  and a non-string (an array, from a repeated field). `.trim() === ''` rejects whitespace-only
  input — `" "` is technically a string but is not a question.
- The response is `400` and the message **names the field**: `The message field is required.`
  That is a developer-facing API, so naming the fix is right.
- **`return` before the response.** Without it, execution would continue and Express would try
  to send a second response — the classic `ERR_HTTP_HEADERS_SENT` crash.

**Block 4 — delegate, then forward errors**

```js
try {
  response.type('text').send(await chatService.chat(message, request.file));
} catch (error) {
  next(error);
}
```

- **The entire controller is one line of real work.** It does not measure the image, does not
  count tokens, does not build the message. That is the chapter's argument in code: **the
  application packages and forwards; the service and the provider do the rest.**
- `request.file` is `undefined` for a text-only turn and the multer file object otherwise. One
  expression serves both halves of the `"Text / Image"` contract — which is why this route needs
  no branching.
- `.type('text')` sets `text/plain`. The board's contract says the response is **text**; being
  explicit about it means a browser shows the answer instead of offering a download.
- `next(error)` hands the failure to `errorHandler` (Chapter 07). **Every async handler must
  forward**, because an `await` that rejects inside an Express handler does not propagate on its
  own in the way a synchronous `throw` does.

**Block 5 — `clear(chatService)`**

```js
export function clear(chatService) {
  return async (request, response, next) => {
    try {
      await chatService.clearHistory();
      response.status(200).end();
    } catch (error) {
      next(error);
    }
  };
}
```

- Another factory, for the same injection reason.
- `response.status(200).end()` sends an empty body with an explicit `200`. `.end()` is correct
  here rather than `.send()`: there is nothing to send, and an empty body is the honest
  representation of "done".
- `await` is used even though clearing is synchronous internally — the service returns a
  promise, so the controller treats it as one. Keeping the `await` means the service could
  become genuinely asynchronous later without touching this file.


---

## 9.5 Block-by-block explanation — the routes

**Block 1 — `createRouter(chatService)`**

```js
export function createRouter(chatService) {
  const router = Router();
  ...
  return router;
}
```

- `Router()` from Express creates an isolated mini-app: its own routes, its own middleware
  stack. `src/index.js` mounts it with `app.use(createRouter(...))`.
- Returning a router (rather than exporting a configured one) keeps the service injected. The
  router is a *factory* for exactly the same reason the controller is.
- **Three routes, and that is the whole API.** Chapter 07.5's "the application shape is
  unchanged" is visible here: adding vision did not add endpoints, it changed the *payload* of
  one.

**Block 2 — the probe**

```js
router.get('/health', chatController.health);
```

- `health` is passed **directly**, not called. It takes no arguments to build, because it needs
  no service. This is the difference between the factory handlers (`chat(chatService)`) and the
  plain one (`health`), and it is deliberate: don't manufacture a closure you don't need.

**Block 3 — the contract route, and its middleware order**

```js
router.post(
  '/chat',
  rejectOversizedRequest,
  upload.single('image'),
  chatController.chat(chatService),
);
```

- **Read the arguments left to right; they run in that order.**

  | Step | Middleware | What it does |
  |---|---|---|
  | 1 | `rejectOversizedRequest` | cheap `Content-Length` check, before any allocation |
  | 2 | `upload.single('image')` | parse the multipart body into `req.file` + `req.body` |
  | 3 | `chatController.chat(...)` | validate `message`, delegate, render |

- **Order is not cosmetic.** Putting `rejectOversizedRequest` after the upload would defeat its
  entire purpose — the bytes would already be in memory. Putting the controller first would
  leave `req.body` undefined, because nothing had parsed the body yet.
- `upload.single('image')` means: accept **at most one** file, from the form field named
  `image`, and put it on `request.file`. The field name is part of the public contract — the
  `curl` command in the README uses `-F 'image=@payment.png'` and must match.
- The path is `/chat`, matching the board literally (`Client —/chat→ LLM`). Not `/api/chat`,
  not `/v1/chat` — the lecture's own label.
- The handler is created **once**, at router-construction time, not per request. Calling
  `chatController.chat(chatService)` inside the request would allocate a new closure for every
  call.

**Block 4 — reset**

```js
router.delete('/chat', chatController.clear(chatService));
```

- `DELETE` on the *same path* as `POST` is the resource-oriented way to say "reset this
  conversation". One URL, two verbs, two meanings — no `/chat/reset` needed.
- Chapter 07.6 makes this more than a convenience: images accumulate in history and cost money
  every turn, so "start over" is a cost control as well as a UX feature.

**Block 5 — what is deliberately absent**

There is no route for the pipeline itself. The offline walkthrough lives in `src/demo.js`
(Chapter 10), **not** behind an endpoint.

- Reason one: the notes' claim is that the *application* does not inspect images, so exposing
  an endpoint that returns patches and embeddings would contradict the design.
- Reason two: it keeps the HTTP surface honest — three routes that a real client would actually
  use, and no debug endpoints to secure.

---

## 9.6 Run / verify

```bash
cd "Lecture 16/code/Basic Code" && npm start
```

```bash
curl -s http://127.0.0.1:8080/health
curl -s -X POST http://127.0.0.1:8080/chat -F 'message=Why is my payment failing?'
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://127.0.0.1:8080/chat
```

Expected (verified):

```text
{"ok":true,"model":"gpt-4o-mini","patchSize":16,"maxImageTokens":8160,"modelConfigured":false}

[offline] no image attached. You asked: "Why is my payment failing?". Set OPENAI_API_KEY in .env for a real answer.

200
```

---

## 9.7 Checkpoint

1. **Why are `chat` and `clear` *factories* (`chat(chatService)`) while `health` is a plain
   handler?** → they need the service injected; `health` does not. It also lets the tests inject
   a fake client.
2. **Why must `rejectOversizedRequest` come before `upload.single('image')`?** → the point of
   the check is to reject *before* the bytes are buffered into memory.
3. **What does the controller do with the image?** → nothing. It passes `request.file` straight
   to the service. That is Chapter 07.5's "the app packages; it does not interpret".

**Next:** [Chapter 10 — Entry Point & Offline Demo](./10_Entry_Point_and_Offline_Demo.md)

