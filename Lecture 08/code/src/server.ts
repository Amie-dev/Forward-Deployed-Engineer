import { createApp } from './app.js';
import { vectorStore } from './services/vector.store.js';
import { env, isLiveOpenAIEnabled } from './config/env.js';

async function bootstrap() {
  // ── Phase 1: Build the catalog ─────────────────────────────────────────────
  // Precompute embeddings for every movie description.
  // This runs ONCE on startup — all subsequent queries are pure vector math.
  await vectorStore.build();

  // ── Phase 2: Start the HTTP server ─────────────────────────────────────────
  const app = createApp();

  app.listen(env.PORT, () => {
    console.log(`
========================================================================
🎬 LECTURE 08: MOVIE RECOMMENDATION ENGINE (Embeddings + Cosine Sim)
========================================================================
📡 Server:          http://localhost:${env.PORT}
🏥 Health:          GET  http://localhost:${env.PORT}/health
🔍 Semantic Search: POST http://localhost:${env.PORT}/api/movies/search
🎞️  All Movies:      GET  http://localhost:${env.PORT}/api/movies
🎯 Similar Movies:  GET  http://localhost:${env.PORT}/api/movies/:id/similar
📊 Catalog Status:  GET  http://localhost:${env.PORT}/api/movies/status
------------------------------------------------------------------------
🤖 Embedding Model: ${env.EMBEDDING_MODEL}
🔑 OpenAI Live:     ${isLiveOpenAIEnabled() ? 'ENABLED ✅' : 'MOCK MODE ⚠️  (set OPENAI_API_KEY for real embeddings)'}
========================================================================
`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap failure:', err);
  process.exit(1);
});
