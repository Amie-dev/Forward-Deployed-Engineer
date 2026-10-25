# Chapter 11 — The Surfaces: Controllers, Routes, Entry

> **The HTTP boundary, and nothing else.** Three files that read a request, call a
> service, and shape a response — with **no security logic anywhere in them**.
>
> That absence is the design. Every rule in this project lives in `services/`, which
> is what lets `npm run demo` run the entire attack suite with no server at all. If
> a controller ever grew an `if (user === …)`, the CLI would stop being able to
> test the same behaviour and the two surfaces would drift.
>
> There are exactly two decisions at this boundary, and both are Chapter 08 §8.3:
> **the session is built from the server's records**, and the trace goes into the
> response body because for this project the trace *is* the lesson.

---

## File details

| | `controllers/chatController.ts` | `controllers/securityController.ts` | `routes/index.ts` | `index.ts` |
|---|---|---|---|---|
| **Lines** | 88 | 130 | 54 | 27 |
| **Layer** | HTTP | HTTP | HTTP | entry |
| **Purpose** | `POST /chat` | the security model, the audit log, the attacks | the route table, and the 404 | bind a port and say so |
| **Exports** | `chatController()` | `securityController()` | `app` | — |
| **Notes sections** | Ch 06 §6.2, Ch 08 §8.3 | Ch 07 §7.4, Ch 09 §9.10, §9.13 | Ch 06 §6.2 | Ch 06 §6.2 |

**The wiring is the point of `routes/index.ts`.** Two decisions — which model, and
which agent every surface shares — are made there and nowhere else, so "what is
this deployment running?" has one answer in one file.

---

## Commands

```bash
cd "Lecture 19/code/Basic Code"
npm run typecheck
npm start
```

```bash
# The index — what this deployment is and what it can do.
curl -s http://127.0.0.1:8080/

# Chapter 08 §8.3 — the session is looked up server-side. An unknown user is a 401.
curl -s -X POST http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"user":"mallory","message":"Where is ORD-101?"}'

# Chapter 09 §9.13 — the status code IS the verdict on an attack.
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/attack/indirect-no-filter
```

---

## `src/controllers/chatController.ts` — the full file

```ts
import type { Request, Response } from "express";
import { CUSTOMERS } from "../domain/data.js";
import type { Session } from "../domain/types.js";
import type { Agent } from "../services/agent.js";

/**
 * Chapter 06 §6.2 / Chapter 08 §8.3 — the request surface.
 *
 * Two things here are the lecture.
 *
 * **The session is built server-side.** The `user` field in the body stands in
 * for an authenticated session; a real deployment would read it from a token.
 * That is the *only* difference, and it is the difference that matters: identity
 * is looked up from the server's records, never taken from the request's
 * arguments. If the model could name its own user, Chapter 07's whole argument
 * about over-permissioned tools would be moot.
 *
 * **The response carries the trace.** In production the trace would go to a log
 * sink — Chapter 09 §9.13's audit log — rather than into the response body. It is
 * in the body here because for this project the trace *is* the lesson: it is the
 * only way to see which layer did what.
 */
export function chatController(deps: { agent: Agent }) {
  return {
    chat: async (request: Request, response: Response): Promise<void> => {
      const body = request.body as
        | { message?: unknown; user?: unknown; confirmationId?: unknown; confirmArgs?: unknown }
        | undefined;

      const message = typeof body?.message === "string" ? body.message.trim() : "";
      const user = typeof body?.user === "string" ? body.user.trim() : "";
      const customer = CUSTOMERS.find((entry) => entry.user === user);

      if (customer === undefined) {
        response.status(401).json({
          error: {
            message: `unknown user "${user}"`,
            recovery: 'Send {"user":"alice","message":"Where is my order ORD-101?"}',
          },
        });
        return;
      }

      const confirmationId = typeof body?.confirmationId === "string" ? body.confirmationId : undefined;

      if (message === "" && confirmationId === undefined) {
        response.status(400).json({
          error: {
            message: "Body must be { user: string, message: string }.",
            recovery:
              'curl -s -X POST localhost:8080/chat -H "content-type: application/json" ' +
              '-d \'{"user":"alice","message":"Where is my order ORD-101?"}\'',
          },
        });
        return;
      }

      const session: Session = { user: customer.user, email: customer.email };

      const confirmation =
        confirmationId === undefined
          ? undefined
          : {
              id: confirmationId,
              args:
                typeof body?.confirmArgs === "object" && body.confirmArgs !== null
                  ? (body.confirmArgs as Record<string, unknown>)
                  : undefined,
            };

      try {
        response.json(await deps.agent.chat(message, session, confirmation));
      } catch (error) {
        // A failure should say what to try next, not only that it failed.
        response.status(502).json({
          error: {
            message: (error as Error).message,
            recovery: "Check the model credentials, then retry the same request.",
          },
        });
      }
    },
  };
}
```

