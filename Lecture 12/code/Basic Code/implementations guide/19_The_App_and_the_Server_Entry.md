# Chapter 19 — The App and the Server Entry

> **Goal of this chapter:** read the last two files, and the one decision they
> encode: **the app is built in one place and bound to a port in another.** That
> split is what lets a test own the app and the entry point own the port.
>
> **Lecture chapters:** all of them — this is where the eight controls become a
> running service.

---

## 19.1 File details

| Property | Value |
|---|---|
| **Path (app)** | `src/app.ts` |
| **Path (entry)** | `src/index.ts` |
| **Layer** | composition, then entry |
| **Purpose** | `createApp()` assembles middleware + routes + failure path; `index.ts` listens |
| **Imports (app)** | `cors`, `express`, `notFound`/`errorHandler`, `routes` |
| **Imports (entry)** | `createApp`, `config` |
| **Exports** | `createApp` (app), nothing (entry) |
| **Imported by** | `index.ts` |
| **Lecture sections** | all |

### Why two files instead of one

| If `createApp` also listened | With the split |
|---|---|
| importing the app starts a server | importing the app is side-effect free |
| a test would need a real port | a test can drive the app directly |
| the port is buried in the composition | the port is one line in the entry point |

---

## 19.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run dev        # tsx watch src/index.ts — restarts on edit
npm run start      # tsx src/index.ts — one shot
PORT=3200 npm run start
```

---

## 19.3 Full files

**Path:** `src/app.ts`

```ts
import cors from "cors";
import express, { type Express } from "express";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { routes } from "./routes/index.js";

/**
 * Chapter 17 — the app.
 *
 * The order of the four `use` calls *is* the file:
 *   1. middleware every request needs (CORS, JSON body parsing),
 *   2. the route table,
 *   3. the failure path — 404 first, then the error handler.
 *
 * `createApp()` returns the app instead of listening, so the entry point owns
 * the port and a test could own the app.
 */
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
```

**Path:** `src/index.ts`

```ts
import { createApp } from "./app.js";
import { config } from "./config/config.js";

/**
 * Chapter 17 — the process entry point.
 *
 * The only file that binds the app to a port. Everything above it is importable
 * without a side effect, which is what lets the HTTP server and the CLI
 * (`src/cli.ts`) share the exact same services.
 */
const app = createApp();

app.listen(config.port, () => {
  console.log(`[lecture-12-basic-rag] listening on http://localhost:${config.port}`);
  console.log("  GET  /health   GET /filters   GET /eval   GET /ablation");
  console.log("  POST /search   POST /ask");
});
```

---

## 19.4 Block-by-block explanation

**Block 1 — `createApp`: the order of five `use` calls**

```ts
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
```

- **The order is the logic.** Express runs middleware in registration order, so:
  1. `cors()` — headers on every response, including errors.
  2. `express.json()` — parses the body, so `req.body` exists in the controllers.
  3. `routes` — the six bindings.
  4. `notFound` — a catch-all, so it must come *after* the routes.
  5. `errorHandler` — the four-argument handler, which Express calls from anywhere
     in the chain.
- Swapping 4 and 3 would make every request a 404; moving `errorHandler` before
  `routes` would still work (Express collects it separately) but would read as if
  it were a normal handler. The comment in the file records the reasoning so the
  order is not "fixed" by accident later.
- `cors()` with no options is a demo default: any origin may call the API. In
  production this is the line you would restrict, and it is deliberately a
  one-liner so the change is obvious.
- `createApp()` **returns** the app rather than calling `listen`. That is the
  single most valuable decision in the file: `index.ts` owns the port, and a test
  could import `createApp` and drive it without binding a socket.

**Block 2 — the entry point: three lines of work**

```ts
import { createApp } from "./app.js";
import { config } from "./config/config.js";

const app = createApp();

app.listen(config.port, () => { … });
```

- `import { config }` is what loads `.env`, transitively: `config.ts` runs
  `dotenv/config` at import time, so the port is available before `listen`.
- `config.port` defaults to `3100` and is overridable with `PORT=3200 npm run
  start`. Because it lives in `config.ts` with every other knob, the server's port
  is in the same place as the retrieval settings — one file to read.
- The callback prints the **route table** as a banner. That is the same instinct
  as `/health`: a running service should tell you what it offers. It writes to
  `stdout` (not `stderr`) because it is the program's normal output.
- There is no `process.exit`, no signal handling and no graceful shutdown. For a
  local demo that would be noise; the honest note is that a real deployment needs
  both.

**Block 3 — why `cli.ts` is not part of this file**

```ts
/**
 * … which is what lets the HTTP server and the CLI (`src/cli.ts`) share the
 * exact same services.
 */
```

- The project has **two entries**: `index.ts` (a long-running server) and
  `cli.ts` (a one-shot command). Neither is the "real" one — they are two doors
  into `services/`.
- The test of the layering is that adding a third door (a queue worker, a cron
  job, a test harness) would require no change to `services/`, `models/` or
  `config/`. That is what Chapter 01's layer table was for.

---

## 19.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run start
```

Expected:

```text
[lecture-12-basic-rag] listening on http://localhost:3100
  GET  /health   GET /filters   GET /eval   GET /ablation
  POST /search   POST /ask
```

Then, in another shell:

```bash
curl -s localhost:3100/health | head -c 120; echo
curl -s -o /dev/null -w 'status %{http_code}\n' localhost:3100/nope
```

And to prove the port is configuration:

```bash
PORT=3200 npm run start     # → listening on http://localhost:3200
```

---

## 19.6 Checkpoint

1. **Why does `createApp()` not call `listen`?** So importing the app has no side
   effect — the entry point owns the port and a test can own the app.
2. **Why is `notFound` registered after `routes`?** Middleware runs in
   registration order, so the catch-all must be last.
3. **What are the project's two entry points, and what do they share?** `index.ts`
   (HTTP) and `cli.ts` (commands); both call the same `services/`.

---

## Where to go next

You have now read every file in the project. Four useful next steps, in
increasing order of ambition:

1. **Break something on purpose.** `CATEGORIES=electronics npm run ask` — the
   general policy disappears from the context and the answer changes. That is
   Chapter 08's restrictiveness trap, felt rather than read.
2. **Calibrate a threshold.** `MIN_SCORE=0 RERANK_MIN_BEST=0 npm run eval` — watch
   `refusal` fall. The floor is the only reason refusal is reachable.
3. **Add a route.** A `POST /chunks` that returns the chunk list for a document is
   one controller function and one line in `routes/index.ts`; nothing in
   `services/` needs to change.
4. **Replace one stage.** Swap `embed` in `services/embeddings.ts` for a real
   embedding API, or `rerank` in `services/rerank.ts` for a cross-encoder.
   Nothing else in the pipeline moves — which is the point of the layering.

**Back to:** [Implementation guide index](./README.md) · [Basic Code README](../README.md) ·
[Lecture 12 notes](../../../notes/README.md)

