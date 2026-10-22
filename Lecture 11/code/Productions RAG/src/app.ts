import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';

import type { EmbeddingProvider } from './embeddings/provider.js';
import type { GenerationProvider } from './generation/provider.js';
import { HttpError } from './lib/errors.js';
import type { RagService } from './rag.service.js';
import type { VectorStore } from './store/vector-store.js';

export interface AppDependencies {
  service: RagService;
  store: VectorStore;
  embeddings: EmbeddingProvider;
  generator: GenerationProvider;
}

const querySchema = z.object({
  question: z.string().trim().min(2).max(2000),
  sessionId: z.string().trim().min(1).max(120).optional(),
});

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    res.on('finish', () => {
      const ms = (performance.now() - started).toFixed(1);
      console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  app.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        status: 'healthy',
        service: 'Lecture 11 — RAG API',
        embedding: {
          provider: deps.embeddings.name,
          model: deps.embeddings.model,
          dimensions: deps.embeddings.dimensions,
        },
        generation: { provider: deps.generator.name, model: deps.generator.model },
        store: { kind: deps.store.name, chunks: await deps.store.count() },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  /** The whole product in one endpoint: answer + citations + trace. */
  app.post('/api/query', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = querySchema.parse(req.body);
      res.json(await deps.service.ask(body));
    } catch (error) {
      next(error);
    }
  });

  /** Re-index after the documents change. Slow, idempotent, safe to retry. */
  app.post('/api/ingest', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await deps.service.ingest());
    } catch (error) {
      next(error);
    }
  });

  /** Deleting a conversation is one call: history, memory and caches go together. */
  app.delete('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const deleted = deps.service.resetSession(String(req.params.sessionId));
    res.status(deleted ? 200 : 404).json({ deleted });
  });

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
