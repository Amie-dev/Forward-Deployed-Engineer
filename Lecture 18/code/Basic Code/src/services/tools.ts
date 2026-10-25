/**
 * Chapter 02 §2.3 — the three tools, and the fixture data behind them.
 *
 * The fixtures are hard-coded on purpose. Chapter 05 §5.2 says "freeze what you
 * can before running the dataset"; a tool that reads a live database turns every
 * eval run into a different experiment, and a different experiment cannot be
 * compared with yesterday's score.
 */

/** What the model is offered. Every tool takes one argument: an order id. */
export interface ToolDefinition {
  name: string;
  description: string;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "getOrderStatus",
    description: "Look up the shipping status of an order. Argument: the order id, for example ORD-101.",
  },
  {
    name: "getDeliveryEstimate",
    description: "Look up when an order will arrive, or when it arrived. Argument: the order id.",
  },
  {
    name: "getRefundAmount",
    description: "Look up the refund amount for an order. Argument: the order id.",
  },
];

interface OrderFixture {
  status: string;
  /** `null` means the order has not arrived yet. */
  arrivedDaysAgo: number | null;
  refundable: number;
}

const ORDERS: Record<string, OrderFixture> = {
  "ORD-101": { status: "shipped", arrivedDaysAgo: null, refundable: 0 },
  "ORD-102": { status: "delivered", arrivedDaysAgo: 20, refundable: 4999 },
  "ORD-103": { status: "delivered", arrivedDaysAgo: 31, refundable: 4999 },
};

/**
 * Chapter 02 §2.3 — run one tool.
 *
 * A missing order is a **result**, not an exception. "Order not found" is a
 * perfectly valid thing to tell the agent, and Chapter 05 wants to be able to
 * assert that the agent *said so* rather than inventing a status for ORD-999 —
 * which is exactly the hallucination the judge in Chapter 06 exists to catch.
 */
export function runTool(name: string, argument: string): string {
  const orderId = argument.trim().toUpperCase();
  const order = ORDERS[orderId];

  if (order === undefined) {
    return `Order not found: ${orderId}.`;
  }

  switch (name) {
    case "getOrderStatus":
      return order.arrivedDaysAgo === null
        ? `Order ${orderId} has been shipped and is on the way.`
        : `Order ${orderId} was delivered ${order.arrivedDaysAgo} days ago.`;
    case "getDeliveryEstimate":
      return order.arrivedDaysAgo === null
        ? `Order ${orderId} should arrive on 15 October 2026.`
        : `Order ${orderId} arrived ${order.arrivedDaysAgo} days ago.`;
    case "getRefundAmount":
      return `Order ${orderId} is eligible for a refund of INR ${order.refundable}.`;
    default:
      return `Unknown tool: ${name}.`;
  }
}

/** The tool names, in the order they are offered to the model. */
export const toolNames: string[] = toolDefinitions.map((tool) => tool.name);