**How it works, block by block — `chatController`**

| Block | What it does and why |
| :--- | :--- |
| `chatController(deps: { agent: Agent })` | The factory pattern: the controller receives its dependency rather than importing a singleton. That is what lets the CLI and the HTTP surface share one `Agent` — and it is why the audit log and the confirmation store are consistent across both. |
| `const body = request.body as { … } \| undefined` | The body is typed as **all `unknown`**. Every field is then narrowed with `typeof`. A controller that trusted `body.message` to be a string would be one request away from a crash, and Chapter 08 §8.4's "validate at the boundary" applies to the HTTP boundary too. |
| `const customer = CUSTOMERS.find((entry) => entry.user === user)` | **The session lookup, and the security decision of this file.** The `user` field stands in for an authenticated session; in a real deployment it comes from a verified token. What matters is the direction of the lookup: the server resolves the user, and everything downstream receives a `Session` the client could not fabricate. |
| `if (customer === undefined) → 401` | An unknown user is **401 Unauthorized**, not 400 and not a silent fallback to a default user. A default user is how "the assistant answered as somebody else" becomes a production incident. |
| The 401's `recovery` field | It contains a working `curl` command. An error that tells you what to try next is worth more than an error that tells you what went wrong — the same principle as the 404 in `routes/index.ts`. |
| `if (message === "" && confirmationId === undefined) → 400` | Two valid request shapes: a question, or a confirmation. Both empty is a malformed request, and the `&&` is what stops a confirmation-only request from being rejected for having no message. |
| `const session: Session = { user: customer.user, email: customer.email }` | Built from the **server's** record, with the email coming from `CUSTOMERS` rather than from the body. `sendEmail`'s allowlist is on the *recipient*, so a forged session email would not directly help — but the principle is the one that matters: nothing in this object came from the client except the key it was looked up by. |
| `typeof body?.confirmArgs === "object" && body.confirmArgs !== null` | `typeof null === "object"` in JavaScript, so the null check is required, not defensive noise. Without it, `confirmArgs: null` would be cast to `Record<string, unknown>` and reach `confirm()` as a real (empty) argument set. |
| `await deps.agent.chat(message, session, confirmation)` | The controller's entire job: three arguments in, a `ChatResult` out. No guardrail runs here, no policy decision is made here, and no tool is called here. |
| `response.json(await …)` | The result — answer **and** trace — goes back as JSON. Chapter 02 §2.8: the answer is the claim and the trace is the evidence, and the surface returns both. In production the trace would go to a sink instead; the guide's README notes that as a one-line change. |
| `catch → 502` with a `recovery` | An upstream failure is 502, and the message is the real error. A model that is unreachable is not the client's fault, and the status code should say so. |

---

## `src/controllers/securityController.ts` — the full file

