/**
 * Chapter 02 §2.2 / Chapter 06 §6.3 — shared text helpers.
 *
 * Two services need to compare text by meaning-of-words: the retrieval stand-in
 * and the judge stand-in. Keeping the rule in one place means "what counts as
 * evidence" has exactly one definition in this project — which matters, because
 * a judge that disagrees with retrieval about what a word is will report
 * unfaithfulness that retrieval never caused.
 */

/**
 * Words that carry no retrieval or grading signal for a policy question.
 *
 * Without this list, "What is the weather in Paris?" would match a policy
 * document on the word "the", retrieve it, and *fail* the dataset's
 * `expectedSource: null` assertion — a false failure caused entirely by stop
 * words. Chapter 05 §5.3.4's "assert absence when nothing is expected" only
 * works if retrieval can honestly return nothing.
 *
 * The temporal words (`after`, `before`, `ago`, `later`) belong here for the same
 * reason: in "after 30 days" the signal is `30`, not `after`. A stop list is not a
 * list of unimportant words — it is a list of words that do not *discriminate*
 * between documents.
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

/**
 * A deliberately crude stemmer: strip a plural/gerund/past ending, then a
 * trailing "e".
 *
 * It exists so that "returned" and "return", or "arrive" and "arrived", are the
 * same term. It is *not* a linguistics library, and Chapter 05 §5.3.3's
 * "normalise before comparing" is the habit it stands in for: the cheapest
 * false failures in an eval suite come from comparisons that were too literal.
 */
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
 * different lengths: a two-word question against a paragraph, and a golden
 * answer against a full sentence.
 */
export function overlap(text: string, reference: string): number {
  const wanted = terms(text);

  if (wanted.length === 0) {
    return 0;
  }

  const available = new Set(terms(reference));

  return wanted.filter((term) => available.has(term)).length / wanted.length;
}
