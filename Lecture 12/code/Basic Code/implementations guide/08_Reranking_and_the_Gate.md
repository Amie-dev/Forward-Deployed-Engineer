# Chapter 08 — Reranking and the Gate

> **Goal of this chapter:** reorder a small candidate set, and add the second
> refusal mechanism. Retrieval earns the right to be *considered*; reranking decides
> who is *heard* — over a candidate set it cannot enlarge.
>
> **Lecture chapter:** [07 — Reranking and Two-Stage Retrieval](../../../notes/07_Reranking_Two_Stage_Retrieval.md)
> (why two encoders, the numbers that decide the design, the gate, how to operate an
> optional stage).

---

## 8.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/rerank.ts` |
| **Layer** | ranking |
| **Purpose** | score query and chunk **jointly**, sort, and apply the gate |
| **Imports** | `type Config`, `contentTerms`, `type Hit` |
| **Exports** | `rerank` |
| **Imported by** | `services/index.ts` |
| **Lecture sections** | 07 §"why two encoders", §"the numbers that decide the design", §"operating it" |

### Bi-encoder vs this scorer

| | Bi-encoder (`embed` + `cosine`) | This reranker |
|---|---|---|
| Query + chunk | embedded **independently** | read **jointly** |
| Cost | one query vector + a dot product each | one pass per candidate |
| Role | recall | precision |
| Sees | "these are about similar things" | "these share *these* words, in this heading" |

---

## 8.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run search                    # shows the reranked list and the gate
RERANK=off npm run search         # the same candidates, fused order only
RERANK_MIN_BEST=0.9 npm run ask   # raise the gate until it refuses everything
```

---

## 8.3 Full file

**Path:** `src/services/rerank.ts`

```ts
import type { Config } from "../config/config.js";
import type { Hit } from "../models/types.js";
import { contentTerms } from "./embeddings.js";

/**
 * Chapter 07 — reranking and two-stage retrieval.
 *
 * Retrieval earns the right to be *considered*; reranking decides who is *heard*
 * — over a candidate set it cannot enlarge. A production system uses a
 * cross-encoder (query and document read **jointly**). Offline we use a joint
 * lexical scorer: coverage, exact phrase and heading match, which is exactly the
 * signal a bi-encoder cannot express.
 *
 * The gate is the second half of the chapter: if the best candidate cannot clear
 * `rerankMinBest`, the pipeline returns **nothing** and the answer refuses.
 */
