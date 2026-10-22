# Chapter 07: Hybrid Search and RRF

> **Chapter Goal:** Add the second retrieval arm and fuse two incomparable rankings without
> pretending their scores are comparable. This chapter is where exact strings — SKUs, error
> codes, version numbers, dates — stop being invisible.

> **Lecture mapping:** Notes Chapter 06 — why dense retrieval loses exact terms, BM25 from
> first principles, reciprocal rank fusion, and the reason fusion must use ranks rather than
> scores.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/search/bm25.ts` | 124 | postings, idf, length normalisation, coverage helper |
| `src/search/hybrid.ts` | 99 | RRF, the agreement metric, and the score-fusion anti-pattern |
| `src/pipeline.ts` (`retrieve`) | 90 | the two arms, the fusion, and the trace detail |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- search "Is the AX-204 still covered after 18 months?"
HYBRID=off npm run cli -- search "Is the AX-204 still covered after 18 months?"
```

---

## 2. Measured Output

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts search Is the AX-204 still covered after 18 months?

Question: Is the AX-204 still covered after 18 months?
Config:   hybrid=rrf rerank=heuristic k=25/5 floor=0.15

#  source               heading              dense  bm25   rrf     rerank  kept
─  ───────────────────  ───────────────────  ─────  ─────  ──────  ──────  ────
1  warranty             Coverage by product  0.296  10.47  0.0328  0.770   yes
2  returns-electronics  Scope                0.182  2.34   0.0323  0.397
3  damaged-goods        Reporting window     —      2.08   0.0159  0.105
4  returns-electronics  Exclusions           0.158  —      0.0159  0.067
5  returns-electronics  Return window        0.150  —      0.0156  0.105
6  warranty             Warranty start date  —      1.90   0.0156  0.105

Stages:
  dense       1ms  24 candidates · 24 eligible · 20 below 0.15
  bm25        0ms  4 hits · 2 also in dense
  rrf         0ms  k=60 · 6 fused from 4+4
  rerank      1ms  heuristic · 6 scored · best 0.770 · 1 kept
```

Read the `bm25` column: **10.47** for the warranty document, against **2.34** for the next
best. A dense retriever has no way to produce a gap like that, because `AX-204` is a token
rather than a concept — and the offline embedder's cosine for the same pair is 0.296, barely
above the 0.15 floor.

This is the whole argument for hybrid search in one row. The dense arm brings "which policy
is about warranties"; the lexical arm brings "this specific SKU is named here". Run the same
query with `HYBRID=off` and the warranty document still wins on this corpus — but with
`EMBEDDING_PROVIDER=openai` and a larger catalogue, the dense arm happily returns a
semantically similar *different* product, which is the failure the notes describe.


---

## 3. BM25 — `src/search/bm25.ts`

```ts
import { terms } from '../lib/text.js';
import type { DocMeta, IndexRecord, ScoredChunk } from '../types.js';

/**
 * BM25 — the lexical half of hybrid search, implemented rather than imported.
 *
 * Why not a library: BM25 is six formulas, and every one of them explains a
 * failure mode you will meet in production.
 *
 *   idf(t)    = ln(1 + (N − df + 0.5) / (df + 0.5))     rare terms matter more
 *   tfNorm    = tf·(k1 + 1) / (tf + k1·(1 − b + b·|d|/avgdl))
 *   score(q,d)= Σ idf(t) · tfNorm(t,d)
 *
 * `k1` controls how quickly repeated terms stop helping (1.2 is the usual
 * saturation point). `b` controls length normalisation: 1 = fully normalised,
 * 0 = not at all. On policy documents, where one long document would otherwise
 * outrank every short one, 0.75 is a sane default.
 *
 * The reason this exists at all: dense retrieval is bad at exact strings. An SKU
 * ("AX-204"), an error code, a version number and a date are *tokens*, not
 * concepts, and a bi-encoder happily returns a semantically similar product.
 */

