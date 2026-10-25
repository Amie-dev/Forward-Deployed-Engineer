# Chapter 08: Never Trust, Always Verify — Arguments, Authorization and Confirmation

> **Chapter Goal:** Chapter 07 reduced *which* tools can be called. This chapter covers the other half of safe tool use — the three rules that decide whether a proposed call is allowed to have an effect:
>
> - **Rule 2 — Never trust model-generated arguments.** Validate them as if they came from an external HTTP request.
> - **Rule 3 — Authorization belongs in code.** Ask "does this user own this order?", never "does the model believe this user owns this order?"
> - **Rule 4 — Require explicit approval for high-impact actions.** And store that approval in the backend, not in the conversation.
>
> These three rules are where the lecture's central claim — *the LLM proposes, the backend authorizes* — becomes concrete code.
>
> At the end of this chapter you should be able to answer: *what exactly must be true before my tool executes, and where is each of those facts stored?*

---

## 8.1 Safe Tool Use — Rule 2: Never Trust Tool Arguments

Suppose the model requests:

```text
refundOrder(
    "ORD-101",
    50000
)
```

Treat those arguments like:

```text
HTTP request parameters
```

You would never trust:

```http
POST /refund
amount=50000
```

without validation. **The fact that an LLM generated the number does not make it trustworthy.**

```mermaid
flowchart TD
    A["Model-generated arguments"] --> T["Trust boundary<br/>(same as any HTTP input)"]
    T --> V["Validation"]
    V --> B["Business rules"]
    B --> E["Execution"]

    style T fill:#f38ba8,color:#1e1e2e
    style V fill:#a6e3a1,color:#1e1e2e
```

### 8.1.1 Validate business rules

```java
if (order.getStatus() == SHIPPED) {
    throw new IllegalStateException(
        "Shipped order cannot be cancelled"
    );
}
```

**Financial constraints:**

```java
if (requestedRefund > order.getAmount()) {
    reject();
}
```

### 8.1.2 Even better: do not let the model choose the amount at all

> **Do not allow the model to choose the refund amount at all.**
>
> **Let the backend derive it from trusted data.**

```mermaid
flowchart TD
    subgraph V1["Validate what the model said"]
        M1["Model: amount = 50000"] --> C1["if (50000 > order.amount) reject"]
        C1 --> X1["Execute with the model's number<br/>(still attacker-influenced)"]
    end
    subgraph V2["Derive from trusted data"]
        M2["Model: orderId only"] --> C2["amount = calculateRefund(order)"]
        C2 --> X2["Execute with a server-computed number"]
    end

    style X1 fill:#f9e2af,color:#1e1e2e
    style X2 fill:#a6e3a1,color:#1e1e2e
```

> **The hierarchy of trust:** *validating* an attacker-influenced value is good; *not accepting it at all* is better.

---

## 8.2 The Argument-Validation Catalogue *(beyond the lecture)*

Rule 2 is easy to state and easy to under-implement. Here is the full checklist that a tool boundary should apply, in roughly the order it should apply them.

| # | Check | Example failure it catches | Where it belongs |
|---|---|---|---|
| 1 | **Schema validation** | Wrong type, missing required field, extra fields (`additionalProperties: false`) | Tool boundary |
| 2 | **Normalisation** | `ord-101` vs `ORD-101`; Unicode NFKC; whitespace | Tool boundary |
| 3 | **Format / pattern** | `orderId` must match `^ORD-\d+$` | Tool boundary |
| 4 | **Range / bounds** | `amount ≤ 0`; `quantity = 1e9` | Tool boundary |
| 5 | **Enum membership** | Status set to an arbitrary string | Tool boundary |
| 6 | **Length caps** | 10 MB `note` field (context/cost attack) | Tool boundary |
| 7 | **Referential integrity** | Order id that does not exist | Service |
| 8 | **Ownership** | Another user's order | Service (**Rule 3**) |
| 9 | **Business rules** | Refunding a shipped order; cancelling a delivered one | Service |
| 10 | **Monetary policy** | Refund > paid amount; currency mismatch | Service |
| 11 | **Allowlist of destinations** | Email/webhook to an attacker domain | Service |
| 12 | **Velocity / rate limits** | 200 refunds in a minute | Service |
| 13 | **Idempotency** | The same refund executed twice | Service |
| 14 | **Authoritative value derivation** | Model-supplied amount, price or discount | Service — derive instead |
| 15 | **Mass-assignment guard** | Model passes `role: "admin"` in an update tool | Service — allowlist fields |

