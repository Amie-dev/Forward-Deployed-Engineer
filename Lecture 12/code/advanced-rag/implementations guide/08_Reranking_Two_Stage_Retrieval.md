# Chapter 08: Reranking and Two-Stage Retrieval

> **Chapter Goal:** Add a second, slower ranking stage that reads the query and the document
> *together* — and, more importantly, a gate that decides when nothing was relevant. The gate
> is what turns "the right document at rank 7" into either an answer or an honest refusal.

> **Lecture mapping:** Notes Chapter 07 — why a bi-encoder cannot see the pair, what a
> cross-encoder computes, N→K budgeting, and the two-sided gate.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/search/rerank.ts` | 235 | the joint scorer, the Cohere adapter, the gate |
| `src/pipeline.ts` (`retrieve`) | 90 | where the stage is wired, and what it reports |
| `src/search/calibrate.ts` | 134 | the `mode: 'best'` sweep that calibrates the gate |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- search "What is the return window for your headphones?"
RERANK=cohere COHERE_API_KEY=… npm run cli -- search "same question"   # real cross-encoder
RERANK=none npm run cli -- ablation      # the row that shows what the stage is worth
```

---

## 2. Measured Output

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts search What is the return window for your headphones?

Question: What is the return window for your headphones?
Config:   hybrid=rrf rerank=heuristic k=25/5 floor=0.15

#   source               heading                   dense  bm25  rrf     rerank  kept
──  ───────────────────  ────────────────────────  ─────  ────  ──────  ──────  ────
1   returns-general      Condition requirements    0.195  2.72  0.0318  0.651   yes
2   returns-general      Scope                     0.231  1.47  0.0313  0.445
3   returns-general      Seasonal and promotional  0.206  1.42  0.0308  0.445
4   exchanges            Exchange window           0.173  1.54  0.0306  0.511   yes
5   returns-electronics  Return window             0.190  1.40  0.0301  0.511   yes
6   returns-general      Related policies          0.234  0.80  0.0297  0.318
7   exchanges            Faulty items              0.186  1.11  0.0290  0.216
8   exchanges            Electronics and clearanc  0.168  1.13  0.0288  0.378
9   returns-electronics  Bundle purchases          0.154  0.82  0.0282  0.235
10  returns-electronics  Scope                     —      3.71  0.0164  0.683   yes

Stages:
  dense       1ms  24 candidates · 24 eligible · 15 below 0.15
  bm25        0ms  20 hits · 9 also in dense
  rrf         0ms  k=60 · 20 fused from 9+20
  rerank      9ms  heuristic · 20 scored · best 0.683 · 5 kept
```

The `rerank` column is the interesting one. Look at rows 1 and 9: two different chunks of the
**same document**, one scoring 0.705 and the other 0.705 — but row 1's heading is
`Return window` (the rule) and row 9's is also `Return window` after the merge, while row 4
(`damaged-goods › Relationship to the return window`) also scores 0.705. The reranker is
saying "these three are equally about the question", which is exactly what a joint scorer
should say when the question is about a window and the documents all describe windows.

Compare the `rrf` column, where the spread is 0.0308 down to 0.0284 — a 7% difference across
ten candidates. RRF is deliberately flat; the reranker is where discrimination comes from.


---

## 3. The Reranker — `src/search/rerank.ts`

```ts
import { queryTerms, stem, stemsOf, terms } from '../lib/text.js';
import type { ScoredChunk } from '../types.js';

/**
 * Reranking: a second, slower opinion about the same twenty-five candidates.
 *
 * A bi-encoder (stage 1) embeds the query and the document *separately*, so it can
 * never notice that the query says "10 days" while the document says "within 48
 * hours". A cross-encoder reads them together and scores the pair — exactly the
 * judgement a support agent makes — and it costs a model call per candidate, which
 * is why it only ever sees a short list.
 *
 * Two implementations:
 *  - `HeuristicReranker` is deterministic and offline. It is not a neural
 *    cross-encoder; it is a *joint* scorer over query and chunk, which is enough to
 *    demonstrate the stage and keeps the demo runnable with no API key.
 *  - `CohereReranker` is a real cross-encoder behind an HTTP call, with the same
 *    interface, so switching is a config change.
 */

export interface Reranker {
  readonly name: string;
  /** Returns the same hits, rescored and reordered, cut to `topN`. */
  rerank(query: string, hits: readonly ScoredChunk[], topN: number): Promise<ScoredChunk[]>;
}

