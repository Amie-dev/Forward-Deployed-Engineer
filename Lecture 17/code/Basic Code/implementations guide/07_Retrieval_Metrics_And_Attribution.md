# Chapter 07 — Retrieval Metrics and Attribution

> **A RAG failure is never just "the model".** This is the shortest file in the project and the
> one that changes the most about how you work: it splits the system in half, scores each half,
> and gives every failure an owner.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/retrieval.ts` (106 lines) |
| **Layer** | services |
| **Purpose** | retrieval metrics (set arithmetic) + the attribution classifier + the pointwise gate |
| **Exports** | `scoreRetrieval()`, `classify()`, `pointwiseGate()`, `faithfulnessOf()` |
| **Imports** | `domain/types` only — no judge, no config, no I/O |
| **Notes sections** | Ch07 §7.4 (the pointwise gate), Ch08 §8.2 (retrieval metrics), §8.4 (attribution) |

**Note what is *not* imported: the judge.** Retrieval evaluation needs no model at all, and this
file is the proof — it is pure array arithmetic and a decision tree. Chapter 08 §8.2 calls a
retrieval eval with expected document ids *"the cheapest and most reliable eval you will ever
write"*, and a file with no dependencies is what that looks like.

---

## Commands

```bash
# the four retrieval numbers, and the attribution line that says where the work is
npm run eval --silent 2>&1 | grep -E 'retrieval|attribution'

npm run eval --silent -- --topk=1 --baseline=3 2>&1 | grep -E 'retrieval|attribution|attributed'
```

```text
# baseline (topK=3)
  retrieval      hit 1 · recall 1 · precision 0.72 · mrr 0.92
  attribution    pass 9

# candidate (topK=1)
  retrieval      hit 0.83 · recall 0.83 · precision 0.83 · mrr 1
  attribution    retrieval 1 · pass 8
  warranty-and-return  ->  attributed to retrieval
```

The candidate's **MRR went up** (1 vs 0.92) while its hit rate went down. That is not a bug — it is
the metric telling the truth: with `topK=1` every retrieved document is the *best* one, so the rank
of the first relevant hit is always 1. A single number would have hidden this, which is why the
report prints four.

---

## `src/services/retrieval.ts` — the full file

```ts
import type { Attribution, CheckOutcome, QualityOutcome, Retrieved, RetrievalScore } from "../domain/types.js";

/**
 * Chapter 08 — **a RAG failure is never just "the model".**
 *
 * The chapter's whole move is to split the system in half and ask which half
 * failed, because the two halves have different owners and different fixes. This
 * file is that split, and nothing else.
 *
 * The important property: **retrieval evaluation needs no judge.** With expected
 * document ids it is set arithmetic — §8.2 calls it "the cheapest and most
 * reliable eval you will ever write".
 */

/**
 * §8.2 — hit rate, recall, precision and the first relevant rank, from one run.
 *
 * `applicable` matters more than it looks: a tool-calling case and a refusal case
 * declare no `expectedDocs`, and scoring them as retrieval failures would be a
 * category error. Averages are taken over applicable cases only.
 */
export function scoreRetrieval(expected: string[], retrieved: Retrieved[]): RetrievalScore {
  if (expected.length === 0) {
    return { applicable: false, hit: false, recall: 1, precision: 1, firstRelevantRank: null };
  }

  const ids = retrieved.map((hit) => hit.id);
  const found = expected.filter((id) => ids.includes(id));
  const relevant = ids.filter((id) => expected.includes(id));
  const firstRelevant = retrieved.find((hit) => expected.includes(hit.id));

  return {
    applicable: true,
    hit: found.length > 0,
    recall: found.length / expected.length,
    precision: ids.length === 0 ? 0 : relevant.length / ids.length,
    firstRelevantRank: firstRelevant?.rank ?? null,
  };
}

/**
 * §8.4 — the attribution decision tree, expressed as code.
 *
 * Read it as a sequence of questions, because that is what it is:
 *
 *   1. Did retrieval fail?                  -> the LLM is innocent. Owner: retrieval.
 *   2. Was there no context to judge?       -> the answer was never possible. Owner: retrieval.
 *   3. Is the answer unfaithful?            -> the context was there and it was ignored. Owner: generation.
 *   4. Did a required assertion fail?       -> the answer is grounded but off-contract. Owner: spec.
 *   5. Otherwise                            -> pass.
 *
 * Step 4 is the one teams skip. A grounded, relevant answer that misses a
 * required fact is **not** a model failure — the contract was wrong, or the
 * prompt never asked for it.
 */
