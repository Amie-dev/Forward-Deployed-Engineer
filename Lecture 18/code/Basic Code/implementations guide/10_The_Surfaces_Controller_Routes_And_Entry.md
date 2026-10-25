# Chapter 10 — The Surfaces — Controllers, Routes and Entry

> **The HTTP boundary, and nothing else.** Chapter 02 §2.4 of the notes treats the route table as
> the thing that makes the loop reachable. These four files are that boundary: read a request, call a
> service, shape a response.
>
> There is no evaluation logic anywhere in this chapter. That is the test of whether the layering
> worked — and it did, because `npm run eval` gates a release without any of this code running.

---

## File details

| | `controllers/chatController.ts` | `controllers/evalController.ts` | `routes/index.ts` | `index.ts` |
|---|---|---|---|---|
| **Lines** | 47 | 100 | 48 | 31 |
| **Purpose** | `POST /chat` — the application under test | `GET /`, `/dataset`, `/eval` | the route table, and the 404 | bind a port |
| **Exports** | `chatController()` | `evalController()` | `app` | — (a script) |
| **Notes sections** | Ch02 §2.1, Ch03 §3.3 | Ch04 §4.3–4.4, Ch07 §7.1 | Ch02 §2.4 | Ch02 §2.4, Ch08 §8.5 |

**Two controllers rather than one.** They are two *surfaces* with two audiences: `chatController` is
the product (what a customer hits), and `evalController` is the test harness (what a developer or CI
hits). Merging them would mean shipping eval endpoints on the product surface.

---

## Commands

```bash
npm start
```

```bash
# Chapter 02 §2.1 — the product surface: an answer, and its trace.
curl -s -X POST http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"message":"Where is ORD-101?"}' | python3 -m json.tool

# Chapter 04 §4.3 — the eval surface: the specification, readable without running anything.
curl -s http://127.0.0.1:8080/dataset | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["coverage"])'

# Chapter 07 §7.1 — and the whole pipeline on demand.
curl -s http://127.0.0.1:8080/eval | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["gate"], d["passRate"])'
```

```bash
# the error surfaces
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/chat \
  -H 'content-type: application/json' -d '{}'          # 400 — message is required
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/nope   # 404 — no such route
```

---

## `src/controllers/chatController.ts` — the full file

```ts
import type { Request, Response } from "express";
import type { SupportAgent } from "../services/supportAgent.js";

/**
 * Chapter 02 §2.1 — the application's HTTP surface.
 *
 * Look at what it returns: the answer **and** the trace. Chapter 03 §3.3 calls the
 * trace "the second output of every request", and this is where that decision
 * becomes visible in the code.
 *
 * In production the trace would go to a log sink rather than into the response
 * body — Chapter 03 §3.8: exposing it to end users leaks internal ids, prompts and
 * tool arguments. It is in the body here because, for this project, the trace *is*
 * the lesson.
 */
export function chatController(deps: { agent: SupportAgent }) {
  return {
    chat: async (request: Request, response: Response): Promise<void> => {
      const body = request.body as { message?: unknown } | undefined;
      const message = typeof body?.message === "string" ? body.message.trim() : "";

      if (message === "") {
        response.status(400).json({
          error: {
            message: "Body must be { message: string }.",
            recovery:
              'curl -s -X POST localhost:8080/chat -H "content-type: application/json" ' +
              '-d \'{"message":"Where is ORD-101?"}\'',
          },
        });
        return;
      }

      try {
        response.json(await deps.agent.chat(message));
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

### Block-by-block

**Block 1 — a factory, not a module-level object.**

```ts
export function chatController(deps: { agent: SupportAgent }) {
  return { chat: async (request, response) => { … } };
}
```

The controller is a *function that takes its dependencies* and returns handlers. Three consequences:

| Style | Consequence |
| :--- | :--- |
| a module-level `export const chat = …` that imports the agent directly | the controller and the agent are welded together; there is no seam to substitute |
| **a factory taking `deps`** | `routes/index.ts` constructs the agent once and passes it in; a test could pass a different one |

It also makes the dependency *visible in the signature*. A reader of `routes/index.ts` can see
exactly what `POST /chat` needs in order to work, without opening the file.

**Block 2 — validating `{ message }`.**

```ts
const body = request.body as { message?: unknown } | undefined;
const message = typeof body?.message === "string" ? body.message.trim() : "";

