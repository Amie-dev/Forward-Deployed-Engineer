import "dotenv/config";
import { METRICS, type MetricName } from "../domain/types.js";

/**
 * Chapter 02 §2.8 / Chapter 08 §8.4 — the configuration **is** what is being
 * measured.
 *
 * Every threshold lives here, read from the environment rather than buried in a
 * function body, because Chapter 08 asks for "explicit, reviewable thresholds".
 * A gate whose limits are hard-coded somewhere in `services/` is not reviewable
 * and not negotiable — and thresholds are product decisions, so they must be
 * negotiable.
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

/**
 * Chapter 08 §8.4 — one threshold per metric, not one global number.
 *
 * `EVAL_MIN_SCORE` is the default; `EVAL_MIN_FAITHFULNESS=5` tightens a single
 * metric without touching the others. That is the whole point of Chapter 08
 * §7.8.2's "per-metric thresholds": faithfulness is a hard correctness signal
 * while helpfulness is a soft one, and a single number hides the difference.
 */
const defaultThreshold = numberFromEnv("EVAL_MIN_SCORE", 4);

const metricThresholds = Object.fromEntries(
  METRICS.map((metric) => [
    metric,
    numberFromEnv(`EVAL_MIN_${metric.replace(/([A-Z])/g, "_$1").toUpperCase()}`, defaultThreshold),
  ]),
) as Record<MetricName, number>;

export const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: numberFromEnv("PORT", 8080),

  /** Chapter 02 §2.2 — how many policy documents retrieval returns. The topK lever. */
  topK: numberFromEnv("RETRIEVAL_TOPK", 1),

  /**
   * Chapter 05 §5.2 — the operational budget. Note this is a *check*, not a
   * metric: latency is deterministic, so no judge is involved.
   */
  budget: {
    maxLatencyMs: numberFromEnv("EVAL_MAX_LATENCY_MS", 5000),
    maxToolCalls: 3,
  },

  /** Chapter 07 §7.8 — Layer 3: the quality thresholds, per metric. */
  metricThresholds,

  /** Chapter 08 §8.6 — the release gate: what fraction of cases must pass. */
  minPassRate: numberFromEnv("EVAL_MIN_PASS_RATE", 1),

  /**
   * Chapter 03 §3.7 — the prompt is versioned, because "the answer got worse"
   * is not a bug report until you know which prompt produced it.
   */
  promptVersion: "v1",

  /** Chapter 06 §6.4 — which model judges, when a key is present. */
  model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  hasModelKey: (process.env.OPENAI_API_KEY ?? "").trim() !== "",
};

/**
 * Chapter 02 §2.8 — a description of the configuration.
 *
 * A score with no version attached cannot be compared to anything: change a
 * threshold or a topK and you have changed what is being measured.
 */
export function appVersion(): string {
  return (
    `agent-v1.0.0 | topK=${config.topK} | prompt=${config.promptVersion} | ` +
    `model=${config.hasModelKey ? config.model : "offline"}`
  );
}
