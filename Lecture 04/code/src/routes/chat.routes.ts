import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { openai, isLiveApiKeyConfigured } from '../lib/openai.js';
import { config } from '../config/env.js';
import { SessionStore } from '../services/session.store.js';
import { ContextManagerService } from '../services/context-manager.service.js';
import { StreamingService } from '../services/streaming.service.js';
import { GroundingService } from '../services/grounding.service.js';

const router = Router();
const sessionStore = SessionStore.getInstance();
const contextManager = new ContextManagerService();
const streamingService = new StreamingService();
const groundingService = new GroundingService();

// ============================================================================
// Input Validation Schemas
// ============================================================================

const ChatRequestSchema = z.object({
  sessionId: z.string().default(() => `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
  userId: z.string().default('user_vip_001'),
  message: z.string().min(1, 'Message text is required'),
});

const GroundedQuerySchema = z.object({
  message: z.string().min(1, 'Query message is required'),
});

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * POST /api/chat
 * Synchronous Multi-Turn Chat Completion with Full Usage Telemetry
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { sessionId, userId, message } = ChatRequestSchema.parse(req.body);

    // 1. Associate session with user identity (Application Memory)
    sessionStore.getOrCreateSession(sessionId, userId);

    // 2. Append user turn to session history
    sessionStore.appendUserMessage(sessionId, message);

    // 3. Hydrate context with Token-Budgeted Sliding Window & Summary
    const { messages: hydratedMessages, metrics } = await contextManager.prepareHydratedPayload(sessionId);

    let reply = '';
    let tokenUsage: any = null;

    if (isLiveApiKeyConfigured()) {
      const completion = await openai.chat.completions.create({
        model: config.AI_MODEL,
        messages: hydratedMessages as any,
        temperature: config.AI_TEMPERATURE,
      });

      reply = completion.choices[0]?.message?.content || 'I could not generate a response.';
      tokenUsage = completion.usage;
    } else {
      // Offline local simulation
      reply = `[Tomato Support Executive]: Thank you for reaching out regarding "${message}". We are tracking your inquiry for session ${sessionId}.`;
      tokenUsage = {
        prompt_tokens: metrics.totalEstimatedTokens,
        completion_tokens: 35,
        total_tokens: metrics.totalEstimatedTokens + 35,
      };
    }

    // 4. Append assistant reply to session store
    sessionStore.appendAssistantMessage(sessionId, reply);

    res.status(200).json({
      success: true,
      sessionId,
      reply,
      metrics,
      usage: tokenUsage,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/chat/stream
 * Real-Time Server-Sent Events (SSE) Streaming Endpoint
 */
router.post('/stream', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { sessionId, userId, message } = ChatRequestSchema.parse(req.body);

    // Ensure session is initialized with correct user profile
    sessionStore.getOrCreateSession(sessionId, userId);

    // Delegate to dedicated streaming lifecycle engine
    await streamingService.handleStreamingChat(req, res, sessionId, message);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/chat/grounded
 * Zero-Hallucination RAG Grounded Q&A with Zod Constrained Decoding
 */
router.post('/grounded', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message } = GroundedQuerySchema.parse(req.body);

    const groundedResult = await groundingService.generateGroundedAnswer(message);

    res.status(200).json({
      success: true,
      result: groundedResult,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/chat/sessions/:sessionId
 * Session Telemetry, Message History, and Context Inspection
 */
router.get('/sessions/:sessionId', (req: Request, res: Response): void => {
  const sessionId = req.params.sessionId as string;
  const session = sessionStore.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: `Session "${sessionId}" not found.` });
    return;
  }

  res.status(200).json({
    sessionId: session.sessionId,
    userId: session.userId,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    cumulativeTurns: session.cumulativeTurns,
    currentHistoryTurns: session.messages.length,
    runningSummary: session.runningSummary || 'None',
    messages: session.messages,
  });
});

/**
 * DELETE /api/chat/sessions/:sessionId
 * Session Eviction (GDPR Right to be Forgotten Compliant)
 */
router.delete('/sessions/:sessionId', (req: Request, res: Response): void => {
  const sessionId = req.params.sessionId as string;
  const deleted = sessionStore.deleteSession(sessionId);

  if (!deleted) {
    res.status(404).json({ error: `Session "${sessionId}" not found.` });
    return;
  }

  res.status(200).json({
    success: true,
    message: `Session "${sessionId}" permanently purged from state store.`,
  });
});

export default router;