if (message === "") { … 400 … }
```

Three defensive steps, each answering a real request:

| Step | Handles |
| :--- | :--- |
| `as { message?: unknown } \| undefined` | `express.json()` leaves `body` as `{}` for an empty body, and `undefined` if the middleware never ran |
| `typeof … === "string"` | `{"message": 42}` or `{"message": {"a":1}}` — the shape is not assumed |
| `.trim()` | `{"message": "   "}` is an empty message, and an empty message is a 400, not a request the agent should see |

Chapter 06 §6.5's "a structured request is easier to validate than a prose one" is the reason this is
a JSON body rather than a query parameter: the contract is checkable in three lines, and it *fails
loudly* rather than being passed through as a strange prompt.

**Block 3 — the error object, with `recovery`.**

```ts
response.status(400).json({
  error: {
    message: "Body must be { message: string }.",
    recovery: 'curl -s -X POST localhost:8080/chat -H "content-type: application/json" -d \'{"message":"Where is ORD-101?"}\'',
  },
});
```

Every error in this project carries a `recovery` field, and the 400's is a **runnable curl command**.
That is not politeness; it is the same principle as the report's `expected=X actual=Y`:

> **A failure should carry the next action, not just the diagnosis.**

The 404 in `routes/index.ts` does the same thing (`"Call GET / for the index of available routes."`),
and so does the release gate (`GATE BLOCKED` plus itemised reasons).

**Block 4 — returning the agent's whole response.**

```ts
response.json(await deps.agent.chat(message));
```

One line, and it returns `AgentResponse` in full — answer *and* trace. Chapter 03 §3.3's "the second
output of every request" is realised here: the trace is not a log line, it is part of the contract.

The comment is explicit about the production caveat, because the difference matters: Chapter 03 §3.8
lists *"exposing the trace to end users leaks internal ids, prompts and tool arguments"* as a
mistake. In a real deployment this line would become `response.json({ answer })` plus a log call —
and the eval would read the trace from the sink instead of the body.

**Block 5 — the `try`/`catch`, and the 502.**

```ts
try {
  response.json(await deps.agent.chat(message));
} catch (error) {
  response.status(502).json({ error: { message: (error as Error).message, recovery: "…" } });
}
```

`502 Bad Gateway`, not `500`. The distinction is deliberate and it is the same one from Chapter 04:
the agent's *own* failures are results it should report; what reaches this `catch` is a failure of a
**dependency** — the model refused, the network dropped, the tool contract was broken. That is what
502 means, and using it tells whoever is reading the logs where to look.

`(error as Error).message` surfaces the dependency's message verbatim. That is safe here because the
messages in this project are written for humans ("The model requested a tool after the tool-call
budget was spent"), and it is the difference between a 502 you can act on and a 502 you have to
reproduce.

---

## `src/controllers/evalController.ts` — the full file

```ts
import type { Request, Response } from "express";
import { dataset } from "../domain/dataset.js";
import { METRICS, type Category } from "../domain/types.js";
import { runDataset } from "../services/pipeline.js";
import { buildReport } from "../services/report.js";

/**
 * Chapter 08 §8.5 — the eval surface.
 *
 * Every route maps to a chapter, and none of them contains evaluation logic: the
 * pipeline is in `services/`, and a route is a path plus a method. That separation
 * is what lets `npm run eval` reuse exactly the same services with no HTTP at all
 * — which is the point, because the offline run is the one that gates a release.
 */
