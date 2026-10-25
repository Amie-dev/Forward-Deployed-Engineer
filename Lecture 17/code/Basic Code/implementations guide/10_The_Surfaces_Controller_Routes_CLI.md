# Chapter 10 — The Surfaces: Controller, Routes, Entry Point, CLI

> **Two surfaces over one set of services.** The HTTP API is how a human explores the system; the CLI
> is how CI gates a commit. Neither contains evaluation logic, and that is the whole design.

---

## File details

| | `controllers/evalController.ts` | `routes/index.ts` | `index.ts` | `cli.ts` |
|---|---|---|---|---|
| **Lines** | 249 | 52 | 28 | 119 |
| **Layer** | HTTP | HTTP | entry | entry |
| **Purpose** | read a query string, call a service, shape the answer | the route table | bind a port | run the offline eval, set the exit code |
| **Exports** | `evalController()` | `app` | — | — |
| **Notes sections** | Ch02 §2.4 | Ch02 §2.4 | Ch09 §9.1 | Ch09 §9.1, Ch04 §4.8 |

**Why the CLI is not a thin wrapper around the HTTP API.** Because it must not need a server.
Chapter 09 §9.1's diagram has the offline run *blocking the release* — and a gate that requires booting
an app, waiting for a port, and curling itself is a gate that will be disabled the first time it flakes.
Both surfaces call the same `evaluateDataset`, so the gate and the endpoint can never disagree about
what "blocked" means.

---

## Commands

```bash
npm start &
curl -s http://127.0.0.1:8080/ | python3 -m json.tool          # the index
curl -s 'http://127.0.0.1:8080/eval?topk=1&baseline=3' | head -c 400
npm run eval --silent                                          # the same evaluation, no HTTP
```

---

## `src/controllers/evalController.ts` — the full file