```ts
import type { Request, Response } from "express";
import { appVersion, config } from "../config/config.js";
import { ASSET_CLASSES, GUARDRAIL_LAYERS, TOOL_TIERS } from "../domain/types.js";
import { auditLog, summarise } from "../services/audit.js";
import { CAPABILITY_MAP } from "../services/router.js";
import type { createScenarios } from "../services/scenarios.js";
import { TOOLS } from "../services/tools.js";

type Scenarios = ReturnType<typeof createScenarios>;

/**
 * Chapter 09 §9.10 — the security model, served as data.
 *
 * The point of this controller is that the security model is *inspectable*.
 * Chapter 09 §9.10 asks for a core model you can state in a sentence and review
 * as a whole; the cheapest way to make that true is to have the application
 * describe itself, so that "what can this agent reach?" is a request rather than
 * an archaeology exercise across five files.
 */
export function securityController(deps: { scenarios: Scenarios }) {
  return {
    index: (_request: Request, response: Response): void => {
      response.json({
        application: appVersion(),
        routes: [
          "POST /chat                        { user, message, confirmationId?, confirmArgs? }",
          "GET  /security                    the guardrails, tool tiers and capability map",
          "GET  /audit                       the recent traces, with what each layer did",
          "GET  /scenarios                   the eight attacks this project can run",
          "POST /attack/:scenario            run one attack and see the verdict",
        ],
      });
    },

    security: (_request: Request, response: Response): void => {
      response.json({
        principle:
          "The LLM can propose an action. It should never be the authority that decides whether the action is permitted.",
        assetClasses: ASSET_CLASSES,
        guardrailLayers: GUARDRAIL_LAYERS,
        guardrailsEnabled: config.guardrails,
        toolTiers: TOOL_TIERS,
        /** Chapter 07 §7.4 — intent to capability. Nothing else grants privileges. */
        capabilities: CAPABILITY_MAP,
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          tier: tool.tier,
          asset: tool.asset,
          schema: tool.schema,
          rowScoped: tool.rowScoped,
        })),
        limits: {
          topK: config.topK,
          autoApproveLimit: config.autoApproveLimit,
          maxToolCalls: config.maxToolCalls,
        },
      });
    },

    audit: (_request: Request, response: Response): void => {
      response.json({
        count: auditLog.length,
        entries: auditLog.map((trace) => ({
          requestId: trace.requestId,
          user: trace.user,
          question: trace.question,
          capabilities: trace.capabilities,
          retrieved: trace.retrieved,
          guardrails: trace.guardrails,
          toolCalls: trace.toolCalls,
          canaryLeaked: trace.canaryLeaked,
          refused: trace.refused,
          answer: trace.answer,
        })),
      });
    },

    scenarios: (_request: Request, response: Response): void => {
      response.json({
        scenarios: deps.scenarios.list.map(({ id, asset, user, question, forbidden, teaches }) => ({
          id,
          asset,
          user,
          question,
          forbidden,
          teaches,
        })),
      });
    },

    attack: async (request: Request, response: Response): Promise<void> => {
      const id = String(request.params.scenario ?? "");

      try {
        const outcome = await deps.scenarios.run(id);

        // Chapter 09 §9.13 — the status code is the verdict, so CI can read it
        // without parsing prose. A forbidden effect is a failed security test.
        response.status(outcome.violated.length === 0 ? 200 : 500).json({
          scenario: outcome.scenario.id,
          teaches: outcome.scenario.teaches,
          note: outcome.note,
          verdict: outcome.violated.length === 0 ? "contained" : "VIOLATED",
          violated: outcome.violated,
          effects: outcome.effects,
          answer: outcome.result.answer,
          trace: outcome.result.trace,
          summary: summarise(outcome.result.trace),
        });
      } catch (error) {
        response.status(404).json({
          error: {
            message: (error as Error).message,
            recovery: "Call GET /scenarios for the list of attack ids.",
          },
        });
      }
    },
  };
}
```

**How it works, block by block — `securityController`**