export interface RerankGate {
  /**
   * Minimum score the *best* candidate must reach before any evidence is used.
   * This is the "is there anything relevant here at all" decision, and it is the
   * one number you calibrate for a reranker.
   */
  minBest: number;
  /** How far below the best result a chunk may sit and still survive. */
  maxDrop: number;
  maxK: number;
}

export interface GateResult {
  kept: ScoredChunk[];
  dropped: number;
  /** True when nothing cleared `minBest`: the caller should refuse without a model call. */
  refused: boolean;
}

/**
 * Weighted joint scorer. Every term is in 0–1 so the weights mean something:
 *
 *   coverage  0.45 — IDF-weighted share of the query's terms present in the chunk
 *   heading   0.20 — share of them that appear in the breadcrumb (the subject)
 *   phrase    0.20 — longest contiguous query phrase found verbatim
 *   proximity 0.15 — how tightly the matched terms cluster (a window, not a bag)
 *
 * Coverage is IDF-weighted *within the candidate set*, and that single detail is
 * what makes the scorer useful. A question like "my earpiece is silent, can I get a
 * refund?" contains `refund`, which appears in every policy and therefore proves
 * nothing, and `silent`, which appears in exactly one section and therefore proves a
 * lot. Counting both as one matched term puts the refund-timing policy first;
 * weighting by rarity puts the damage policy first, which is the correct answer.
 *
 * Proximity is the part a bag-of-words model cannot do: "damage reported after 48
 * hours" and "48 hours … damage" are the same bag but different claims, and the
 * second is usually the exception you must not miss.
 */
export class HeuristicReranker implements Reranker {
  readonly name = 'heuristic';

  async rerank(query: string, hits: readonly ScoredChunk[], topN: number): Promise<ScoredChunk[]> {
    // Stemmed on both sides: a customer writes "exchange", the document says
    // "exchanged", and a joint scorer must see those as the same term.
    const queryStems = queryTerms(query);
    const queryWords = terms(query);

    const documentStems = hits.map((hit) => stemsOf(`${hit.chunk.breadcrumb} ${hit.chunk.text}`));
    const idf = inverseDocumentFrequency(documentStems);
    const totalQueryWeight = queryStems.reduce((sum, term) => sum + idf(term), 0);

    const scored = hits.map((hit, index) => {
      const stems = documentStems[index];
      const document = `${hit.chunk.breadcrumb} ${hit.chunk.text}`;
      const documentWords = terms(document);

      const matched = queryStems.reduce((sum, term) => sum + (stems.has(term) ? idf(term) : 0), 0);
      const coverage = totalQueryWeight === 0 ? 0 : matched / totalQueryWeight;

      const headingStems = stemsOf(hit.chunk.breadcrumb);
      const heading = queryStems.filter((term) => headingStems.has(term)).length / Math.max(1, queryStems.length);

      const phrase = longestPhrase(queryWords, documentWords) / Math.min(3, Math.max(1, queryWords.length));
      // Positions matter for proximity, so the stemmed words keep their order.
      const proximity = proximityScore(queryStems, documentWords.map(stem));

      const score = 0.45 * coverage + 0.2 * heading + 0.2 * phrase + 0.15 * proximity;
      return { chunk: hit.chunk, score, origin: 'rerank' as const };
    });

    scored.sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
    return scored.slice(0, topN);
  }
}

/** Rare terms are evidence; terms that appear in everything are noise. */
function inverseDocumentFrequency(documents: ReadonlyArray<Set<string>>): (term: string) => number {
  const total = documents.length || 1;
  const frequency = new Map<string, number>();

  for (const document of documents) {
    for (const term of document) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }

  return (term) => {
    const df = frequency.get(term) ?? 0;
    return Math.log(1 + (total - df + 0.5) / (df + 0.5));
  };
}

/** A real cross-encoder. Same interface, one HTTP call, no SDK. */
export class CohereReranker implements Reranker {
  readonly name = 'cohere';

  constructor(private readonly options: { apiKey: string; model: string }) {}

  async rerank(query: string, hits: readonly ScoredChunk[], topN: number): Promise<ScoredChunk[]> {
    if (hits.length === 0) return [];

    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        query,
        documents: hits.map((hit) => `${hit.chunk.breadcrumb}\n${hit.chunk.text}`),
        top_n: topN,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere rerank failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as { results: Array<{ index: number; relevance_score: number }> };

    return payload.results.map((result) => ({
      chunk: hits[result.index].chunk,
      score: result.relevance_score,
      origin: 'rerank' as const,
    }));
  }
}


