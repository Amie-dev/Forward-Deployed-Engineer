import { createApp } from './app.js';
import { createContainer } from './container.js';

async function main(): Promise<void> {
  const container = await createContainer();
  const { env, store, embeddings, generator, service } = container;

  console.log(
    `[boot] embedding=${embeddings.name}/${embeddings.model} dims=${embeddings.dimensions} ` +
      `generation=${generator.name}/${generator.model} store=${store.name}`,
  );

  const chunkCount = await store.count();

  if (chunkCount === 0 && env.AUTO_INGEST) {
    const report = await service.ingest();
    console.log(
      `[boot] ingested ${report.chunks} chunks from ${report.documents} documents ` +
        `in ${report.durationMs}ms`,
    );
  } else {
    console.log(`[boot] ${chunkCount} chunks already indexed`);
  }

  const app = createApp({ service, store, embeddings, generator });
  const server = app.listen(env.PORT, () => {
    console.log(`[boot] listening on http://localhost:${env.PORT}`);
    console.log('[boot] POST /api/query | POST /api/ingest | GET /health');
  });

  const shutdown = (signal: string): void => {
    console.log(`[shutdown] ${signal} received`);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