| Block | What it does and why |
| :--- | :--- |
| `type Scenarios = ReturnType<typeof createScenarios>` | Derives the dependency's type from the factory, so the controller cannot drift from `scenarios.ts`. No hand-written interface to keep in sync — the compiler does it. |
| `index` — `appVersion()` | Chapter 02 §2.8. The first thing any client sees is which configuration is running. |
| `index` — the `routes` array | A plain list of strings rather than router introspection. The list is documentation, and documentation that lives next to the routes is documentation that gets updated. |
| `security` — `principle` | **The lecture's thesis, served as a field.** `"The LLM can propose an action. It should never be the authority that decides whether the action is permitted."` It is in the API because a security model nobody can state is a security model nobody can review. |
| `security` — `ASSET_CLASSES`, `GUARDRAIL_LAYERS`, `TOOL_TIERS` | The three `as const` arrays from `domain/types.ts`, served straight. This is why they are arrays rather than bare union types: the runtime value and the type are the same fact. |
| `security` — `guardrailsEnabled: config.guardrails` | The live switch state. The single most useful field for a reviewer: it answers "which layers were on when this happened?" without reading `.env`. |
| `security` — `capabilities: CAPABILITY_MAP` | Chapter 07 §7.4's whole policy, in one response. "What can this agent reach?" is now a request rather than an archaeology exercise across five files. |
| `security` — `tools.map(...)` and `limits` | The tool metadata (tier, asset, schema, rowScoped) and the three numeric limits. Together with the capabilities, this is a complete answer to "what is the blast radius of this deployment?" |
| `audit` — the explicit field list | The trace is copied field by field rather than spread wholesale. That is deliberate: a spread would leak any future internal field onto a public route, and an allowlist of fields is the same instinct as `validateArguments`'s unknown-field refusal. |
| `scenarios` — destructuring the table | The endpoint serves the table's *declarative* fields and **not** `override` or `confirmWith`. A caller can read what an attack does; it cannot use the endpoint to flip a guardrail off. The read-only projection is the security boundary of this route. |
| `attack` — `String(request.params.scenario ?? "")` | Express 5 types `params` loosely, so the coercion keeps `strict` happy. An empty id fails the lookup and produces a 404 with a recovery hint. |
| `attack` — `deps.scenarios.run(id)` | **The same runner the CLI uses.** Not a reimplementation, not a parallel code path: the identical function, with the identical fixture reset and the identical `finally` restore. This is what makes `POST /attack/:id` evidence rather than a demo. |
| `response.status(outcome.violated.length === 0 ? 200 : 500)` | Chapter 09 §9.13, and the neatest idea in the file. **The HTTP status code is the verdict** — 200 for contained, 500 for VIOLATED — so anything that can read a status code can gate on it: CI, a monitor, a smoke test, `curl -f`. |
| `catch → 404` | An unknown scenario id is a client error, not a server error. The `recovery` field points at `GET /scenarios`, so the next request can be correct. |

---

## `src/routes/index.ts` — the full file

```ts
import express, { type Express, type Request, type Response } from "express";
import { chatController } from "../controllers/chatController.js";
import { securityController } from "../controllers/securityController.js";
import { requestContext } from "../middleware/requestContext.js";
import { Agent } from "../services/agent.js";
import { createModel } from "../services/model.js";
import { createScenarios } from "../services/scenarios.js";

/**
 * Chapter 06 §6.2 — the route table.
 *
 * Six lines of routing and no security logic at all, which is the layering: the
 * loop lives in `services/agent.ts`, the rules live in `services/policy.ts`, and
 * a route is a path plus a method.
 *
 * The wiring above the routes is where the two decisions Chapter 07 §7.4 and
 * Chapter 02 §2.8 ask to be made in exactly one place are made: which model, and
 * which agent every surface shares.
 */

// One agent per process, so the audit log and the confirmation store are shared
// by the CLI, the HTTP surface and the attack endpoints.
const agent = new Agent(createModel());
const scenarios = createScenarios({ agent });

const chat = chatController({ agent });
const security = securityController({ scenarios });

export const app: Express = express();

// Express advertises itself by default, and a server that answers strangers
// should not volunteer its stack.
app.disable("x-powered-by");

app.use(requestContext);

// Chapter 09 §9.4 — a request size limit, before anything reads the body. The
// input guardrail has a length rule too; this one runs earlier and costs less,
// because a payload that is never parsed is never a payload.
app.use(express.json({ limit: "16kb" }));

app.get("/", security.index);
app.post("/chat", chat.chat);
app.get("/security", security.security);
app.get("/audit", security.audit);
app.get("/scenarios", security.scenarios);
app.post("/attack/:scenario", security.attack);

/**
 * The 404, registered *after* every route — the same shape as a refusal: it
 * says what to try next instead of only saying no.
 */
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});
```

**How it works, block by block — the routes**

| Block | What it does and why |
| :--- | :--- |
| `const agent = new Agent(createModel())` | **The single wiring decision.** One agent per process, so the audit log, the confirmation store and the fixtures are shared by every surface. Two agents would mean `POST /attack/:id` and `GET /audit` describing different worlds. |
| `createScenarios({ agent })` | The same agent, handed to the runner. This is the line that makes the HTTP attack endpoint and `npm run demo` the *same* code path. |
| `app.disable("x-powered-by")` | One line, and a real hardening step: a server that answers strangers should not volunteer its stack. It costs nothing and removes a fingerprinting signal. |
| `app.use(requestContext)` | The request id, before anything else, so every log line and every trace is joinable. Chapter 09 §9.13's precondition. |
| `express.json({ limit: "16kb" })` | Chapter 09 §9.4's size limit, and note *where*: before the route, so a payload that is never parsed is never a payload. The input guardrail's 2,000-character rule is a second, later net; this one costs almost nothing and runs first. Defence in depth is also depth in *order*. |
| The six routes | Path plus method plus a controller function. Nothing else: no inline guardrail, no `if (user)`, no tool call. Every rule this system has is enforced in `services/`, which is why the CLI can exercise all of it. |
| `POST /attack/:scenario` | The one route that changes state (it runs an attack), and it is a `POST` for exactly that reason. A `GET` that executed a scenario would be a cross-site request forgery waiting to happen. |
| The 404 handler, registered **after** the routes | Express matches middleware in order, so a 404 registered last only fires when nothing else matched. Placing it first is the classic bug: every request 404s. |
| The 404's `recovery` field | It points at `GET /` — the same "say what to try next" shape as a policy refusal and a confirmation mismatch. A consistent error shape across a system is what makes it operable. |

