import { Router, Request, Response } from 'express';
import { config } from '../config/env.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'support-summarizer-service',
    configuredModel: config.AI_MODEL,
    temperature: config.AI_TEMPERATURE,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});
