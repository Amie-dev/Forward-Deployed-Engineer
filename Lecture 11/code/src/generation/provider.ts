import type { ChatMessage } from '../types/rag.types.js';
import { ExtractiveProvider } from './extractive.provider.js';
import { OpenAiGenerationProvider } from './openai.provider.js';

export interface GenerationRequest {
  /** System-level rules. Never contains retrieved text. */
  instructions: string;
  /** Conversation turns, ending with the evidence + question. */
  messages: readonly ChatMessage[];
}

export interface GeneratedText {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerationProvider {
  readonly name: string;
  readonly model: string;
  generate(request: GenerationRequest): Promise<GeneratedText>;
}

export interface GenerationProviderConfig {
  provider: 'openai' | 'extractive';
  model: string;
  apiKey?: string;
}

export function createGenerationProvider(config: GenerationProviderConfig): GenerationProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAiGenerationProvider(config);
    case 'extractive':
      return new ExtractiveProvider();
  }
}
