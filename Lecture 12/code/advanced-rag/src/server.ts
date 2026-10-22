import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { z } from 'zod';

import { serverConfig } from './config/env.js';
import { RagPipeline } from './pipeline.js';
import { parseFilter } from './store/filters.js';
import type { AccessContext } from './types.js';

/**
 * A thin HTTP surface over the same pipeline the CLI uses.
 *
 * Four design rules, all of them production rules rather than demo rules:
 *
 *  1. **Access comes from the request, not the server.** `tenantId` and `acl` are
 *     required on every call: a server that defaults them is a server that answers
 *     with the wrong tenant's data the first time a client forgets a header.
 *  2. **Filters are parsed, never `eval`ed.** An unknown field throws.
 *  3. **The trace is returned with the answer.** Debuggability is a feature, not a
 *     log file.
 *  4. **The index is built once at boot.** Ingestion is not on the request path.
 */

const accessSchema = z.object({
  tenantId: z.string().min(1),
  acl: z.array(z.string().min(1)).min(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const askSchema = z.object({
  question: z.string().min(3).max(1000),
  access: accessSchema,
  filter: z.string().min(1).max(200).optional(),
});

const searchSchema = askSchema.extend({
  topK: z.number().int().min(1).max(50).optional(),
});

async function main(): Promise<void> {
  const pipeline = await RagPipeline.create();
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      ok: true,
      index: {
        strategy: pipeline.stats.strategy,
        documents: pipeline.stats.documents,
        chunks: pipeline.stats.chunks,
        dimensions: pipeline.stats.dimensions,
        model: pipeline.config.embedding.model,
      },
      controls: {
        hybrid: pipeline.config.hybrid,
        rerank: pipeline.config.rerank,
        minScore: pipeline.config.minScore,
        kRetrieve: pipeline.config.kRetrieve,
        kContext: pipeline.config.kContext,
        expandParents: pipeline.config.expandParents,
      },
    });
  });

  app.post('/search', async (request: Request, response: Response) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    const { question, access, filter, topK } = parsed.data;
    const run = await pipeline.retrieve(question, {
      access: access as AccessContext,
      filter: filter ? parseFilter(filter) : undefined,
    });

    response.json({
      question,
      hits: run.hits.slice(0, topK ?? run.hits.length).map((hit, index) => ({
        rank: index + 1,
        id: hit.chunk.id,
        source: hit.chunk.source,
        heading: hit.chunk.heading,
        breadcrumb: hit.chunk.breadcrumb,
        score: Number(hit.score.toFixed(4)),
        tokens: hit.chunk.tokens,
      })),
      stages: run.stages,
      candidates: run.candidates,
    });
  });

  app.post('/ask', async (request: Request, response: Response) => {
    const parsed = askSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    const { question, access, filter } = parsed.data;
    const result = await pipeline.ask(question, {
      access: access as AccessContext,
      filter: filter ? parseFilter(filter) : undefined,
    });

    response.json(result);
  });

  // A thrown filter-parse error is a client error, not a server error.
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    console.error(`[api] ${error.message}`);
    response.status(400).json({ error: 'bad_request', message: error.message });
  });

  app.listen(serverConfig.port, () => {
    console.log(`Advanced RAG API on http://localhost:${serverConfig.port}`);
    console.log(`  index: ${pipeline.stats.chunks} chunks from ${pipeline.stats.documents} documents`);
    console.log(`  try:   curl -s localhost:${serverConfig.port}/health`);
  });
}

main().catch((error: unknown) => {
  console.error(`[api] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