export function rerank(
  query: string,
  candidates: Hit[],
  cfg: Config,
): { results: Hit[]; passed: boolean } {
  const terms = contentTerms(query);
  const phrase = query.toLowerCase().trim();

  const results = candidates
    .map((hit) => {
      const text = hit.chunk.text.toLowerCase();
      const matched = terms.filter((term) => text.includes(term)).length;
      const coverage = terms.length === 0 ? 0 : matched / terms.length;
      const exact = phrase.length > 0 && text.includes(phrase) ? 1 : 0;
      const heading = terms.some((term) => hit.chunk.breadcrumb.toLowerCase().includes(term)) ? 1 : 0;

      // A joint score in [0, 1], so the gate is a number a human can reason about.
      const score = Number((0.6 * coverage + 0.25 * exact + 0.15 * heading).toFixed(4));
      return { chunk: hit.chunk, score };
    })
    .sort((a, b) => b.score - a.score);

  const passed = results.length > 0 && results[0].score >= cfg.rerankMinBest;
  return { results, passed };
}
```

---

## 8.4 Block-by-block explanation

**Block 1 — the signature: candidates in, order out**

```ts
export function rerank(
  query: string,
  candidates: Hit[],
  cfg: Config,
): { results: Hit[]; passed: boolean } {
```

- `candidates` is what the pipeline already cut at `kRetrieve` — usually 10 or 20.
  The notes' constraint is explicit: **N is 10–20, at most 50**, because cost and
  latency scale linearly with N. The caller enforces that; this function trusts it.
- The return type carries **two** things: the new order *and* `passed`. That second
  field is the gate, and it is returned rather than thrown so the caller can decide
  what a failed gate means (here: an empty context and a refusal).
- Note what is *absent*: any way to add a candidate. "Reranking cannot create
  information" is a property of the signature.

**Block 2 — the joint features**

```ts
  const terms = contentTerms(query);
  const phrase = query.toLowerCase().trim();
```

- `contentTerms` strips stopwords and de-duplicates, so "does the ax-204 wireless
  headphone support fast charging?" becomes a short list of the words that carry
  meaning. A query of nine tokens where four are stopwords should not be scored as
  if it were nine.
- `phrase` is the whole query lowercased — used for the exact-phrase bonus. It is
  computed once, outside the loop, because it is the same for every candidate.

```ts
      const text = hit.chunk.text.toLowerCase();
      const matched = terms.filter((term) => text.includes(term)).length;
      const coverage = terms.length === 0 ? 0 : matched / terms.length;
      const exact = phrase.length > 0 && text.includes(phrase) ? 1 : 0;
      const heading = terms.some((term) => hit.chunk.breadcrumb.toLowerCase().includes(term)) ? 1 : 0;
```

- Three features, each answering a question a bi-encoder cannot:
  - **`coverage`** — what fraction of the query's content terms appear in the chunk?
    This is the joint reading of query *and* document: `terms` comes from one, `text`
    from the other, and the comparison happens here and nowhere else.
  - **`exact`** — does the chunk contain the query verbatim? For a SKU question this
    is the strongest possible signal, and embeddings routinely miss it.
  - **`heading`** — does any query term appear in the breadcrumb? A chunk whose
    *section name* answers the question is a better candidate than one that merely
    mentions the words in passing.
- `text` is `chunk.text`, i.e. breadcrumb **plus** body. So `heading` is a bonus on
  top of a text that already contains the heading — deliberately a *tie-break* that
  promotes the section that is actually about the topic.
- `terms.length === 0 ? 0 : ...` guards the degenerate query (all stopwords) so
  coverage is never `NaN`.

**Block 3 — the weighted score**

```ts
      const score = Number((0.6 * coverage + 0.25 * exact + 0.15 * heading).toFixed(4));
      return { chunk: hit.chunk, score };
```

- A convex combination: the weights sum to 1, so the score is always in `[0, 1]`.
  That property is the whole reason the gate can be a human-readable number.
- The weights encode a priority: **coverage dominates (0.6)**, an exact phrase is a
  strong but not decisive bonus (0.25), and a heading match breaks ties (0.15).
- `toFixed(4)` then `Number(...)` rounds the score, which keeps printed output stable
  and makes the sort deterministic when two candidates are close.
- **Compare this with a real cross-encoder.** A cross-encoder runs query and document
  through one transformer and emits a single relevance logit — it can represent
  interactions this linear sum cannot (negation, word order, implication). The
  scorer here is the *shape* of the stage, not its accuracy, and the file says so.

**Block 4 — the gate**

```ts
  const passed = results.length > 0 && results[0].score >= cfg.rerankMinBest;
  return { results, passed };
```

- `results[0]` is the best candidate after sorting, so this asks: *is the best thing
  we found good enough to answer from?*
- If not, `passed` is `false` and the pipeline assembles an **empty** context. That
  is Chapter 04's "the floor makes refusal possible" arriving through a second door —
  and it is needed here because BM25 has no floor of its own (Chapter 07).
- `results.length > 0` comes first so an empty candidate set can never index
  `results[0]` as `undefined`.
- The default is `0.2`, calibrated on this corpus: answerable questions score about
  0.27–0.62, while the off-topic question scores `0.0` — because its content terms
  (`won`, `indian`, `premier`, `league`, `2026`) appear nowhere in the eligible
  corpus. `RERANK_MIN_BEST=0.9 npm run ask` shows the other extreme: everything
  refuses.

---

## 8.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run search
```

Expected (excerpt):

```text
  3 · fused (RRF, k = 60) (10)
    0.0328  return-policy-electronics  Electronics Return Policy → Return window
    0.0318  return-policy-general  General Return Policy → Return window
    0.0318  damaged-product-policy  Damaged Product Reporting Policy → Exception
    …

  4 · reranked (joint score) (10)
    0.4167  return-policy-electronics  Electronics Return Policy → Return window
    0.4167  damaged-product-policy  Damaged Product Reporting Policy → Exception
    0.3500  return-policy-general  General Return Policy → Return window
    …

  Gate    : best 0.4167 vs 0.2 → pass
  Context : 4 blocks, ~259 tokens
```

Two things to notice:

1. **The fused order and the reranked order differ.** RRF had the general policy
   second (it appears in both lists); the reranker demotes it below the damaged
   policy, because `damaged` is a rare content term the general policy does not
   contain. That is "right document, wrong position" being fixed.
2. **The gate printed a decision.** `best 0.4167 vs 0.2 → pass` is the number a
   runbook would record; with an off-topic question the same line reads `REFUSE`.

---

## 8.6 Checkpoint

1. **What does a reranker change, and what can it not change?** The ordering of a
   fixed candidate set. It cannot add a candidate.
2. **Why is the score in `[0, 1]`?** The weights sum to 1 and each feature is 0–1, so
   the gate threshold is a number a human can reason about.
3. **Why is the gate needed when there is already a similarity floor?** Because BM25
   has no floor, so the lexical path would otherwise always supply *something* to
   answer from.

**Next:** [Chapter 09 — Context engineering](./09_Context_Engineering.md)


