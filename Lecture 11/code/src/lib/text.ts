import { createHash } from 'node:crypto';

/** Stable id for a chunk. Same source + position + text always produces the same id. */
export function sha256(...parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Clean extracted text without changing its meaning.
 *
 * Only fixes what extraction broke: ligatures, CRLF, words hyphenated across a
 * line break, and the blank-line runs that page headers leave behind. Cleaning
 * is not cosmetic — boilerplate repeated in every chunk flattens the vector
 * space and destroys retrieval precision.
 */
export function normaliseText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Words, lowercased. Used for lexical overlap, never for embeddings. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'so', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/** Content words, deduplicated, in order. Cheap stand-in for a keyword extractor. */
export function keywords(text: string, limit = 6): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const word of words(text)) {
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    result.push(word);
    if (result.length === limit) break;
  }

  return result;
}

/**
 * Words that carry meaning, with stopwords removed.
 *
 * The offline embedder uses this: "what / is / the / for" appear in every
 * sentence and would otherwise dominate the hash features, making every chunk
 * look equally similar to every question.
 */
export function contentWords(text: string): string[] {
  return words(text).filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Split text into sentence-ish units for the offline extractive generator.
 * Bullets and headings are treated as their own unit: they are usually the most
 * quotable part of a policy document.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Trim a string to a character budget without cutting mid-word where avoidable. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