export function classify(input: {
  retrieval: RetrievalScore;
  hasQuality: boolean;
  qualitySkipped: boolean;
  faithfulness?: number;
  deterministic: CheckOutcome[];
}): Attribution {
  if (input.retrieval.applicable && !input.retrieval.hit) {
    return "retrieval";
  }

  if (input.hasQuality && input.qualitySkipped) {
    return "retrieval";
  }

  if (input.faithfulness !== undefined && input.faithfulness < 3) {
    return "generation";
  }

  if (!input.deterministic.every((check) => check.passed)) {
    return "spec";
  }

  return "pass";
}

/** Chapter 07 §7.4 — the pointwise gate: a score becomes a decision at a threshold. */
export function pointwiseGate(
  averages: Record<string, number>,
  minFaithfulness: number,
): { ship: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const faithfulness = averages.faithfulness;

  if (faithfulness === undefined) {
    reasons.push("no faithfulness scores were produced, so the release is not gated on quality");
  } else if (faithfulness < minFaithfulness) {
    reasons.push(
      `faithfulness ${faithfulness.toFixed(2)} < ${minFaithfulness} — investigate before shipping`,
    );
  } else {
    reasons.push(`faithfulness ${faithfulness.toFixed(2)} >= ${minFaithfulness}`);
  }

  return { ship: reasons.every((reason) => !reason.includes("<")), reasons };
}

