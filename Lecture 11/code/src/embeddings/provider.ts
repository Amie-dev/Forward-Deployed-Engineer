import { MockEmbeddingProvider } from './mock.provider.js';
import { OpenAiEmbeddingProvider } from './openai.provider.js';

/**
 * `document` vs `query` is not cosmetic: some models are trained with different
 * prefixes for each side, and mixing them silently costs recall.
 */
export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** One vector per input, in input order. */
  embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]>;
}

export interface EmbeddingProviderConfig {
  provider: 'openai' | 'mock';
  model: string;
  dimensions: number;
  apiKey?: string;
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider(config);
    case 'openai':
      return new OpenAiEmbeddingProvider(config);
  }
}
