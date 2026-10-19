import { env } from '../config/env.js';
import { QdrantAdapter } from '../adapters/qdrant.adapter.js';
import { PgVectorAdapter } from '../adapters/pgvector.adapter.js';

async function main(): Promise<void> {
  console.log('\nService connectivity\n');

  const qdrant = new QdrantAdapter({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
    collection: env.QDRANT_COLLECTION,
    dimensions: env.EMBEDDING_DIMENSIONS,
    metric: env.VECTOR_METRIC,
  });
  try {
    const health = await qdrant.health();
    console.log(`  qdrant    ok  url=${env.QDRANT_URL} collections=${health.collections.join(', ')}`);
    console.log(`            collection=${env.QDRANT_COLLECTION} count=${health.count}`);
  } catch (error) {
    console.log(`  qdrant    unavailable at ${env.QDRANT_URL}`);
    console.log(`            ${error instanceof Error ? error.message : String(error)}`);
    console.log('            start it with: npm run qdrant:up');
  }

  if (!env.DATABASE_URL) {
    console.log('  pgvector  skipped (DATABASE_URL is not set)');
  } else {
    const pgvector = new PgVectorAdapter({
      connectionString: env.DATABASE_URL,
      table: env.PGVECTOR_TABLE,
      dimensions: env.EMBEDDING_DIMENSIONS,
      metric: env.VECTOR_METRIC,
    });
    try {
      const health = await pgvector.health();
      console.log(`  pgvector  ${health.ok ? 'ok' : 'extension missing'}  version=${health.extension}`);
      console.log(`            table=${env.PGVECTOR_TABLE} count=${health.count}`);
    } catch (error) {
      console.log(`  pgvector  unavailable at ${env.DATABASE_URL}`);
      console.log(`            ${error instanceof Error ? error.message : String(error)}`);
      console.log('            start it with: npm run pgvector:up');
    } finally {
      await pgvector.close();
    }
  }

  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
