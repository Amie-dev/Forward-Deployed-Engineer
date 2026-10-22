import type { Citation, Match } from '../types/rag.types.js';

const MARKER = /\[(\d+)\]/g;

/** All distinct `[n]` labels in an answer, in ascending order. */
export function extractCitationLabels(answer: string): number[] {
  const labels = new Set<number>();
  for (const match of answer.matchAll(MARKER)) labels.add(Number(match[1]));
  return [...labels].sort((left, right) => left - right);
}

/**
 * Resolve `[n]` against the chunks that were actually in the prompt.
 *
 * A label with no matching chunk is a fabricated source. That is the cheapest
 * hallucination detector in the whole system: no model call, no judgement, just
 * set membership.
 */
export function linkCitations(answer: string, labels: ReadonlyMap<number, Match>): Citation[] {
  return extractCitationLabels(answer).map((label) => {
    const match = labels.get(label);

    if (!match) {
      return { label, chunkId: '', source: '', section: '', score: 0, valid: false };
    }

    return {
      label,
      chunkId: match.id,
      source: match.source,
      section: match.section,
      score: match.score,
      valid: true,
    };
  });
}

/** Remove citations the model invented, so the customer never sees a fake source. */
export function stripInvalidMarkers(answer: string, labels: ReadonlyMap<number, Match>): string {
  return answer.replace(MARKER, (marker, raw: string) => (labels.has(Number(raw)) ? marker : ''));
}

export function countInvalid(citations: readonly Citation[]): number {
  return citations.filter((citation) => !citation.valid).length;
}
