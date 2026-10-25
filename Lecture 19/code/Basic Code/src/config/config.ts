import "dotenv/config";

/**
 * Chapter 02 §2.8 — the configuration is part of the security model.
 *
 * Every control below is a *setting* rather than a constant in a function body,
 * for the same reason Chapter 18 put its thresholds in the environment: a limit
 * that lives in the environment can be reviewed, argued with and turned off in
 * a demo. A limit buried in code can only be found by reading code.
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

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  return raw === "true" || raw === "1" || raw === "yes";
}

export const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: numberFromEnv("PORT", 8080),

  /**
   * Chapter 04 §4.3 — how many documents retrieval returns.
   *
   * This is the lever that makes the injection reachable. At `topK = 1` the
   * untrusted note is still first, so the channel exists either way; the point
   * is that a retrieval setting is a *security* setting.
   */
  topK: numberFromEnv("RETRIEVAL_TOPK", 2),

  /**
   * Chapter 09 §9.4–9.7 — the four guardrail layers, individually switchable.
   *
   * Being able to turn a layer off is the whole demonstration: it is how you
   * find out which layer was actually protecting you. Chapter 09 §9.5 says the
   * instruction layer is a filter; the demo is where you watch it be one.
   */
  guardrails: {
    input: booleanFromEnv("GUARDRAIL_INPUT", true),
    instructions: booleanFromEnv("GUARDRAIL_INSTRUCTIONS", true),
    actions: booleanFromEnv("GUARDRAIL_ACTIONS", true),
    output: booleanFromEnv("GUARDRAIL_OUTPUT", true),
  },

  /**
   * Chapter 08 §8.6 — the confirmation threshold.
   *
   * A high-impact write at or below this amount executes on the user's own
   * request. Above it, the model's proposal becomes a *pending confirmation*:
   * a human decides, and the decision is bound to the exact arguments.
   */
  autoApproveLimit: numberFromEnv("AUTO_APPROVE_LIMIT", 5000),

  /** Chapter 06 §6.3 — the loop ceiling. An unbounded agent loop is a DoS. */
  maxToolCalls: numberFromEnv("MAX_TOOL_CALLS", 4),

  /**
   * Chapter 02 §2.3 — the canary token.
   *
   * It sits in the system prompt. If it ever appears in an answer, the prompt
   * has leaked — and the output guardrail (Chapter 09 §9.7) is the layer that
   * notices, because no prompt can promise not to say something.
   */
  canaryToken: process.env.CANARY_TOKEN?.trim() || "CANARY-7f3a91",

  /** Chapter 01 §1.2 — which model answers, when a key is present. */
  model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  hasModelKey: (process.env.OPENAI_API_KEY ?? "").trim() !== "",
};

/**
 * Chapter 02 §2.8 — a description of what is running.
 *
 * A trace with no configuration attached cannot be compared with anything: turn
 * one guardrail layer off and you have changed what is being measured.
 */
export function appVersion(): string {
  const enabled = Object.entries(config.guardrails)
    .filter(([, on]) => on)
    .map(([layer]) => layer);

  return (
    `shopx-agent-v1.0.0 | topK=${config.topK} | ` +
    `guardrails=${enabled.join("+") || "none"} | ` +
    `model=${config.hasModelKey ? config.model : "offline"}`
  );
}