```ts
import type { Request, Response } from "express";
import { config } from "../config/config.js";
import { coverageReport, dataset } from "../domain/dataset.js";
import type { Judge } from "../services/judge.js";
import type { OnlineMonitor } from "../services/online.js";
import { runApp } from "../services/app.js";
import {
  buildReport,
  casePassed,
  compareConfigurations,
  evaluateDataset,
  passingIds,
} from "../services/report.js";

/**
 * The HTTP surface.
 *
 * Every route maps to one chapter of the notes, and none of them contains
 * evaluation logic — the services do that. A controller's job here is to read a
 * query string, call a service, and shape the answer (Chapter 02 §2.4's loop,
 * made reachable).
 */

/**
 * Express types `request.query[key]` as `string | string[] | ParsedQs`. Every
 * route here wants one string or nothing, so the narrowing happens once.
 */
function query(request: Request, key: string): string | undefined {
  const value = request.query[key];

  return typeof value === "string" ? value : undefined;
}

/** A positive integer query parameter, or the fallback. */
function numberParam(request: Request, key: string, fallback: number): number {
  const raw = query(request, key);
  const value = raw === undefined ? fallback : Number(raw);

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function badRequest(response: Response, message: string, recovery: string): void {
  response.status(400).json({ error: { message, recovery } });
}

export function evalController(deps: { judge: Judge; online: OnlineMonitor }) {
  return {
    /** What this is, and what you can ask it. */
    index: (_request: Request, response: Response): void => {
      response.json({
        lecture: "Lecture 17 — GenAI Evals & Testing",
        dataset: { app: dataset.app, revision: dataset.revision, cases: dataset.cases.length },
        judge: deps.judge.version,
        retrievalTopK: config.topK,
        routes: [
          { method: "GET", path: "/ask?q=…&topk=3", chapter: "02", description: "run the system under test once and return the trace" },
          { method: "GET", path: "/dataset", chapter: "03", description: "the fixed dataset and its coverage report" },
          { method: "GET", path: "/eval?topk=3&baseline=1", chapter: "04–06, 08", description: "offline evaluation: checks, judged quality, attribution, release gate" },
          { method: "GET", path: "/pairwise?a=3&b=1", chapter: "07", description: "compare two retrieval settings, both orders, as a win rate" },
          { method: "POST", path: "/feedback", chapter: "09", description: "record explicit feedback for a recorded interaction" },
          { method: "GET", path: "/online", chapter: "09", description: "online signals and the promotion queue" },
          { method: "POST", path: "/promote", chapter: "09", description: "turn a production failure into a candidate regression test" },
        ],
      });
    },

    /**
     * Chapter 02 §2.6 — the **system under test**, and its trace.
     *
     * The trace is returned rather than hidden because §2.6's claim is that we
     * evaluate the whole system: without the retrieved documents you cannot tell
     * whether a wrong answer came from retrieval or from generation.
     */
    ask: (request: Request, response: Response): void => {
      const input = query(request, "q");

      if (input === undefined || input.trim() === "") {
        badRequest(
          response,
          "Query parameter 'q' is required.",
          "Try /ask?q=What+is+the+return+period%3F",
        );
        return;
      }

      const run = runApp(input, numberParam(request, "topk", config.topK));

      // Chapter 09 §9.3 — every real interaction is recorded. That recording is
      // what makes the online half possible at all.
      const interaction = deps.online.record(input, run.answer);

      response.json({
        input,
        version: run.version,
        status: run.parsed?.status,
        answer: run.answer,
        retrieved: run.retrieved,
        contextChars: run.contextSent.join(" ").length,
        calls: run.calls,
        usage: run.usage,
        interactionId: interaction.id,
      });
    },

    /** Chapter 03 §3.8 — the dataset and the coverage report it promises. */
    describeDataset: (_request: Request, response: Response): void => {
      response.json({
        revision: dataset.revision,
        app: dataset.app,
        createdAt: dataset.createdAt,
        categories: dataset.categories,
        coverage: coverageReport(),
        cases: dataset.cases.map((testCase) => ({
          id: testCase.id,
          category: testCase.category,
          input: testCase.input,
          evaluators: testCase.evaluators.map((evaluator) => evaluator.kind),
        })),
      });
    },

    /**
     * Chapter 04–06 and 08 — the offline evaluation.
     *
     * `?baseline=<topk>` is the Chapter 09 §9.1 idea: a candidate is only
     * *blocked* relative to something. Without a baseline the run can still be
     * gated on its absolute pass rate and its faithfulness threshold, but it
     * cannot report a **regression** — which is why the lecture calls the
     * regression list the actionable half of a report.
     */
    evaluate: async (request: Request, response: Response): Promise<void> => {
      const topK = numberParam(request, "topk", config.topK);
      const baselineTopK = query(request, "baseline");

      const results = await evaluateDataset(dataset.cases, { judge: deps.judge, topK });

      const baselinePassIds =
        baselineTopK === undefined
          ? []
          : passingIds(
              await evaluateDataset(dataset.cases, {
                judge: deps.judge,
                topK: numberParam(request, "baseline", topK),
              }),
            );

      const report = buildReport(results, { baselinePassIds });

      response.json({
        report,
        // Chapter 02 §2.8 — per-case results are what make a report actionable.
        cases: results.map((result) => ({
          id: result.caseId,
          category: result.category,
          passed: casePassed(result),
          attribution: result.attribution,
          failed: result.deterministic.filter((check) => !check.passed),
          quality: result.quality.map((outcome) => ({
            metric: outcome.metric,
            score: outcome.score,
            reason: outcome.reason,
          })),
          retrieval: result.retrieval,
        })),
      });
    },

    /** Chapter 07 §7.5 — pairwise, in both orders, reported as a win rate. */
    pairwise: async (request: Request, response: Response): Promise<void> => {
      const a = numberParam(request, "a", config.topK);
      const b = numberParam(request, "b", 1);

      const report = await compareConfigurations(
        dataset.cases,
        { label: `topK=${a}`, topK: a },
        { label: `topK=${b}`, topK: b },
        deps.judge,
      );

      response.json({
        ...report,
        note:
          "A deterministic stand-in judge cannot exhibit position bias — which is exactly why a real " +
          "judge must be order-tested. `positionBiasCases` is where that check shows up.",
      });
    },

    /** Chapter 09 §9.3 — explicit feedback: 👍 / 👎. High signal, low volume. */
    feedback: (request: Request, response: Response): void => {
      const body = request.body as { id?: unknown; verdict?: unknown };
      const id = typeof body.id === "string" ? body.id : undefined;
      const verdict = body.verdict === "up" || body.verdict === "down" ? body.verdict : undefined;

      if (id === undefined || verdict === undefined) {
        badRequest(
          response,
          "Body must be { id, verdict: 'up' | 'down' }.",
          "Record an interaction with GET /ask first.",
        );
        return;
      }

      const updated = deps.online.feedback(id, verdict);

      if (updated === undefined) {
        response.status(404).json({ error: { message: `No recorded interaction "${id}".` } });
        return;
      }

      response.json({ recorded: updated });
    },

    /** Chapter 09 §9.3 — the online signals, and the promotion queue they feed. */
    online: (_request: Request, response: Response): void => {
      response.json(deps.online.snapshot());
    },

    /**
     * Chapter 09 §9.5 — the loop's mechanical half.
     *
     * Note that this returns a **candidate** and does not edit the dataset. A
     * dataset mutated by production traffic is not a baseline (§3.1), and an
     * unasserted case cannot gate anything — so promotion stops at a stub a human
     * has to finish.
     */
    promote: (request: Request, response: Response): void => {
      const body = request.body as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : undefined;

      if (id === undefined) {
        badRequest(
          response,
          "Body must be { id }.",
          "Use an id from the promotion queue in GET /online.",
        );
        return;
      }

      const promoted = deps.online.promote(id);

      if (promoted === undefined) {
        response.status(404).json({ error: { message: `No recorded interaction "${id}".` } });
        return;
      }

      response.json(promoted);
    },
  };
}
```

