import { createHash } from 'node:crypto';

import { getEncoding, type Tiktoken } from 'js-tiktoken';

/**
 * Text utilities. Small on purpose: every function here is a decision that shows
 * up in retrieval quality, so each one is worth reading.
 */

let cached: Tiktoken | undefined;

/** cl100k_base — the tokenizer behind text-embedding-3-* and GPT-4-class models. */
export function tokenizer(): Tiktoken {
  cached ??= getEncoding('cl100k_base');
  return cached;
}

export function countTokens(text: string): number {
  return tokenizer().encode(text).length;
}

/** Stable id for a chunk. Same source + position + text always produces the same id. */
export function sha256(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Clean extracted text without changing its meaning.
 *
 * Only fixes what extraction breaks: ligatures, CRLF, words hyphenated across a
 * line break, and the blank-line runs that page headers leave behind. Cleaning is
 * not cosmetic — boilerplate repeated in every chunk flattens the vector space and
 * destroys retrieval precision.
 */
export function normaliseText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    // Markdown emphasis is formatting, not content. Leaving `**7 days**` in the text
    // splits the token across the asterisks and makes the number harder to match.
    // `[\s\S]` because a bold run may span a line break in a hard-wrapped document.
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sentence-ish units. Used to split long sections and to build extractive answers.
 *
 * Splitting on a single newline is wrong: documents are hard-wrapped, so a sentence
 * that happens to cross a line break would be cut in half and the second half would
 * become a sentence of its own. Only a blank line ends a sentence here.
 */
export function sentences(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

/**
 * Tokens for BM25.
 *
 * Keeps `ax-204` as one token instead of splitting it into `ax` and `204`,
 * because the whole point of lexical search is that a SKU is a single term.
 */
export function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+(?:-\d+)?|\d+/g) ?? [];
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Five characters is enough to group refund/refunds, ship/shipping, exchange/exchanged. */
export function stem(word: string): string {
  return word.slice(0, 5);
}

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'our', 'can', 'could', 'what', 'how', 'does', 'did', 'are',
  'was', 'were', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'not', 'but', 'still', 'any',
  'get', 'got', 'after', 'before', 'when', 'where', 'which', 'who', 'why', 'use', 'used', 'about',
  'they', 'them', 'then', 'there', 'these', 'those', 'been', 'would', 'should', 'please', 'want',
]);

/**
 * Query-side terms, stemmed, for *scoring* comparisons only.
 *
 * Never build an inverted index out of these: a BM25 postings list must tokenise a
 * document exactly the way the query is tokenised, and it deliberately keeps the
 * exact term so that `ax-204` stays one token. Scoring, by contrast, wants
 * `exchange` to match `exchanged`, which is what the stem gives it.
 */
export function queryTerms(text: string, limit = 12): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const term of terms(text)) {
    if (term.length < 4 || QUERY_STOPWORDS.has(term)) continue;
    const stemmed = stem(term);
    if (seen.has(stemmed)) continue;
    seen.add(stemmed);
    result.push(stemmed);
    if (result.length === limit) break;
  }

  return result;
}

/** The same stemmed view of a document, so both sides of a comparison agree. */
export function stemsOf(text: string): Set<string> {
  return new Set(terms(text).map(stem));
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'so', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'still', 'just', 'any',
]);

/**
 * Content words, deduplicated, in order.
 *
 * The offline embedder uses this: "what / is / the / for" appear in every
 * sentence and would otherwise dominate the hash features, making every chunk
 * look equally similar to every question.
 */
export function contentWords(text: string, limit = 64): string[] {
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

/** Trim to a character budget without cutting mid-word where avoidable. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** `7 days` → `7 days`; `do NOT extend` → `do NOT extend`. Used only for display. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
