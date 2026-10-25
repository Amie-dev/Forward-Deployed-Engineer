import "dotenv/config";

/**
 * Chapter 02 — the evaluated system has a *version*, and the version **is** the
 * configuration. Change any value below and you have changed what is being
 * measured, which is why §2.8 records `appVersion` on every result: a score with
 * no version attached cannot be compared to anything.
 *
 * Every threshold here is read from the environment rather than hard-coded,
 * because Chapter 04 §4.8 asks for "explicit, reviewable thresholds" — a gate
 * whose limits are buried in a function body is not reviewable.
 */

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }

  return value;
}

export const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: numberFromEnv("PORT", 8080),

  /** Chapter 08 §8.2 — the lever the lecture keeps returning to ("topK 5 -> 3"). */
  topK: numberFromEnv("RETRIEVAL_TOPK", 3),

  /** Chapter 04 §4.8 / Chapter 09 §9.1 — the release gate. */
  minPassRate: numberFromEnv("EVAL_MIN_PASS_RATE", 0.95),

  /** Chapter 07 §7.4 — the pointwise gate: "faithfulness >= 4.2 -> ship". */
  minFaithfulness: numberFromEnv("EVAL_MIN_FAITHFULNESS", 4.2),

  /**
   * Chapter 04 §4.5 — the operational budget. Note it is a *check*, not a metric:
   * latency and cost are deterministic, so no judge is involved.
   */
  budget: { maxMs: 5000, maxToolCalls: 2, maxUsd: 0.02 },

  /** Chapter 06 — the judge's model. Unused when the key is empty. */
  model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  hasModelKey: (process.env.OPENAI_API_KEY ?? "").trim() !== "",
};

/**
 * Chapter 02 §2.8 — a description of the configuration, so any score can be
 * attributed to the exact prompt/retrieval/model combination that produced it.
 */
export function appVersion(topK: number = config.topK): string {
  return `app-v1.0.0 | topK=${topK} | model=${config.hasModelKey ? config.model : "offline"}`;
}
