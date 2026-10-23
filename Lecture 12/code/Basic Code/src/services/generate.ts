import { contentTerms } from "./embeddings.js";
import type { AssembledContext } from "./context.js";

/**
 * Chapter 08 — the grounded answer.
 *
 * Two rules from the notes live here:
 *   - cite `[n]`, or refuse with one exact sentence;
 *   - an empty context is the *only* mechanism that makes refusal reachable, so
 *     the refusal branch is the most important one in this file.
 *
 * This generator is **extractive**: it quotes the best-matching sentences. It
 * cannot conclude that "10 days is past a 7-day window" — that is the honest
 * limit of a no-API-key demo, and Chapter 09 calls those cases `generation-miss`.
 */
export const REFUSAL = "I don't know — no eligible policy in the corpus covers this question.";

export type Answer = { text: string; citations: number[]; refused: boolean };

function sentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function generateAnswer(question: string, context: AssembledContext): Answer {
  if (context.blocks.length === 0) {
    return { text: REFUSAL, citations: [], refused: true };
  }

  const questionTerms = contentTerms(question);

  // Chapter 06's IDF, applied to the context: a term that appears in every block
  // ("return", "policy") says almost nothing; a rare one ("headphones") decides.
  const documentFrequency = new Map<string, number>();
  for (const block of context.blocks) {
    for (const term of contentTerms(`${block.heading} ${block.body}`)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string): number =>
    Math.log(1 + context.blocks.length / (documentFrequency.get(term) ?? 1));

  const candidates = context.blocks.flatMap((block) =>
    sentences(block.body).map((sentence) => {
      // The label is part of the evidence: the section name disambiguates.
      const scored = contentTerms(`${block.heading} ${sentence}`);
      const score = questionTerms
        .filter((term) => scored.includes(term))
        .reduce((sum, term) => sum + idf(term), 0);
      return { label: block.label, sentence, score };
    }),
  );

  const best = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (best.length === 0) {
    return { text: REFUSAL, citations: [], refused: true };
  }

  return {
    text: best.map((candidate) => `${candidate.sentence} [${candidate.label}]`).join("\n"),
    citations: [...new Set(best.map((candidate) => candidate.label))],
    refused: false,
  };
}
