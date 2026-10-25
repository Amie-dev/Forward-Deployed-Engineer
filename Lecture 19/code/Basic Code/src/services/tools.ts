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
