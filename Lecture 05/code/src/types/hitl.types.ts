import OpenAI from 'openai';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface PendingApprovalTicket {
  ticketId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
  riskLevel: 'critical' | 'high' | 'medium';
  reason: string;
  createdAt: string;
  status: ApprovalStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  // Preserved state for resumption
  savedMessages: OpenAI.Chat.ChatCompletionMessageParam[];
}

export interface HITLResumePayload {
  ticketId: string;
  action: 'approve' | 'reject';
  reviewedBy: string;
  rejectionReason?: string;
}
