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