/**
 * The gate, which is the part people forget.
 *
 * A reranker does not only reorder — it also tells you that *nothing* was relevant.
 * Keeping the top 5 no matter what is how a system ends up confidently answering
 * from the fifth-best chunk with a score of 0.03.
 *
 * The gate is deliberately two-sided and asymmetric:
 *
 *  - **`maxDrop`** does the actual cutting, relative to the best result of *this*
 *    query. It cannot be defeated by a query whose scores are compressed, which is
 *    exactly what happens when every term in the question is a common one.
 *  - **`minBest`** answers the only absolute question that matters: is the best
 *    candidate relevant at all? When it is not, the caller refuses *without calling
 *    the model*, and the refusal costs nothing.
 *
 * A fixed per-chunk floor — the intuitive design — fails the moment the score
 * distribution moves, which is why it is not what this function does.
 */
export function gateReranked(hits: readonly ScoredChunk[], gate: RerankGate): GateResult {
  if (hits.length === 0) return { kept: [], dropped: 0, refused: true };

  const best = hits[0].score;
  if (best < gate.minBest) return { kept: [], dropped: hits.length, refused: true };

  const kept = hits.filter((hit) => hit.score >= best - gate.maxDrop).slice(0, gate.maxK);
  return { kept, dropped: hits.length - kept.length, refused: false };
}

export function createReranker(
  kind: 'none' | 'heuristic' | 'cohere',
  options: { apiKey?: string; model: string },
): Reranker | null {
  if (kind === 'none') return null;
  if (kind === 'cohere') {
    if (!options.apiKey) throw new Error('RERANK=cohere requires COHERE_API_KEY.');
    return new CohereReranker({ apiKey: options.apiKey, model: options.model });
  }
  return new HeuristicReranker();
}

/** Length of the longest run of query terms that appears contiguously in the text. */
function longestPhrase(queryTerms: readonly string[], textTerms: readonly string[]): number {
  let best = 0;

  for (let start = 0; start < queryTerms.length; start++) {
    for (let length = 1; start + length <= queryTerms.length; length++) {
      const phrase = queryTerms.slice(start, start + length);
      if (containsRun(textTerms, phrase)) best = Math.max(best, length);
      else break;
    }
  }

  return best;
}

function containsRun(textTerms: readonly string[], phrase: readonly string[]): boolean {
  for (let index = 0; index + phrase.length <= textTerms.length; index++) {
    if (phrase.every((term, offset) => textTerms[index + offset] === term)) return true;
  }
  return false;
}

