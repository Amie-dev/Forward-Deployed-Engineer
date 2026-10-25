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
