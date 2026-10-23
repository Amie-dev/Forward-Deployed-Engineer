import { config, type Config } from "../config/config.js";
import type { CaseResult, GoldenCase, Metrics } from "../models/types.js";
import { runPipeline } from "./index.js";

/**
 * Chapter 09 — evaluation.
 *
 * The closing principle of the lecture: **evaluate retrieval and generation
 * separately**. A generation metric without a retrieval metric beside it cannot
 * tell you which stage failed.
 *
 * Metrics here are deliberately small: `recall@N` and `MRR` for retrieval,
 * `context precision` for the assembled prompt, `refusal correctness` for
 * generation, plus `contextTokens` for cost.
 *
 * `GoldenCase`, `CaseResult` and `Metrics` are contracts (Chapter 02). `Preset`
 * stays here because it is a `Partial<Config>` — evaluation is the only layer
 * that rewrites the configuration.
 */

export const GOLDEN: GoldenCase[] = [
  {
    question: "Can I return my damaged headphones after 10 days?",
    expectedDocs: ["return-policy-electronics", "damaged-product-policy"],
    answerable: true,
  },
  {
    question: "How long is the return window for electronic products?",
    expectedDocs: ["return-policy-electronics"],
    answerable: true,
  },
  {
    question: "How long do I have to report a damaged product?",
    expectedDocs: ["damaged-product-policy"],
    answerable: true,
  },
  {
    question: "Does the AX-204 wireless headphone support fast charging?",
    expectedDocs: ["product-ax204"],
    answerable: true,
  },
  {
    question: "What is the general return window?",
    expectedDocs: ["return-policy-general"],
    answerable: true,
  },
  {
    question: "Who won the Indian Premier League in 2026?",
    expectedDocs: [],
    answerable: false,
  },
];

/** The doc ids behind a list of chunk ids: `return-policy-electronics#2#ab12` → doc id. */
function docIds(chunkIds: string[]): string[] {
  return [...new Set(chunkIds.map((id) => id.split("#")[0]))];
}

export function evaluate(cfg: Config = config): { metrics: Metrics; cases: CaseResult[] } {
  const cases = GOLDEN.map((golden) => {
    const trace = runPipeline(golden.question, cfg);
    const retrieved = docIds(trace.reranked.map((hit) => hit.chunk.id));

    const ranks = golden.expectedDocs
      .map((docId) => retrieved.indexOf(docId))
      .filter((rank) => rank >= 0);
    const recall = golden.expectedDocs.length === 0 || ranks.length === golden.expectedDocs.length ? 1 : 0;

    // Context precision (Chapter 09): of the chunks that actually reached the
    // prompt, how many belong to a document the case expects?
    const contextDocs = trace.context.blocks.map((block) => block.docId);
    const relevant = contextDocs.filter((docId) => golden.expectedDocs.includes(docId)).length;
    const precision = contextDocs.length === 0 ? 0 : relevant / contextDocs.length;

    const reciprocal = ranks.length > 0 ? 1 / (Math.min(...ranks) + 1) : 0;
    const correct = golden.answerable === !trace.answer.refused ? 1 : 0;

    return {
      question: golden.question,
      expected: golden.expectedDocs,
      retrieved,
      recall,
      precision,
      reciprocal,
      correct,
      tokens: trace.context.tokens,
      refused: trace.answer.refused,
    };
  });

  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(3));

  const first = runPipeline(GOLDEN[0].question, cfg);
  const answerable = cases.filter((c) => c.expected.length > 0);
  return {
    metrics: {
      chunks: first.chunks,
      recall: mean(cases.map((c) => c.recall)),
      precision: mean(answerable.map((c) => c.precision)),
      mrr: mean(cases.map((c) => c.reciprocal)),
      refusal: mean(cases.map((c) => c.correct)),
      contextTokens: Math.round(cases.reduce((sum, c) => sum + c.tokens, 0) / cases.length),
    },
    cases,
  };
}

/**
 * Chapter 09 — the ablation: one control at a time, same golden set.
 *
 *   0 baseline (fixed chunks, dense, K=4)
 *   1 + structural chunking
 *   2 + hybrid search (dense + BM25 + RRF)
 *   3 + calibrated threshold and a wider candidate set
 *   4 + rerank 20 → present 4
 */
export type Preset = { name: string; overrides: Partial<Config> };

export const PRESETS: Preset[] = [
  {
    name: "naive",
    overrides: { chunkStrategy: "fixed", chunkOverlap: 0, hybrid: "off", rerank: "off", minScore: 0, kRetrieve: 4, kContext: 4 },
  },
  {
    name: "structural",
    overrides: { chunkStrategy: "structural", hybrid: "off", rerank: "off", minScore: 0, kRetrieve: 4, kContext: 4 },
  },
  {
    name: "hybrid",
    overrides: { chunkStrategy: "structural", hybrid: "rrf", rerank: "off", minScore: 0.15, kRetrieve: 10, kContext: 4 },
  },
  {
    name: "rerank",
    overrides: { chunkStrategy: "structural", hybrid: "rrf", rerank: "on", minScore: 0.15, kRetrieve: 10, kContext: 4 },
  },
  {
    name: "full",
    overrides: { chunkStrategy: "structural", hybrid: "rrf", rerank: "on", minScore: 0.15, kRetrieve: 20, kContext: 4 },
  },
];

export function ablation(base: Config = config): { preset: string; metrics: Metrics }[] {
  return PRESETS.map((preset) => ({
    preset: preset.name,
    metrics: evaluate({ ...base, ...preset.overrides }).metrics,
  }));
}