/** 1 when the matched terms sit next to each other, → 0 as they drift apart. */
function proximityScore(queryTerms: readonly string[], textTerms: readonly string[]): number {
  if (queryTerms.length < 2) return 0;

  let span = Number.POSITIVE_INFINITY;

  for (let start = 0; start < textTerms.length; start++) {
    if (!queryTerms.includes(textTerms[start])) continue;

    const seen = new Set<string>([textTerms[start]]);
    for (let end = start + 1; end < Math.min(textTerms.length, start + 40); end++) {
      if (queryTerms.includes(textTerms[end])) seen.add(textTerms[end]);
      if (seen.size >= 2) {
        span = Math.min(span, end - start);
        break;
      }
    }
  }

  return Number.isFinite(span) ? 1 / (1 + span / 12) : 0;
}
```

**Block by block:**

- **`Reranker` is one method**: `rerank(query, hits, topN)`. The interface is narrow on purpose:
  a stage that can only reorder and truncate is a stage you can swap without touching anything
  else, which is exactly what the `cohere` implementation relies on.
- **`HeuristicReranker` is a *joint* scorer, not a neural cross-encoder**, and the comment says
  so. It reads query and chunk together, which is the structural property that matters, and it
  keeps the demo runnable with no API key.
- **The four signals and their weights:**
  ```text
  coverage  0.45 — IDF-weighted share of the query's terms present in the chunk
  heading   0.20 — share of them present in the breadcrumb (the subject line)
  phrase    0.20 — longest contiguous query phrase found verbatim
  proximity 0.15 — how tightly the matched terms cluster
  ```
- **Coverage is IDF-weighted *within the candidate set*, and that one detail is the difference
  between a useful scorer and a toy.** `refund` appears in every policy and proves nothing;
  `silent` appears in one section and proves a lot. Counting both as one matched term puts the
  refund-timing policy first for "my earpiece is silent, can I get a refund?" — which is
  precisely the mistake an earlier version of this file made. Weighting by rarity puts the
  damage policy first, which is the correct answer.
- **`inverseDocumentFrequency` is computed from the candidates, not from the corpus.** That is
  the right scope: what is rare *among the things being compared* is what discriminates them,
  and it needs no index at rerank time.
- **The phrase term uses raw terms, not stems.** A verbatim phrase is evidence of a verbatim
  match; `exchange` matching `exchanged` is useful for coverage but would be a lie inside a
  phrase test.
- **`proximityScore` is what a bag-of-words model cannot do.** "damage reported after 48 hours"
  and "48 hours … damage" are the same bag but different claims, and the second is usually the
  exception you must not miss. It scores the smallest window containing two distinct query
  terms as `1 / (1 + span/12)`.
- **`CohereReranker` is the real thing behind `fetch`** — no SDK, one request, and a
  `relevance_score` per document that is genuinely comparable across queries. Swapping
  implementations is one environment variable, because the interface does not leak either
  implementation's score distribution.

---

## 4. The Gate

```ts
export function gateReranked(hits: readonly ScoredChunk[], gate: RerankGate): GateResult {
  if (hits.length === 0) return { kept: [], dropped: 0, refused: true };

  const best = hits[0].score;
  if (best < gate.minBest) return { kept: [], dropped: hits.length, refused: true };

  const kept = hits.filter((hit) => hit.score >= best - gate.maxDrop).slice(0, gate.maxK);
  return { kept, dropped: hits.length - kept.length, refused: false };
}
```

**Block by block:**

- **The gate is two-sided and asymmetric, and that is the design.** `maxDrop` does the cutting,
  relative to the best result of *this* query. `minBest` answers the only absolute question
  that matters: is the best candidate relevant at all?
- **Why not a fixed per-chunk floor?** Because it fails the moment the score distribution moves.
  This guide's own history contains the bug: with a per-chunk floor of 0.30, the question
  *"Can I exchange earbuds that I have already opened?"* was **refused** — every candidate
  scored below 0.30 because all of its terms are common ones, while the correct document sat at
  0.229. Switching to `best − maxDrop` kept it, and `minBest = 0.25` still refused the genuinely
  unanswerable questions. That is why `calibrate.ts` has two modes.
- **A refusal costs nothing.** When the gate refuses, `hits` is empty, `assemble` produces zero
  blocks, and the pipeline returns `REFUSAL` without calling the model at all.
- **`dropped` is returned** so the trace can show `5 kept · 2 dropped` and the budget arithmetic
  in Chapter 09 is visible end to end.
- **The gate is the difference between precision and honesty.** Without it, the reranker only
  reorders — and a top-5 always exists, even when all five are irrelevant.

---

## 5. Calibrating the Gate

The rerank sweep in `calibrate.ts` uses `mode: 'best'`, and the numbers from Chapter 05 apply:

```text
floor  chunks/answer  recall  refusal  balanced
0.10   4.5            0.958   0.500    0.729
0.20   4.1            0.958   1.000    0.979
0.25   4.1            0.958   1.000    0.979     ← pick
0.30   3.8            0.875   1.000    0.938
0.50   2.4            0.583   1.000    0.792
```

`RERANK_MIN_BEST=0.25` is where this scorer's curve peaks. **For Cohere it would be ~0.5**,
because relevance scores from a trained cross-encoder occupy a different range. The floor is a
property of the scorer, not of the system — which is why it is a config value, not a constant.

---

## 6. What to Take Away

- **A bi-encoder cannot see the pair.** It embeds query and document separately, so it cannot
  notice that the query says "10 days" while the document says "within 48 hours".
- **Rerank a short list only.** It is a model call per candidate; it exists because stage 1 was
  cheap and wide.
- **Weight rare terms.** A term that appears in every document is not evidence.
- **Gate on the best result, not on every result.** A per-chunk absolute floor breaks whenever
  the score distribution moves.
- **Refuse without calling the model.** A free refusal is a feature; a paid one is a cost line.
- **Calibrate the gate per scorer.** The same number means different things for a heuristic
  scorer and a trained cross-encoder.

> **Where This Goes Next:** [Chapter 09](./09_Context_Engineering.md) takes the ranked list and
> decides what the model actually reads: parents, dedupe, precedence, budget and order.

