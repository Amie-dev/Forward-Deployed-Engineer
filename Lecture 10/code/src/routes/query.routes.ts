import { Router } from 'express';
import { z } from 'zod';
import { Bm25Index, reciprocalRankFusion } from '../store/hybrid.js';
import { compileFilter } from '../store/filters.js';
import { asyncHandler } from '../lib/http.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';
import type { Filter } from '../types/vector.types.js';

const indexSchema = z.enum(['flat', 'ivf', 'hnsw', 'pq']);
const tuningSchema = {
  k: z.number().int().min(1).max(100).default(10),
  index: indexSchema.optional(),
  nprobe: z.number().int().min(1).max(4_096).optional(),
  efSearch: z.number().int().min(1).max(1_000).optional(),
  rescore: z.number().int().min(0).max(500).optional(),
};
const querySchema = z.object({
  query: z.string().min(1).max(4_000),
  filter: z.unknown().optional(),
  hybrid: z.boolean().default(false),
  ...tuningSchema,
});
const vectorQuerySchema = z.object({
  vector: z.array(z.number().finite()).min(1),
  filter: z.unknown().optional(),
  ...tuningSchema,
});

export function createQueryRouter(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = querySchema.parse(req.body);
      const started = performance.now();
      const vector = await embeddings.embedQuery(body.query);
      const filter = body.filter as Filter | undefined;
      const dense = store.query({
        vector,
        k: body.hybrid ? Math.min(100, body.k * 3) : body.k,
        filter,
        index: body.index,
        nprobe: body.nprobe,
        efSearch: body.efSearch,
        rescore: body.rescore,
      });

      if (!body.hybrid) {
        res.json({
          strategy: 'dense',
          query: body.query,
          index: dense.index,
          tookMs: Number((performance.now() - started).toFixed(2)),
          exactFallback: dense.exactFallback,
          hits: dense.hits,
        });
        return;
      }

      const predicate = compileFilter<Record<string, unknown>>(filter);
      const lexical = new Bm25Index(
        store
          .all()
          .filter((record) => record.text && predicate(record.payload))
          .map((record) => ({ id: record.id, text: record.text! })),
      ).search(body.query, Math.min(100, body.k * 3));

      const fused = reciprocalRankFusion(
        [dense.hits.map((hit) => ({ id: hit.id, score: hit.score })), lexical],
        { limit: body.k },
      );
      const byId = new Map(store.all().map((record) => [record.id, record]));

      res.json({
        strategy: 'hybrid',
        fusion: 'rrf',
        query: body.query,
        index: dense.index,
        tookMs: Number((performance.now() - started).toFixed(2)),
        exactFallback: dense.exactFallback,
        hits: fused.map((hit) => {
          const record = byId.get(hit.id)!;
          return {
            id: hit.id,
            score: Number(hit.score.toFixed(6)),
            payload: record.payload,
            text: record.text,
          };
        }),
      });
    }),
  );

  router.post(
    '/by-vector',
    asyncHandler(async (req, res) => {
      const body = vectorQuerySchema.parse(req.body);
      const result = store.query({
        vector: body.vector,
        k: body.k,
        filter: body.filter as Filter | undefined,
        index: body.index,
        nprobe: body.nprobe,
        efSearch: body.efSearch,
        rescore: body.rescore,
      });
      res.json({
        strategy: 'vector',
        index: result.index,
        tookMs: result.tookMs,
        exactFallback: result.exactFallback,
        hits: result.hits,
      });
    }),
  );

  return router;
}