export function evalController() {
  return {
    /** What this is, and what you can ask it. */
    index: (_request: Request, response: Response): void => {
      response.json({
        lecture: "Lecture 18 — AI Application Testing: Deterministic Evals & LLM-as-a-Judge",
        dataset: { app: dataset.app, revision: dataset.revision, cases: dataset.cases.length },
        metrics: METRICS,
        routes: [
          {
            method: "POST",
            path: "/chat",
            chapter: "02–03",
            description: "run the application once; returns the answer and the trace",
          },
          {
            method: "GET",
            path: "/dataset",
            chapter: "04",
            description: "the golden dataset — the definition of correct behaviour",
          },
          {
            method: "GET",
            path: "/eval",
            chapter: "05–08",
            description: "the four-layer pipeline over the whole dataset, plus the release gate",
          },
        ],
      });
    },

    /**
     * Chapter 04 §4.3 — the dataset is a specification, so it is worth reading
     * without running anything.
     *
     * The coverage block counts cases per category, and Chapter 04 §4.4 is why it
     * is computed against the categories the application *promises* (`A`, `B`, `C`)
     * rather than against the cases that happen to exist. Counting what you have
     * can never report a gap.
     */
    dataset: (_request: Request, response: Response): void => {
      const categories: Category[] = ["A", "B", "C"];

      response.json({
        revision: dataset.revision,
        app: dataset.app,
        cases: dataset.cases,
        coverage: categories.map((category) => ({
          category,
          cases: dataset.cases.filter((evalCase) => evalCase.category === category).length,
        })),
      });
    },

    /**
     * Chapter 07 §7.1 — the whole pipeline, over the whole dataset.
     *
     * The HTTP status is always 200: the *gate* is a verdict, not a transport
     * error, and it is reported in the body. CI reads the CLI's exit code
     * (Chapter 08 §8.6), which is the only place a release is decided.
     */
    evaluate: async (_request: Request, response: Response): Promise<void> => {
      const results = await runDataset();
      const report = buildReport(results);

      response.json({
        ...report,
        // Chapter 02 §2.8 — per-case results are what make a report actionable.
        // A number you cannot open is a number you cannot fix.
        cases: results.map((result) => ({
          id: result.caseId,
          category: result.category,
          question: result.question,
          passed: result.passed,
          answer: result.response.answer,
          retrievedDocuments: result.response.retrievedDocuments,
          toolsUsed: result.response.toolsUsed,
          toolArguments: result.response.toolArguments,
          failedChecks: result.checks.filter((check) => !check.passed),
          quality: result.quality,
          thresholdFailures: result.thresholdFailures,
        })),
      });
    },
  };
}
```

### Block-by-block

**Block 1 — no `deps`, and why that is correct here.**

```ts
export function evalController() {
  return { … };
}
```

`chatController` takes a `SupportAgent`; `evalController` takes nothing. That asymmetry is
informative: the eval surface holds no long-lived agent, because `runDataset()` builds its own per
run (Chapter 08). Each `GET /eval` therefore starts from a clean state — no accumulated tool calls,
no stale model client.

The factory form is kept anyway, for symmetry with `chatController` and because a future parameter
(which dataset revision to run) would slot in without changing the call site.

**Block 2 — `GET /` as a self-describing index.**

```ts
routes: [
  { method: "POST", path: "/chat", chapter: "02–03", description: "…" },
  { method: "GET", path: "/dataset", chapter: "04", description: "…" },
  { method: "GET", path: "/eval", chapter: "05–08", description: "…" },
],
```

Every route carries the **notes chapter** it demonstrates. That is engineering etiquette with a real
payoff: a reader who lands on this API with no context gets a map from the running system back to the
reasoning behind it.

It also makes the surface self-checking. If a route is added without a chapter, the omission is
visible in `GET /` — and a route that cannot be traced to a requirement is a route worth questioning.

**Block 3 — the coverage calculation.**

```ts
const categories: Category[] = ["A", "B", "C"];

coverage: categories.map((category) => ({
  category,
  cases: dataset.cases.filter((evalCase) => evalCase.category === category).length,
})),
```

The iteration is over the **promised categories**, not over the cases present. That is the entire
point of the block, and it is Chapter 04 §4.4's lesson in code:

| Iterating over | A missing capability reports |
| :--- | :--- |
| `dataset.cases` | nothing — you only ever see categories you already have |
| **`["A", "B", "C"]`** | `{ category: "C", cases: 0 }` — a visible gap |

The two loops look interchangeable and are not. Counting what you have can never report what you are
missing, which is why the literal list is annotated `Category[]` — so the compiler catches a promised
category that is never counted.

**Block 4 — the `/eval` response, and why the status is always 200.**

```ts
const results = await runDataset();
const report = buildReport(results);
response.json({ ...report, cases: results.map(…) });
```

`response.json(…)` with no `.status(…)` — so a blocked gate is a **200**. That is deliberate, and it
is the cleanest expression of this chapter's central distinction:

| | Transport layer | Verdict layer |
| :--- | :--- | :--- |
| Question | did the request succeed? | did the system pass? |
| Signalled by | HTTP status | `gate.blocked` in the body |
| Read by | the HTTP client | CI, from `cli.ts`'s exit code |

A blocked gate is a *successful* eval reporting bad news. Conflating the two — returning 500 when the
gate blocks — makes it impossible to tell "the eval ran and the system failed" from "the eval itself
broke", which is the first distinction anyone debugging needs.

**Block 5 — the per-case projection.**

```ts
cases: results.map((result) => ({
  id: result.caseId, category, question, passed,
  answer: result.response.answer,
  retrievedDocuments: result.response.retrievedDocuments,
  toolsUsed: result.response.toolsUsed,
  toolArguments: result.response.toolArguments,
  failedChecks: result.checks.filter((check) => !check.passed),
  quality: result.quality,
  thresholdFailures: result.thresholdFailures,
})),
```

Eleven fields per case, and every one is a *different* answer to "why did this fail?":

| Field | Answers |
| :--- | :--- |
| `answer` | what the user would have seen |
| `retrievedDocuments` | did retrieval happen, and return the right thing? |
| `toolsUsed` / `toolArguments` | was the right tool called with the right argument? |
| `failedChecks` | which deterministic assertions broke, with expected/actual |
| `quality` | the five scores **and the reason** |
| `thresholdFailures` | which thresholds were missed, and by how much |

`failedChecks` is filtered here rather than in the client, because the *passing* checks are already
summarised by `deterministicPassRate`. What a reader needs per case is the failures — and filtering
server-side keeps the payload focused on the thing being debugged.

Note that `quality` is included **in full**, including `reason`. A score without its reason is
unarguable, and an unarguable score is one nobody acts on (Chapter 06 §6.5).

---

## `src/routes/index.ts` — the full file

```ts
import express, { type Express, type Request, type Response } from "express";
import { chatController } from "../controllers/chatController.js";
import { evalController } from "../controllers/evalController.js";
import { requestContext } from "../middleware/requestContext.js";
import { createModel } from "../services/model.js";
import { SupportAgent } from "../services/supportAgent.js";