### Block-by-block

**Block 1 — the two small helpers, and the one type they exist to fix.**

```ts
function query(request: Request, key: string): string | undefined {
  const value = request.query[key];
  return typeof value === "string" ? value : undefined;
}

function numberParam(request: Request, key: string, fallback: number): number {
  const raw = query(request, key);
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
```

`query` exists because Express types `request.query[key]` as `string | string[] | ParsedQs`. Every
route here wants one string or nothing, so the narrowing happens once — and a caller who sends
`?topk=1&topk=2` gets `undefined` rather than an array that would flow into `runApp` as a `topk` of
`[1,2]`.

`numberParam` guards the three ways a query parameter goes wrong: absent (falls back), non-numeric
(`Number("lots")` is `NaN`, which fails `isFinite`, so it falls back), and non-positive or fractional
(`Math.floor`, and `> 0`). The fallback is always the configured default, so a malformed parameter
degrades to the *configured* behaviour rather than to a crash — which matters because these endpoints
are meant to be typed by hand.

**Block 2 — `badRequest`, and the recovery sentence.**

```ts
function badRequest(response: Response, message: string, recovery: string): void {
  response.status(400).json({ error: { message, recovery } });
}
```

One helper, called from four places, and it enforces a house style on every 400 in the API: **a
message and a recovery.** `"Query parameter 'q' is required."` plus `"Try
/ask?q=What+is+the+return+period%3F"`.

The `recovery` field is the same idea as the MCP lectures' error `recovery` sentence, and the reason
is the same: a caller who gets a 400 from a demo endpoint has no idea what the endpoint wanted, and
telling them the exact URL to try converts a dead end into a next step. A 400 without a recovery is a
bug report about the API rather than a fix for the caller.

**Block 3 — `index`: the API documents itself.**

```ts
index: (_request: Request, response: Response): void => {
  response.json({
    lecture: "Lecture 17 — GenAI Evals & Testing",
    dataset: { app: dataset.app, revision: dataset.revision, cases: dataset.cases.length },
    judge: deps.judge.version,
    retrievalTopK: config.topK,
    routes: [
      { method: "GET", path: "/ask?q=…&topk=3", chapter: "02", description: "run the system under test once and return the trace" },
      { method: "GET", path: "/dataset",        chapter: "03", description: "the fixed dataset and its coverage report" },
      { method: "GET", path: "/eval?topk=3&baseline=1", chapter: "04–06, 08", description: "offline evaluation: checks, judged quality, attribution, release gate" },
      { method: "GET", path: "/pairwise?a=3&b=1", chapter: "07", description: "compare two retrieval settings, both orders, as a win rate" },
      { method: "POST", path: "/feedback",       chapter: "09", description: "record explicit feedback for a recorded interaction" },
      { method: "GET", path: "/online",          chapter: "09", description: "online signals and the promotion queue" },
      { method: "POST", path: "/promote",        chapter: "09", description: "turn a production failure into a candidate regression test" },
    ],
  });
}
```

The index is not decoration. Three fields are there because a reader cannot interpret anything else
without them:

- **`judge`** — `standin-v1` or `model:gpt-4o-mini`. Every number the API returns depends on which
  judge produced it, so it is reported before any number is.
- **`dataset.revision`** — §3.8's comparability rule, surfaced at the top level.
- **`retrievalTopK`** — the configured lever, so a reader knows what `/eval` will use by default.

And the route list carries a **`chapter`** for each endpoint. That is unusual, and it is deliberate: it
turns the API into a map of the lecture, so someone who curls `/` and has read the notes knows exactly
which endpoint answers which question. An API that teaches its own structure is worth six extra lines.

