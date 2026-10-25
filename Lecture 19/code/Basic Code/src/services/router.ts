/**
 * Chapter 07 §7.4 — least privilege and capability routing.
 *
 * The problem the router solves is a chicken-and-egg one, and Chapter 07 states
 * it plainly: you cannot give the model the tools it might need, because that is
 * how a model that can be persuaded becomes a model that can be *made* to act.
 * So something has to decide, **before the model runs**, what this one request
 * is allowed to reach.
 *
 * That something is this file. Note what it is: a keyword classifier over the
 * user's own words. It is not a model, it cannot be argued with, and it is
 * deliberately not clever — Chapter 07 §7.4's rule is that the router itself
 * gets **no tools**, so a router that can be injected is a router that hands out
 * privileges to an attacker.
 */

/**
 * Chapter 07 §7.4 — the capability map: one intent, one capability set.
 *
 * `policy` and `other` map to an empty set, and that is not a mistake. A
 * question about the return window needs *no* tool at all; the cheapest way to
 * protect a tool is to not hand it over.
 */
export const CAPABILITY_MAP = {
  email: ["sendEmail"],
  refund: ["getOrderStatus", "issueRefund"],
  delivery: ["getDeliveryEstimate"],
  order_status: ["getOrderStatus"],
  policy: [],
  other: [],
} as const;

export type Intent = keyof typeof CAPABILITY_MAP;

/**
 * The order matters: the first pattern that matches wins.
 *
 * A request that says "refund and email" is an *email* request with a refund
 * aside, and it is routed as one intent. Chapter 07 §7.4 is explicit that this
 * is the point of the router — one request, one capability set, so a second
 * intention smuggled into a sentence does not widen what is reachable.
 */
const INTENT_PATTERNS: { intent: Intent; pattern: RegExp }[] = [
  { intent: "email", pattern: /\b(email|send|forward|notify)\b/i },
  { intent: "refund", pattern: /\b(refund|reimburse|cancel|money back)\b/i },
  { intent: "delivery", pattern: /\b(arrive|arriving|delivery|deliver|shipped when)\b/i },
  { intent: "order_status", pattern: /\b(status|track|tracking|order)\b/i },
  { intent: "policy", pattern: /\b(policy|return|returns|window|days)\b/i },
];

export interface Route {
  intent: Intent;
  /** Chapter 07 §7.5 — the only tools the model will be offered on this request. */
  capabilities: string[];
  reason: string;
}

export function route(question: string): Route {
  const matched = INTENT_PATTERNS.find(({ pattern }) => pattern.test(question));
  const intent: Intent = matched?.intent ?? "other";
  const capabilities = [...CAPABILITY_MAP[intent]];

  return {
    intent,
    capabilities,
    reason:
      capabilities.length === 0
        ? `intent "${intent}" needs no tool, so none is offered.`
        : `intent "${intent}" is offered exactly [${capabilities.join(", ")}].`,
  };
}
