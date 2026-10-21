# Chapter 07: Retrieval and Hybrid Scoring

> **Chapter Goal:** Turn a question into a short, ordered, trustworthy list of chunks — or into nothing at all. The refusal path depends on this chapter being honest about scores.

> **Lecture mapping:** Notes Chapter 05 — query embedding, top-K, score floors, filters, hybrid search, and the fact that a similarity score is not a confidence.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/retrieval/lexical.ts` | 28 | Keyword overlap with a cheap stemmer. |
| `src/retrieval/retriever.ts` | 68 | Embed → over-fetch → blend → floor → top-K. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run ask -- "What is the refund window for apparel?"
#   [1] ok      refund-policy.md · Refund window (score 0.642)
#   [2] ok      refund-policy.md · Exchanges (score 0.444)
#   [3] ok      refund-policy.md · How to start a refund (score 0.273)

npm run ask -- "Can I pay with Bitcoin?"
# I don't have that information in the company documents.
# [trace] candidates=12 matches=0 refused=true generate=0ms
```

Now disable the lexical half and watch the ranking flatten:

```bash
HYBRID_LEXICAL_WEIGHT=0 npm run ask -- "How long does a refund take to reach my account?"
```

With pure cosine the top chunk is "How to start a refund" — lexically close, semantically wrong. With the blend, "Refund timing" wins.

---

## 2. Lexical Scoring — `src/retrieval/lexical.ts`

#### 📄 `src/retrieval/lexical.ts`

```ts
import { contentWords } from '../lib/text.js';

/** Five characters is enough to group refund/refunds and ship/shipping. */
function stem(word: string): string {
  return word.slice(0, 5);
}

/**
 * Share of the question's content words that appear in the chunk.
 *
 * Cosine similarity answers "are these about the same thing?"; this answers "does
 * this text literally contain what was asked?". Blending the two is hybrid search
 * in miniature — it fixes the case where a long, vaguely-related chunk outranks a
 * short, exact one purely because cosine divides by length.
 */
export function lexicalOverlap(query: string, text: string): number {
  const queryStems = new Set(contentWords(query).map(stem));
  if (queryStems.size === 0) return 0;

  const textStems = new Set(contentWords(text).map(stem));
  let shared = 0;
  for (const stemmed of queryStems) {
    if (textStems.has(stemmed)) shared++;
  }

  return shared / queryStems.size;
}
```

**Block by block:**

- **`stem(word)` — five characters** — `refund`/`refunds` → `refun`, `ship`/`shipping` → `ship`, `day`/`days` → `day`. Not linguistics; just enough to stop a plural from breaking a match.
- **`lexicalOverlap(query, text)`** — `shared / |queryStems|`. The denominator is the **query**, not the document. That is what makes the score comparable across chunks of different lengths, unlike cosine which divides by both norms.
- **The empty-query guard** — `0` instead of `NaN`. A question made entirely of stopwords has no lexical signal, and pretending otherwise would divide by zero.
- **What the caller passes** — `section + text`, so a chunk from the "Refund timing" section gets credit for the words in its heading. The heading is part of the evidence.

### Why blend at all

Cosine answers *"are these about the same thing?"* Lexical overlap answers *"does this text literally contain what was asked?"*. They fail in opposite directions:

| Query | Pure cosine | Pure lexical |
| :--- | :--- | :--- |
| "return shoes" (docs say *footwear*) | no shared words, weak | no shared words, zero |
| "how long does a refund take" | diluted by long chunks | finds "refund", misses "timing" |
| "express delivery cost" | good | good |

A blend is not a semantic model — it is a tie-breaker that favours the chunk which actually contains the words. At 0.35 the vector signal still dominates, but a short exact match can beat a long vague one.

---

## 3. The Retriever — `src/retrieval/retriever.ts`

#### 📄 `src/retrieval/retriever.ts`

