# Chapter 07 — Never Trust, Always Verify

> **Chapter 08: the model can be persuaded, so what does it matter?** It matters
> because persuasion and permission are different things. This file is where that
> sentence becomes four functions.
>
> Everything here runs **after** the model has already been fooled, and it runs on
> facts the model cannot touch: the shape of the argument, the owner of the row,
> the size of the amount, and whether a human has decided. None of these functions
> reads a sentence the attacker wrote. That is why they hold when the model is
> fully persuaded — the attacker's text is not an input to any of them.
>
> There is also one field in here that most implementations forget, and its absence
> is a complete authentication bypass: `fingerprint`.

---

## File details

| | `src/services/policy.ts` |
|---|---|
| **Lines** | 256 |
| **Layer** | services |
| **Purpose** | validation, row-level authorization, and confirmation bound to arguments |
| **Exports** | `Validation`, `validateArguments()`, `Authorization`, `authorize()`, `requiresConfirmation()`, `requestConfirmation()`, `ConfirmOutcome`, `confirm()`, `pendingConfirmations()` |
| **Imports** | `node:crypto`, `config`, `domain/data`, `domain/types`, `tools` (type only) |
| **Notes sections** | Ch 08 §8.3, §8.4, §8.5, §8.6 |

**The ordering is the design.** Validation before authorization, because "this is
not even a valid order id" is a cheaper and more honest answer than "you are not
allowed to touch ORD-202" — and because a rule that runs on garbage arguments
cannot be trusted to mean anything.

---

## Commands

```bash
cd "Lecture 19/code/Basic Code"
npm run typecheck
```

```bash
# Chapter 08 §8.3 — authorization, refusing an injected call. The refusal has
# nothing to do with the injection text.
npm run demo 2>&1 | sed -n '/indirect-no-filter/,/verdict/p'

# Chapter 08 §8.6 — the confirmation, and the fingerprint it is bound to.
npm run demo 2>&1 | grep -A1 'issueRefund\[pending'

# Chapter 08 §8.6 — confirmation swapping, refused.
npm run demo 2>&1 | sed -n '/confirmation-swap/,/verdict/p'
```

---

## `src/services/policy.ts` — the full file (part 1 of 3)

```ts
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config/config.js";
import { findOrder } from "../domain/data.js";
import type { Confirmation, Session } from "../domain/types.js";
import type { ToolSpec } from "./tools.js";

/**
 * Chapter 08 — never trust, always verify.
 *
 * This file is the answer to the lecture's hardest question: *the model can be
 * persuaded, so what does it matter?* It matters because persuasion and
 * permission are different things. Everything here runs **after** the model has
 * already been fooled, on facts the model cannot touch:
 *
 *   validateArguments   is the argument well-formed?            (§8.4)
 *   authorize           is this caller allowed to do this to this row? (§8.3)
 *   requiresConfirmation does a human have to decide?           (§8.6)
 *   confirm             was the human's decision the same one?  (§8.6)
 *
 * The ordering is the design. Validation before authorization, because
 * "this is not even a valid order id" is a cheaper and more honest answer than
 * "you are not allowed to touch ORD-202" — and because a rule that runs on
 * garbage arguments cannot be trusted to mean anything.
 */

const ORDER_ID = /^ORD-\d{3,6}$/;
const EMAIL = /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i;

export type Validation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Chapter 08 §8.4 — argument validation.
 *
 * The three checks that catch the most, in the order they catch it:
 *
 *   1. **Unknown fields are refused, not ignored.** A field the tool does not
 *      declare is either a mistake or an attempt to smuggle a second value into
 *      a call that was meant to carry one.
 *   2. **Types and formats.** An order id is `ORD-\d{3,6}`; anything else is not
 *      an order id, whatever it says about itself.
 *   3. **Ranges against the world, not against the argument.** A refund may not
 *      exceed what is left to refund on the order — a fact the model does not
 *      get to supply.
 */
export function validateArguments(tool: ToolSpec, args: Record<string, unknown>): Validation {
  const unknown = Object.keys(args).filter((key) => !(key in tool.schema));

  if (unknown.length > 0) {
    return { ok: false, reason: `unknown argument(s): ${unknown.join(", ")}` };
  }

  const cleaned: Record<string, unknown> = {};

  for (const [field, type] of Object.entries(tool.schema)) {
    const value = args[field];

    if (value === undefined || value === null || value === "") {
      return { ok: false, reason: `missing required argument "${field}"` };
    }

    if (type === "string") {
      if (typeof value !== "string") {
        return { ok: false, reason: `"${field}" must be a string, got ${typeof value}` };
      }

      cleaned[field] = value.trim();
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: `"${field}" must be a finite number, got ${typeof value}` };
    }

    cleaned[field] = value;
  }

  if (typeof cleaned.orderId === "string") {
    const orderId = cleaned.orderId.toUpperCase();
    cleaned.orderId = orderId;

    if (!ORDER_ID.test(orderId)) {
      return { ok: false, reason: `"${orderId}" is not an order id (expected ORD-000)` };
    }
  }

  if (tool.name === "sendEmail" && typeof cleaned.to === "string" && !EMAIL.test(cleaned.to)) {
    return { ok: false, reason: `"${cleaned.to}" is not an email address` };
  }

  if (typeof cleaned.amount === "number") {
    if (!Number.isInteger(cleaned.amount)) {
      return { ok: false, reason: "amount must be a whole number of INR" };
    }

    if (cleaned.amount <= 0) {
      return { ok: false, reason: "amount must be greater than zero" };
    }

    const order = findOrder(String(cleaned.orderId));

    if (order !== undefined) {
      const remaining = order.total - order.refunded;

      if (cleaned.amount > remaining) {
        return {
          ok: false,
          reason: `amount INR ${cleaned.amount} exceeds what is left to refund on ${order.id} (INR ${remaining})`,
        };
      }
    }
  }

  return { ok: true, args: cleaned };
}
```

