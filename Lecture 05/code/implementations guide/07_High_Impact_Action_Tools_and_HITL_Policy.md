# Chapter 07: High-Impact Action Tools & Human-in-the-Loop Governance

> **Chapter Goal:** Implement high-consequence mutation tools (`refundCustomer`), establish dynamic governance policies (`requiresApproval`), and build the durable Human-in-the-Loop (HITL) approval ticket manager (`HITLApprovalService`).

---

## 7.1 File Details & Purpose

| File | Target Path | Operational Purpose |
| :--- | :--- | :--- |
| **`refund.tool.ts`** | `Lecture 05/code/src/tools/refund.tool.ts` | Represents a Tier 3 Critical Action Tool. Modifies financial ledger state and enforces a governance gate when the requested amount exceeds the configured threshold (`HITL_FINANCIAL_THRESHOLD`). |
| **`hitl-approval.service.ts`** | `Lecture 05/code/src/services/hitl-approval.service.ts` | Manages the queue of pending approval tickets. Preserves execution session snapshots (`savedMessages`) and handles approvals/rejections from managers. |

### Terminal Commands
```bash
# Run the automated HITL test script
npm run test:hitl
```

---

## 7.2 Full Code File: `src/tools/refund.tool.ts`

```typescript
import { z } from 'zod';
import { Tool } from '../types/tool.types.js';
import { env } from '../config/env.js';

export const RefundArgsSchema = z.object({
  orderId: z.string().min(1).describe('The unique identifier of the customer order (e.g. ORD-9821)'),
  amount: z.number().positive().describe('The financial refund amount requested'),
  reason: z.string().min(3).describe('The justification for the refund request')
});

export type RefundArgs = z.infer<typeof RefundArgsSchema>;

export interface RefundOutput {
  status: 'PROCESSED' | 'PENDING_APPROVAL';
  transactionId: string;
  orderId: string;
  amount: number;
  message: string;
  processedAt: string;
}

export const refundTool: Tool<RefundArgs, RefundOutput> = {
  name: 'refundCustomer',
  description:
    'Processes a financial refund to a customer account for an order. High-value refunds require human managerial approval.',
  tier: 'critical_action',
  argsSchema: RefundArgsSchema,
  parameters: {
    type: 'object',
    properties: {
      orderId: {
        type: 'string',
        description: 'Customer order ID'
      },
      amount: {
        type: 'number',
        description: 'Refund amount'
      },
      reason: {
        type: 'string',
        description: 'Reason for refund'
      }
    },
    required: ['orderId', 'amount', 'reason']
  },
  // High-impact governance rule
  requiresApproval: (args: RefundArgs) => {
    return args.amount > env.HITL_FINANCIAL_THRESHOLD;
  },
  execute: async ({ orderId, amount, reason }) => {
    const txId = `TXN-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

    return {
      status: 'PROCESSED',
      transactionId: txId,
      orderId,
      amount,
      message: `Successfully refunded ${amount} for order ${orderId}. Reason: ${reason}`,
      processedAt: new Date().toISOString()
    };
  }
};
```

---

## 7.3 Block-by-Block Explanation: `src/tools/refund.tool.ts`

### Block 1: Zod Argument Schema
```typescript
export const RefundArgsSchema = z.object({
  orderId: z.string().min(1).describe('The unique identifier of the customer order (e.g. ORD-9821)'),
  amount: z.number().positive().describe('The financial refund amount requested'),
  reason: z.string().min(3).describe('The justification for the refund request')
});
```
- **What this does:** Validates that incoming tool arguments specify an order identifier, a positive monetary amount, and an explanatory reason string.

### Block 2: Governance Policy Predicate (`requiresApproval`)
```typescript
  tier: 'critical_action',
  requiresApproval: (args: RefundArgs) => {
    return args.amount > env.HITL_FINANCIAL_THRESHOLD;
  },
```
- **What this does:** Implements dynamic authorization logic.
- **How it works:** When an autonomous LLM requests `refundCustomer({ orderId: "ORD-50001", amount: 50000 })`, the engine calls `requiresApproval(args)`. Since ₹50,000 exceeds ₹5,000 (`HITL_FINANCIAL_THRESHOLD`), execution is intercepted immediately before calling `execute()`.

### Block 3: Execution Logic
```typescript
  execute: async ({ orderId, amount, reason }) => {
    const txId = `TXN-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
    return { ... };
  }
```
- **What this does:** Executes the refund transaction once authorization is granted. Generates an audit transaction ID and returns structured confirmation.

---

## 7.4 Full Code File: `src/services/hitl-approval.service.ts`

```typescript
import { PendingApprovalTicket, ApprovalStatus } from '../types/hitl.types.js';

export class HITLApprovalService {
  private tickets: Map<string, PendingApprovalTicket> = new Map();

  public createTicket(ticket: Omit<PendingApprovalTicket, 'status' | 'createdAt'>): PendingApprovalTicket {
    const fullTicket: PendingApprovalTicket = {
      ...ticket,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    this.tickets.set(fullTicket.ticketId, fullTicket);
    console.log(
      `🔒 [HITL Gate] Created Approval Ticket #${fullTicket.ticketId} for tool '${fullTicket.toolName}' (Session: ${fullTicket.sessionId})`
    );
    return fullTicket;
  }

  public getTicket(ticketId: string): PendingApprovalTicket | undefined {
    return this.tickets.get(ticketId);
  }

  public listPending(): PendingApprovalTicket[] {
    return Array.from(this.tickets.values()).filter((t) => t.status === 'pending');
  }

  public resolveTicket(
    ticketId: string,
    action: 'approve' | 'reject',
    reviewedBy: string,
    rejectionReason?: string
  ): PendingApprovalTicket {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Approval Ticket #${ticketId} not found.`);
    }

    if (ticket.status !== 'pending') {
      throw new Error(`Approval Ticket #${ticketId} is already marked as ${ticket.status}.`);
    }

    ticket.status = action === 'approve' ? 'approved' : 'rejected';
    ticket.reviewedBy = reviewedBy;
    ticket.reviewedAt = new Date().toISOString();
    ticket.rejectionReason = rejectionReason;

    console.log(
      `⚖️ [HITL Gate] Ticket #${ticketId} was ${ticket.status.toUpperCase()} by ${reviewedBy}`
    );

    return ticket;
  }

  public clear(): void {
    this.tickets.clear();
  }
}

export const defaultHITLService = new HITLApprovalService();
```

---

## 7.5 Block-by-Block Explanation: `src/services/hitl-approval.service.ts`

### Block 1: Ticket Store & Creation
```typescript
  public createTicket(ticket: Omit<PendingApprovalTicket, 'status' | 'createdAt'>): PendingApprovalTicket { ... }
```
- **What this does:** Persists an intercepted tool execution.
- **How it works:** Stores the ticket with status `'pending'`, records the requested tool name, arguments, risk level, and saves the snapshot of conversation messages (`savedMessages`).

### Block 2: Ticket Resolution & State Transition
```typescript
  public resolveTicket(
    ticketId: string,
    action: 'approve' | 'reject',
    reviewedBy: string,
    rejectionReason?: string
  ): PendingApprovalTicket { ... }
```
- **What this does:** Transition ticket status to `'approved'` or `'rejected'`.
- **How it works:** Validates that the ticket exists and is currently `'pending'`. Stamps reviewer identity (`reviewedBy`), timestamp (`reviewedAt`), and optional justification (`rejectionReason`).
