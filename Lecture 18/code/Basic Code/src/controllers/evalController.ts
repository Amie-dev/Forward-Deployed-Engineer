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
