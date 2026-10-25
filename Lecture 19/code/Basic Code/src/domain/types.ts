/**
 * Chapter 02 §2.2 — the vocabulary of the lecture, as types.
 *
 * This file imports nothing. That is deliberate: Chapter 02 §2.1 says a threat
 * model starts from assets, not from attacks, so the words for *what is at
 * stake* should be readable without reading any machinery.
 */

/**
 * Chapter 02 §2.3–2.7 — the five asset classes, in the order the lecture
 * introduces them. A, B and C are what an attacker wants; D and E are what an
 * attacker breaks.
 */
export const ASSET_CLASSES = [
  "confidential-information",
  "other-users-data",
  "powerful-tools",
  "application-behaviour",
  "downstream-systems",
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

/**
 * Chapter 06 §6.6 — tools are not equally dangerous.
 *
 * The tier is not a label for documentation. It is the input to a different
 * rule set: `read` is offered freely, `write` needs its arguments checked, and
 * `high-impact-write` needs a human (Chapter 08 §8.6).
 */
export const TOOL_TIERS = ["read", "write", "high-impact-write"] as const;

export type ToolTier = (typeof TOOL_TIERS)[number];

/** Chapter 09 §9.4–9.7 — the four guardrail layers, in the order they run. */
export const GUARDRAIL_LAYERS = ["input", "instructions", "actions", "output"] as const;

export type GuardrailLayer = (typeof GUARDRAIL_LAYERS)[number];

/**
 * Chapter 09 §9.8 — what a guardrail *did*.
 *
 * `flag` is not a failure and must not be treated as one: it means the layer
 * noticed and the request continued, which is the honest limit of a filter.
 * Only `block` stops anything.
 */
export type GuardrailOutcome = "allow" | "flag" | "block";

/** Chapter 09 §9.13 — one line of the security trace. */
export interface SecurityEvent {
  layer: GuardrailLayer;
  rule: string;
  outcome: GuardrailOutcome;
  detail: string;
}

/** Chapter 04 §4.3 — a document, and whether its text is data or instruction. */
export interface RetrievedDocument {
  id: string;
  title: string;
  content: string;
  /** `false` means the text was written by somebody outside the trust boundary. */
  trusted: boolean;
  score: number;
}

/**
 * Chapter 06 §6.3 — the model's output is a **proposal**, never an action.
 *
 * `status` is what the *code* decided about that proposal. There is no value of
 * this type that means "the model authorized it".
 */
export interface ToolCall {
  name: string;
  tier: ToolTier;
  args: Record<string, unknown>;
  status: "executed" | "pending-confirmation" | "blocked";
  reason: string;
}

/**
 * Chapter 02 §2.8 — the trace is the security artefact.
 *
 * The same object Chapter 18 called an eval trace. `retrieved` is the untrusted
 * input surface, `toolCalls` is the effect surface, `guardrails` is what each
 * layer did, and `canaryLeaked` is the one field that answers "did the prompt
 * leave the building?" (Chapter 02 §2.3).
 */
export interface Trace {
  requestId: string;
  user: string;
  question: string;
  capabilities: string[];
  retrieved: string[];
  toolCalls: ToolCall[];
  guardrails: SecurityEvent[];
  answer: string;
  refused: boolean;
  canaryLeaked: boolean;
}

/** Chapter 06 §6.2 — the answer *and* the evidence. */
export interface ChatResult {
  answer: string;
  trace: Trace;
}

/**
 * Chapter 08 §8.6 — a pending confirmation.
 *
 * `fingerprint` is the part teams forget. Without it, a confirmation for "refund
 * ORD-101, INR 2,500" can be replayed as "refund ORD-202, INR 9,800" — the
 * confirmation *swapping* attack.
 */
export interface Confirmation {
  id: string;
  user: string;
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
  status: "pending" | "confirmed" | "rejected";
}

/**
 * Chapter 08 §8.3 — who is asking.
 *
 * Identity is a property of the session, never of a tool argument. If `user`
 * were something the model could put in an argument, the model would be
 * choosing its own privileges.
 */
export interface Session {
  user: string;
  email: string;
}