export interface Bm25Options {
  k1: number;
  b: number;
}

export class Bm25Index {
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly lengths: number[] = [];
  private readonly records: readonly IndexRecord[];
  private readonly idf = new Map<string, number>();
  private readonly averageLength: number;
  private readonly options: Bm25Options;

  constructor(records: readonly IndexRecord[], options: Bm25Options) {
    this.records = records;
    this.options = options;

    let totalLength = 0;

    records.forEach((record, index) => {
      // The heading is part of the searchable text: "Return window" must match
      // "return window", even when the phrase is only in the heading.
      const tokens = terms(`${record.breadcrumb} ${record.text}`);
      this.lengths[index] = tokens.length;
      totalLength += tokens.length;

      for (const token of tokens) {
        let posting = this.postings.get(token);
        if (!posting) {
          posting = new Map<number, number>();
          this.postings.set(token, posting);
        }
        posting.set(index, (posting.get(index) ?? 0) + 1);
      }
    });

    this.averageLength = records.length === 0 ? 0 : totalLength / records.length;

    const total = records.length;
    for (const [token, posting] of this.postings) {
      const df = posting.size;
      this.idf.set(token, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
    }
  }

  /** How many documents contain a term — the `df` a reviewer will ask for. */
  documentFrequency(token: string): number {
    return this.postings.get(token.toLowerCase())?.size ?? 0;
  }

  search(query: string, topK: number, predicate?: (meta: DocMeta) => boolean): ScoredChunk[] {
    const queryTerms = [...new Set(terms(query).filter((term) => !STOP.has(term)))];
    const scores = new Array<number>(this.records.length).fill(0);

    for (const term of queryTerms) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const idf = this.idf.get(term) ?? 0;

      for (const [index, tf] of posting) {
        const length = this.lengths[index] || 1;
        const denominator =
          tf + this.options.k1 * (1 - this.options.b + (this.options.b * length) / this.averageLength);
        scores[index] += idf * ((tf * (this.options.k1 + 1)) / denominator);
      }
    }

    const hits: ScoredChunk[] = [];

    this.records.forEach((record, index) => {
      const score = scores[index];
      if (score <= 0) return;
      if (predicate && !predicate(record.meta)) return;

      const { vector: _vector, embedText: _embedText, ...chunk } = record;
      hits.push({ chunk, score, origin: 'lexical' });
    });

    hits.sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
    return hits.slice(0, topK);
  }

  /** Terms shared by query and text — used by the offline reranker. */
  coverage(query: string, text: string): number {
    const queryTerms = [...new Set(terms(query).filter((term) => !STOP.has(term)))];
    if (queryTerms.length === 0) return 0;

    const textTerms = new Set(terms(text));
    let hits = 0;
    for (const term of queryTerms) if (textTerms.has(term)) hits++;
    return hits / queryTerms.length;
  }
}