**Block 4 — `ask`: the system under test, and the recording that feeds the loop.**

```ts
ask: (request: Request, response: Response): void => {
  const input = query(request, "q");

  if (input === undefined || input.trim() === "") {
    badRequest(response, "Query parameter 'q' is required.", "Try /ask?q=What+is+the+return+period%3F");
    return;
  }

  const run = runApp(input, numberParam(request, "topk", config.topK));

  const interaction = deps.online.record(input, run.answer);

  response.json({
    input, version: run.version, status: run.parsed?.status, answer: run.answer,
    retrieved: run.retrieved, contextChars: run.contextSent.join(" ").length,
    calls: run.calls, usage: run.usage, interactionId: interaction.id,
  });
}
```

Two things about this handler are worth naming.

**It returns the trace, not just the answer.** `retrieved` with ranks, `contextChars`, `calls`, and
`usage` are all in the response, because Chapter 02 §2.6's claim is that we evaluate the whole system —
and a reader cannot check that claim against a bare answer string.

**It records every interaction as a side effect.** This one line is what connects the two halves of
the lecture: `/ask` is the production path, so every call it serves becomes an `Interaction`, which
feeds `/online`, which feeds `/promote`, which feeds the dataset. Without it the online chapter would
be a demo of a data structure rather than a loop.

`interactionId` is returned so the caller can immediately post feedback — which is what the `curl`
walkthrough in the README does.

**Block 5 — `describeDataset`: the dataset and its coverage claim (§3.8).**

```ts
describeDataset: (_request: Request, response: Response): void => {
  response.json({
    revision: dataset.revision, app: dataset.app, createdAt: dataset.createdAt,
    categories: dataset.categories,
    coverage: coverageReport(),
    cases: dataset.cases.map((testCase) => ({
      id: testCase.id, category: testCase.category, input: testCase.input,
      evaluators: testCase.evaluators.map((evaluator) => evaluator.kind),
    })),
  });
}
```

The `cases` projection is deliberately shallow: id, category, input, and the *kinds* of evaluator — no
expected behaviour. The endpoint is for answering *"what is in the dataset, and is it balanced?"*, and
the coverage report answers the second half. Anyone who needs the full expectations reads
`domain/dataset.ts`, which is where a dataset belongs.

`coverage.missingCategories` is the field to watch: it is `[]` today because all six categories have
cases, and it is computed against the promise (Chapter 03, Block 8), so deleting a category's cases
makes it fill up.

**Block 6 — `evaluate`: the offline run, with an optional baseline.**

```ts
evaluate: async (request: Request, response: Response): Promise<void> => {
  const topK = numberParam(request, "topk", config.topK);
  const baselineTopK = query(request, "baseline");

  const results = await evaluateDataset(dataset.cases, { judge: deps.judge, topK });

  const baselinePassIds = baselineTopK === undefined
    ? []
    : passingIds(await evaluateDataset(dataset.cases, { judge: deps.judge, topK: numberParam(request, "baseline", topK) }));

  const report = buildReport(results, { baselinePassIds });

  response.json({
    report,
    cases: results.map((result) => ({
      id: result.caseId, category: result.category, passed: casePassed(result),
      attribution: result.attribution,
      failed: result.deterministic.filter((check) => !check.passed),
      quality: result.quality.map((outcome) => ({ metric: outcome.metric, score: outcome.score, reason: outcome.reason })),
      retrieval: result.retrieval,
    })),
  });
}
```

**The baseline is a second run, not a stored number.** That is more expensive and it is the right
trade for this project: a stored baseline is a file that can go stale, be edited, or drift from the
code, whereas `?baseline=3` means *"run the same dataset at `topK=3` and tell me what changed."* The
cost is bounded (nine cases), and the semantics are unambiguous.

`baselineTopK === undefined ? [] : …` is the branch that makes the difference between the two modes
visible: with no baseline, `buildReport` receives an empty list and **cannot report a regression** —
only absolute pass rate and the quality threshold. That is why the endpoint's documentation says the
baseline is what makes the regression list meaningful.

**The response has two halves: `report` and `cases`.** The report is the aggregate; the cases are the
per-case detail with the failed checks inline. Both are needed, and the split mirrors `EvalReport`
versus `EvalResult` — a caller who wants a dashboard reads `report`, and a caller who wants to know
what to fix reads `cases`.

**Block 7 — `pairwise`: two candidates, and a stated caveat.**

