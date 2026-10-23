# Chapter 05 — Embeddings and the Analyzer

> **Goal of this chapter:** define what "similar" means in this project, and see
> the two small functions that every later stage depends on: the **analyzer**
> (how text becomes tokens) and the **embedder** (how tokens become a vector).
>
> **Lecture chapters:** [03](../../../notes/03_Structural_Semantic_and_Contextual_Chunking.md)
> (embeddings are fixed-width summaries) and
> [06](../../../notes/06_Hybrid_Search_and_RRF.md) (the analyzer warnings: hyphen
> variants, negation words, case).

---

## 5.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/embeddings.ts` |
| **Layer** | ingest / retrieval |
| **Purpose** | tokenize text, and turn it into a unit-length vector; plus stopword-aware `contentTerms` for scorers |
| **Imports** | none |
| **Exports** | `DIMENSIONS`, `contentTerms`, `analyze`, `embed`, `normalize`, `cosine` |
| **Imported by** | `services/store.ts`, `search.ts`, `rerank.ts`, `generate.ts` |
| **Lecture sections** | 03 §"an embedding is a fixed-width summary", 06 §"analyzer warnings" |

---

## 5.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run typecheck
npm run search -- "Does the AX-204 wireless headphone support fast charging?"
```

The second command is the analyzer test: `AX-204` must survive lowercasing and
hyphen handling, or the SKU never matches.

---

## 5.3 Full file

**Path:** `src/services/embeddings.ts`

```ts
import { fnv1a } from "../utils/hash.js";

/**
 * Chapters 03 and 06 — the embedder and its analyzer.
 *
 * Offline and deterministic: each token is hashed into a fixed-width vector, so
 * the whole lecture runs with **no API key**. The honest limit from Chapter 04
 * applies — this is lexical, not semantic, so paraphrase is only findable
 * through BM25. Set a real embedding model and nothing else in the code changes.
 *
 * The hash itself lives in `utils/hash.ts` (Chapter 15) because the chunker needs
 * the same function.
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
```

---

## 5.4 Block-by-block explanation

**Block 1 — the dimension constant, and the honest limit**

```ts
export const DIMENSIONS = 256;
```

- A real embedding model emits 768–3072 dimensions. 256 is enough to keep hash
  collisions rare on this corpus and small enough to read in a debugger.
- The header comment records the limit out loud: *"this is lexical, not semantic,
  so paraphrase is only findable through BM25."* A reader who understands that
  sentence will not misread any number in Chapter 12's ablation table.

**Block 2 — stopwords, and the words that must never be stopwords**

```ts
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", ... "about",
]);
```

- These are dropped from **scoring helpers only** — never from BM25. BM25 has its
  own IDF mechanism for down-weighting common words, so filtering there would
  change the ranking function; the reranker and the extractive generator are
  simple scorers, so they need the filter.
- The list deliberately omits `not`, `no`, `except`, `never`, `only`, `without`.
  That is Chapter 06's rule — *"never drop negation words from a policy corpus"* —
  enforced by the code rather than remembered by a human. Dropping `not` from
  *"do not infer policy that is not stated"* would invert the policy.

**Block 3 — `contentTerms`: a `Set` and a filter**

```ts
export function contentTerms(text: string): string[] {
  return [...new Set(analyze(text))].filter((token) => !STOPWORDS.has(token));
}
```

- `new Set(analyze(text))` de-duplicates, so a term repeated five times in a
  sentence counts once. That is what makes coverage a *proportion* rather than a
  frequency — the reranker in Chapter 08 asks "how much of the question is
  present?", not "how often is it repeated?".
- `Set.has` is O(1), so the filter is linear in the number of tokens.

**Block 4 — the analyzer**

```ts
export function analyze(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const out: string[] = [];
  for (const token of tokens) {
    out.push(token);
    if (token.includes("-")) out.push(token.replace(/-/g, ""));
  }
  return out;
}
```

- `toLowerCase()` handles case: `AX-204`, `Ax-204` and `ax-204` become one term.
- The regex `[a-z0-9]+(?:-[a-z0-9]+)*` keeps internal hyphens **inside** a token,
  so `ax-204` is one token rather than `ax` + `204`.
- Then the loop emits **both** forms: `ax-204` *and* `ax204`. This is the notes'
  analyzer warning — *"index hyphen variants (`ax-204` and `ax204`)"* — because a
  user may type either. The token array is intentionally redundant here.
- `?? []` guards the case where `match` finds nothing (an empty or
  punctuation-only string), which would otherwise be `null`.

**Block 5 — hashing a token into a bucket**

```ts
function bucket(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
```

- The same FNV-1a as the chunk id, reused as a hash table. Deterministic: the same
  token always lands in the same bucket, which is what makes the whole project
  reproducible.
- `>>> 0` returns an unsigned 32-bit integer, so `h % DIMENSIONS` is never
  negative — which matters in the next block.

**Block 6 — `embed`: signed hashing**

```ts
export function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of analyze(text)) {
    const h = bucket(token);
    vector[h % DIMENSIONS] += (h & 0x100) === 0 ? 1 : -1;
  }
  return normalize(vector);
}
```

- **Bag of words, hashed.** Each token adds to one dimension; the vector is the
  distribution of the text's vocabulary. This is the "hashing trick" — a
  fixed-width vector with no vocabulary file to store.
- `(h & 0x100) === 0 ? 1 : -1` is **signed hashing**: one bit of the hash decides
  the sign. If two different tokens collide in the same bucket they cancel out more
  often than they add up, which keeps collisions from inflating similarity. Without
  the sign, every collision would look like shared meaning.
- `normalize` at the end is what makes `cosine` a pure dot product (Block 8).

**Block 7 — `normalize`**

```ts
export function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length === 0 ? vector : vector.map((value) => value / length);
}
```

- Divides by the Euclidean length, so every vector lies on the unit sphere.
- The `length === 0` branch is not decoration: an empty string (or a text of
  punctuation only) produces the zero vector, and dividing by zero would fill the
  vector with `NaN` — which then propagates silently through every cosine score.

**Block 8 — `cosine`, and why it is three lines**

```ts
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are already unit length
}
```

- Cosine similarity is `dot(a, b) / (|a| · |b|)`. Because `embed` already
  normalized both vectors, `|a| = |b| = 1` and the division disappears — the
  result is exactly the dot product.
- That is the metric Chapter 06's threshold is expressed in: `minScore` is a
  cosine value, and the notes' rule is that such a floor is *corpus-specific and
  must be calibrated*, never copied.

---

## 5.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run search -- "Does the AX-204 wireless headphone support fast charging?"
```

Expected (excerpt): BM25 ranks the AX-204 "Charging" chunk first with a score
around `8.9`, while dense search prefers the AX-204 *Overview* chunk at `0.5774`
and keeps the BX-900 nearby — the analyzer earning its keep.

---

## 5.6 Checkpoint

1. **Why does the analyzer emit two tokens for `ax-204`?** So a query typed as
   `ax204` still matches; the notes' analyzer warning is enforced here.
2. **Which words are deliberately missing from `STOPWORDS`?** `not`, `no`,
   `except`, `never`, `only` — dropping a negation inverts a policy.
3. **Why is `cosine` just a dot product?** Because `embed` normalizes every vector
   to unit length first.

**Next:** [Chapter 06 — The index and the eligibility filter](./06_The_Index_and_the_Eligibility_Filter.md)


