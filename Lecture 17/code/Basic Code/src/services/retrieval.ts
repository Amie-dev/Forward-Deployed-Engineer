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
