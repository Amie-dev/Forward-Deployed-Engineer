import { MemoryVectorStore } from './vector-store.js';
import type { VectorStore } from './vector-store.js';

export interface VectorStoreConfig {
  kind: 'memory' | 'pinecone';
  indexPath: string;
  model: string;
  dimensions: number;
  pinecone?: { apiKey?: string; indexName: string; namespace: string };
}

/**
 * Pick the store at boot, never at request time.
 *
 * A store that is unavailable should stop the process, not fail the third
 * customer question of the day.
 */
export async function createVectorStore(config: VectorStoreConfig): Promise<VectorStore> {
  if (config.kind === 'pinecone') {
    const { PineconeVectorStore } = await import('./pinecone.store.js');
    return PineconeVectorStore.connect(
      config.pinecone ?? { indexName: 'shop-support', namespace: 'policies' },
    );
  }

  const store = new MemoryVectorStore({
    indexPath: config.indexPath,
    model: config.model,
    dimensions: config.dimensions,
  });

  const loaded = await store.load();
  if (loaded > 0) console.log(`[store] loaded ${loaded} records from ${config.indexPath}`);

  return store;
}