### 8.2.1 The three-way split of "trust"

```mermaid
flowchart LR
    M["Model output"] --> S["SHAPE<br/>validated by schema"]
    M --> V["VALUE<br/>validated by rules"]
    M --> N["NEVER ACCEPTED<br/>derived server-side"]

    S --> OK["Acceptable"]
    V --> OK2["Acceptable if it passes"]
    N --> OK3["Not a model input at all"]

    style S fill:#a6e3a1,color:#1e1e2e
    style V fill:#f9e2af,color:#1e1e2e
    style N fill:#89b4fa,color:#1e1e2e
```

> **The rule of thumb:** *shape* may come from the model (Lecture 13 gives you the schema for free). *Values* must be validated against trusted data. *Authority-bearing values* — identity, money, permissions, destinations — must never come from the model.

### 8.2.2 A validation pipeline in TypeScript shape

```ts
// pseudo-code — one place where every argument passes through
type ValidationResult = { ok: true } | { ok: false; reason: string };

async function validateArgs<T>(spec: ToolSpec<T>, raw: unknown, actor: Actor): Promise<ValidationResult> {
  // 1 · shape — schema from lecture 13
  const parsed = spec.schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };

  // 2 · normalise + format
  const args = normalise(parsed.data);

  // 3 · referential integrity
  const target = await spec.loadTarget(args);       // e.g. the order
  if (!target) return { ok: false, reason: "not-found" };

  // 4 · ownership (Rule 3 — never ask the model)
  if (!(await owns(actor, target))) return { ok: false, reason: "forbidden" };

  // 5 · business rules + monetary policy
  if (!spec.policy(args, target, actor).allow) return { ok: false, reason: "policy" };

  // 6 · rate/velocity
  if (!(await withinRate(actor, spec.name))) return { ok: false, reason: "rate" };

  return { ok: true };
}
```

> **Note the shape:** every failure returns a *reason*, so the assistant can say something useful ("that order isn't yours", "that order has already shipped") without ever revealing *why* a check failed in a way that helps an attacker.

---

## 8.3 Safe Tool Use — Rule 3: Authorization Happens in Code

**Authenticated user:**

```text
USER-17
```

**User asks:**

```text
Cancel ORD-101.
```

**The model requests:**

```text
cancelOrder("ORD-101")
```

**The backend must verify:**

```text
Does USER-17 own ORD-101?
```

**Not:**

```text
Does the LLM believe USER-17 owns ORD-101?
```

> **Authentication and authorization are deterministic backend concerns.**

```mermaid
sequenceDiagram
    participant U as USER-17
    participant A as Application
    participant L as LLM
    participant S as Order service

    U->>A: "Cancel ORD-101"  (session: USER-17)
    A->>L: prompt + cancel capability
    L->>A: cancelOrder({ orderId: "ORD-101" })
    Note over A: identity comes from the SESSION,<br/>never from the model or the message
    A->>S: cancel({ orderId, actorId: "USER-17" })
    S->>S: owns(USER-17, ORD-101)?
    alt owns
        S-->>A: cancelled
    else not owner
        S-->>A: AccessDenied
    end
```

### 8.3.1 The three identity mistakes

| Mistake | Why it fails |
|---|---|
| Model supplies `userId` as a tool argument | The attacker now controls identity — the model will happily pass `"USER-01"` |
| Model is asked "is this user the owner?" | You have delegated authorization to a probabilistic interpreter |
| Identity is taken from the *message text* ("I am USER-17") | Text is not authentication |
| **Identity comes from the authenticated session, server-side** | ✅ The only correct source |