/** Query-side stopwords only. Removing them from documents costs recall. */
const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'for', 'of',
  'to', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'if', 'it', 'its', 'this', 'that', 'my', 'i',
  'what', 'how', 'when', 'where', 'which', 'who', 'why', 'you', 'your', 'we', 'our', 'still', 'after',
]);
```

**Block by block:**

- **Why not a library:** BM25 is six formulas, and every one of them explains a failure mode
  you will meet in production. Reading 120 lines once is cheaper than debugging a black box.
- **The formulas, in the order they are used:**
  ```text
  idf(t)     = ln(1 + (N − df + 0.5) / (df + 0.5))        rare terms matter more
  tfNorm     = tf · (k1 + 1) / (tf + k1 · (1 − b + b·|d|/avgdl))
  score(q,d) = Σ idf(t) · tfNorm(t,d)
  ```
- **`k1 = 1.2` controls saturation.** The second occurrence of a term adds less than the
  first; by the fourth or fifth, it adds almost nothing. Raising `k1` makes the score grow
  more linearly with term frequency, which mostly rewards long documents.
- **`b = 0.75` controls length normalisation.** `b = 1` fully normalises by document length,
  `b = 0` not at all. On policy corpora — where one long document would otherwise outrank
  every short one — 0.75 is the sane default.
- **The index is built over `breadcrumb + text`**, so a chunk whose heading is "Return window"
  matches "return window" even when the phrase appears only in the heading. The heading is
  part of the evidence.
- **The postings map is `term → (docIndex → termFrequency)`.** Rebuilt at boot from the same
  records the vector store holds, which keeps the two arms provably in sync: there is no
  second ingestion path to forget.
- **`documentFrequency` is exposed** because when BM25 misranks something, the first question
  is whether the term is rare (`df` small, idf high) or common (`df` large, idf ≈ 0). It is a
  one-line debugging affordance that saves an hour.
- **The query side drops stopwords; the document side does not.** Removing stopwords from
  documents costs recall (they are part of phrases), while removing them from a query only
  stops noise terms from matching everything.
- **`coverage` is exported for the reranker in Chapter 08** — one definition of "which query
  terms are present", used by both stages.

---

## 4. Fusion — `src/search/hybrid.ts`

```ts
import type { ScoredChunk } from '../types.js';

/**
 * Reciprocal Rank Fusion — and the mistake it exists to prevent.
 *
 * RRF ignores the scores entirely and fuses *ranks*:
 *
 *     score(doc) = Σ over lists  1 / (k + rank_in_list(doc)),   k = 60
 *
 * The constant `k` damps the top of each list. With k = 60, rank 1 contributes
 * 1/61 = 0.01639 and rank 10 contributes 1/70 = 0.01429 — a 13% difference
 * instead of a 10× difference. That is deliberate: a bi-encoder's 0.83 versus
 * 0.81 says almost nothing, while BM25's 12.4 versus 9.1 says a lot, and there is
 * no principled way to put those two numbers on one scale.
 *
 * `scoreFusion` below is the anti-pattern, kept in the file on purpose. It looks
 * reasonable, it runs, and it silently deletes one of the two signals.
 */

export interface HybridOptions {
  /** RRF constant. 60 is the value from the original paper and a safe default. */
  rrfK: number;
  /** How deep to read each list. Fusing 100 ranks is not better than fusing 25. */
  depth: number;
}

export interface HybridResult {
  hits: ScoredChunk[];
  /** Documents that appeared in both lists — the ones hybrid search rescued. */
  agreement: number;
  denseMs: number;
  lexicalMs: number;
}

/**
 * Fuse ranked lists. Rank starts at 1, not 0: `1/(60+0)` would make the top hit
 * contribute more than the entire rest of the list combined.
 */
export function rrf(lists: ReadonlyArray<readonly ScoredChunk[]>, k: number, depth = 100): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk['chunk']; score: number; bestRank: number }>();

  for (const list of lists) {
    list.slice(0, depth).forEach((hit, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const existing = fused.get(hit.chunk.id);

      if (existing) {
        existing.score += contribution;
        existing.bestRank = Math.min(existing.bestRank, rank);
      } else {
        fused.set(hit.chunk.id, { chunk: hit.chunk, score: contribution, bestRank: rank });
      }
    });
  }

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank || left.chunk.id.localeCompare(right.chunk.id))
    .map((entry) => ({ chunk: entry.chunk, score: entry.score, origin: 'fused' as const }));
}

/**
 * The anti-pattern: normalise each list by its own maximum, then add the numbers.
 *
 * It fails because normalisation preserves *shape*, not *meaning*. BM25 scores are
 * unbounded and often spread over 0–15; cosine scores live in a narrow band around
 * 0.2–0.9. Dividing each by its max makes both top out at 1.0, so a document that
 * BM25 loved twice as much as the next one looks identical to a document that the
 * bi-encoder merely liked. Worse, a single outlier flattens every other score in
 * the list toward zero, and the other signal takes over.
 */
