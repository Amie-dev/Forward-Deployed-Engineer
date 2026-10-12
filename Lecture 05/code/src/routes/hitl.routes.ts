import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { defaultHITLService } from '../services/hitl-approval.service.js';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { defaultToolRegistry } from '../tools/registry.js';
import { GENERAL_AGENT_SYSTEM_PROMPT } from '../prompts/general-agent.prompt.js';

export const hitlRouter = Router();

const engine = new AgentExecutionEngine(defaultToolRegistry, {
  systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
});

const ResumeRequestSchema = z.object({
  ticketId: z.string().min(1, 'ticketId is required'),
  action: z.enum(['approve', 'reject']),
  reviewedBy: z.string().min(1, 'reviewedBy is required'),
  rejectionReason: z.string().optional()
});

/**
 * GET /api/approvals
 * Lists all pending approval tickets awaiting human sign-off
 */
hitlRouter.get('/', (req: Request, res: Response): void => {
  const pending = defaultHITLService.listPending();
  res.status(200).json({
    success: true,
    totalPending: pending.length,
    data: pending
  });
});

/**
 * POST /api/agent/resume
 * Webhook endpoint invoked by human reviewer (Slack / Admin Dashboard) to resume execution
 */
hitlRouter.post('/resume', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = ResumeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request payload',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { ticketId, action, reviewedBy, rejectionReason } = parseResult.data;

    const result = await engine.resume(ticketId, action, reviewedBy, rejectionReason);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[HITLResume Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal error resuming agent execution'
    });
  }
});