**How it works, block by block — validation (§8.4)**

| Block | What it does and why |
| :--- | :--- |
| `ORDER_ID` / `EMAIL` | Two anchored regexes (`^…$`), at module scope so the rules are visible at the top of the file. Anchors matter: without `^`/`$`, `ORD-101` would match inside `xORD-101y`. |
| `Object.keys(args).filter((key) => !(key in tool.schema))` | **Unknown fields are refused, not ignored.** A field the tool does not declare is either a bug or an attempt to smuggle a second value into a call meant to carry one. Silently dropping it teaches the model nothing and hides the attempt. |
| `cleaned` as a **new** object | Validation returns a *normalised copy*, never mutating the input. Everything downstream uses `cleaned`, so authorization and confirmation see the values validation approved — not the model's originals. |
| `value === undefined \|\| null \|\| ""` | Three ways to be absent. `""` matters because a model will happily emit an empty string, and an empty string is not an order id. |
| `!Number.isFinite(value)` | Rejects `NaN`, `Infinity` and `-Infinity` — all of which are `typeof "number"` in JavaScript. Without this, `amount: Infinity` passes a naive type test and then `order.refunded += Infinity`. |
| `const orderId = cleaned.orderId.toUpperCase(); cleaned.orderId = orderId;` | Normalise into a local, then store. **The local is not style** — assigning to an index-signature property resets TypeScript's narrowing, and this project compiles under `strict`. |
| `!ORDER_ID.test(orderId)` | Format enforcement. An order id is `ORD-\d{3,6}`; anything else is not an order id, *whatever it says about itself*. This is what turns `"../etc/passwd"` into a refusal rather than a lookup. |
| `tool.name === "sendEmail" && !EMAIL.test(cleaned.to)` | Per-tool format rules, in the one place that knows the tool. Note what it does **not** do: it does not check the *domain*. "Is this a well-formed email?" belongs here; "may we mail this domain?" is a policy decision and lives in Layer 3's allowlist. Splitting them keeps each rule testable on its own. |
| `Number.isInteger(cleaned.amount)` / `<= 0` | A refund of INR 0.5 is a data error. And `-9800` would *add* money back to the order through `order.refunded += amount` — the kind of bug that exists only because nobody checked the sign. |
| `const remaining = order.total - order.refunded` | **The most important line in the function.** The ceiling comes from the *world*, not from the argument. `order.total` is a fact about the order; the model supplies only the amount to test against it. A rule comparing the amount to another model-supplied value would be checking one guess against another. |
| `if (order !== undefined)` | An unknown order is **not** a validation failure — it is an authorization failure, and `authorize()` reports it with the right reason. Keeping checks in their own lanes is what makes the trace readable. |
| `{ ok: true, args } \| { ok: false, reason }` | A discriminated union, so callers must handle both branches. No `null`, no exception, no "returns the args or undefined" — a shape that makes forgetting the failure case impossible. |

