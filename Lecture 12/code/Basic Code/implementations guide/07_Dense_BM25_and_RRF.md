# Chapter 07 — Dense, BM25 and RRF

> **Goal of this chapter:** build the **candidate set**. Two retrievers answer two
> different questions — dense answers *"what does this mean?"*, lexical answers
> *"what does this say?"* — and RRF merges their rankings because their scores are
> incomparable.
>
> **Lecture chapters:** [04](../../../notes/04_Top_K_and_Similarity_Thresholds.md)
> (the floor and the K, applied here) and
> [06](../../../notes/06_Hybrid_Search_and_RRF.md) (why dense fails on identifiers,
> BM25 in one line, RRF, the three implementation rules).

---

## 7.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/search.ts` |
| **Layer** | retrieval |
| **Purpose** | dense search (cosine + floor + K), BM25, RRF fusion, and the hybrid switch |
| **Imports** | `type Config`, `analyze`/`cosine`/`embed`, `type IndexedChunk` |
| **Exports** | `type Hit`, `denseSearch`, `bm25Search`, `rrfFuse`, `hybridSearch` |
| **Imported by** | `services/rerank.ts` (type only), `services/index.ts` |
| **Lecture sections** | 04 §"K is a budget", §"the threshold makes refusal possible"; 06 §"BM25", §"RRF", §"the three implementation rules" |

### The three implementation rules, and where they are enforced

| Rule (notes) | Enforced by |
|---|---|
| Same id space — fusion joins on `id` | `rrfFuse` keys on `hit.chunk.id` |
| Same filters on both retrievers | the caller passes one `eligible` array to both |
| Rename the score — after fusion it is RRF | the floor is applied in `denseSearch`, *before* fusion |

---

## 7.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run search -- "Does the AX-204 wireless headphone support fast charging?"
HYBRID=off npm run search -- "Does the AX-204 wireless headphone support fast charging?"
MIN_SCORE=0 npm run search -- "Who won the Indian Premier League in 2026?"
```

The first two commands are this chapter in one comparison: with `HYBRID=off` the
BX-900 crowds the AX-204; with `HYBRID=rrf` the exact SKU wins.

---

## 7.3 Full file

**Path:** `src/services/search.ts`

```ts
import type { Config } from "../config/config.js";
import type { Hit, IndexedChunk } from "../models/types.js";
import { analyze, cosine, embed } from "./embeddings.js";

/**
 * Chapters 04 and 06 — the two retrievers and their fusion.
 *
 * Order of operations (Chapter 04): **filter → search → threshold → cut at K**.
 * The caller filters, so both retrievers see exactly the same eligible set —
 * Chapter 05's "same filter on both retrievers".
 */

/** Chapter 04 — dense retrieval: meaning, with a floor and a K. */
export function denseSearch(chunks: IndexedChunk[], query: string, cfg: Config): Hit[] {
  const queryVector = embed(query);
  return chunks
    .map((chunk) => ({ chunk, score: cosine(queryVector, chunk.vector) }))
    .filter((hit) => hit.score >= cfg.minScore) // the floor makes refusal possible
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.kRetrieve); // K is a budget
}
```

```ts
/**
 * Chapter 06 — BM25: what the text *says*.
 *
 *   IDF            rare terms dominate — the SKU outweighs "fast"
 *   TF saturation  the 10th occurrence adds little (k1)
 *   length norm    long documents do not win by volume (b)
 */
export function bm25Search(chunks: IndexedChunk[], query: string, cfg: Config): Hit[] {
  const terms = analyze(query);
  const documentFrequency = new Map<string, number>();
  const tokensById = new Map<string, string[]>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = analyze(chunk.text);
    tokensById.set(chunk.id, tokens);
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = totalLength / Math.max(chunks.length, 1);

  const scored = chunks.map((chunk) => {
    const tokens = tokensById.get(chunk.id) ?? [];
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);

    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      const saturation = (frequency * (cfg.bm25K1 + 1)) /
        (frequency + cfg.bm25K1 * (1 - cfg.bm25B + cfg.bm25B * (tokens.length / averageLength)));
      score += idf * saturation;
    }
    return { chunk, score };
  });

  return scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.kRetrieve);
}
```

```ts
/**
 * Chapter 06 — Reciprocal Rank Fusion.
 *
 *   RRF(d) = Σ 1 / (k + rank_i(d)),  k = 60
 *
 * It fuses **ranks**, because a cosine score and a BM25 score are incomparable
 * scales. Two rules from the notes are enforced here: both lists share one id
 * space (we join on `chunk.id`), and the output score is renamed — after fusion
 * `score` is an RRF score (~0.016–0.033), never a similarity.
 */
