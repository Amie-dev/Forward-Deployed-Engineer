import { env } from '../config/env.js';
import { CORPUS } from '../data/corpus.js';
import { createEmbeddingProvider } from '../embeddings/provider.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import { QdrantAdapter } from '../adapters/qdrant.adapter.js';
import { PgVectorAdapter } from '../adapters/pgvector.adapter.js';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target !== 'qdrant' && target !== 'pgvector') {
    throw new Error('Usage: tsx src/scripts/seed.ts <qdrant|pgvector>');
  }

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
  const vectors = await embeddings.embedDocuments(CORPUS.map((document) => document.text));
  const queryVector = await embeddings.embedQuery('graph based nearest neighbour index');

  const records = CORPUS.map((document, index) => ({
    id: document.id,
    vector: vectors[index],
    payload: document.payload as Record<string, unknown>,
    text: document.text,
    model: provider.model,
  }));

  if (target === 'qdrant') {
    const adapter = new QdrantAdapter({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      collection: env.QDRANT_COLLECTION,
      dimensions: provider.dimensions,
      metric: env.VECTOR_METRIC,
    });
    const created = await adapter.ensureCollection({ quantization: 'int8' });
    if (created) await adapter.createPayloadIndexes();
    const upserted = await adapter.upsert(records);
    const hits = await adapter.query(queryVector, {
      k: 3,
      filter: { must: [{ key: 'tenant', match: { value: 'acme' } }] },
    });

    console.log(`[qdrant] ${created ? 'created' : 'reused'} ${env.QDRANT_COLLECTION}`);
    console.log(`[qdrant] upserted ${upserted}, count=${await adapter.count()}`);
    for (const hit of hits) console.log(`  ${hit.id} score=${hit.score.toFixed(4)}`);
    return;
  }

  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for the pgvector target.');
  const adapter = new PgVectorAdapter({
    connectionString: env.DATABASE_URL,
    table: env.PGVECTOR_TABLE,
    dimensions: provider.dimensions,
    metric: env.VECTOR_METRIC,
  });
  await adapter.initialize({ index: 'hnsw' });
  const upserted = await adapter.upsert(records);
  const hits = await adapter.query(queryVector, { k: 3, filter: { tenant: 'acme' } });

  console.log(`[pgvector] upserted ${upserted}, count=${await adapter.count()}`);
  for (const hit of hits) console.log(`  ${hit.id} score=${hit.score.toFixed(4)}`);
  await adapter.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