---

## `src/services/policy.ts` — the full file (part 2 of 3)

```ts
export type Authorization = { ok: true } | { ok: false; reason: string };

/**
 * Chapter 08 §8.3 — authorization, and the one rule that makes it work.
 *
 * **Identity comes from the session, never from an argument.** If `user` were
 * something the model could fill in, the model would be choosing its own
 * privileges — which is the whole of Chapter 07's warning about over-permissioned
 * tools, arriving from the other direction.
 *
 * The row-level check is what turns a prompt injection from a data breach into a
 * failed request: an injected "refund ORD-202" is refused here because ORD-202
 * belongs to somebody else, and it is refused *without anyone having to
 * recognise the injection*.
 */
export function authorize(tool: ToolSpec, args: Record<string, unknown>, session: Session): Authorization {
  if (!tool.rowScoped) {
    return { ok: true };
  }

  const order = findOrder(String(args.orderId ?? ""));

  if (order === undefined) {
    return { ok: false, reason: `no such order: ${String(args.orderId)}` };
  }

  if (order.owner !== session.user) {
    return {
      ok: false,
      reason: `${order.id} belongs to another customer; ${session.user} may not ${tool.name} it`,
    };
  }

  return { ok: true };
}
```

**How it works, block by block — authorization (§8.3)**

| Block | What it does and why |
| :--- | :--- |
| `if (!tool.rowScoped) return { ok: true }` | An explicit early return for tools that do not act on somebody's row (`sendEmail`). Written as an early return rather than nesting the rest in an `if` so that the **absence** of a check is visible — which is what you want when reviewing a security file. |
| `findOrder(String(args.orderId ?? ""))` | The row lookup. `args.orderId` was normalised by validation, so this is a plain read; `?? ""` guarantees a miss rather than an `undefined.toUpperCase()` crash if the pipeline order ever changes. |
| `order === undefined` → `no such order` | Reported here, not in validation. A nonexistent order is an *authorization* fact — "there is nothing here for you to act on" — and giving it its own reason is what lets the audit log distinguish a typo from an attack. |
| `order.owner !== session.user` | **The line that makes prompt injection survivable.** The injected call was `issueRefund ORD-202`; ORD-202 belongs to `bob`; the session is `alice`; the refusal happens without anyone having to notice the injection, classify it, or match it against a pattern. |
| The refusal's wording | It names the row, the caller and the operation. That is the sentence a support engineer needs at 2 a.m., and it is also the sentence that goes back into the model's context so it stops asking. |
| `session` as the third parameter | The signature is the security property. `authorize()` cannot see the model, the question or the documents — only the validated args and the session. There is no code path by which a model-supplied `user` could reach this comparison. |
| **What is missing** | No role table, no permission matrix, no `if (session.user === "admin")`. Deliberate: the *smallest* correct authorization rule is one that is obviously correct. Roles are where row-level checks go to die, and Chapter 08 §8.3's argument is that ownership is the rule that generalises. |

---

## `src/services/policy.ts` — the full file (part 3 of 3)