> **Note:** the model may *read* identity from the session for phrasing purposes ("I can see your order ORD-101…"), but it must never *supply* identity to a privileged operation.

---

## 8.4 Safe Tool Use — Rule 4: High-Risk Actions Need Explicit Approval

Suppose the user really does own the order. **Cancellation is still destructive.**

The model may misunderstand:

```text
What would happen if I cancelled ORD-101?
```

as:

```text
Cancel ORD-101.
```

> **Security therefore protects against attackers *plus* model mistakes.**

```mermaid
flowchart TD
    T["Threats to a destructive action"] --> A["Attackers<br/>(injection, manipulation)"]
    T --> B["Model mistakes<br/>(misreading intent)"]
    T --> C["Ambiguity<br/>(hypothetical vs imperative)"]
    A --> X["Explicit approval gate"]
    B --> X
    C --> X

    style X fill:#a6e3a1,color:#1e1e2e
```

### 8.4.1 The confirmation pattern

A safer flow:

```text
User:
Cancel ORD-101.
        ↓
Application creates pending action.
Nothing is cancelled yet.
        ↓
Assistant:
Confirm cancellation of ORD-101?
        ↓
User:
Yes.
        ↓
Backend verifies:
   pending action exists
 + belongs to authenticated user
 + has not expired
        ↓
cancelOrder()
```

```mermaid
sequenceDiagram
    participant U as User
    participant A as Application
    participant P as Pending-action store
    participant S as Order service

    U->>A: "Cancel ORD-101"
    A->>P: createPending(actor=USER-17, action=cancel, order=ORD-101, expires=+10m)
    A-->>U: "Confirm cancellation of ORD-101?"
    U->>A: "Yes"
    A->>P: consume(actor=USER-17, order=ORD-101)
    P-->>A: pending exists · belongs to USER-17 · not expired
    A->>S: cancelOrder(ORD-101)
    S-->>A: cancelled
    A-->>U: "ORD-101 has been cancelled."
```

> **The backend should track confirmation state.**

### 8.4.2 Unsafe vs better confirmation

**Unsafe confirmation:**

```text
SYSTEM:
Only cancel after user confirmation.

User says:
I confirmed earlier.
```

The model believes them. **Unsafe.**

**Better confirmation:**

```java
if (!confirmationService
        .hasConfirmation(userId, orderId)) {
    return "CONFIRMATION_REQUIRED";
}
```

Now:

```text
"I already confirmed"
```

is **not** equivalent to:

```text
storedConfirmation == true
```

```mermaid
flowchart LR
    subgraph U["UNSAFE — confirmation lives in the conversation"]
        A1["User claims: 'I confirmed earlier'"] --> B1["Model believes it"] --> C1["Action executes"]
    end
    subgraph S["SAFE — confirmation lives in the backend"]
        A2["User clicks confirm"] --> B2["Backend stores confirmation<br/>(actor · action · target · expiry · nonce)"]
        B2 --> C2["Tool checks the stored record"]
        C2 --> D2["Action executes"]
    end

    style C1 fill:#f38ba8,color:#1e1e2e
    style D2 fill:#a6e3a1,color:#1e1e2e
```

> **The rule:** *a conversational claim is data. A stored confirmation record is a fact.* Only the second may authorize an action.

---

## 8.5 Designing the Confirmation Gate Properly *(beyond the lecture)*

### 8.5.1 The confirmation record

A confirmation is a **record**, not a message. It needs enough fields to be verifiable and non-replayable:

```ts
// pseudo-code — the stored pending action
type PendingAction = {
  id: string;              // server-generated
  actorId: string;         // from the session, never from the model
  sessionId: string;       // binds the confirmation to this session
  action: string;          // "cancelOrder"
  target: string;          // "ORD-101"
  argsHash: string;        // hash of the exact validated arguments
  createdAt: number;
  expiresAt: number;       // short window, e.g. 10 minutes
  consumedAt: number | null;   // one-shot: null until used
  nonce: string;           // prevents forged/replayed confirmations
};
```