---

## `src/index.ts` — the full file

```ts
#!/usr/bin/env node
import { config } from "./config/config.js";
import { app } from "./routes/index.js";

/**
 * Chapter 06 §6.2 — the entry point.
 *
 * Everything interesting is somewhere else: the routes are in `routes/`, the
 * loop is in `services/agent.ts`, the rules are in `services/policy.ts`. This
 * file binds a port and says so.
 *
 * That separation is not decoration. It is what lets `npm run demo` reuse the
 * exact same agent with **no HTTP at all**, which matters because a security
 * test that needs a running server is a security test that runs less often.
 */
const server = app.listen(config.port, config.host, () => {
  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  console.error(`[lecture-19-security] listening on http://${config.host}:${config.port}`);
  console.error(`  try: curl -s http://${config.host}:${config.port}/security`);
  console.error(
    `  and: curl -s -X POST http://${config.host}:${config.port}/chat ` +
      `-H 'content-type: application/json' ` +
      `-d '{"user":"alice","message":"I want a refund for my order ORD-101."}'`,
  );
  console.error(`  and: curl -s -X POST http://${config.host}:${config.port}/attack/indirect-no-filter`);
  console.error(`  and: npm run demo`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}
```

**How it works, block by block — the entry point**

| Block | What it does and why |
| :--- | :--- |
| `import { app } from "./routes/index.js"` | The entry imports the *assembled* app, so `index.ts` knows nothing about agents, controllers or models. All the wiring happened in `routes/`. |
| `app.listen(config.port, config.host, …)` | Binds to `127.0.0.1` by default rather than `0.0.0.0`. A development server for a project about security should not be listening on every interface. |
| The `console.error` startup banner | It prints four working `curl` commands and `npm run demo`. The first thing a reader sees is how to see something — the same instinct as the `recovery` fields in the error responses. |
| `console.error`, not `console.log` | Diagnostics to **stderr**, so `stdout` stays free. That is what lets `npm run demo > report.txt` produce a clean file even while a server is logging. |
| `for (const signal of ["SIGINT", "SIGTERM"] as const)` | Graceful shutdown on both signals, so a `Ctrl-C` or a container stop closes the listener rather than leaving a port bound. In a project with an audit log, a clean shutdown is also what lets an in-flight request finish writing its trace. |

---

## Checkpoint

Before you finish, you should be able to answer:

1. Why does `chatController` type the whole body as `unknown` and narrow every
   field?
2. Where is the session built, and why does that matter more than the shape of the
   session object?
3. Why does `GET /security` exist? What question does it answer in one request?
4. Why does the `scenarios` endpoint omit `override` and `confirmWith`?
5. Why is `POST /attack/:scenario` a `POST`?
6. Why does the HTTP status code of `/attack/:id` carry the verdict?
7. Why is there no security logic in `controllers/` or `routes/`?

---

## Where to go next

You have now read every line of the project. Two things are worth doing next, in
this order:

1. **Break it on purpose.** Set `GUARDRAIL_ACTIONS=false` and run `npm run demo`.
   Set `GUARDRAIL_OUTPUT=false` and watch the canary leave. Then read the README's
   "What this project deliberately does not do" table and decide which of those
   omissions you would not ship without.
2. **Write the ninth scenario.** Add a case to `SCENARIOS` that you think this
   system should contain, and see whether the architecture holds. If it needs a
   change to `agent.ts` rather than a new row in the table, that is worth knowing —
   and it is the same test Chapter 09 §9.13 asks you to apply to a real deployment.

---

**Back to:** [Guide index](./README.md) · [Basic Code README](../README.md)