```ts
/**
 * Chapter 08 §8.6 — the confirmation.
 *
 * A high-impact write is not refused above the auto-approve limit; it is
 * *deferred*. The model's proposal becomes a pending record, and the request
 * ends there. That is the difference between a control that says no and a
 * control that says "not on your own".
 */
const pending = new Map<string, Confirmation>();

/**
 * Chapter 08 §8.6 — the fingerprint, which is the part teams forget.
 *
 * A confirmation id alone is not a decision; it is a *reference* to a decision.
 * Without a fingerprint binding it to exact arguments, the flow is exploitable
 * in the simplest possible way: get a confirmation for "refund ORD-101, INR
 * 2,500", then replay it as "refund ORD-202, INR 9,800". The human approved the
 * first thing. This hash is what makes the approval mean the first thing.
 *
 * The hash is taken over the sorted entries so that key order cannot change it —
 * a fingerprint that depends on property order is a fingerprint that breaks when
 * somebody refactors an object literal.
 */
function fingerprint(tool: string, args: Record<string, unknown>): string {
  const stable = JSON.stringify([tool, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]);
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

export function requiresConfirmation(tool: ToolSpec, args: Record<string, unknown>): boolean {
  return tool.tier === "high-impact-write" && Number(args.amount ?? 0) > config.autoApproveLimit;
}

export function requestConfirmation(tool: ToolSpec, args: Record<string, unknown>, session: Session): Confirmation {
  const confirmation: Confirmation = {
    id: randomUUID().slice(0, 8),
    user: session.user,
    tool: tool.name,
    args,
    fingerprint: fingerprint(tool.name, args),
    status: "pending",
  };

  pending.set(confirmation.id, confirmation);
  return confirmation;
}

export type ConfirmOutcome =
  | { ok: true; tool: string; args: Record<string, unknown>; confirmation: Confirmation }
  | { ok: false; reason: string };

/**
 * Chapter 08 §8.6 — accepting a confirmation.
 *
 * Four checks, and each one is a way this flow is attacked in practice:
 *
 *   exists        an id from nowhere is not a decision
 *   still pending a confirmation is single-use; replay is not approval
 *   same user     a confirmation is bound to the person who triggered it
 *   same arguments the fingerprint — the confirmation-swapping defence
 */
export function confirm(
  id: string,
  session: Session,
  submitted: Record<string, unknown> | undefined,
): ConfirmOutcome {
  const confirmation = pending.get(id);

  if (confirmation === undefined) {
    return { ok: false, reason: `no confirmation with id ${id}` };
  }

  if (confirmation.status !== "pending") {
    return { ok: false, reason: `confirmation ${id} was already ${confirmation.status}` };
  }

  if (confirmation.user !== session.user) {
    return { ok: false, reason: `confirmation ${id} belongs to another customer` };
  }

  if (submitted !== undefined) {
    const submittedFingerprint = fingerprint(confirmation.tool, submitted);

    if (submittedFingerprint !== confirmation.fingerprint) {
      // Reject the whole confirmation, not just this attempt: an approval that
      // has been replayed with different arguments is not an approval any more.
      confirmation.status = "rejected";
      return {
        ok: false,
        reason:
          `confirmation ${id} was issued for different arguments ` +
          `(expected ${confirmation.fingerprint}, got ${submittedFingerprint})`,
      };
    }
  }

  confirmation.status = "confirmed";
  return { ok: true, tool: confirmation.tool, args: confirmation.args, confirmation };
}

/** Chapter 08 §8.6 — what is waiting for a human. */
export function pendingConfirmations(): Confirmation[] {
  return [...pending.values()].filter((confirmation) => confirmation.status === "pending");
}
```

**How it works, block by block — confirmation (§8.6)**