| Field | Threat it defeats |
|---|---|
| `actorId` | Confirmation from a different user |
| `sessionId` | Stolen/replayed confirmation across sessions |
| `argsHash` | **Confirmation swapping** — user confirms a ₹500 refund, the model then executes ₹50,000 |
| `expiresAt` | Stale confirmations executing days later |
| `consumedAt` | Double execution (replay) |
| `nonce` | CSRF-style forged confirmation requests |

> **The `argsHash` field is the one teams forget.** Without it, the confirmation covers the *action name*, not the *parameters* — so an injected argument change between "confirm" and "execute" goes unnoticed.

### 8.5.2 TOCTOU: time-of-check to time-of-use

Between the ownership check and the execution, state can change.

```mermaid
sequenceDiagram
    participant A as Application
    participant S as Order service
    participant O as Other actor

    A->>S: owns(USER-17, ORD-101)? → yes
    O->>S: ORD-101 shipped
    A->>S: cancelOrder(ORD-101)
    Note over S: Ownership was true,<br/>the business rule is now false
```

**Fix:** re-check inside the transaction, using a **conditional update**:

```sql
UPDATE orders
   SET status = 'CANCELLED'
 WHERE id = 'ORD-101'
   AND user_id = 'USER-17'
   AND status IN ('PLACED','PACKED');
```

> If the statement updates 0 rows, the action is refused. The check and the effect are now atomic.

### 8.5.3 Idempotency

Agent loops, retries and timeouts can all cause the same call twice.

| Mechanism | Effect |
|---|---|
| Client-supplied idempotency key | Same key ⇒ same result, no second effect |
| Unique constraint on `(action, target, confirmationId)` | The database refuses the duplicate |
| `consumedAt` on the pending action | Second attempt finds nothing to consume |

> **Without idempotency, "one refund" can become five** — and the cause may be a retry, not an attacker.

### 8.5.4 Matching the gate to the risk tier

| Tier | Gate |
|---|---|
| READ | none |
| WRITE (low) | none, but logged; maybe an undo window |
| WRITE (customer-visible, e.g. email) | confirmation for new destinations |
| HIGH-IMPACT WRITE | explicit confirmation + limit checks + audit |
| HIGH-IMPACT, irreversible (delete account, transfer money) | confirmation **+** step-up auth **+** typed confirmation of the identifier |
| Enterprise / regulated | approval queue with a second human reviewer (dual control) |

```mermaid
flowchart LR
    R["READ"] --> W["WRITE"] --> H["HIGH-IMPACT"] --> I["IRREVERSIBLE / REGULATED"]
    R --- R2["log"]
    W --- W2["log + undo window"]
    H --- H2["confirm + limits + audit"]
    I --- I2["confirm + step-up + dual control"]

    style R fill:#a6e3a1,color:#1e1e2e
    style I fill:#f38ba8,color:#1e1e2e
```

### 8.5.5 Confirmation UX details that matter

| Detail | Why |
|---|---|
| **Echo the parameters** — "Cancel ORD-101 (Blue Running Shoes)?" | Defeats confirmation swapping; the user sees the real target |
| Prefer **out-of-band** confirmation for the highest tier (email/SMS/app push) | Injected content cannot click a real button |
| Show the **consequence**, not just the action | "This cannot be undone" |
| **No confirmation via chat text** for irreversible actions | Chat text is exactly what injection controls |
| Expire quickly | Limits the window for a stolen confirmation |
| Show *who* is confirming | Accountability |
| Never accept "the user said yes earlier" | Only the stored record counts |

> **Refinement *(beyond the lecture)*:** the strongest form of Rule 4 is **out-of-band approval**: the model can *propose* the action, but the approval is a click in a system the model cannot read or write. This is the same reason banking apps ask you to approve a transfer in the app rather than by typing "yes".

### 8.5.6 Audit: proposed vs executed

Log both, always:

```ts
// pseudo-code — one audit record per decision
audit.write({
  ts, actorId, sessionId,
  proposed: { tool: "cancelOrder", args },     // what the model asked for
  validated: { ok: true, normalisedArgs },     // what passed validation
  decision: "allow" | "deny" | "confirmation-required",
  reason,                                       // why
  executed: { ok: true, effect: "order-cancelled" },
});
```

| Question an auditor asks | Answer requires |
|---|---|
| What did the model propose? | `proposed` |
| What did we allow? | `validated` + `decision` |
| Did anything actually happen? | `executed` |
| Why was it denied? | `reason` |
| Who was acting? | `actorId` + `sessionId` |

> **This is the same trace object from Chapter 02 (§2.2)** — the evaluation trace and the security audit log are one artifact.

### 8.5.7 Human-in-the-loop placement

| Placement | Verdict |
|---|---|
| A sentence in the system prompt ("ask before cancelling") | ❌ Guidance, not a gate |
| A model-side check ("did the user confirm?") | ❌ The model believes claims |
| **A backend gate before the executor** | ✅ The only placement that holds |
| An approval queue for async/high-tier actions | ✅ Scales to enterprise review |

---

## 8.6 Common Mistakes

| Mistake | Why it hurts | Correct habit |
|---|---|---|
| Trusting model-generated numbers | Any amount is one injection away | Validate, then derive from trusted data |
| Letting the model pass `userId` | Identity becomes attacker-controlled | Take identity from the session |
| Asking the model to check ownership | Delegating authZ to a probabilistic system | Check ownership in code |
| Confirmation via chat text | Injection controls chat text | Store confirmation server-side |
| Confirmation without `argsHash` | Parameters can change between confirm and execute | Hash and re-verify the exact arguments |
| No expiry / no single use | Replay becomes a second action | `expiresAt` + `consumedAt` |
| Check-then-act without a transaction | State changes in between (TOCTOU) | Conditional update inside the transaction |
| No idempotency | Retries duplicate money movement | Idempotency key + unique constraint |
| No audit of denials | You cannot detect or explain attacks | Log proposed, validated, decision, executed |

---

## 8.7 Chapter Summary

| Rule | Statement |
|---|---|
| **Rule 2** | **Never trust tool arguments.** Validate them like HTTP parameters; derive authority-bearing values server-side |
| Validation order | Shape → normalise → format → range → integrity → ownership → policy → rate |
| **Rule 3** | **Authorization happens in code.** "Does USER-17 own ORD-101?" — not "does the LLM believe it?" |
| Identity source | The authenticated session, never a model argument or message text |
| **Rule 4** | **High-impact actions need explicit approval.** Protection is against attackers *and* model mistakes |
| Confirmation pattern | Create a pending action → ask → verify the stored record → execute |
| The unsafe version | "Only cancel after user confirmation" + "I confirmed earlier" ⇒ the model believes it |
| The safe version | `confirmationService.hasConfirmation(userId, orderId)` ⇒ the backend decides |
| The core distinction | A conversational claim is data; a stored confirmation is a fact |
| Supporting controls | Expiry, single use, `argsHash`, atomic conditional updates, idempotency, audit |

> **Final mental model for this chapter:** the model's tool call is an **untrusted request**. Between that request and the side effect there must be a code path that (1) validates the arguments, (2) resolves identity and ownership, and (3) checks a stored approval when the impact is high.

---

## Where This Goes Next

- **[Chapter 09](./09_Guardrails_As_Layers_Defense_In_Depth.md)** — how all five safe-tool rules plus input, instruction and output guardrails compose into one architecture.
- Cross-lecture: [Lecture 13](../../Lecture%2013/notes/README.md) (schemas and validation/repair), [Lecture 18](../../Lecture%2018/notes/README.md) (deterministic checks — the same assertions, applied to security), [Lecture 05](../../Lecture%2005/notes/README.md) (human-in-the-loop patterns for agents).

---

**Back to:** [Lecture 19 — Chapter Index](./README.md) · [Complete Consolidated Notes](./Lecture_19_Complete_Notes.md)
