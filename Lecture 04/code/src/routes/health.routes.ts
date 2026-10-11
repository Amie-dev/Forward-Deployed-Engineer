import { Router, Request, Response } from 'express';
import { SessionStore } from '../services/session.store.js';
import { config } from '../config/env.js';
import { isLiveApiKeyConfigured } from '../lib/openai.js';

const router = Router();
const sessionStore = SessionStore.getInstance();

/**
 * GET /health
 * Enterprise Health Check Endpoint
 */
router.get('/', (_req: Request, res: Response): void => {
  const memoryUsage = process.memoryUsage();

  res.status(200).json({
    status: 'UP',
    service: 'lecture-04-production-chatbot',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    ai: {
      model: config.AI_MODEL,
      liveKeyConfigured: isLiveApiKeyConfigured(),
      temperature: config.AI_TEMPERATURE,
      maxContextTokens: config.MAX_CONTEXT_TOKENS,
    },
    sessions: {
      activeSessionCount: sessionStore.getSessionCount(),
    },
    memory: {
      rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
      heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
    },
  });
});

export default router;