| Block | What it does and why |
| :--- | :--- |
| `const pending = new Map<string, Confirmation>()` | The store. In-memory so the demo is reproducible; a production system uses a table with the same four columns. Note it is module-private — nothing outside this file can reach into it, so `confirm()` is the only way a pending decision changes state. |
| `Object.entries(args).sort(...)` before hashing | **The detail that makes the fingerprint stable.** Hashing `{orderId, amount}` and `{amount, orderId}` would produce different fingerprints for the same decision, and it would break the day somebody reordered an object literal. Sorting removes that entire class of false rejection. |
| `JSON.stringify([tool, entries])` | The tool **name** is hashed too, not just the arguments. Without it, a confirmation for `sendEmail {to: x}` and one for `issueRefund {to: x}` could collide — and the whole point is that the approval names one specific operation. |
| `createHash("sha256").digest("hex").slice(0, 12)` | A hash, not the arguments themselves, so the stored fingerprint does not duplicate sensitive values. Twelve hex characters is 48 bits — plenty for distinguishing a handful of live confirmations, and short enough to read out loud in a demo. |
| `requiresConfirmation` | `tier === "high-impact-write" && amount > autoApproveLimit`. Two conditions, both from sources the model does not control: the tier from `tools.ts`, the limit from `config.ts`. There is no third condition that reads the conversation. |
| `Number(args.amount ?? 0)` | Defensive: if `amount` is missing the expression is `0 > limit` → `false` → no confirmation. That is the *wrong* direction for safety, which is exactly why `validateArguments` runs first and would already have refused a missing amount. Order matters, and this is what "validation before confirmation" buys. |
| `randomUUID().slice(0, 8)` | A short, human-quotable id. Random rather than sequential, so an attacker cannot guess the next confirmation id — a sequential id is an enumeration vulnerability in a flow whose whole purpose is human approval. |
| `requestConfirmation(tool, args, session)` | Note what it stores: the **validated** `args` (the caller passes `valid.args`), the fingerprint, and `session.user`. That trio makes the confirmation self-contained: everything needed to re-check the decision is inside the record. |
| `confirm()`'s four checks, in order | `exists` → `still pending` → `same user` → `same arguments`. Cheapest first, and each maps to a real attack: a forged id, a replayed confirmation, a confirmation stolen by another account, and confirmation swapping. |
| `confirmation.status !== "pending"` | **Single use.** A confirmation that has been confirmed once cannot be confirmed again, so the same approval cannot be spent twice. This is the check that makes the flow *stateful* rather than a signed token. |
| `confirmation.user !== session.user` | A confirmation is bound to the person who triggered it. Without this, an id leaked in a log or a screenshot becomes a way for somebody else to execute the approved action. |
| `submitted !== undefined` and the comparison | **The confirmation-swapping defence.** The caller may pass the arguments they are confirming; if they differ from what was approved, the whole confirmation is rejected. The `confirmation-swap` scenario replays `ORD-202 / 9800` as `ORD-101 / 9800` and gets exactly this refusal. |
| `confirmation.status = "rejected"` on mismatch | Rejecting the *whole* confirmation, not just the attempt. An approval replayed with different arguments is not an approval any more, and leaving it `pending` would invite a second attempt. |
| The mismatch reason | It prints both fingerprints — `expected f55fdc63b768, got cf3f70f88314`. Two short strings that prove the arguments differed without leaking the arguments themselves. That is what a fingerprint is *for*. |
| `{ ok: true, tool, args, confirmation }` | The successful outcome returns the **stored** args, not the submitted ones. Even on the happy path the caller cannot substitute its own values, because the agent executes `outcome.args`. |
| `pendingConfirmations()` | The queue, for an operator UI or a future `GET /confirmations` route. Exported for visibility — the honest shape for a project whose subject is the *mechanism*, not the back office. |

---

## The three rules this file establishes

1. **Validation, authorization and confirmation are separate functions with
   separate reasons.** Each answers exactly one question, and each refusal names
   the question it answered. That is what makes a trace readable.
2. **Every fact that matters comes from outside the model.** The row's owner, the
   remaining refundable amount, the tier, the auto-approve limit — all from
   `data.ts`, `tools.ts` and `config.ts`. The model supplies an order id and a
   number, and both are tested against the world.
3. **A human decision is bound to its arguments.** The fingerprint is the
   difference between "a human approved something" and "a human approved *this*".

---

## Checkpoint

Before Chapter 08, you should be able to answer:

1. Why does validation run before authorization?
2. Which line in `validateArguments` makes the refund ceiling a fact about the
   world rather than about the argument?
3. Why does `authorize()` take a `Session` instead of a `userId` argument?
4. What are the four checks in `confirm()`, and which attack does each one stop?
5. Why are the arguments sorted before hashing, and what breaks if they are not?
6. Why is the tool *name* part of the fingerprint?
7. Why does `confirm()` return the stored args rather than the submitted ones?

---

**Back to:** [Guide index](./README.md) · [Basic Code README](../README.md)

**Next:** [Chapter 08 — The Four Guardrail Layers](./08_The_Four_Guardrail_Layers.md)
