import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { HttpError } from './lib/errors.js';
import { createDocumentsRouter } from './routes/documents.routes.js';
import { createQueryRouter } from './routes/query.routes.js';
import { createAdminRouter } from './routes/admin.routes.js';
import type { EmbeddingService } from './embeddings/embedding.service.js';
import type { VectorStore } from './store/vector-store.js';

export interface AppDependencies {
  store: VectorStore<Record<string, unknown>>;
  embeddings: EmbeddingService;
}

export function createApp({ store, embeddings }: AppDependencies): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    res.on('finish', () => {
      const ms = (performance.now() - started).toFixed(1);
      console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  app.get('/health', (_req, res) => {
    const stats = store.stats();
    res.json({
      status: 'healthy',
      service: 'Lecture 10 — Vector Database API',
      embedding: {
        provider: embeddings.provider.name,
        model: embeddings.model,
        dimensions: embeddings.dimensions,
      },
      metric: store.metric,
      documents: stats.count,
      index: stats.index?.kind ?? 'flat',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/documents', createDocumentsRouter(store, embeddings));
  app.use('/api/query', createQueryRouter(store, embeddings));
  app.use('/api/admin', createAdminRouter(store, embeddings));

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'NotFound',
      message: `${req.method} ${req.originalUrl} does not exist.`,
    });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);

    if (error instanceof ZodError) {
      return res.status(400).json({
        error: 'ValidationError',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.code, message: error.message });
    }

    console.error('[error]', error);
    return res.status(500).json({
      error: 'InternalServerError',
      message: error instanceof Error ? error.message : 'An unexpected error occurred.',
    });
  });

  return app;
}
