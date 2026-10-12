import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { defaultToolRegistry } from '../tools/registry.js';
import { GENERAL_AGENT_SYSTEM_PROMPT } from '../prompts/general-agent.prompt.js';

export const chatRouter = Router();

const engine = new AgentExecutionEngine(defaultToolRegistry, {
  systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
});

const ChatRequestSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
  sessionId: z.string().optional()
});

/**
 * POST /api/chat
 * Multi-tool conversational endpoint capable of executing parallel and sequential tools
 */
chatRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = ChatRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { message, sessionId } = parseResult.data;
    const result = await engine.execute(message, sessionId);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[ChatRoute Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error processing agent request'
    });
  }
});