```ts
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { VectorStore } from '../store/vector-store.js';
import type { Match } from '../types/rag.types.js';
import { lexicalOverlap } from './lexical.js';

export interface RetrievalOptions {
  topK: number;
  /** How many candidates to fetch per requested result, before the score floor. */
  candidateMultiplier: number;
  /** Similarity floor. Calibrate it on a golden set; never guess. */
  minScore: number;
  /** 0 = pure vector search, 1 = pure keyword matching. 0.3–0.4 is a good start. */
  lexicalWeight: number;
}

export interface RetrievalResult {
  matches: Match[];
  candidates: number;
  embedMs: number;
  searchMs: number;
}

/**
 * Query-time retrieval: one embedding call, one vector search, one filter.
 *
 * Over-fetch then trim. Fetching exactly `topK` means a low-scoring chunk
 * occupies a slot that a better one behind it could have filled; fetching 3×
 * and dropping everything under the floor gives the ranking room to work
 * without paying for a reranker.
 */
export class Retriever {
  constructor(
    private readonly deps: {
      store: VectorStore;
      embeddings: EmbeddingProvider;
      options: RetrievalOptions;
    },
  ) {}

  async retrieve(question: string): Promise<RetrievalResult> {
    const embedStarted = performance.now();
    const [vector] = await this.deps.embeddings.embed([question], 'query');
    const embedMs = performance.now() - embedStarted;

    if (!vector) throw new Error('The embedding provider returned no vector for the query.');

    const searchStarted = performance.now();
    const candidates = await this.deps.store.query({
      vector,
      topK: this.deps.options.topK * this.deps.options.candidateMultiplier,
    });
    const searchMs = performance.now() - searchStarted;

    const matches = candidates
      .map((candidate) => {
        const lexical = lexicalOverlap(question, `${candidate.section}\n${candidate.text}`);
        const score =
          (1 - this.deps.options.lexicalWeight) * candidate.score +
          this.deps.options.lexicalWeight * lexical;

        return { ...candidate, score };
      })
      .sort((left, right) => right.score - left.score)
      .filter((candidate) => candidate.score >= this.deps.options.minScore)
      .slice(0, this.deps.options.topK);

    return { matches, candidates: candidates.length, embedMs, searchMs };
  }
}
```

**Block by block:**

- **`RetrievalOptions`** — `topK`, `candidateMultiplier`, `minScore`, `lexicalWeight`. All four are configuration, because all four are corpus-specific.
- **`RetrievalResult`** — matches plus `candidates`, `embedMs`, `searchMs`. The trace needs the counts; the chapter 08 debug tree needs the timings.
- **`retrieve(question)`** — the whole stage is four steps:
  1. `embed([question], 'query')` — task-tagged, timed.
  2. `store.query({ vector, topK: topK × 3 })` — **over-fetch**. Fetching exactly `topK` means a weak chunk occupies a slot a better one behind it could have filled.
  3. **Blend and re-sort.** The store returns cosine order; after mixing in lexical overlap the order can change, so the array is sorted again rather than trusted.
  4. **Floor, then trim.** `score >= minScore`, then `.slice(0, topK)`.
- **`.map().sort().filter().slice()` order matters** — filtering before sorting keeps the wrong four; slicing before filtering returns three when one was dropped.
- **`if (!vector) throw`** — an empty embedding is a provider bug, not an empty index. Failing here stops a `NaN` vector reaching the store.
- **`candidates`** — the count *before* filtering, so the trace can show `candidates=12 matches=3` and make the floor visible.

---

## 4. Measured Behaviour

Scores from the mock provider (`HYBRID_LEXICAL_WEIGHT=0.35`, top chunk shown):

| Query | Top chunk | Score | Runner-up | Refused? |
| :--- | :--- | ---: | :--- | :--- |
| What is the refund window for apparel? | refund-policy · Refund window | **0.642** | Exchanges 0.444 | no |
| How many days do I have to return shoes? | refund-policy · Refund window | **0.410** | Refund timing 0.285 | no |
| When is standard shipping free? | shipping-policy · Delivery options | **0.347** | Lost parcels 0.259 | no |
| How long does a refund take to reach my account? | refund-policy · Refund timing | **0.465** | How to start 0.298 | no |
| Do you offer a student discount? | warranty · Extended warranty | 0.048 | 0.038 | **yes** |
| Can I pay with Bitcoin? | warranty · What the warranty covers | 0.083 | 0.060 | **yes** |

The separation is the point: answerable questions score 0.35–0.64, unanswerable ones 0.05–0.08. `MIN_SCORE=0.15` sits in the gap with room on both sides.

### Calibrating the floor

`MIN_SCORE` is not a universal constant — it is a property of *this* model and *this* corpus. To recalibrate:

1. Run the golden set with the floor at `0` and print the top score per question.
2. Find the highest unanswerable score and the lowest answerable one.
3. Put the floor between them, closer to the unanswerable side.
4. Re-run `npm run eval` and confirm both refusal accuracy and recall@K.

| Floor too low | Floor too high |
| :--- | :--- |
| Irrelevant chunks reach the prompt | Correct answers are refused |
| Model answers from noise | "I don't have that information" for facts you do have |
| Looks confident, is wrong | Looks broken, is honest |

The second failure is louder and cheaper. That is why the default is conservative.

### What is missing here, on purpose

- **Reranking** — a cross-encoder over the top 30 would improve precision, at the cost of a second model and ~100 ms. Chapter 05 explains when it pays.
- **MMR / dedupe** — with 19 chunks, near-duplicates are rare. With overlapping windows at scale, they are not.
- **Query expansion** — one question, one embedding. Multi-query retrieval is a later optimisation.

**Next:** [Chapter 08 — Context Assembly and Citations](./08_Context_Assembly_and_Citations.md)
