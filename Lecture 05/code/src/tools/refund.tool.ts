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