export function scoreFusion(
  lists: ReadonlyArray<readonly ScoredChunk[]>,
  weights: readonly number[],
): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk['chunk']; score: number }>();

  lists.forEach((list, listIndex) => {
    const max = Math.max(...list.map((hit) => hit.score), Number.EPSILON);
    const weight = weights[listIndex] ?? 1;

    for (const hit of list) {
      const contribution = (hit.score / max) * weight;
      const existing = fused.get(hit.chunk.id);
      if (existing) existing.score += contribution;
      else fused.set(hit.chunk.id, { chunk: hit.chunk, score: contribution });
    }
  });

  return [...fused.values()]
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({ chunk: entry.chunk, score: entry.score, origin: 'fused' as const }));
}

/** How many documents the two lists agree on — the number that predicts the gain. */
export function agreement(dense: readonly ScoredChunk[], lexical: readonly ScoredChunk[]): number {
  const denseIds = new Set(dense.map((hit) => hit.chunk.id));
  return lexical.filter((hit) => denseIds.has(hit.chunk.id)).length;
}
```

**Block by block:**

- **RRF ignores the scores entirely:**
  ```text
  score(doc) = Σ over lists  1 / (k + rank_in_list(doc)),   k = 60
  ```
- **`k` damps the top of each list.** At `k = 60`, rank 1 contributes `1/61 = 0.01639` and
  rank 10 contributes `1/70 = 0.01429` — a 13% difference instead of a 10× difference. That
  is deliberate: a bi-encoder's 0.83 versus 0.81 says almost nothing, while BM25's 12.4 versus
  9.1 says a lot, and there is no principled way to put those two numbers on one scale.
- **Ranks start at 1, not 0.** `1/(60+0)` would make the top hit contribute more than the
  rest of the list combined, which is a different (and much worse) algorithm.
- **`bestRank` is carried as a tie-break.** Two documents with the same fused score are
  ordered by the best rank either arm gave them, then by id — so the output is deterministic.
  Non-deterministic ranking is a debugging nightmare and it makes evaluation numbers wobble
  between runs.
- **`depth` caps how far down each list is read.** Fusing 100 ranks is not better than fusing
  25; it just gives low-ranked noise a vote.
- **`agreement` counts the documents both arms returned.** It is the number that predicts
  whether hybrid search will help: high agreement means the arms see the same thing (little
  gain), low agreement means one arm knows something the other does not (large gain). On the
  SKU query it is 2 of 4 — a small, exact set, which is exactly where hybrid pays.
- **`scoreFusion` is the anti-pattern, kept in the file on purpose.** It normalises each list
  by its own maximum and adds the numbers. It runs, it looks reasonable, and it silently
  deletes one of the two signals: normalisation preserves *shape*, not *meaning*, so a single
  outlier flattens every other score in the list toward zero and the other arm takes over.
  The notes describe this bug; here it is, four lines long, next to the correct version.

---

## 5. What to Take Away

- **Exact strings are tokens, not concepts.** A SKU, an error code, a version number and a
  date are all things a bi-encoder will happily confuse with something similar.
- **Fuse ranks, not scores.** Two ranking systems with different scales cannot be added.
- **`k = 60` is a damping constant, not a tuning knob.** It exists so that rank 1 is not
  king; move it only if you can explain what changes.
- **Make the fusion deterministic.** Tie-break on rank, then id.
- **Report agreement.** It tells you whether the second arm is earning its latency.
- **Keep the anti-pattern in the code, commented.** A bug you can run is a lesson; a bug in a
  slide is trivia.

> **Where This Goes Next:** [Chapter 08](./08_Reranking_Two_Stage_Retrieval.md) adds the
> second, slower opinion about the same candidates — and the gate that decides when *nothing*
> was relevant.

