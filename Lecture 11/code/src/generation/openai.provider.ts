import OpenAI from 'openai';

import { withRetry } from '../lib/retry.js';
import type { GeneratedText, GenerationProvider, GenerationRequest } from './provider.js';

/**
 * OpenAI chat generation via the Responses API.
 *
 * No temperature is sent: reasoning models reject it, and the default is already
 * conservative. Sampling knobs belong in config once the evaluation harness can
 * prove a change helps.
 */
export class OpenAiGenerationProvider implements GenerationProvider {
  readonly name = 'openai';
  readonly model: string;

  private readonly client: OpenAI;

  constructor(config: { apiKey?: string; model: string }) {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is required for the openai generation provider.');
    }

    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async generate(request: GenerationRequest): Promise<GeneratedText> {
    const response = await withRetry(
      () =>
        this.client.responses.create({
          model: this.model,
          instructions: request.instructions,
          input: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          max_output_tokens: 600,
        }),
      {
        attempts: 3,
        onRetry: (error, attempt) =>
          console.warn(
            `[generation] attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      },
    );

    return {
      text: response.output_text.trim(),
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  }
}
