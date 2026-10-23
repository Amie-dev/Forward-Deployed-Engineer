import { fnv1a } from "../utils/hash.js";

/**
 * Chapters 03 and 06 — the embedder and its analyzer.
 *
 * Offline and deterministic: each token is hashed into a fixed-width vector, so
 * the whole lecture runs with **no API key**. The honest limit from Chapter 04
 * applies — this is lexical, not semantic, so paraphrase is only findable
 * through BM25. Set a real embedding model and nothing else in the code changes.
 */
export const DIMENSIONS = 256;

/**
 * Stopwords are dropped from *scoring* helpers only — never from BM25.
 * Chapter 06's warning stands: negation words (`not`, `no`, `except`, `never`,
 * `only`) are **not** in this list, because dropping them inverts a policy.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "am",
  "do", "does", "did", "i", "my", "me", "we", "our", "you", "your",
  "it", "its", "in", "on", "at", "of", "for", "to", "and", "or",
  "who", "what", "when", "where", "why", "how", "can", "could", "may",
  "will", "would", "should", "shall", "have", "has", "had", "this",
  "that", "these", "those", "with", "after", "before", "from", "by",
  "as", "if", "then", "than", "so", "but", "there", "here", "about",
]);

/**
 * The content terms of a text: what a scorer should actually look at.
 * `analyze` still keeps every token — this is a filter applied on top.
 */
export function contentTerms(text: string): string[] {
  return [...new Set(analyze(text))].filter((token) => !STOPWORDS.has(token));
}

/**
 * The analyzer. Chapter 06's warnings, in three lines:
 *   - index the hyphen variant (`ax-204` and `ax204`) so a SKU search hits;
 *   - never drop negation words (`not`, `no`, `except`) from a policy corpus;
 *   - lowercase everything so `AX-204` and `ax-204` are one term.
 */
export function analyze(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const out: string[] = [];
  for (const token of tokens) {
    out.push(token);
    if (token.includes("-")) out.push(token.replace(/-/g, ""));
  }
  return out;
}

/** Signed hashing: the sign bit spreads collisions instead of adding them up. */
export function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of analyze(text)) {
    const h = fnv1a(token);
    vector[h % DIMENSIONS] += (h & 0x100) === 0 ? 1 : -1;
  }
  return normalize(vector);
}

export function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length === 0 ? vector : vector.map((value) => value / length);
}

/** Chapter 04 — the similarity metric the threshold is expressed in. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are already unit length
}
