import { contentWords } from '../lib/text.js';

/** Five characters is enough to group refund/refunds and ship/shipping. */
function stem(word: string): string {
  return word.slice(0, 5);
}

/**
 * Share of the question's content words that appear in the chunk.
 *
 * Cosine similarity answers "are these about the same thing?"; this answers "does
 * this text literally contain what was asked?". Blending the two is hybrid search
 * in miniature — it fixes the case where a long, vaguely-related chunk outranks a
 * short, exact one purely because cosine divides by length.
 */
export function lexicalOverlap(query: string, text: string): number {
  const queryStems = new Set(contentWords(query).map(stem));
  if (queryStems.size === 0) return 0;

  const textStems = new Set(contentWords(text).map(stem));
  let shared = 0;
  for (const stemmed of queryStems) {
    if (textStems.has(stemmed)) shared++;
  }

  return shared / queryStems.size;
}
