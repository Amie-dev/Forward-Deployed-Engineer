import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';
import type { Filter } from '../types/vector.types.js';

const payloadSchema = z.record(z.unknown());
const documentSchema = z.object({
  id: z.string().min(1).max(256),
  text: z.string().min(1).max(20_000),
  payload: payloadSchema.default({}),
});
const singleSchema = documentSchema.omit({ id: true });
const batchSchema = z.object({ documents: z.array(documentSchema).min(1).max(128) });

/**
 * CRUD endpoints. This is where "embedding + storage" meets HTTP:
 * PUT /:id is an upsert (insert or update), DELETE removes, GET reads.
 */
export function createDocumentsRouter(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
): Router {
  const router = Router();

  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = z.string().min(1).max(256).parse(req.params.id);
      const body = singleSchema.parse(req.body);
      const existed = store.has(id);
      const [vector] = await embeddings.embedDocuments([body.text]);
      store.upsert([{ id, vector, payload: body.payload, text: body.text }]);
      res.status(existed ? 200 : 201).json({ id, created: !existed });
    }),
  );

  router.post(
    '/batch',
    asyncHandler(async (req, res) => {
      const body = batchSchema.parse(req.body);
      const vectors = await embeddings.embedDocuments(body.documents.map((document) => document.text));
      const result = store.upsert(
        body.documents.map((document, index) => ({
          id: document.id,
          vector: vectors[index],
          payload: document.payload,
          text: document.text,
        })),
      );
      res.status(201).json(result);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const includeVector = req.query.includeVector === 'true';
      const id = String(req.params.id);
      res.json(store.get(id, includeVector));
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const deleted = store.delete([id]);
      if (deleted === 0) throw new NotFoundError(`Record "${id}" does not exist.`);
      res.status(204).send();
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          tenant: z.string().optional(),
          category: z.string().optional(),
        })
        .parse(req.query);

      const filter: Filter = {};
      if (query.tenant) filter.tenant = query.tenant;
      if (query.category) filter.category = query.category;

      res.json(
        store.list({
          limit: query.limit,
          offset: query.offset,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
        }),
      );
    }),
  );

  return router;
}