export function rrfFuse(lists: Hit[][], k: number): Hit[] {
  const fused = new Map<string, Hit>();

  for (const list of lists) {
    list.forEach((hit, position) => {
      const contribution = 1 / (k + position + 1);
      const existing = fused.get(hit.chunk.id);
      if (existing) existing.score += contribution;
      else fused.set(hit.chunk.id, { chunk: hit.chunk, score: contribution });
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/**
 * Chapter 06 — hybrid: meaning **and** exact terms.
 * `off` keeps the naive baseline (dense only) so the ablation can prove the gain.
 */
export function hybridSearch(
  chunks: IndexedChunk[],
  query: string,
  cfg: Config,
): { dense: Hit[]; lexical: Hit[]; fused: Hit[] } {
  const dense = denseSearch(chunks, query, cfg);
  const lexical = cfg.hybrid === "rrf" ? bm25Search(chunks, query, cfg) : [];
  const fused = cfg.hybrid === "rrf" ? rrfFuse([dense, lexical], cfg.rrfK) : dense;
  return { dense, lexical, fused };
}
```

---

## 7.4 Block-by-block explanation

**Block 1 — `Hit`: one score, two meanings**

```ts
export type Hit = { chunk: IndexedChunk; score: number };
```

- One type for three different scores — a cosine, a BM25 value, an RRF value — and
  that is intentional, because the pipeline only ever *orders* by `score`. The
  notes' warning is about *comparing* them, and the code makes comparing them
  impossible: there is no place where a cosine is added to a BM25 value.
- After `rrfFuse`, the same field holds an RRF score. The comment in `rrfFuse` says
  so out loud — that is the "rename the score" rule, expressed as documentation
  because the type cannot express it.

**Block 2 — `denseSearch`: filter → threshold → sort → cut**

```ts
export function denseSearch(chunks: IndexedChunk[], query: string, cfg: Config): Hit[] {
  const queryVector = embed(query);
  return chunks
    .map((chunk) => ({ chunk, score: cosine(queryVector, chunk.vector) }))
    .filter((hit) => hit.score >= cfg.minScore) // the floor makes refusal possible
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.kRetrieve); // K is a budget
}
```

- The parameter is `chunks: IndexedChunk[]` — **already filtered**. That is
  Chapter 05's "same filter on both retrievers" enforced by the signature: there is
  no filter argument to forget.
- The four steps are exactly Chapter 04's order of operations: **filter** (done by
  the caller) → **search** (`map` + `cosine`) → **threshold** (`filter`) → **cut at
  K** (`slice`).
- The threshold sits **before** the sort on purpose. Conceptually a floor and a
  top-K are independent, but doing the cheap comparison first means the sort only
  sees surviving candidates.
- This is where the notes' central claim about refusal is implemented: *"without a
  floor, a grounded system can never say I don't know."* `minScore = 0` (the naive
  preset) makes this filter a no-op, and `MIN_SCORE=0 npm run search` shows the
  out-of-domain question still returning chunks.

**Block 3 — `bm25Search`, part 1: the corpus statistics**

```ts
  const terms = analyze(query);
  const documentFrequency = new Map<string, number>();
  const tokensById = new Map<string, string[]>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = analyze(chunk.text);
    tokensById.set(chunk.id, tokens);
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = totalLength / Math.max(chunks.length, 1);
```

- BM25 needs three corpus-level statistics before it can score anything: how many
  chunks contain each term (**document frequency**), how long each chunk is, and
  the **average** length.
- `new Set(tokens)` inside the loop is the detail that matters: `df` counts
  *documents containing* a term, so a term repeated five times in one chunk still
  increments `df` once. Getting this wrong turns IDF into a frequency measure.
- `Math.max(chunks.length, 1)` guards the empty-corpus division — the same
  defensive habit as `normalize`'s zero-length branch.
- `chunk.text` (breadcrumb + body) is what is analysed, so a query term that
  appears only in a *heading* still matches. That is the Chapter 04 breadcrumb
  decision showing up in the lexical retriever too.

**Block 4 — `bm25Search`, part 2: the scoring formula**

```ts
    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      const saturation = (frequency * (cfg.bm25K1 + 1)) /
        (frequency + cfg.bm25K1 * (1 - cfg.bm25B + cfg.bm25B * (tokens.length / averageLength)));
      score += idf * saturation;
    }
```

- This is the notes' formula, term by term:

  $$\text{BM25}(D,Q)=\sum_i \text{IDF}(q_i)\cdot\frac{f(q_i,D)(k_1+1)}{f(q_i,D)+k_1(1-b+b|D|/\text{avgdl})}$$

  - `idf` is the probabilistic IDF with the `+0.5` smoothing that keeps it
    positive even for a term that appears in every document.
  - `saturation` is the TF component: as `frequency` grows the fraction approaches
    `k1 + 1` rather than growing without bound — the "the 10th occurrence adds
    little" behaviour.
  - `tokens.length / averageLength` is the length normalisation; `b = 0.75` means it
    applies at 75% strength, so a long chunk does not win by volume alone.
- `score += idf * saturation` — IDF **multiplies**, it does not add. A rare term
  therefore multiplies a large number, which is why the SKU outweighs "fast" by
  roughly an order of magnitude in the output.
- `.filter((hit) => hit.score > 0)` drops every chunk that shares no term with the
  query. BM25 has **no threshold**: any nonzero match is a candidate. That is the
  honest asymmetry with dense search — and Chapter 12's ablation shows the
  consequence (recall up, refusal restored only by the rerank gate).

**Block 5 — `rrfFuse`: fuse ranks, not scores**

```ts
export function rrfFuse(lists: Hit[][], k: number): Hit[] {
  const fused = new Map<string, Hit>();

  for (const list of lists) {
    list.forEach((hit, position) => {
      const contribution = 1 / (k + position + 1);
      const existing = fused.get(hit.chunk.id);
      if (existing) existing.score += contribution;
      else fused.set(hit.chunk.id, { chunk: hit.chunk, score: contribution });
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}
```

- `lists: Hit[][]` — the function is variadic in the number of retrievers. Today it
  is called with two; adding a third (say, a title field) is one more element in
  the array.
- `position` is the zero-based index, so `position + 1` is the **rank**. The
  formula is exactly `RRF(d) = Σ 1/(k + rank_i(d))` with `k = 60`.
- `fused.get(hit.chunk.id)` is the **id-space rule**: fusion joins on the chunk id,
  which both retrievers carry unchanged. If the two lists used different ids (a
  UUID in one, a slug in the other) nothing would ever merge — and the bug would be
  silent, because the output would still look like a plausible ranking.
- `if (existing) existing.score += contribution` is the agreement reward. A
  document ranked 1st in both lists scores `2 × 1/61 ≈ 0.0328`; a document that
  wins one list and places 6th in the other scores `1/61 + 1/66 ≈ 0.0315`.
  **Agreement beats dominance** — the notes' headline property, visible in two
  numbers.
- The `k = 60` damping is why those two numbers are so close: with a smaller `k` the
  rank-1 win would dominate. The notes' table is reproduced by this function to
  three decimals.

**Block 6 — `hybridSearch`: one switch, two retrievers**

```ts
  const dense = denseSearch(chunks, query, cfg);
  const lexical = cfg.hybrid === "rrf" ? bm25Search(chunks, query, cfg) : [];
  const fused = cfg.hybrid === "rrf" ? rrfFuse([dense, lexical], cfg.rrfK) : dense;
```

- With `hybrid: "off"`, `lexical` is `[]` and `fused` is just `dense` — the naive
  baseline, with no extra branch anywhere else in the pipeline.
- With `hybrid: "rrf"`, both retrievers run over the **same** eligible array and the
  two lists are fused.
- Returning all three lists (`dense`, `lexical`, `fused`) rather than only the
  winner is what lets `npm run search` print the comparison, and what makes the
  notes' three rules inspectable rather than asserted.

---

## 7.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run search -- "Does the AX-204 wireless headphone support fast charging?"
```

Expected (excerpt):

```text
  1 · dense (cosine, above the floor) (5)
    0.5774  product-ax204  AX-204 Wireless Headphone Datasheet → Overview
    0.5092  product-ax204  AX-204 Wireless Headphone Datasheet → Warranty
    …

  2 · lexical (BM25) (10)
    8.9149  product-ax204  AX-204 Wireless Headphone Datasheet → Charging
    6.9584  product-ax204  AX-204 Wireless Headphone Datasheet → Overview
    …

  3 · fused (RRF, k = 60) (10)
    0.0328  product-ax204  AX-204 Wireless Headphone Datasheet → Charging
    0.0323  product-ax204  AX-204 Wireless Headphone Datasheet → Overview
    …
```

Three things to read out of that:

1. **Dense never reaches the "Charging" section first** — it prefers "Overview",
   because "headphone" and "wireless" dominate the vector and the SKU is only a few
   dimensions.
2. **BM25 puts "Charging" first by a wide margin** (`8.91`), because `ax-204` is rare
   and therefore carries a large IDF.
3. **RRF promotes the chunk that both retrievers like**, giving `0.0328` — an RRF
   score, not a similarity. This is why `minScore` must be applied before fusion.

---

## 7.6 Checkpoint

1. **Why can you not add a cosine score to a BM25 score?** Different,
   corpus-dependent scales — BM25 dominates numerically. Fuse by rank instead.
2. **What does `k = 60` do?** It damps the difference between rank 1 and rank 10 to
   about 13%, so agreement between the two lists matters more than winning one.
3. **Which rule does `rrfFuse` depend on, and what breaks without it?** The shared
   id space. Mismatched ids mean nothing merges — silently.

**Next:** [Chapter 08 — Reranking and the gate](./08_Reranking_and_the_Gate.md)



