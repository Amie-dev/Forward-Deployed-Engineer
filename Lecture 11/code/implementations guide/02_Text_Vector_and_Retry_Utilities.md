# Chapter 02: Text, Vector & Retry Utilities

> **Chapter Goal:** Build the three primitives every later stage leans on: text normalisation that does not change meaning, cosine similarity that refuses to compare incompatible vectors, and retries that only retry what is worth retrying.

> **Lecture mapping:** Notes Chapter 03 (cleaning and normalisation), Chapter 04 (cosine, normalisation), Chapter 09 (retry, backoff, provider failure).

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/lib/text.ts` | 105 | Normalise, tokenise, stopwords, sentence splitting, clipping. |
| `src/lib/vectors.ts` | 35 | Unit-normalise and cosine similarity with a dimension guard. |
| `src/lib/retry.ts` | 45 | Exponential backoff with jitter, 429/5xx only. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npx tsc --noEmit
npm run demo | sed -n '1,24p'   # prints the chunk counts these helpers produce
```

---

## 2. Text — `src/lib/text.ts`

#### 📄 `src/lib/text.ts`

```ts
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
```

**Block by block:**

- **`sha256(...parts)`** — joins with `:` and hashes. `sha256(source, index, text)` gives a chunk id that is stable across machines and runs, which is what makes re-ingestion idempotent instead of duplicating the index.
- **`normaliseText`** — five fixes, each targeting a specific extraction bug:
  - `.normalize('NFKC')` — `ﬁ` becomes `fi`, curly quotes become straight ones, so the same sentence from two PDFs hashes the same.
  - `\r\n?` → `\n` — Windows and classic-Mac line endings both collapse to `\n`.
  - `(\p{Ll})-\n(\p{Ll})` → `$1$2` — re-joins words hyphenated across a line break (`refun-\nd` → `refund`). Without this, a PDF split randomly changes the vocabulary.
  - `[ \t]+$` and `[ \t]{2,}` — trims trailing spaces and collapses runs, which otherwise survive into chunk text and waste tokens.
  - `\n{3,}` → `\n\n` — normalises the blank-line runs that page headers leave behind.
- **`words(text)`** — lowercase, Unicode-aware `[\p{L}\p{N}]+`. Used for lexical scoring and the mock embedder, never for real embeddings.
- **`STOPWORDS`** — ~60 function words. Deliberately small: an aggressive list removes "not", "only" or "before", which change the meaning of a policy sentence.
- **`keywords(text, limit)`** — first N distinct content words in order. Chapter 11 uses it to carry a topic forward into a rewritten query.
- **`contentWords(text)`** — words minus stopwords, longer than two characters. This is the *only* token source for the mock embedder and for lexical overlap; keeping the two consistent is why the offline scores in chapter 07 line up with the keyword behaviour.
- **`splitSentences`** — splits on newlines *and* sentence punctuation, with a lookbehind. Bullets and headings become their own units, which is what a quotable policy answer needs.
- **`clip(text, maxChars)`** — truncates at a word boundary when possible and appends `…`. Used when a single chunk must be squeezed into a token budget, and by the extractive generator when quoting.

### Why normalisation is not cosmetic

Boilerplate that survives extraction appears in *every* chunk: the same footer, the same page number, the same "Confidential — internal use". Those tokens dominate the embedding and make every chunk look like every other chunk. Cleaning is the cheapest recall improvement available, and it happens before any model is called.

---

## 3. Vectors — `src/lib/vectors.ts`

#### 📄 `src/lib/vectors.ts`

```ts
/**
 * Vector helpers.
 *
 * Vectors are stored unit-length, so cosine similarity is a plain dot product
 * and one less pass over the array per candidate. That is the same trick the
 * managed vector databases use when you choose the cosine metric.
 */

/** Scale a vector to unit length. A zero vector is returned unchanged. */
export function normalise(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;

  const length = Math.sqrt(sumSquares);
  if (length === 0) return [...vector];

  const unit = new Array<number>(vector.length);
  for (let i = 0; i < vector.length; i++) unit[i] = vector[i] / length;
  return unit;
}

/** Cosine similarity with a defensive fallback for non-normalised input. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}.`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
```

**Block by block:**

- **`normalise`** — divides by the L2 norm and returns `[...vector]` unchanged when the norm is zero. A zero vector has no direction; scaling it would produce `NaN` and poison every comparison downstream.
- **`cosineSimilarity`** — three accumulators in one loop (dot product, both norms). One pass, no intermediate arrays.
- **The dimension guard** — throws instead of returning a plausible-looking number. Comparing a 1024-dim query with a 1536-dim record is the single most common RAG configuration bug, and a thrown error surfaces it in the first test run.
- **`denominator === 0`** — returns `0` rather than `NaN`. A `NaN` score sorts unpredictably and silently corrupts top-K.

### Why store unit vectors

The mock provider returns normalised vectors, and for cosine that makes the similarity a plain dot product. The store still computes a real cosine so that an un-normalised vector from a future provider cannot produce a wrong ranking — correctness first, with the fast path available.

---

## 4. Retries — `src/lib/retry.ts`

#### 📄 `src/lib/retry.ts`

```ts
export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry transient failures with exponential backoff and jitter.
 *
 * Retrying a 400 is pointless — it will fail the same way three times and just
 * triples the latency. Only 429 and 5xx are retried; anything without a status
 * (connection reset, DNS blip) is assumed transient.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 300, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;

      onRetry?.(error, attempt);
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await sleep(delay);
    }
  }

  throw lastError;
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true;
}
```

**Block by block:**

- **`RetryOptions`** — attempts, base delay, and an `onRetry` hook so callers can log the attempt number without the helper depending on a logger.
- **`sleep`** — promise wrapper; the loop is `async`, so blocking the event loop is not an option.
- **`withRetry`** — tries, catches, checks `isRetryable`, waits, retries. It rethrows the **last** error, so the caller sees the real failure rather than a generic "retries exhausted".
- **`isRetryable`** — `429` and `5xx` are transient; `400`/`401`/`404` are permanent. Retrying a malformed request three times only triples the latency and hides the bug.
- **Jitter** — `baseDelay * 2^(attempt-1) * (0.5 + Math.random())`. The random factor matters when a hundred instances hit the same rate limit: without it they retry in lockstep and re-trigger it.

The helper is used by both provider adapters (chapters 05 and 10) and nowhere else. A retry hidden inside a domain service would make `ask()` retry the whole pipeline, duplicating embedding calls and sometimes duplicating charges.

---

## 5. Verify the Chapter

The demo prints what these helpers produce:

```text
refund-policy.md        6 chunks  first: "Refund window"
shipping-policy.md      7 chunks  first: "Delivery options"
warranty-policy.md      6 chunks  first: "Warranty covers"
indexed 19 chunks / 870 tokens
```

Three documents, 19 chunks, section headings preserved — that is `normaliseText` plus section splitting working. Chapters 03–04 consume exactly these functions.

**Next:** [Chapter 03 — Document Loading](./03_Document_Loading.md)
