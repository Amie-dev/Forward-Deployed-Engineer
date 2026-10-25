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
