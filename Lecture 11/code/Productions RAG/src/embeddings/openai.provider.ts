import OpenAI from 'openai';

import { withRetry } from '../lib/retry.js';
import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/** The embeddings endpoint accepts up to 2048 inputs per call; 100 keeps failures small. */
const BATCH_SIZE = 100;

/**
 * OpenAI embeddings.
 *
 * `dimensions` is sent on every call, at ingestion and at query time. If those
 * two numbers ever disagree, the query vector cannot be compared with the index
 * and the failure is a dimension-mismatch error at best, silently wrong results
 * at worst.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;

  private readonly client: OpenAI;

  constructor(config: { apiKey?: string; model: string; dimensions: number }) {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is required for the openai embedding provider.');
    }

    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);

      const response = await withRetry(
        () =>
          this.client.embeddings.create({
            model: this.model,
            input: [...batch],
            dimensions: this.dimensions,
            encoding_format: 'float',
          }),
        {
          attempts: 3,
          onRetry: (error, attempt) =>
            console.warn(`[embedding] attempt ${attempt} failed: ${describe(error)}`),
        },
      );

      for (const item of response.data) vectors.push(item.embedding);
    }

    return vectors;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
