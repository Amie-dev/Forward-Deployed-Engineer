import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/**
 * Embedding service: batching, deduplication and an LRU cache.
 *
 * Query embeddings are pure functions of (model, task, text), so caching them
 * is safe and removes a provider round-trip on repeated queries. The cache is
 * intentionally small and process-local: a multi-instance deployment needs a
 * shared cache (Redis) and a versioned key that includes the model id.
 */
export class EmbeddingService {
  private readonly cache = new Map<string, number[]>();

  constructor(
    readonly provider: EmbeddingProvider,
    private readonly cacheSize = 1_000,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  get dimensions(): number {
    return this.provider.dimensions;
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return this.embed(texts, 'document');
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text], 'query');
    return vector;
  }

  private async embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];

    const missing = new Map<string, string>();
    const results = new Array<number[] | undefined>(texts.length);

    texts.forEach((text, index) => {
      const key = `${this.provider.model}:${task}:${text}`;
      const cached = this.cache.get(key);
      if (cached) {
        // Refresh LRU position.
        this.cache.delete(key);
        this.cache.set(key, cached);
        results[index] = cached;
      } else {
        missing.set(key, text);
      }
    });

    if (missing.size > 0) {
      const keys = [...missing.keys()];
      const values = await this.provider.embed([...missing.values()], task);
      if (values.length !== keys.length) {
        throw new Error(`Provider returned ${values.length} vectors for ${keys.length} inputs.`);
      }
      keys.forEach((key, i) => {
        this.cache.set(key, values[i]);
        this.evict();
      });
      texts.forEach((text, index) => {
        if (results[index]) return;
        results[index] = this.cache.get(`${this.provider.model}:${task}:${text}`);
      });
    }

    return results.map((vector, index) => {
      if (!vector) throw new Error(`Missing embedding for input ${index}.`);
      return vector;
    });
  }

  private evict(): void {
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      this.cache.delete(oldest);
    }
  }
}
