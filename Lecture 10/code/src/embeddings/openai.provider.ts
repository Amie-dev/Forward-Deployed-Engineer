import OpenAI from 'openai';
import { mapWithConcurrency } from '../lib/async.js';
import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingTask } from './provider.js';

/**
 * OpenAI embeddings through the official SDK.
 *
 * Production details that matter: batch the input (the endpoint accepts arrays),
 * cap concurrency, and let the SDK retry 429/5xx with exponential backoff.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  readonly client: OpenAI;

  constructor(config: EmbeddingProviderConfig) {
    if (!config.apiKey) throw new Error('OPENAI_API_KEY is required for the OpenAI provider.');
    this.model = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions ?? (this.model.includes('large') ? 3072 : 1536);
    this.client = new OpenAI({ apiKey: config.apiKey, maxRetries: 3, timeout: 30_000 });
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error('Embedding input must not contain empty strings.');
    }

    const batches = chunk(texts, 64);
    const vectors = await mapWithConcurrency(batches, 4, (batch) => this.embedBatch(batch));
    return vectors.flat();
  }

  private async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: [...texts],
      encoding_format: 'float',
      // Only text-embedding-3-* supports Matryoshka truncation.
      ...(this.model.startsWith('text-embedding-3') ? { dimensions: this.dimensions } : {}),
    });

    return response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