```ts
pairwise: async (request: Request, response: Response): Promise<void> => {
  const a = numberParam(request, "a", config.topK);
  const b = numberParam(request, "b", 1);

  const report = await compareConfigurations(dataset.cases,
    { label: `topK=${a}`, topK: a }, { label: `topK=${b}`, topK: b }, deps.judge);

  response.json({
    ...report,
    note: "A deterministic stand-in judge cannot exhibit position bias — which is exactly why a real " +
          "judge must be order-tested. `positionBiasCases` is where that check shows up.",
  });
}
```

The candidates are two `topK` settings, which is §7.5's *"RAG configurations"* case — and the lever
Chapter 01's regression story turns on, so one endpoint demonstrates both chapters.

**The `note` field is the interesting part.** `positionBiasCases: []` is a green result, and here a
green result means *nothing*: a deterministic stand-in judge cannot exhibit position bias by
construction. Returning the empty array without the caveat would be a small lie told by omission, and
the kind that gets quoted in a status update. Stating the limitation in the payload is the cheap fix.

**Block 8 — `feedback` and `online`: the explicit channel and the snapshot.**

```ts
feedback: (request: Request, response: Response): void => {
  const body = request.body as { id?: unknown; verdict?: unknown };
  const id = typeof body.id === "string" ? body.id : undefined;
  const verdict = body.verdict === "up" || body.verdict === "down" ? body.verdict : undefined;

  if (id === undefined || verdict === undefined) {
    badRequest(response, "Body must be { id, verdict: 'up' | 'down' }.", "Record an interaction with GET /ask first.");
    return;
  }

  const updated = deps.online.feedback(id, verdict);

  if (updated === undefined) {
    response.status(404).json({ error: { message: `No recorded interaction "${id}".` } });
    return;
  }

  response.json({ recorded: updated });
},

online: (_request: Request, response: Response): void => {
  response.json(deps.online.snapshot());
},
```

`request.body` is `any`, so both fields are validated before use — and the validation is a *type
guard* rather than a cast, because a body of `{ "id": 42 }` must be a 400 rather than a lookup for the
string `"42"`.

The two status codes are the whole error model for this route: **400** for a malformed body,
**404** for an id that was never recorded. Collapsing them would hide the difference between a client
bug and a stale id — and the recovery sentence says which one to fix.

`online` is a one-liner because `snapshot()` already returns the shape the API wants. That is not
laziness; it is the layering paying off — the controller has nothing to add.

**Block 9 — `promote`: the loop, exposed.**

```ts
promote: (request: Request, response: Response): void => {
  const body = request.body as { id?: unknown };
  const id = typeof body.id === "string" ? body.id : undefined;

  if (id === undefined) {
    badRequest(response, "Body must be { id }.", "Use an id from the promotion queue in GET /online.");
    return;
  }

  const promoted = deps.online.promote(id);

  if (promoted === undefined) {
    response.status(404).json({ error: { message: `No recorded interaction "${id}".` } });
    return;
  }

  response.json(promoted);
},
```

The same two-step shape as `feedback`, and the recovery sentence points at the queue — *"Use an id from
the promotion queue in `GET /online`"* — so a caller who guessed an id is told where the real ones are.

The response is `{ testCase, note }` straight from the service, with the note carrying the instruction
for the human who has to finish the case. A controller that summarised that note would be a place for
the instruction to get lost.

---

## `src/routes/index.ts` — the full file

```ts
import express, { type Express, type Request, type Response } from "express";

import { evalController } from "../controllers/evalController.js";
import { createJudge } from "../services/judge.js";
import { createOnlineMonitor } from "../services/online.js";

/**
 * Chapter 02 §2.4 — **the route table.**
 *
 * Eight lines of routing, and no evaluation logic at all. That is the point of
 * the layering: the loop lives in `services/`, and a route is a path plus a
 * method. Chapter 08 §8.5's whole pipeline is reachable from here without any of
 * it being *implemented* here.
 */

// One judge and one online monitor per process. The judge is stateless; the
// monitor is stateful by nature, because it accumulates interactions.
const deps = { judge: createJudge(), online: createOnlineMonitor() };
const controller = evalController(deps);

export const app: Express = express();

// Express advertises itself by default, and a server that answers strangers
// should not volunteer its stack.
app.disable("x-powered-by");

// Needed for the two POST routes. The lecture's own point applies here: a
// structured request is easier to validate than a prose one.
app.use(express.json());

app.get("/", controller.index);
app.get("/ask", controller.ask);
app.get("/dataset", controller.describeDataset);
app.get("/eval", controller.evaluate);
app.get("/pairwise", controller.pairwise);
app.get("/online", controller.online);
app.post("/feedback", controller.feedback);
app.post("/promote", controller.promote);

/**
 * The 404, as a catch-all registered *after* every route — the same shape as
 * Chapter 09's "block the release, but say why" gate: a failure should tell you
 * what to try next.
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

**The composition root.**

```ts
const deps = { judge: createJudge(), online: createOnlineMonitor() };
const controller = evalController(deps);

