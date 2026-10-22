import type { Pinecone as PineconeClient } from '@pinecone-database/pinecone';

import type { IndexRecord, Match } from '../types/rag.types.js';
import type { VectorQuery, VectorStore } from './vector-store.js';

const UPSERT_BATCH = 100;

/**
 * The managed path: same interface as `MemoryVectorStore`, different machine.
 *
 * The namespace is the tenant/domain boundary. A query that forgets it searches
 * every namespace, which is how one customer's documents end up in another
 * customer's answer — so the namespace is set once, in the constructor.
 */
export class PineconeVectorStore implements VectorStore {
  readonly name = 'pinecone';

  private constructor(
    private readonly client: PineconeClient,
    private readonly indexName: string,
    private readonly namespace: string,
  ) {}

  static async connect(config: {
    apiKey?: string;
    indexName: string;
    namespace: string;
  }): Promise<PineconeVectorStore> {
    if (!config.apiKey) throw new Error('PINECONE_API_KEY is required for VECTOR_STORE=pinecone.');

    // Imported lazily so the in-memory path never pays for the SDK at boot.
    const { Pinecone } = await import('@pinecone-database/pinecone');
    return new PineconeVectorStore(new Pinecone({ apiKey: config.apiKey }), config.indexName, config.namespace);
  }

  async upsert(records: readonly IndexRecord[]): Promise<number> {
    const index = this.index();

    for (let start = 0; start < records.length; start += UPSERT_BATCH) {
      await index.upsert({
        records: records.slice(start, start + UPSERT_BATCH).map((record) => ({
          id: record.id,
          values: record.vector,
          metadata: {
            text: record.text,
            source: record.source,
            section: record.section,
            chunkIndex: record.chunkIndex,
            tokens: record.tokens,
          },
        })),
      });
    }

    return records.length;
  }

  async query({ vector, topK, filter }: VectorQuery): Promise<Match[]> {
    const response = await this.index().query({
      vector: [...vector],
      topK,
      includeMetadata: true,
      ...(filter?.source ? { filter: { source: { $eq: filter.source } } } : {}),
    });

    return response.matches.flatMap((match) => {
      const metadata = match.metadata;
      if (!metadata || typeof metadata.text !== 'string') return [];

      return [
        {
          id: match.id,
          // Pinecone returns cosine similarity directly for a cosine index.
          score: match.score ?? 0,
          text: metadata.text,
          source: String(metadata.source ?? 'unknown'),
          section: String(metadata.section ?? ''),
          chunkIndex: Number(metadata.chunkIndex ?? 0),
          tokens: Number(metadata.tokens ?? 0),
        },
      ];
    });
  }

  async deleteBySource(source: string): Promise<number> {
    await this.index().deleteMany({ filter: { source: { $eq: source } } });
    return 1;
  }

  async count(): Promise<number> {
    const stats = await this.client.index(this.indexName).describeIndexStats();
    return stats.namespaces?.[this.namespace]?.recordCount ?? 0;
  }

  private index() {
    return this.client.index(this.indexName).namespace(this.namespace);
  }
}