/**
 * Chapter 02 §2.4 — the route table.
 *
 * Four lines of routing and no evaluation logic at all. That is the layering: the
 * agent lives in `services/supportAgent.ts`, the pipeline in `services/pipeline.ts`,
 * and a route is a path plus a method.
 */

// One agent per process. The model client is chosen here — and nowhere else.
const chat = chatController({ agent: new SupportAgent(createModel()) });
const evals = evalController();

export const app: Express = express();

// Express advertises itself by default, and a server that answers strangers
// should not volunteer its stack.
app.disable("x-powered-by");

app.use(requestContext);

// Needed for POST /chat. Chapter 06 §6.5's point applies to the wire too: a
// structured request is easier to validate than a prose one.
app.use(express.json());

app.get("/", evals.index);
app.post("/chat", chat.chat);
app.get("/dataset", evals.dataset);
app.get("/eval", evals.evaluate);

/**
 * The 404, registered *after* every route — the same shape as the release gate:
 * a failure should tell you what to try next.
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

### Block-by-block

**Block 1 — the composition root.**

```ts
const chat = chatController({ agent: new SupportAgent(createModel()) });
const evals = evalController();
```

This is where the object graph is built, and it is the *only* place. `createModel()` picks the
instrument, `new SupportAgent(…)` wraps it, `chatController({ agent })` exposes it over HTTP. A
reader can see the whole wiring in two lines.

The alternative — each module importing what it needs — would spread the wiring across the codebase
and make the model choice unfindable. The comment makes the claim explicit: *"The model client is
chosen here — and nowhere else."*

**Block 2 — `app.disable("x-powered-by")`.**

```ts
app.disable("x-powered-by");
```

One line, and it removes the `X-Powered-By: Express` response header. A server that answers strangers
should not volunteer its stack: the header is free reconnaissance for anyone looking for a known
Express vulnerability. It costs nothing to remove and there is no reason to keep it.

**Block 3 — the middleware order.**

```ts
app.use(requestContext);
app.use(express.json());
```

Order matters, and the reason is concrete: `requestContext` is registered **first** so its `finish`
listener is attached before anything can throw. A request rejected by the JSON body parser still gets
a trace id and a log line — which is exactly the request you would otherwise have no record of.

`express.json()` comes second because only `POST /chat` needs it, and parsing every body is work the
`GET` routes should not pay for.

**Block 4 — the route table.**

```ts
app.get("/", evals.index);
app.post("/chat", chat.chat);
app.get("/dataset", evals.dataset);
app.get("/eval", evals.evaluate);
```

Four routes, four lines, and no logic. Note that the handler is *named* — `chat.chat`, `evals.index` —
rather than written inline as an arrow function. That keeps the routing table readable as a table, and
it means the handlers are testable without going through Express.

The method choice carries meaning too: `/chat` is a **POST** because it takes a body (a structured
request, per Chapter 06 §6.5's principle), while the eval routes are **GET**s because they take no
input and are safe to call repeatedly.

**Block 5 — the 404, and `app.use` as a catch-all.**

```ts
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});
```

Registered with `app.use` rather than `app.get`, so it catches **every** method and path. And
registered **last**, which is what makes it a fallback rather than a blocker — Express runs middleware
in registration order, so a 404 placed before the routes would swallow everything.

The body follows the same shape as the 400 in `chatController`: a `message` that names what was
requested, and a `recovery` that says what to try instead. Chapter 08 §8.6's gate has the same shape
for the same reason — **a failure should carry the next action.**

---

## `src/index.ts` — the full file

```ts
#!/usr/bin/env node
import { config } from "./config/config.js";
import { app } from "./routes/index.js";

/**
 * Chapter 02 §2.4 — the entry point.
 *
 * Everything interesting is somewhere else: the routes are in `routes/`, the agent
 * is in `services/`, and the dataset is in `domain/`. This file binds a port and
 * says so.
 *
 * That separation is not decoration. It is what lets `npm run eval` reuse the exact
 * same services with **no HTTP at all** — which is Chapter 08 §8.5's point: the
 * offline run is the one that gates a release, and it should not need a server.
 */
