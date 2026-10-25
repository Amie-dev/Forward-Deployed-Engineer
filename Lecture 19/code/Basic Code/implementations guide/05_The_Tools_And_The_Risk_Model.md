# Chapter 05 — The Tools and the Risk Model

> **Chapter 06 §6.6: tools are not equally dangerous.** This file is where that
> sentence stops being an observation and becomes a data structure.
>
> Every tool carries four facts about itself: a **tier** (how much damage one call
> can do), an **asset class** (which of Chapter 02's five assets it can reach), a
> **schema** (what arguments it accepts), and **whether it acts on a row that
> belongs to somebody**. The layers in Chapters 06–09 read those facts. None of
> them are documentation — delete `tier` and `policy.ts` stops compiling.
>
> And the tools are where the lecture stops being about text. Up to here, a
> successful attack means the assistant *said* something wrong. From here, it means
> the assistant *did* something wrong.

---

## File details

| | `src/services/tools.ts` |
|---|---|
| **Lines** | 118 |
| **Layer** | services |
| **Purpose** | the four tools, with the metadata every deciding layer reads |
| **Exports** | `ToolSpec`, `TOOLS`, `findTool()`, `toolNames` |
| **Imports** | `domain/data` (the rows), `domain/types` (`AssetClass`, `Session`, `ToolTier`) |
| **Notes sections** | Ch 02 §2.3–2.7, Ch 06 §6.2, §6.3, §6.6, Ch 08 §8.3, §8.4 |

**The rule this file establishes:** a tool is a **capability**, not a function the
model may call. `run()` is the last method in the file and the last thing that
happens in a request — everything before it exists to decide whether it may be
reached.

---

## Commands

```bash
cd "Lecture 19/code/Basic Code"
npm run typecheck
```

```bash
# Chapter 06 §6.6 — the tiers, as the server describes them.
npm start
curl -s http://127.0.0.1:8080/security | python3 -c \
  'import json,sys; [print(t["name"], t["tier"], t["asset"], t["rowScoped"]) for t in json.load(sys.stdin)["tools"]]'
#   getOrderStatus      read                other-users-data     True
#   getDeliveryEstimate read                other-users-data     True
#   issueRefund         high-impact-write   downstream-systems   True
#   sendEmail           write               downstream-systems   False
```

```bash
# Chapter 06 §6.6 — the tier is not a label: it changes what happens.
npm run demo 2>&1 | grep -E 'high-impact-write|confirmation-required'
```

---

## `src/services/tools.ts` — the full file (part 1 of 2)

```ts
import { findOrder, REFUND_LOG, type Order } from "../domain/data.js";
import type { AssetClass, Session, ToolTier } from "../domain/types.js";

/**
 * Chapter 06 §6.2 — the tools, and the risk model that goes with them.
 *
 * A tool is where the lecture stops being about text and starts being about
 * consequences. Chapter 06 §6.3's rule is the shape of this file: a tool is a
 * **capability**, not a function the model may call. Everything below is
 * metadata for the layers that decide — `tier` for the rules, `asset` for the
 * blast radius, `schema` for validation, `rowScoped` for ownership.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** Chapter 06 §6.6 — how much damage one call can do. */
  tier: ToolTier;
  /** Chapter 02 §2.3–2.7 — which asset class this tool can reach. */
  asset: AssetClass;
  /** Chapter 08 §8.4 — the fields the tool accepts, and their types. */
  schema: Record<string, "string" | "number">;
  /** Chapter 08 §8.3 — does it act on a row that belongs to somebody? */
  rowScoped: boolean;
  /** The effect. Only ever reached after every check has passed. */
  run(args: Record<string, unknown>, session: Session): string;
}

function orderFrom(args: Record<string, unknown>): Order | undefined {
  return findOrder(String(args.orderId ?? ""));
}

export const TOOLS: ToolSpec[] = [
  {
    name: "getOrderStatus",
    description: "Look up an order: status, total and how much has already been refunded. Argument: orderId.",
    tier: "read",
    asset: "other-users-data",
    schema: { orderId: "string" },
    rowScoped: true,
    run(args) {
      const order = orderFrom(args);

      if (order === undefined) {
        return `Order not found: ${String(args.orderId)}.`;
      }

      // Returning `owner` is what makes the ownership check visible in the trace.
      return (
        `Order ${order.id}: status ${order.status}, owner ${order.owner}, ` +
        `total INR ${order.total}, refunded INR ${order.refunded}.`
      );
    },
  },
  {
    name: "getDeliveryEstimate",
    description: "Look up when an order will arrive, or when it arrived. Argument: orderId.",
    tier: "read",
    asset: "other-users-data",
    schema: { orderId: "string" },
    rowScoped: true,
    run(args) {
      const order = orderFrom(args);

      if (order === undefined) {
        return `Order not found: ${String(args.orderId)}.`;
      }

      return order.arrivedDaysAgo === null
        ? `Order ${order.id} should arrive on 15 October 2026.`
        : `Order ${order.id} arrived ${order.arrivedDaysAgo} days ago.`;
    },
  },
```

**How it works, block by block — part 1**

| Block | What it does and why |
| :--- | :--- |
| `ToolSpec.tier` | Chapter 06 §6.6. The input to a *rule set*, not a label: `policy.ts` refuses to compile against `"high-impact-write"` unless the value exists, and `requiresConfirmation` compares to it by name. |
| `ToolSpec.asset` | Chapter 02 §2.3–2.7. Naming which asset a tool can reach is what turns a threat model from a document into a query: `GET /security` prints it, and "which tools can touch other users' data?" becomes answerable in one line. |
| `ToolSpec.schema` | Chapter 08 §8.4. `Record<string, "string" \| "number">` is deliberately minimal — the *fields*, not a full JSON Schema. It is enough to drive validation (`validateArguments`), to drive the model's tool definition (`toolSchema` in `model.ts`), and to drive the argument-smuggling check in Layer 3. One description, three consumers. |
| `ToolSpec.rowScoped` | Chapter 08 §8.3. `true` means "this call acts on a row that belongs to somebody", which is the flag `authorize()` branches on. A tool with `rowScoped: false` skips the ownership check entirely — and `sendEmail` is exactly that, which is why its protection has to come from somewhere else. |
| `run(args, session)` | The effect. Note the signature: it receives the **session**, so a tool *can* record who did it (`REFUND_LOG`) — but it never uses the session to *decide*. Decision happens upstream, where it is auditable. |
| `orderFrom(args)` | One small helper, because two tools need the same lookup. It coerces with `String(args.orderId ?? "")`, which is honest about the input type: by the time `run()` is called the arguments have already been validated, so this is belt-and-braces rather than the check. |
| `getOrderStatus`: `tier: "read"` | Chapter 06 §6.6's lowest tier. Freely offered when the router grants it, no confirmation, no side effect. |
| `getOrderStatus`: `asset: "other-users-data"` | **Not** `confidential-information` — reading *any* order is fine, reading *someone else's* is the asset. Naming it this way is what makes `rowScoped: true` obviously necessary. |
| `getOrderStatus` returning `owner` | Deliberate. It puts the ownership decision *in the trace*: after the `confirmation` scenario, the trace shows `owner bob` and the refund that followed, so a reader can see that authorization had something real to check. |
| `Order not found` as a return value | Chapter 06 §6.2.1's spirit. A missing order is a **result**, not an exception: "order not found" is a perfectly good thing to tell a model, and a tool that threw would turn a normal lookup into a 500. |
| `getDeliveryEstimate` | The second read tool, and it exists for a reason that is easy to miss: it gives the `delivery` intent something to route to, so `CAPABILITY_MAP` is not a one-entry fiction. Its `arrivedDaysAgo === null` branch is the "not yet arrived" case. |

---

## `src/services/tools.ts` — the full file (part 2 of 2)

```ts
  {
    name: "issueRefund",
    description: "Refund an amount in INR against an order. Arguments: orderId, amount.",
    /**
     * Chapter 06 §6.6 — the tier that changes everything. Moving money is the
     * step from "the assistant said something wrong" to "the assistant did
     * something wrong", which is why it is the only tool that requires a
     * confirmation (Chapter 08 §8.6).
     */
    tier: "high-impact-write",
    asset: "downstream-systems",
    schema: { orderId: "string", amount: "number" },
    rowScoped: true,
    run(args, session) {
      const order = orderFrom(args);
      const amount = Number(args.amount);

      if (order === undefined) {
        return `Order not found: ${String(args.orderId)}.`;
      }

      order.refunded += amount;
      REFUND_LOG.push({ orderId: order.id, amount, user: session.user });

      return `Refunded INR ${amount} against ${order.id}. Total refunded now INR ${order.refunded}.`;
    },
  },
  {
    name: "sendEmail",
    description: "Send one email to one recipient. Arguments: to, subject, body.",
    /** Chapter 06 §6.6 — an outward-facing effect: it leaves the trust boundary. */
    tier: "write",
    asset: "downstream-systems",
    schema: { to: "string", subject: "string", body: "string" },
    rowScoped: false,
    run(args) {
      return `Email sent to ${String(args.to)} with subject "${String(args.subject)}".`;
    },
  },
];

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

export const toolNames: string[] = TOOLS.map((tool) => tool.name);
```

**How it works, block by block — part 2**

| Block | What it does and why |
| :--- | :--- |
| `issueRefund`: `tier: "high-impact-write"` | Chapter 06 §6.6's top tier, and the **only** place it is used. One tool carries the tier, and that single fact drives: the `high-impact-write` flag in Layer 3, the confirmation requirement in `policy.ts`, and the entire `confirmation` scenario. This is what "the tier is not a label" means. |
| `issueRefund`: `asset: "downstream-systems"` | Chapter 02 §2.7's asset E. A refund does not just read the database, it *changes the world* — money leaves, an accounting entry appears, a customer gets an email. Naming asset E is how the threat model distinguishes "leaked data" from "changed state". |
| `schema: { orderId: "string", amount: "number" }` | Two fields, and the types matter: `amount` is a **number**, so `validateArguments` can reject `"9800"` as a string and `NaN` as a value. A tool that accepted `amount: string` would push parsing into the effect, where nobody can review it. |
| `order.refunded += amount` | The mutation. This is the line the whole project exists to protect, and it is reached **only** after capability, actions, validation, authorization and confirmation have all passed. Everything else in the codebase is scaffolding around this one assignment. |
| `REFUND_LOG.push({ …, user: session.user })` | Chapter 09 §9.13: an effect that is not recorded did not happen. The log records *who*, which is the field an incident review needs and the field most implementations forget. Note that it takes `user` from the session — the one thing in this file that is not attacker-controlled. |
| `sendEmail`: `tier: "write"` | Middle tier. It does not move money and it does not need a human, but it leaves the building — so it is `write`, not `read`, and it gets an allowlist rule instead of a confirmation. |
| `sendEmail`: `rowScoped: false` | The honest declaration, and the reason the `over-permission` scenario exists. An email is not "somebody's row", so the ownership check cannot protect it. **The protection has to come from somewhere else** — and it does, twice: the capability router never offers `sendEmail` on a refund request, and Layer 3 enforces a recipient allowlist. |
| `sendEmail`'s three fields | `to`, `subject`, `body`. Layer 3 checks `to` and `subject` for newlines and angle brackets but deliberately **skips `body`** — a message body is free text by design, while the fields that *address* something are not. That distinction is one of the more useful habits in the file. |
| `findTool(name)` | The lookup that makes `tool === undefined` possible, and `strict` forces every caller to handle it. An unknown tool name is a refusal, not a crash: the model can name anything it likes, and "that tool does not exist" is a security decision with a trace entry. |
| `toolNames` | The full list, exported for tooling and documentation. Note it is **not** what gets offered to the model — `router.ts` decides that per request. A project that offered `toolNames` to the model would have no capability routing at all. |

**The one-sentence version.** A tool is a capability with a declared blast radius,
and the tier/schema/rowScoped triple is how every deciding layer in the next four
chapters knows what it is looking at without reading a single line of prose.

---

## Checkpoint

Before Chapter 06, you should be able to answer:

1. Which single tool carries `high-impact-write`, and what three behaviours does
   that one word cause?
2. `sendEmail` is `rowScoped: false`. What does that mean for the ownership check,
   and where does its protection come from instead?
3. Why is `getOrderStatus`'s asset `other-users-data` rather than
   `confidential-information`?
4. Why does `sendEmail`'s schema include `body`, but Layer 3 skip checking it?
5. What is the difference between `toolNames` and the `toolNames` passed to
   `ModelClient.answer()`?
6. Which line in `issueRefund` is "the effect", and what must be true before it is
   reached?

---

**Back to:** [Guide index](./README.md) · [Basic Code README](../README.md)

**Next:** [Chapter 06 — Least Privilege and Capability Routing](./06_Least_Privilege_And_Capability_Routing.md)
