import type { Request, Response } from "express";
import { config } from "../config/config.js";
import type { Filter, Hit } from "../models/types.js";
import { DOCUMENTS } from "../services/documents.js";
import { ablation, evaluate, GOLDEN } from "../services/eval.js";
import { runPipeline } from "../services/index.js";
import { buildIndex, filterFrom, isEligible } from "../services/store.js";

/**
 * Chapter 14 — the controller.
 *
 * A controller does three things and nothing else:
 *   1. read and validate the request,
 *   2. call **one** service,
 *   3. shape the response.
 *
 * It contains no retrieval logic, which is what keeps every rule in the notes
 * reachable from both the CLI and HTTP without being written twice.
 */

/** The request contract, validated in one place (Chapter 16 turns the throw into a 400). */
function questionFrom(body: unknown): string {
  const question = (body as { question?: unknown } | null)?.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new Error("Body must be { question: string } with a non-empty question.");
  }
  return question.trim();
}

/** Chapters 08–09 — the ranked lists, flattened into JSON. */
function toHits(hits: Hit[]): { id: string; source: string; heading: string; score: number }[] {
  return hits.map((hit) => ({
    id: hit.chunk.id,
    source: hit.chunk.docId,
    heading: hit.chunk.breadcrumb,
    score: Number(hit.score.toFixed(4)),
  }));
}

/** Chapter 17 — liveness, plus the controls that produced the last answer. */
export function health(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    service: "lecture-12-basic-rag",
    documents: DOCUMENTS.length,
    chunks: buildIndex(DOCUMENTS, config).length,
    // Only the non-sensitive knobs: never the tenant or the ACL.
    controls: {
      chunkStrategy: config.chunkStrategy,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      kRetrieve: config.kRetrieve,
      kContext: config.kContext,
      minScore: config.minScore,
      hybrid: config.hybrid,
      rrfK: config.rrfK,
      rerank: config.rerank,
      rerankMinBest: config.rerankMinBest,
      maxContextTokens: config.maxContextTokens,
    },
  });
}

/** Chapters 07–09 — the retrieval trace, without the answer. */
export function search(req: Request, res: Response): void {
  const question = questionFrom(req.body);
  const trace = runPipeline(question, config);
  res.json({
    question,
    filter: trace.filter,
    corpus: { chunks: trace.chunks, eligible: trace.eligible },
    dense: toHits(trace.dense),
    lexical: toHits(trace.lexical),
    fused: toHits(trace.fused),
    reranked: toHits(trace.reranked),
    gate: {
      best: trace.reranked[0] ? Number(trace.reranked[0].score.toFixed(4)) : null,
      min: config.rerankMinBest,
      passed: trace.passed,
    },
    context: {
      blocks: trace.context.blocks.length,
      tokens: trace.context.tokens,
      ids: trace.context.ids,
    },
    timings: trace.timings,
  });
}

/** Chapters 10–11 — the assembled prompt and the grounded answer. */
export function ask(req: Request, res: Response): void {
  const question = questionFrom(req.body);
  const trace = runPipeline(question, config);
  res.json({
    question,
    answer: trace.answer.text,
    citations: trace.answer.citations,
    refused: trace.answer.refused,
    sources: trace.context.blocks.map((block) => ({
      label: block.label,
      source: block.docId,
      heading: block.heading,
    })),
    context: trace.context.text,
    tokens: trace.context.tokens,
  });
}

/** Chapter 07 — eligibility, access control and time travel, as JSON. */
export function filters(_req: Request, res: Response): void {
  const index = buildIndex(DOCUMENTS, config);
  const base = filterFrom(config);

  const scenarios: { label: string; filter: Filter }[] = [
    { label: "category in [electronics, general] (correct tiers)", filter: { ...base, categories: ["electronics", "general"] } },
    { label: "category == electronics (the bug)", filter: { ...base, categories: ["electronics"] } },
    { label: 'tenant = "" (fail closed)', filter: { ...base, tenant: "" } },
    { label: "asOf = 2026-02-01 (before the new policy)", filter: { ...base, asOf: "2026-02-01", categories: ["electronics", "general"] } },
  ];

  res.json({
    scenarios: scenarios.map(({ label, filter }) => ({
      scenario: label,
      eligible: [...new Set(index.filter((chunk) => isEligible(chunk, filter)).map((chunk) => chunk.docId))],
    })),
  });
}

/** Chapter 13 — the golden set, per case and in aggregate. */
export function evaluateHandler(_req: Request, res: Response): void {
  const { metrics, cases } = evaluate();
  res.json({ golden: GOLDEN.length, metrics, cases });
}

/** Chapter 13 — the ablation table. */
export function ablationHandler(_req: Request, res: Response): void {
  res.json({ presets: ablation() });
}
