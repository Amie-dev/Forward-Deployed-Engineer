import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { movieRouter } from './routes/movie.routes.js';
import { env } from './config/env.js';

export function createApp(): Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  // ── Health Check ──────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'Lecture 08 — Movie Recommendation Engine',
      embeddingModel: env.EMBEDDING_MODEL,
      timestamp: new Date().toISOString(),
    });
  });

  // ── API Routes ────────────────────────────────────────────────────────────
  app.use('/api/movies', movieRouter);

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'NotFound',
      message: `${req.method} ${req.originalUrl} does not exist.`,
    });
  });

  // ── Global Error Handler ──────────────────────────────────────────────────
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[UnhandledError]', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: err.message ?? 'An unexpected error occurred.',
    });
  });

  return app;
}
