import type { Citation, RagTrace } from '../types.js';

/**
 * Retrieval and generation metrics, computed separately.
 *
 * The separation is the whole point of Chapter 10: an end-to-end "was the answer
 * good" score cannot tell you whether to change the chunker or the prompt. These
 * functions each answer one question about one stage:
 *
 *   recall@K   did any of the right documents reach the prompt?
 *   MRR        how high was the first right one?
 *   nDCG@K     was the whole list ordered well, not just the top?
 *   citation   did every claim cite a block that existed?
 *   facts      did the exact numbers survive into the answer?
 */

export interface GoldenCase {
  id: string;
  question: string;
  asOf: string;
  answerable: boolean;
  expectedSources: string[];
  mustInclude: string[];
}

export interface CaseEvaluation {
  id: string;
  question: string;
  answerable: boolean;
  refused: boolean;
  /** Sources in the order they reached the prompt. */
  usedSources: string[];
  recall: number;
  mrr: number;
  ndcg: number;
  citationValidity: number;
  factMatch: boolean;
  contextTokens: number;
  latencyMs: number;
  answer: string;
}

/** Share of the expected documents that made it into the prompt. */
export function recallOf(expected: readonly string[], retrieved: readonly string[]): number {
  if (expected.length === 0) return 0;
  const seen = new Set(retrieved);
  return expected.filter((source) => seen.has(source)).length / expected.length;
}

/**
 * 1 / rank of the first expected document, or 0 when none appeared.
 *
 * Ranks are counted over *documents*, not chunks: five chunks from the third-best
 * document are still one document at one position, and counting them five times
 * would flatter a retriever that simply returned a lot of one thing.
 */
export function reciprocalRank(expected: readonly string[], retrieved: readonly string[]): number {
  const rank = [...new Set(retrieved)].findIndex((source) => expected.includes(source));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

/**
 * nDCG with binary relevance.
 *
 * A list of five chunks where the right document is third is worse than one where
 * it is first, and MRR alone cannot express *how much* worse once several relevant
 * documents exist. DCG divides each hit by log2(rank + 1), so position decays
 * gently instead of collapsing. Duplicates are collapsed first — the same document
 * retrieved twice is not two relevant results.
 */
export function ndcgAtK(expected: readonly string[], retrieved: readonly string[], k: number): number {
  if (expected.length === 0) return 0;

  const unique = [...new Set(retrieved)].slice(0, k);

  let dcg = 0;
  unique.forEach((source, index) => {
    if (expected.includes(source)) dcg += 1 / Math.log2(index + 2);
  });

  let idcg = 0;
  for (let index = 0; index < Math.min(expected.length, k); index++) {
    idcg += 1 / Math.log2(index + 2);
  }

  return idcg === 0 ? 0 : Math.min(1, dcg / idcg);
}

export function evaluateCase(
  testCase: GoldenCase,
  result: { answer: string; refused: boolean; citations: readonly Citation[]; trace: RagTrace },
): CaseEvaluation {
  const usedSources = result.trace.retrieved
    .filter((row) => row.used)
    .sort((left, right) => (left.rank ?? 99) - (right.rank ?? 99))
    .map((row) => row.source);

  const answered = result.answer.toLowerCase();
  const factMatch = testCase.mustInclude.every((phrase) => answered.includes(phrase.toLowerCase()));

  const citationValidity = result.citations.length === 0
    ? (result.refused ? 1 : 0)
    : result.citations.filter((citation) => citation.valid).length / result.citations.length;

  return {
    id: testCase.id,
    question: testCase.question,
    answerable: testCase.answerable,
    refused: result.refused,
    usedSources,
    recall: recallOf(testCase.expectedSources, usedSources),
    mrr: reciprocalRank(testCase.expectedSources, usedSources),
    ndcg: ndcgAtK(testCase.expectedSources, usedSources, 5),
    citationValidity,
    factMatch,
    contextTokens: result.trace.contextTokens,
    latencyMs: result.trace.latencyMs,
    answer: result.answer,
  };
}

export interface SuiteSummary {
  cases: number;
  recall: number;
  mrr: number;
  ndcg: number;
  /** Share of answerable questions whose required facts appear in the answer. */
  factAccuracy: number;
  /** Share of unanswerable questions that were correctly refused. */
  refusalAccuracy: number;
  /** Share of answerable questions that were wrongly refused. */
  falseRefusal: number;
  citationValidity: number;
  averageContextTokens: number;
  p50LatencyMs: number;
}

export function summarise(evaluations: readonly CaseEvaluation[]): SuiteSummary {
  const answerable = evaluations.filter((evaluation) => evaluation.answerable);
  const unanswerable = evaluations.filter((evaluation) => !evaluation.answerable);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));

  const latencies = evaluations.map((evaluation) => evaluation.latencyMs).sort((a, b) => a - b);

  return {
    cases: evaluations.length,
    recall: mean(evaluations.map((evaluation) => evaluation.recall)),
    mrr: mean(evaluations.map((evaluation) => evaluation.mrr)),
    ndcg: mean(evaluations.map((evaluation) => evaluation.ndcg)),
    factAccuracy: mean(answerable.map((evaluation) => (evaluation.factMatch ? 1 : 0))),
    refusalAccuracy: mean(unanswerable.map((evaluation) => (evaluation.refused ? 1 : 0))),
    falseRefusal: mean(answerable.map((evaluation) => (evaluation.refused ? 1 : 0))),
    citationValidity: mean(evaluations.map((evaluation) => evaluation.citationValidity)),
    averageContextTokens: Math.round(
      evaluations.reduce((sum, evaluation) => sum + evaluation.contextTokens, 0) / Math.max(1, evaluations.length),
    ),
    p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
  };
}
