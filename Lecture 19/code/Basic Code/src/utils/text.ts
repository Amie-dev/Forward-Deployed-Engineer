/**
 * Chapter 04 §4.3 — shared text helpers.
 *
 * Retrieval (`services/knowledgeBase.ts`) and the offline model both need
 * "which words matter". One definition, because two different ideas of "the
 * same words" would make the injection demo unreproducible — and a demo you
 * cannot reproduce is not evidence.
 */

/**
 * Words that carry no retrieval signal for an order or policy question.
 *
 * Without this list, every question would match every document on the word
 * "the", retrieval would always return the maximum number of documents, and the
 * *channel* the injection arrives through (Chapter 04 §4.3) would be impossible
 * to see. A stop list is not a list of unimportant words: it is a list of words
 * that do not discriminate between documents.
 */
const STOP_WORDS = new Set([
  "a", "after", "ago", "all", "am", "an", "and", "are", "as", "at", "be", "been",
  "before", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "get", "got", "had", "has", "have", "he", "her", "hi", "him", "his", "how",
  "i", "if", "in", "is", "it", "its", "later", "long", "many", "may", "me",
  "might", "much", "must", "my", "no", "not", "of", "on", "or", "our", "please",
  "shall", "she", "should", "so", "still", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "to", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "would", "yes", "you", "your",
]);

/** A deliberately crude stemmer, so "refunded" and "refund" are the same term. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");
}

/** The content terms of a string: lower-cased, split, de-stopped and stemmed. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

/**
 * How much of `text` appears in `reference`, as a fraction of `text`'s terms.
 *
 * A fraction rather than a count, because the callers compare strings of very
 * different lengths: a five-word question against a paragraph-long document.
 */
export function overlap(text: string, reference: string): number {
  const wanted = terms(text);

  if (wanted.length === 0) {
    return 0;
  }

  const available = new Set(terms(reference));

  return wanted.filter((term) => available.has(term)).length / wanted.length;
}
