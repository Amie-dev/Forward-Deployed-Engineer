import { MockEmbeddingProvider } from './mock.provider.js';
import { OpenAiEmbeddingProvider } from './openai.provider.js';
import { GeminiEmbeddingProvider } from './gemini.provider.js';

export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /**
   * Embed a batch. Providers return one vector per input, in input order.
   * `task` lets providers that support it use asymmetric retrieval prompts;
   * OpenAI ignores it, Gemini maps it to RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY.
   */
  embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]>;
}

export interface EmbeddingProviderConfig {
  provider: 'mock' | 'openai' | 'gemini';
  model?: string;
  dimensions?: number;
  apiKey?: string;
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider(config.dimensions);
    case 'openai':
      return new OpenAiEmbeddingProvider(config);
    case 'gemini':
      return new GeminiEmbeddingProvider(config);
  }
}
