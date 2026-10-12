import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as path from 'path';
import { env } from './config/env.js';
import { chatRouter } from './routes/chat.routes.js';
import { websiteRouter } from './routes/website.routes.js';
import { hitlRouter } from './routes/hitl.routes.js';
import { defaultWorkspaceTools } from './tools/registry.js';

export function createApp(): Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  // Serve generated websites statically for live browser viewing
  const workspacePath = defaultWorkspaceTools.getWorkspaceRoot();
  app.use('/sites', express.static(workspacePath));

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'Lecture 05 Autonomous AI Agent Service',
      model: env.AI_MODEL,
      workspace: env.WORKSPACE_DIR
    });
  });

  // Mount API Routers
  app.use('/api/chat', chatRouter);
  app.use('/api/generate-site', websiteRouter);
  app.use('/api/approvals', hitlRouter);
  app.use('/api/agent', hitlRouter);

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: `The requested route '${req.method} ${req.originalUrl}' does not exist.`
    });
  });

  // Global Error Handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled Server Exception:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: err.message || 'An unexpected error occurred.'
    });
  });

  return app;
}
