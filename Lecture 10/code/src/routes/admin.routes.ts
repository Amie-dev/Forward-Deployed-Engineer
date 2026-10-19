import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequestError, HttpError } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { seedStore } from '../services/seed.service.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';
import type { IndexConfig } from '../types/vector.types.js';

const indexSchema = z.object({
  kind: z.enum(['flat', 'ivf', 'hnsw', 'pq']),
  ivf: z
    .object({
      nlist: z.number().int().min(1).max(65_536).optional(),
      nprobe: z.number().int().min(1).max(4_096).optional(),
      iterations: z.number().int().min(1).max(200).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  hnsw: z
    .object({
      m: z.number().int().min(2).max(128).optional(),
      efConstruction: z.number().int().min(2).max(2_000).optional(),
      efSearch: z.number().int().min(1).max(1_000).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  pq: z
    .object({
      m: z.number().int().min(1).max(256).optional(),
      ksub: z.number().int().min(1).max(256).optional(),
      iterations: z.number().int().min(1).max(200).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
});

export function createAdminRouter(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
): Router {
  const router = Router();

  router.get('/stats', (_req, res) => {
    const stats = store.stats();
    res.json({
      ...stats,
      embedding: {
        provider: embeddings.provider.name,
        model: embeddings.model,
        dimensions: embeddings.dimensions,
      },
      uptimeSeconds: Number(process.uptime().toFixed(1)),
    });
  });

  router.post(
    '/index',
    asyncHandler(async (req, res) => {
      const body = indexSchema.parse(req.body);
      try {
        const config: IndexConfig = {
          kind: body.kind,
          ivf: body.ivf,
          hnsw: body.hnsw,
          pq: body.pq,
        };
        const result = store.buildIndex(config);
        res.json({ kind: body.kind, buildMs: result.buildMs, stats: result.stats });
      } catch (error) {
        throw new BadRequestError(
          error instanceof Error ? error.message : 'Index build failed.',
          'INDEX_BUILD_FAILED',
        );
      }
    }),
  );

  router.post(
    '/seed',
    asyncHandler(async (req, res) => {
      const body = z.object({ reset: z.boolean().default(false) }).parse(req.body ?? {});
      if (body.reset) store.clear();
      const result = await seedStore(store, embeddings);
      res.json(result);
    }),
  );

  router.post('/reset', (_req, res) => {
    if (env.NODE_ENV === 'production') {
      throw new HttpError('Reset is disabled in production.', 403, 'FORBIDDEN');
    }
    store.clear();
    res.status(204).send();
  });

  return router;
}