/** Helper used by the report and the pairwise comparison. */
export function faithfulnessOf(quality: QualityOutcome[]): number | undefined {
  return quality.find((outcome) => outcome.metric === "faithfulness")?.score;
}
```

### Block-by-block

**Block 1 — `scoreRetrieval`, and the `applicable` guard (Chapter 08 §8.2).**

```ts
export function scoreRetrieval(expected: string[], retrieved: Retrieved[]): RetrievalScore {
  if (expected.length === 0) {
    return { applicable: false, hit: false, recall: 1, precision: 1, firstRelevantRank: null };
  }

  const ids = retrieved.map((hit) => hit.id);
  const found = expected.filter((id) => ids.includes(id));
  const relevant = ids.filter((id) => expected.includes(id));
  const firstRelevant = retrieved.find((hit) => expected.includes(hit.id));

  return {
    applicable: true,
    hit: found.length > 0,
    recall: found.length / expected.length,
    precision: ids.length === 0 ? 0 : relevant.length / ids.length,
    firstRelevantRank: firstRelevant?.rank ?? null,
  };
}
```

Four metrics, and the shape of each expression is its definition:

| Metric | Expression | Reads as |
| :--- | :--- | :--- |
| `hit` | `found.length > 0` | "was *any* expected document retrieved?" |
| `recall` | `found / expected` | "what fraction of what was needed did we get?" |
| `precision` | `relevant / retrieved` | "what fraction of what we got was needed?" |
| `firstRelevantRank` | the rank of the first expected id | "how high did the right answer rank?" — the MRR input |

**The early return is the important part.** A case with no `expectedDocs` is not a retrieval test,
and returning `applicable: false` keeps it out of the averages. Without it the tool case and the two
refusal cases would count as retrieval failures and the hit rate would be meaningless — a report
*wrong in a direction that looks like bad news*, which is the worst kind of wrong because someone
will act on it.

`precision` has a zero-guard (`ids.length === 0 ? 0 : …`) because an empty retrieval is a real
outcome — it is what `gift-wrapping` expects — and dividing by zero would produce `NaN`, which would
propagate into an average and quietly destroy it.

**Block 2 — `classify`, the decision tree (Chapter 08 §8.4).**

```ts
export function classify(input: {
  retrieval: RetrievalScore;
  hasQuality: boolean;
  qualitySkipped: boolean;
  faithfulness?: number;
  deterministic: CheckOutcome[];
}): Attribution {
  if (input.retrieval.applicable && !input.retrieval.hit) return "retrieval";
  if (input.hasQuality && input.qualitySkipped)           return "retrieval";
  if (input.faithfulness !== undefined && input.faithfulness < 3) return "generation";
  if (!input.deterministic.every((check) => check.passed))        return "spec";
  return "pass";
}
```

Five lines, and they are the whole chapter. Read them as a sequence of questions, because that is
what they are:

| Order | Question | Owner | Why it comes here |
| :--- | :--- | :--- | :--- |
| 1 | did retrieval fail? | **retrieval** | *"if retrieval failed, the LLM may never have had the information required to answer correctly"* — the model is innocent, so nothing else is worth asking |
| 2 | was there no context to judge? | **retrieval** | an answer that was never possible is not a generation failure. §8.5 marks it `skipped`, and skipping is *attribution*, not failure |
| 3 | is the answer unfaithful? | **generation** | the context *was* there and the answer ignored it. Now the model is guilty |
| 4 | did a required assertion fail? | **spec** | grounded and relevant but off-contract — the prompt or the expected behaviour is wrong, not the model |
| 5 | otherwise | **pass** | |

**Step 4 is the one teams skip, and it is the most valuable.** A grounded, relevant answer that
misses a required fact is not a model failure — it is a specification failure. Without this bucket
the default conclusion is always "the model is bad", and the fix people reach for (a bigger model)
is the expensive wrong one.

**A note on honesty: this demo has no `generation` failures.** The system under test composes its
answer from retrieved sentences (Chapter 04, Block 5), so it is faithful by construction, and the
`generation` bucket is empty in every run. That is the correct result for *this* system rather than
a gap in the code — and the bucket is still implemented, because the day someone swaps the stand-in
for a real model is the day it fills up. A report that could only ever say `pass` and `spec` would
have hidden that change.

**Block 3 — `pointwiseGate`: a score becomes a decision (Chapter 07 §7.4).**

```ts
export function pointwiseGate(averages: Record<string, number>, minFaithfulness: number):
  { ship: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const faithfulness = averages.faithfulness;

  if (faithfulness === undefined) {
    reasons.push("no faithfulness scores were produced, so the release is not gated on quality");
  } else if (faithfulness < minFaithfulness) {
    reasons.push(`faithfulness ${faithfulness.toFixed(2)} < ${minFaithfulness} — investigate before shipping`);
  } else {
    reasons.push(`faithfulness ${faithfulness.toFixed(2)} >= ${minFaithfulness}`);
  }

  return { ship: reasons.every((reason) => !reason.includes("<")), reasons };
}
```

This is §7.4's gate pattern — *"faithfulness ≥ 4.2 → ship; < 4.2 → investigate before shipping"* —
made executable. Three things about it are deliberate:

- **It always returns a reason, including when it passes.** The success message states the number
  and the threshold, so a report shows *what it was measured against* rather than only a verdict. A
  gate whose passing condition is invisible cannot be reviewed.
- **The "no scores" branch is a first-class outcome.** A dataset with no judge evaluators would
  otherwise produce `undefined < 4.2`, which is `false`, which reads as a pass. Naming that case is
  what stops an unmeasured release from looking like a good one.
- **`ship` is derived from the reasons rather than computed separately.** One source of truth: the
  verdict cannot drift from the explanation, because it *is* the explanation.

**Block 4 — `faithfulnessOf`, the small bridge.**

```ts
export function faithfulnessOf(quality: QualityOutcome[]): number | undefined {
  return quality.find((outcome) => outcome.metric === "faithfulness")?.score;
}
```

Three lines, and it exists because `classify` needs a faithfulness score while `quality` is a list.
Returning `undefined` when the metric is absent — rather than `0` or a default — is what lets
`classify` distinguish *"the answer was unfaithful"* from *"faithfulness was never measured"*.
Those are different facts, and only one of them is a failure.

---

## Checkpoint

1. **Why does `scoreRetrieval` return early for a case with no `expectedDocs`?**
   Because such a case is not a retrieval test. Counting it as a failure would drag the hit rate down
   and make the report wrong in a direction that looks like bad news.

2. **Why is the retrieval branch of `classify` checked first?**
   Because §8.4's rule is that if retrieval failed, the LLM is innocent — nothing else is worth
   asking. Attribution order is diagnostic order.

3. **What is the `spec` bucket for, and why does it matter?**
   A grounded, relevant answer that misses a required fact. Without it, the default conclusion is
   always "the model is bad", and the fix people reach for is a bigger model.

4. **Why is `generation` empty in this project, and is that a problem?**
   Because the stand-in answer is composed from retrieved sentences, so it is faithful by
   construction. It is the correct result for this system; the bucket stays implemented so a real
   model's arrival is visible.

5. **Why does `pointwiseGate` return a reason even when it passes?**
   So the report shows what was measured and against what. A gate whose passing condition is
   invisible cannot be reviewed.

---

**[Chapter 08: The Eval Loop, the Report and the Gate →](./08_The_Eval_Loop_Report_And_Gate.md)**