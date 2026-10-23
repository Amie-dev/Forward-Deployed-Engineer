# Chapter 17 — The Routes

> **Goal of this chapter:** read the whole HTTP surface of the project in one
> screen. A route is a **binding** — a path, a method, and a controller function —
> and there is no logic here at all.
>
> **Lecture chapters:** all of them. The route table is also where Chapter 05's
> request shape becomes explicit.

---

## 17.1 File details

| Property | Value |
|---|---|
| **Path** | `src/routes/index.ts` |
| **Layer** | binding |
| **Purpose** | map path + method to a controller function |
| **Imports** | `Router` (express), six handlers from the controller |
| **Exports** | `routes` |
| **Imported by** | `app.ts` |
| **Lecture sections** | 01 §"the pipeline", 05 §"server-derived scope", 09 §"the runbook" |

### The route table

| Method | Path | Handler | Chapter it exposes |
|---|---|---|---|
| `GET` | `/health` | `health` | 04 (the controls) |
| `GET` | `/filters` | `filters` | 08 (eligibility) |
| `GET` | `/eval` | `evaluateHandler` | 14 (the golden set) |
| `GET` | `/ablation` | `ablationHandler` | 14 (one control at a time) |
| `POST` | `/search` | `search` | 09–10 (the trace) |
| `POST` | `/ask` | `ask` | 11–12 (the answer) |

Six routes: four read-only diagnostics and two question endpoints. **Every chapter
of the lecture is reachable over HTTP**, and the CLI reaches the same six
behaviours through `src/cli.ts`.

---

## 17.2 Commands

```bash
cd "Lecture 12/code/Basic Code"
npm run dev

# the whole table, by hand
curl localhost:3100/health
curl localhost:3100/filters
curl localhost:3100/eval
curl localhost:3100/ablation
curl -X POST localhost:3100/search -H 'content-type: application/json' -d '{"question":"return window for electronics"}'
curl -X POST localhost:3100/ask    -H 'content-type: application/json' -d '{"question":"Who won the IPL in 2026?"}'
```

---

## 17.3 Full file

**Path:** `src/routes/index.ts`

```ts
import { Router } from "express";
import {
  ablationHandler,
  ask,
  evaluateHandler,
  filters,
  health,
  search,
} from "../controllers/ragController.js";

/**
 * Chapter 15 — the route table.
 *
 * A route is a *binding*: it names a path and a method and points at a
 * controller function. There is no logic here, which is the point — the whole
 * HTTP surface of the project fits on one screen.
 *
 * The two POST routes take `{ question: string }`. Note what they do **not**
 * take: a tenant, an ACL or a date. Those come from configuration (Chapter 07),
 * which is what makes Chapter 05's IDOR case impossible over HTTP.
 */
export const routes: Router = Router();

routes.get("/health", health);
routes.get("/filters", filters);
routes.get("/eval", evaluateHandler);
routes.get("/ablation", ablationHandler);
routes.post("/search", search);
routes.post("/ask", ask);
```

---

## 17.4 Block-by-block explanation

**Block 1 — the imports: `Router` and six named handlers**

```ts
import { Router } from "express";
import { ablationHandler, ask, evaluateHandler, filters, health, search } from "../controllers/ragController.js";
```

- The handler names are imported **by name**, not as a namespace. That is a small
  choice with a visible consequence: the route table reads as a list of
  behaviours, and a typo is a compile error rather than a 404 at runtime.
- `evaluateHandler` and `ablationHandler` carry the `Handler` suffix because
  `evaluate` and `ablation` are the *service* names — the suffix keeps the two
  layers from being confused at a glance.

**Block 2 — the comment states the rule and the security property**

```ts
/**
 * A route is a *binding*: it names a path and a method and points at a
 * controller function. There is no logic here…
 *
 * The two POST routes take `{ question: string }`. Note what they do **not**
 * take: a tenant, an ACL or a date. Those come from configuration (Chapter 07),
 * which is what makes Chapter 05's IDOR case impossible over HTTP.
 */
```

- The second paragraph is the important one. The notes' IDOR example is *"user
  changes `tenantId` in the request"* — and the defence is not a validation rule,
  it is that **the field does not exist**. A reviewer reading only this file can
  verify the boundary.

**Block 3 — the router and the six bindings**

```ts
export const routes: Router = Router();

routes.get("/health", health);
routes.get("/filters", filters);
routes.get("/eval", evaluateHandler);
routes.get("/ablation", ablationHandler);
routes.post("/search", search);
routes.post("/ask", ask);
```

- `Router()` creates a mini-application: it has its own middleware stack and can
  be mounted anywhere. `app.ts` mounts it at the root, so the paths above are the
  real URLs.
- `routes: Router` uses the same name for the type and the value — the standard
  Express idiom, and it makes the exported type explicit for the importer.
- The order of the six lines is deliberate: the four diagnostics first (they
  describe the system), then the two question endpoints (they use it). That is the
  order a reader wants, and the order `/health` prints in its banner.
- `export const routes` (rather than a default export) means `app.ts` imports
  `{ routes }`, so a second router could be added later without a naming
  collision.

**What is deliberately missing**

| Not here | Why |
|---|---|
| a version prefix (`/api/v1`) | nothing to version yet; adding it is one `app.use` in Chapter 18 |
| auth middleware | the demo has no users; the *shape* of the boundary is in the filter |
| a body-schema library | one field, one validator, one error message (Chapter 16) |
| route-level error handling | one error handler for the whole app (Chapter 18) |

---

## 17.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run dev &
curl -s localhost:3100/health
```

Expected: a JSON object with `"status": "ok"`. If you change `CHUNK_STRATEGY` in
`.env` and restart, `"chunks"` moves from `19` to `12` — proof that the routes are
wired to the live configuration and not to a snapshot.

---

## 17.6 Checkpoint

1. **What is a route?** A binding: path + method → controller function. No logic.
2. **What do the two POST routes deliberately not accept?** A tenant, an ACL or an
   `asOf` date — which is what removes the IDOR case by construction.
3. **Why import handlers by name instead of a namespace?** A typo becomes a
   compile error, and the table reads as a list of behaviours.

**Next:** [Chapter 18 — Middleware: the failure path](./18_Middleware_The_Failure_Path.md)

