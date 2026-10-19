import assert from 'node:assert/strict';
import { env } from '../config/env.js';
import { createEmbeddingProvider } from '../embeddings/provider.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import { QdrantAdapter } from '../adapters/qdrant.adapter.js';
import { PgVectorAdapter } from '../adapters/pgvector.adapter.js';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target !== 'qdrant' && target !== 'pgvector') {
    throw new Error('Usage: tsx src/scripts/adapter-crud.ts <qdrant|pgvector>');
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
  const [vector] = await embeddings.embedDocuments(['adapter CRUD smoke test']);
  const payload = { tenant: 'acme', category: 'operations', year: 2026 };
  const id = 'smoke-001';

  if (target === 'qdrant') {
    const adapter = new QdrantAdapter({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      collection: env.QDRANT_COLLECTION,
      dimensions: provider.dimensions,
      metric: env.VECTOR_METRIC,
    });
    const created = await adapter.ensureCollection();
    if (created) await adapter.createPayloadIndexes();

    await adapter.upsert([{ id, vector, payload, text: 'adapter CRUD smoke test' }]);
    assert.equal((await adapter.get(id))?.payload.tenant, 'acme');

    await adapter.upsert([{ id, vector, payload: { ...payload, year: 2027 }, text: 'updated' }]);
    assert.equal((await adapter.get(id))?.payload.year, 2027);

    const filtered = await adapter.query(vector, {
      k: 5,
      filter: { must: [{ key: 'tenant', match: { value: 'acme' } }] },
    });
    assert.ok(filtered.some((hit) => hit.id === id));

    await adapter.delete([id]);
    assert.equal(await adapter.get(id), null);
    console.log(`[qdrant] upsert -> update -> filter -> delete ok (count=${await adapter.count()})`);
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

  await adapter.upsert([{ id, vector, payload, text: 'adapter CRUD smoke test' }]);
  assert.equal((await adapter.get(id))?.payload.tenant, 'acme');

  await adapter.upsert([{ id, vector, payload: { ...payload, year: 2027 }, text: 'updated' }]);
  assert.equal((await adapter.get(id))?.payload.year, 2027);

  const filtered = await adapter.query(vector, { k: 5, filter: { tenant: 'acme' } });
  assert.ok(filtered.some((hit) => hit.id === id));

  assert.equal(await adapter.delete([id]), 1);
  assert.equal(await adapter.get(id), null);
  console.log(`[pgvector] upsert -> update -> filter -> delete ok (count=${await adapter.count()})`);
  await adapter.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
