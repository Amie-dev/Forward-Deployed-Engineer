import { env } from './config/env.js';
import { createApp } from './app.js';
import { createEmbeddingProvider } from './embeddings/provider.js';
import { EmbeddingService } from './embeddings/embedding.service.js';
import { seedStore } from './services/seed.service.js';
import { VectorStore } from './store/vector-store.js';

async function main(): Promise<void> {
  const provider = createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    apiKey:
      env.EMBEDDING_PROVIDER === 'openai'
        ? env.OPENAI_API_KEY
        : env.EMBEDDING_PROVIDER === 'gemini'
          ? env.GEMINI_API_KEY
          : undefined,
  });

  const embeddings = new EmbeddingService(provider);
  const store = new VectorStore<Record<string, unknown>>({
    dimensions: provider.dimensions,
    metric: env.VECTOR_METRIC,
    defaultIndex: { kind: env.DEFAULT_INDEX },
  });

  console.log(
    `[boot] embeddings=${provider.name}/${provider.model} dims=${provider.dimensions} ` +
      `metric=${env.VECTOR_METRIC} index=${env.DEFAULT_INDEX}`,
  );

  if (env.AUTO_SEED) {
    const started = performance.now();
    const result = await seedStore(store, embeddings);
    console.log(
      `[boot] seeded ${result.documents} documents in ${(performance.now() - started).toFixed(0)}ms`,
    );
  }

  if (env.DEFAULT_INDEX !== 'flat') {
    const started = performance.now();
    const built = store.buildIndex({ kind: env.DEFAULT_INDEX });
    console.log(
      `[boot] built ${built.stats.kind} index in ${(performance.now() - started).toFixed(0)}ms ` +
        `(${built.stats.memoryBytes} bytes of index structure)`,
    );
  }

  const app = createApp({ store, embeddings });
  const server = app.listen(env.PORT, () => {
    console.log(`[boot] listening on http://localhost:${env.PORT}`);
    console.log('[boot] PUT /api/documents/:id | POST /api/query | GET /api/admin/stats');
  });

  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
