# Chapter 10 — Grounded Answer or Refusal

> **Goal of this chapter:** produce the answer — with a citation, or not at all. The
> notes' rule is one exact refusal sentence plus verified citations; the *most*
> important branch in this file is the one that returns nothing.
>
> **Lecture chapter:** [08 — Context Engineering](../../../notes/08_Context_Engineering.md)
> (the grounded answer, citations, refusal) with the diagnostic vocabulary of
> [09](../../../notes/09_Evaluation_and_Production_Playbook.md) (`generation-miss`).

---

## 10.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/generate.ts` |
| **Layer** | generation |
| **Purpose** | turn an assembled context into an answer with citations, or refuse |
| **Imports** | `contentTerms`, `type AssembledContext` |
| **Exports** | `REFUSAL`, `type Answer`, `generateAnswer` |
| **Imported by** | `services/index.ts` |
| **Lecture sections** | 08 §"the grounded answer", §"budget and truncation"; 09 §"the diagnostic tree" |

### The two guards that make refusal reachable

| Guard | Where | Fires when |
|---|---|---|
| the rerank gate | `rerank.ts` | the best candidate is below `rerankMinBest` → **no context** |
| the no-match rule | this file | the context exists but no sentence shares a content term |

---

## 10.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run ask                                          # evidence + citations
npm run ask -- "Who won the Indian Premier League in 2026?"   # the refusal
RERANK=off npm run ask -- "Who won the Indian Premier League in 2026?"
```

---

## 10.3 Full file

**Path:** `src/services/generate.ts`

```ts
import type { Answer, AssembledContext } from "../models/types.js";
import { contentTerms } from "./embeddings.js";

/**
 * Chapter 08 — the grounded answer.
 *
 * Two rules from the notes live here:
 *   - cite `[n]`, or refuse with one exact sentence;
 *   - an empty context is the *only* mechanism that makes refusal reachable, so
 *     the refusal branch is the most important one in this file.
 *
 * This generator is **extractive**: it quotes the best-matching sentences. It
 * cannot conclude that "10 days is past a 7-day window" — that is the honest
 * limit of a no-API-key demo, and Chapter 09 calls those cases `generation-miss`.
 */
export const REFUSAL = "I don't know — no eligible policy in the corpus covers this question.";

function sentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function generateAnswer(question: string, context: AssembledContext): Answer {
  if (context.blocks.length === 0) {
    return { text: REFUSAL, citations: [], refused: true };
  }

  const questionTerms = contentTerms(question);

  // Chapter 06's IDF, applied to the context: a term that appears in every block
  // ("return", "policy") says almost nothing; a rare one ("headphones") decides.
  const documentFrequency = new Map<string, number>();
  for (const block of context.blocks) {
    for (const term of contentTerms(`${block.heading} ${block.body}`)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string): number =>
    Math.log(1 + context.blocks.length / (documentFrequency.get(term) ?? 1));

  const candidates = context.blocks.flatMap((block) =>
    sentences(block.body).map((sentence) => {
      // The label is part of the evidence: the section name disambiguates.
      const scored = contentTerms(`${block.heading} ${sentence}`);
      const score = questionTerms
        .filter((term) => scored.includes(term))
        .reduce((sum, term) => sum + idf(term), 0);
      return { label: block.label, sentence, score };
    }),
  );

  const best = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (best.length === 0) {
    return { text: REFUSAL, citations: [], refused: true };
  }

  return {
    text: best.map((candidate) => `${candidate.sentence} [${candidate.label}]`).join("\n"),
    citations: [...new Set(best.map((candidate) => candidate.label))],
    refused: false,
  };
}
```

---

## 10.4 Block-by-block explanation

**Block 1 — the refusal sentence, and the Answer contract**

```ts
export const REFUSAL = "I don't know — no eligible policy in the corpus covers this question.";
export type Answer = { text: string; citations: number[]; refused: boolean };
```

- The refusal is a **constant**, not a string built inline, because the notes require
  *one exact sentence*. A refusal that varies ("I don't know", "I'm not sure", "I
  cannot find that") cannot be asserted on, counted, or shown to a user as a policy
  decision — and `refusal correctness` in Chapter 12 would have nothing to match.
- `refused: boolean` is a first-class field rather than something a caller infers by
  string-comparing `text`. Every metric in Chapter 12 reads it directly, so a change to
  the refusal wording cannot silently break the evaluation.
- `citations` holds the `[n]` labels, which are the numbers from Chapter 09's labels. A
  citation is therefore a pointer into the *assembled prompt*, not into the corpus —
  the honest thing to show a user, since it is what the answer was derived from.

**Block 2 — `sentences`: the split**

```ts
function sentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
```

- The regex has two alternatives, and both are needed:
  - `(?<=[.!?])\s+` — a lookbehind for a sentence terminator followed by whitespace.
    The lookbehind keeps the `.` **in** the sentence; without it, `split` would consume
    the punctuation and the quote would lose its full stop.
  - `\n+` — a line break, because the corpus stores each section body as lines and a
    heading-less list would otherwise be one giant "sentence".
- `(?<=…)` is a modern RegExp feature, which is one reason `tsconfig.json` targets
  `ES2022`.
- `.map(trim)` then `.filter(length > 0)` is the standard cleanup: split always risks
  empty fragments at the edges.

**Block 3 — the refusal branch, first**

```ts
  if (context.blocks.length === 0) {
    return { text: REFUSAL, citations: [], refused: true };
  }
```

- This is the most important branch in the file, and it is deliberately the **first**
  thing the function does. An empty context means either the corpus had nothing
  eligible, or the floor dropped everything, or the gate refused — and in all three
  cases the only correct answer is the refusal.
- Putting it first also makes the function total: every path below this line has at
  least one block to work with, so no later line needs a `?? REFUSAL` fallback.
- Note `citations: []` — a refusal cites nothing. An answer that refuses *and* cites a
  document is a contradiction, and this contract makes it unrepresentable.

**Block 4 — IDF over the context**

```ts
  const questionTerms = contentTerms(question);

  const documentFrequency = new Map<string, number>();
  for (const block of context.blocks) {
    for (const term of contentTerms(`${block.heading} ${block.body}`)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string): number =>
    Math.log(1 + context.blocks.length / (documentFrequency.get(term) ?? 1));
```

- This is Chapter 06's IDF reused as a **scoring weight**, the smallest possible way to
  get a real signal out of a four-block context.
- Why it is necessary: without weights, "return" (which appears in every block) counts
  exactly as much as "damaged" (which appears in one). An earlier, unweighted version
  produced a three-way tie between the electronics rule, the general rule and the
  damage exception — and the tie broke on block order, which is not a reason.
- `Math.log(1 + N/df)` has the same shape as BM25's IDF: a term in every block scores
  `log(2) ≈ 0.69`, a term in one of four scores `log(5) ≈ 1.61`. Rare terms therefore
  dominate the choice of sentence, which is what makes `damaged` and `headphones`
  decide the answer.
- The frequency is counted over `${block.heading} ${block.body}` — the **label** is
  part of the evidence. That is Chapter 08's "labels make chunks self-describing"
  paying off: the word `Damaged` in the breadcrumb
  `Damaged Product Reporting Policy → Exception` is why the exception sentence wins the
  running example, even though the sentence itself says "Damage reported".

**Block 5 — scoring every sentence, jointly with its heading**

```ts
  const candidates = context.blocks.flatMap((block) =>
    sentences(block.body).map((sentence) => {
      // The label is part of the evidence: the section name disambiguates.
      const scored = contentTerms(`${block.heading} ${sentence}`);
      const score = questionTerms
        .filter((term) => scored.includes(term))
        .reduce((sum, term) => sum + idf(term), 0);
      return { label: block.label, sentence, score };
    }),
  );
```

- `flatMap` because the result is two-dimensional (blocks → sentences) and we want one
  flat list. Each candidate remembers its `label`, so the citation travels with the
  sentence.
- `questionTerms.filter(term => scored.includes(term)).reduce(sum + idf(term), 0)` is
  the whole scoring rule: sum the IDF of every question term this sentence (plus its
  heading) contains.
- `scored.includes(term)` is a plain membership test — a linear scan over a handful of
  terms, fine at this scale and obvious to read.
- Note what is **not** here: no length normalisation, no position weighting, no
  stemming. The scorer demonstrates the *idea* — quote the sentence that shares the
  rarest terms with the question — and the honest limit is documented.

**Block 6 — pick the best two, or refuse**

```ts
  const best = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (best.length === 0) {
    return { text: REFUSAL, citations: [], refused: true };
  }
```

- `filter(score > 0)` is the **second refusal guard**: if no sentence shares a single
  content term with the question, there is nothing to quote and the answer refuses.
  This is what makes the off-topic question refuse even with `RERANK=off`, when the
  gate is not in play.
- `slice(0, 2)` is a hard budget of two sentences. Two is enough to carry a rule and
  its exception (the running example needs exactly two) and small enough that the
  answer stays a quote rather than a summary.
- `if (best.length === 0)` re-checks and returns the same refusal shape — the same
  contract, reached by a different route.

**Block 7 — the answer and the citations**

```ts
  return {
    text: best.map((candidate) => `${candidate.sentence} [${candidate.label}]`).join("\n"),
    citations: [...new Set(best.map((candidate) => candidate.label))],
    refused: false,
  };
```

- Each quoted sentence carries its `[n]` inline, which is the notes' citation rule: the
  number in the answer must point at a numbered source block. Because the label came
  from the block, an invalid citation is impossible by construction — no code path
  emits a number that is not in the prompt.
- `new Set(...)` de-duplicates the labels: if two quoted sentences come from the same
  block, the answer cites that block once.
- `refused: false` is explicit rather than omitted, so the type has no optional fields
  and Chapter 12's metrics never need a null check.

**The honest limit, stated in the code**

The header comment says it plainly: this generator *quotes*, it does not *reason*. It
cannot conclude that 10 days is past a 7-day window, so the running example's answer is
the two pieces of evidence — the 48-hour damage rule and the electronics override —
rather than the word "No". Chapter 09's diagnostic tree has a name for that case
(`generation-miss`), and Chapter 12's `recall 1.000` with `precision 0.65` is its
numeric signature: the evidence is all present and the answer is still not a
conclusion.

---

## 10.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run ask
```

Expected (the answer section):

```text
── answer ────────────────────────────────────────────
Damage reported after 48 hours is treated as a normal return and follows the return policy for the product category. [2]
This policy overrides the general return policy for all electronic products, including headphones and speakers. [3]

citations: [2, 3]  refused: false
```

And the refusal:

```bash
npm run ask -- "Who won the Indian Premier League in 2026?"
```

```text
── answer ────────────────────────────────────────────
I don't know — no eligible policy in the corpus covers this question.

citations: []  refused: true
```

---

## 10.6 Checkpoint

1. **Why is the refusal a constant?** The notes require one exact sentence, so it can be
   asserted on and counted — `refusal correctness` depends on it.
2. **What are the two guards that make refusal reachable?** The rerank gate (empty
   context) and this file's `filter(score > 0)` (no sentence shares a content term).
3. **Why is the block's heading included in the scored text?** Because the label is part
   of the evidence — `Damaged … → Exception` is what makes the damage sentence win a
   question that says "damaged".

**Next:** [Chapter 11 — The pipeline](./11_The_Pipeline.md)