const server = app.listen(config.port, config.host, () => {
  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  console.error(`[lecture-18-testing] listening on http://${config.host}:${config.port}`);
  console.error(
    `  try: curl -s -X POST http://${config.host}:${config.port}/chat ` +
      `-H 'content-type: application/json' -d '{"message":"Where is ORD-101?"}'`,
  );
  console.error(`  and: curl -s http://${config.host}:${config.port}/eval`);
  console.error(`  and: npm run eval`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}
```

### Block-by-block

**Block 1 — `app.listen`, and a startup message that teaches.**

```ts
const server = app.listen(config.port, config.host, () => {
  console.error(`[lecture-18-testing] listening on http://${config.host}:${config.port}`);
  console.error(`  try: curl -s -X POST http://${config.host}:${config.port}/chat …`);
  console.error(`  and: curl -s http://${config.host}:${config.port}/eval`);
  console.error(`  and: npm run eval`);
});
```

The banner prints three runnable commands. That is the same principle as the 404's `recovery` field
and the 400's curl example, applied to startup: **the system tells you how to use it.**

`console.error` rather than `console.log`, for the reason established in Chapter 04 — stdout stays
free for program output. On a server there is no report on stdout, but keeping the convention means
`npm start | something` behaves predictably.

**Block 2 — graceful shutdown, and the two signals.**

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}
```

Two signals because they arrive from different places: `SIGINT` is Ctrl-C in a terminal, `SIGTERM` is
what Docker, Kubernetes and `systemd` send when they want a process to stop. Handling only one means
the container runtime eventually has to `SIGKILL`, which drops in-flight requests.

`server.close()` stops accepting new connections and lets existing ones finish. The `as const` on the
array is what makes the loop's `signal` the union `"SIGINT" | "SIGTERM"` rather than `string` — which
is what `process.on` requires.

There is deliberately **no** `process.exit()` here. Once the server is closed and the event loop is
empty, Node exits on its own with code 0 — the correct outcome for a requested shutdown. (Contrast
Chapter 09's `cli.ts`, which sets `process.exitCode` for the same reason: never cut off buffered
output.)

**Block 3 — what this file is not.**

Two imports, one `listen`, one shutdown loop. The comment says it plainly: *"this file binds a port
and says so."*

That is the end state the whole project aimed at. Every behaviour worth testing lives in `services/`;
every specification lives in `domain/`; every threshold lives in `config/`. What is left here is the
one thing that genuinely cannot be tested offline — binding a socket — which is exactly the right
amount of untestable code.

---

## Checkpoint

1. **Why are there two controllers rather than one?**
   Two surfaces with two audiences: `chatController` is the product (what a customer hits) and
   `evalController` is the harness (what a developer or CI hits). Merging them would ship eval
   endpoints on the product surface.

2. **Why is a blocked gate a 200 rather than a 500?**
   Because the eval *succeeded* and reported bad news. Conflating "the eval ran and the system failed"
   with "the eval itself broke" removes the first distinction anyone debugging needs. CI reads the exit
   code, not the status.

3. **Why is `requestContext` registered before `express.json()`?**
   So its `finish` listener is attached before anything can throw — a request rejected by the body
   parser still gets a trace id and a log line, which is exactly the request you would otherwise have
   no record of.

4. **Why is the 404 registered with `app.use` and placed last?**
   `app.use` catches every method and path; placing it last makes it a fallback rather than a blocker,
   since Express runs middleware in registration order.

5. **Why does `index.ts` have no `process.exit()` in its shutdown handler?**
   Because closing the server and letting the event loop drain produces a clean exit with code 0. A
   forced exit would cut off in-flight requests — the same reason `cli.ts` sets `process.exitCode`
   instead of calling `process.exit()`.

---

**Back to:** [Guide index](./README.md) · [Lecture 18 Basic Code README](../README.md) · [Lecture 18 notes](../../../notes/README.md)