export const app: Express = express();
app.disable("x-powered-by");
app.use(express.json());

app.get("/", controller.index);
…
```

Two decisions worth naming:

- **`deps` is built once, at module scope.** The judge is stateless, so a fresh one per request would
  be wasteful; the monitor is stateful, so a fresh one per request would be *wrong* — the interactions
  would vanish. One instance each, owned by the module, is the honest expression of both facts.
- **The controller is a factory called once.** `evalController(deps)` closes over the dependencies, so
  the route table is eight references to already-composed handlers rather than eight closures. That is
  what keeps the route table readable as a *table*.

**`app.disable("x-powered-by")` and `app.use(express.json())`** are the only two pieces of middleware,
and each is there for a reason. The first is the same hygiene as the MCP lectures — a server that
answers strangers should not volunteer its stack. The second is what makes `request.body` available;
without it, `feedback` and `promote` would receive `undefined` and every request would be a 400.

**The 404 is a two-argument `app.use` registered last**, and it follows the same house style as
`badRequest`: a message and a recovery. A wrong URL should tell you the right ones.

---

## `src/index.ts` — the full file

```ts
#!/usr/bin/env node
import { config } from "./config/config.js";
import { app } from "./routes/index.js";

/**
 * Chapter 02 — the entry point.
 *
 * Everything interesting is somewhere else: the routes are in `routes/`, the
 * evaluation is in `services/`, and the dataset is in `domain/`. This file binds
 * a port and says so.
 *
 * That separation is not decoration. It is what lets `npm run eval` reuse the
 * exact same services with **no HTTP at all** — which is Chapter 09 §9.1's
 * point: the offline run is the one that gates the release, and it should not
 * need a server to do it.
 */
