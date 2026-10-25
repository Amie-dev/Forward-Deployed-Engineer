# Chapter 06 — Least Privilege and Capability Routing

> **Chapter 07 §7.4: something has to decide what this request may reach, and it
> has to decide it *before* the model runs.** That is this file — 40 lines, and it
> is the highest-leverage security code in the project.
>
> The chicken-and-egg problem the lecture states: you cannot give the model the
> tools it might need, because a model that can be persuaded becomes a model that
> can be *made* to act. So the privileges are decided up front, from the user's own
> words, by a keyword classifier that cannot be argued with — and that deliberately
> **gets no tools itself**, because a router that can be injected is a router that
> hands out privileges to an attacker.

---

## File details

| | `src/services/router.ts` |
|---|---|
| **Lines** | 70 |
| **Layer** | services |
| **Purpose** | one intent → one capability set, decided before the model runs |
| **Exports** | `CAPABILITY_MAP`, `Intent`, `Route`, `route()` |
| **Imports** | **nothing** |
| **Notes sections** | Ch 07 §7.4, §7.5, Ch 06 §6.3 |

**Why it imports nothing.** The router cannot be influenced by data, by the model,
or by a document — because it has no access to any of them. Its only input is the
question string, and its only output is an array of tool names. That narrowness is
the control.

---

## Commands

```bash
cd "Lecture 19/code/Basic Code"
npm run typecheck
```

```bash
# Chapter 07 §7.4 — the map, as data.
curl -s http://127.0.0.1:8080/security | python3 -c 'import json,sys; print(json.load(sys.stdin)["capabilities"])'
#   {'email': ['sendEmail'], 'refund': ['getOrderStatus', 'issueRefund'],
#    'delivery': ['getDeliveryEstimate'], 'order_status': ['getOrderStatus'],
#    'policy': [], 'other': []}
```

```bash
# Chapter 07 §7.5 — the capability set, printed on every trace.
npm run demo 2>&1 | grep -E '^\s+capabilities'
```

---

## `src/services/router.ts` — the full file

```ts
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
```

**How it works, block by block**

| Block | What it does and why |
| :--- | :--- |
| `CAPABILITY_MAP` with `as const` | The whole policy in seven lines, readable by anyone in the company. `as const` makes each value a readonly tuple, so `Intent` can be derived from the keys — the map and its type cannot drift. |
| `policy: []` and `other: []` | **The two most important entries.** Chapter 07 §7.4's point is that the cheapest way to protect a tool is not to hand it over. A question about the return window needs no tool at all, so it gets none — and that is a *deliberate* empty set, not a missing case. |
| `refund: ["getOrderStatus", "issueRefund"]` | Note the ordering: **read before write.** The capability set encodes the shape of the flow, so the model's first available action on a refund request is a lookup, never a refund. Chapter 06 §6.2's "read before write" is a property of the map, not a hope about the model. |
| `INTENT_PATTERNS` order | The order **is** the policy. `email` is first, so "refund my order and email the customer list" routes as an **email** request with a refund aside — one intent, one capability set. Chapter 07 §7.4 is explicit that a second intention smuggled into a sentence must not widen what is reachable. |
| `INTENT_PATTERNS` as `{ intent, pattern }[]` rather than an object | A JS object preserves insertion order for string keys, but an array makes the ordering *visible and reviewable*. When the order is a security decision, it should be obvious in the code that it is one. |
| `\b(email\|send\|forward\|notify)\b` | Word boundaries, so "sender" does not match `send`. Each pattern is deliberately generous on synonyms and strict on boundaries: a false positive here widens the capability set, and widening is the failure mode that matters. |
| `INTENT_PATTERNS.find(...)` | First match wins. Not `filter`, not scoring, not a model — `find`. Determinism is what makes the routing decision testable and what makes "the same question always gets the same privileges" true. |
| `matched?.intent ?? "other"` | The safe default. An unrecognised question is `other`, which maps to `[]`, which means **no tools**. The failure mode of the router is "grant nothing", not "grant everything" — which is the same fail-closed principle as `runLayer` in the agent. |
| `const capabilities = [...CAPABILITY_MAP[intent]]` | The spread is required (`as const` made the value readonly) and it is also useful: callers get a fresh array they cannot use to mutate the policy. |
| `reason` | Chapter 09 §9.13. The routing decision is recorded in words, so `GET /audit` explains *why* a request had the capabilities it had. A trace that shows `capabilities: []` without a reason is a trace that cannot tell "not needed" from "router bug". |

**What this file is not.** It is not a classifier, not a model, and not clever. It
is a lookup with a keyword front door, and Chapter 07 §7.4 says that is the correct
design: the router's job is to *shrink* the blast radius before the model runs, not
to be accurate about intent. A router that used a model would reintroduce exactly
the property the lecture is trying to remove.

**The one thing to notice.** There is no path through this file by which a
*retrieved document* can influence the capability set. `route()` receives the
question and nothing else. The injected note can ask for `sendEmail` all it likes;
the router never sees it, and the model was never offered it.

---

## Checkpoint

Before Chapter 07, you should be able to answer:

1. Which two intents map to an empty capability set, and why is that a decision
   rather than an omission?
2. Why does the `email` pattern come before the `refund` pattern?
3. Why is the router a keyword classifier rather than a model?
4. What happens when no pattern matches, and why is that the correct default?
5. Why does `refund` list `getOrderStatus` before `issueRefund`?
6. Can a retrieved document widen the capability set? Trace the data flow to
   justify your answer.

---

**Back to:** [Guide index](./README.md) · [Basic Code README](../README.md)

**Next:** [Chapter 07 — Never Trust, Always Verify](./07_Never_Trust_Always_Verify.md)