const server = app.listen(config.port, config.host, () => {
  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  console.error(`[lecture-17-evals] listening on http://${config.host}:${config.port}`);
  console.error(`  try: curl 'http://${config.host}:${config.port}/eval?topk=3'`);
  console.error(`  and: npm run eval -- --topk=1 --baseline=3`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}
```

### Block-by-block

```ts
const server = app.listen(config.port, config.host, () => {
  console.error(`[lecture-17-evals] listening on http://${config.host}:${config.port}`);
  console.error(`  try: curl 'http://${config.host}:${config.port}/eval?topk=3'`);
  console.error(`  and: npm run eval -- --topk=1 --baseline=3`);
});
```

Twenty-eight lines, and the only thing it does is bind a port and print two hints.

**The two hints are the file's real content.** The first names an endpoint that works; the second names
the CLI command that reproduces the regression. A server that starts silently sends the reader back to
the README; a server that prints its own two most interesting commands is self-documenting. Both go to
`stderr`, which is the same discipline as the MCP lectures — `stdout` stays free for anything that
reads it.

**`config.port` and `config.host` come from the environment**, so `PORT=9090 npm start` works without
touching the file. That is Chapter 02's principle applied to the entry point: configuration is data,
not code.

**The shutdown loop** handles `SIGINT` and `SIGTERM` and calls `server.close()`, which stops accepting
connections and lets in-flight ones finish. Two signals rather than one, because `SIGINT` is Ctrl-C (a
developer) and `SIGTERM` is an orchestrator — handling both means the shutdown path is exercised in
development rather than only in production.

---

## `src/cli.ts` — the full file

```ts
#!/usr/bin/env node
import { config } from "./config/config.js";
import { dataset } from "./domain/dataset.js";
import { createJudge } from "./services/judge.js";
import { buildReport, compareConfigurations, evaluateDataset, passingIds } from "./services/report.js";

/**
 * Chapter 09 §9.1 — **offline evaluation, as a command.**
 *
 * This is the file the lecture's diagram is about: a change lands, the fixed
 * dataset is re-run, and the release is blocked if anything regressed. It exits
 * **non-zero**, because an evaluation nobody gates on is a dashboard rather than
 * a test.
 *
 * ```bash
 * npm run eval                          # gate the current configuration
 * npm run eval -- --topk=1 --baseline=3 # reproduce the topK regression, and watch it block
 * npm run eval -- --topk=1 --baseline=3 --pairwise
 * ```
 */

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;

  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const topK = Number(arg("topk") ?? config.topK);
const baselineTopK = arg("baseline");
const judge = createJudge();

const results = await evaluateDataset(dataset.cases, { judge, topK });

// Chapter 09 §9.1 — a candidate is only "blocked" relative to a baseline, so the
// baseline is a separate run rather than a number someone remembered.
const baselinePassIds =
  baselineTopK === undefined
    ? []
    : passingIds(await evaluateDataset(dataset.cases, { judge, topK: Number(baselineTopK) }));

const report = buildReport(results, { baselinePassIds });

const line = (label: string, value: string): void => console.log(`  ${label.padEnd(14)} ${value}`);

console.log(`\nLecture 17 — offline evaluation`);
console.log(`  dataset       revision ${report.datasetRevision} · ${report.cases} cases`);
console.log(`  app           ${report.appVersion}`);
console.log(`  judge         ${judge.version}`);

console.log(`\n  --- the two halves, kept apart (Chapter 02 §2.8) ---`);
line("deterministic", `pass rate ${report.deterministicPassRate}`);
line(
  "retrieval",
  `hit ${report.retrieval.hitRate} · recall ${report.retrieval.recall} · precision ${report.retrieval.precision} · mrr ${report.retrieval.mrr}`,
);

const metrics = Object.entries(report.averages)
  .map(([metric, score]) => `${metric} ${score}`)
  .join(" · ");
line("quality", metrics === "" ? "(no judge evaluators ran)" : metrics);

const attribution = Object.entries(report.attribution)
  .filter(([, count]) => count > 0)
  .map(([name, count]) => `${name} ${count}`)
  .join(" · ");
line("attribution", attribution);

console.log(`\n  --- where the failures cluster (never one blended number) ---`);
for (const [category, summary] of Object.entries(report.byCategory)) {
  line(category, `${summary.cases} case(s) · pass rate ${summary.passRate}`);
}

if (report.coverage.missingCategories.length > 0) {
  console.log(`\n  coverage gap: no cases for ${report.coverage.missingCategories.join(", ")}`);
}

if (report.regressions.length > 0) {
  console.log(`\n  --- regressions vs baseline (topK=${baselineTopK ?? "none"}) ---`);

  for (const id of report.regressions) {
    const result = results.find((candidate) => candidate.caseId === id);

    console.log(`  ${id}  ->  attributed to ${result?.attribution ?? "unknown"}`);

    for (const check of result?.deterministic.filter((c) => !c.passed) ?? []) {
      console.log(`      ${check.name}: ${check.detail ?? "failed"}`);
    }
  }
}

line("\n  cost", `${report.cost.tokens} tokens · $${report.cost.usd} · ${report.cost.avgMs} ms avg`);

if (process.argv.includes("--pairwise")) {
  const other = Number(baselineTopK ?? 1);
  const pairwise = await compareConfigurations(
    dataset.cases,
    { label: `topK=${topK}`, topK },
    { label: `topK=${other}`, topK: other },
    judge,
  );

  console.log(
    `\n  pairwise      ${pairwise.labelA} vs ${pairwise.labelB} · win rate ${pairwise.winRate}` +
      ` (${pairwise.wins}W / ${pairwise.losses}L / ${pairwise.ties}T)` +
      (pairwise.positionBiasCases.length === 0 ? " · no position bias" : ""),
  );
}

// Chapter 04 §4.8 — the gate. Non-zero exit, named reasons.
if (report.gate.blocked) {
  console.log(`\nGATE BLOCKED`);
  for (const reason of report.gate.reasons) {
    console.log(`  - ${reason}`);
  }
  console.log("");
  process.exit(1);
}

console.log(`\nGATE PASSED — ship with evidence.\n`);
```

### Block-by-block

**The argument reading.**

```ts
function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const topK = Number(arg("topk") ?? config.topK);
const baselineTopK = arg("baseline");
```

Two functions, no argument-parsing library, and that is a deliberate choice for a teaching project: a
dependency that hides `process.argv` would also hide the fact that *this is all a CLI is*. `--topk=1`
is found by prefix, and an absent flag falls back to the configured default — the same
"environment as the default" pattern as `config.ts`.

**The body: the same three calls the endpoint makes.**

```ts
const results = await evaluateDataset(dataset.cases, { judge, topK });

const baselinePassIds = baselineTopK === undefined
  ? []
  : passingIds(await evaluateDataset(dataset.cases, { judge, topK: Number(baselineTopK) }));

const report = buildReport(results, { baselinePassIds });
```

**This is the same code as `evaluate` in the controller, minus the HTTP.** That is not duplication to
be factored out — the two surfaces have different *presentation* needs (JSON versus a printed report)
and identical *semantic* needs, and the shared part is already factored into `services/`. What is left
here is three calls, which is the right amount of duplication for two entry points.

Top-level `await` works because the project is ESM. A CLI is exactly the kind of program that benefits:
the whole file reads as a sequence rather than as a `main().catch()`.

**The printing, and why it is laid out the way it is.**

```ts
const line = (label: string, value: string): void => console.log(`  ${label.padEnd(14)} ${value}`);

console.log(`\n  --- the two halves, kept apart (Chapter 02 §2.8) ---`);
line("deterministic", `pass rate ${report.deterministicPassRate}`);
line("retrieval", `hit ${report.retrieval.hitRate} · recall ${report.retrieval.recall} · …`);
line("quality", metrics === "" ? "(no judge evaluators ran)" : metrics);
line("attribution", attribution);
```

The report is printed as a **table with named sections**, and the section headers quote the chapters
(`--- the two halves, kept apart (Chapter 02 §2.8) ---`). That is a small thing that pays off
disproportionately: a reader running `npm run eval` for the first time learns *why* the output is split
the way it is, without opening the guide.

**The regression block is the actionable half:**

```ts
for (const id of report.regressions) {
  const result = results.find((candidate) => candidate.caseId === id);
  console.log(`  ${id}  ->  attributed to ${result?.attribution ?? "unknown"}`);
  for (const check of result?.deterministic.filter((c) => !c.passed) ?? []) {
    console.log(`      ${check.name}: ${check.detail ?? "failed"}`);
  }
}
```

A regressed case prints its **attribution** and its **failed checks with details** — so the output of
the gate is not *"something broke"* but *"`warranty-and-return` failed `expected-docs` because
`warranty` was not retrieved, and that is a retrieval problem."* That is the difference between a
failing build and a work item.

**The exit code (Chapter 04 §4.8).**

```ts
if (report.gate.blocked) {
  console.log(`\nGATE BLOCKED`);
  for (const reason of report.gate.reasons) console.log(`  - ${reason}`);
  console.log("");
  process.exit(1);
}

console.log(`\nGATE PASSED — ship with evidence.\n`);
```

Four lines, and they are the reason this file exists. `process.exit(1)` is what makes the evaluation a
**test** rather than a dashboard — CI reads the exit code, and a gate that always exits 0 is a gate
nobody has to satisfy. The reasons are printed before exiting, because an exit code cannot carry an
explanation.

`GATE PASSED — ship with evidence` is the lecture's closing phrase (Chapter 09 §9.8: *"from 'looks good
to me' to 'we measured it'"*), and printing it is the point of the whole project: the successful case
should say what it means.

**`--pairwise` reuses the same candidates.** When the flag is present the CLI runs
`compareConfigurations` over the same dataset with `--topk` against `--baseline`, so one command shows
both the gate's verdict and the preference result for the same two candidates. It also prints
`· no position bias` only when `positionBiasCases` is empty — and the guide has already explained why
that green result is uninformative for a deterministic judge, which is why the *endpoint* states the
caveat and the CLI does not need to.

---

## Checkpoint

1. **Why is the CLI not a wrapper around the HTTP API?**
   Because Chapter 09 §9.1's gate must not require a server. Both surfaces call the same
   `evaluateDataset`, so they cannot disagree — but only the CLI can run in CI without a port.

2. **Why is `deps` created once at module scope in `routes/index.ts`?**
   Because the monitor is stateful: a per-request instance would throw away every recorded interaction.
   The judge is stateless, so one shared instance is simply efficient.

3. **What does the `chapter` field on each route buy?**
   It turns the API into a map of the lecture — someone who has read the notes and curls `/` knows
   immediately which endpoint answers which question.

4. **Why does `/pairwise` return a `note` about position bias?**
   Because `positionBiasCases: []` is a green result that means nothing for a deterministic stand-in
   judge. Omitting the caveat would let an empty array be quoted as evidence that the judge is unbiased.

5. **What makes `npm run eval` a test rather than a report?**
   `process.exit(1)`. CI reads exit codes, and a gate that always exits 0 is a gate nobody has to
   satisfy.

---

**Back to:** [Implementation guide index](./README.md) · [Lecture 17 Basic Code README](../README.md) · [Lecture 17 notes](../../notes/README.md)
