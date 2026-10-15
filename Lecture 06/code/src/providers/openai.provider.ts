import OpenAI from 'openai';
import { env } from '../config/env.js';
import { classifyProviderError } from './provider.errors.js';
import type {
  FinishReason,
  ProviderDelta,
  ProviderStream,
  ProviderStreamRequest,
  StreamProvider,
  TokenUsage,
} from '../types/stream.types.js';

/**
 * Live provider implementation (OpenAI Chat Completions with `stream: true`).
 *
 * This is the concrete equivalent of `.call() ➔ .stream()` in Chapter 07.2: the
 * return type is an AsyncIterable — "zero, one or many values over time" — not a
 * `Promise<string>`. Because the type is a stream, nothing above this layer is
 * able to accidentally buffer the answer.
 *
 * Two production decisions worth calling out:
 *
 *  1. `maxRetries: 0` on the SDK. The SDK's own retry would restart a stream
 *     that has already emitted text, duplicating fragments in the user's bubble
 *     (Anti-pattern #10). Retries are therefore owned by the streaming service,
 *     which knows whether the first byte has been written yet.
 *  2. `stream_options.include_usage: true`, because usage is otherwise missing
 *     in streaming mode — the "billing blind spot" of §7.9.
 */
export class OpenAIProvider implements StreamProvider {
  public readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(apiKey: string = env.OPENAI_API_KEY) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: env.STREAM_TOTAL_TIMEOUT_MS,
    });
  }

  public async stream(request: ProviderStreamRequest): Promise<ProviderStream> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages as OpenAI.Chat.ChatCompletionMessageParam[],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: request.abortSignal }
      );

      return this.iterate(stream, request.abortSignal);
    } catch (error) {
      // Failure BEFORE the first byte ⇒ the service may still answer with a real
      // HTTP status, or retry with jitter if `retryable` is true.
      throw classifyProviderError(error);
    }
  }

  /**
   * Translate OpenAI SSE chunks into the provider contract.
   *
   * `await this.client...create()` resolves as soon as the response headers
   * arrive, so iterating here is what actually consumes the token deltas.
   */
  private async *iterate(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    abortSignal: AbortSignal
  ): AsyncGenerator<ProviderDelta> {
    let index = 0;
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;

    try {
      for await (const chunk of stream) {
        // The usage carrier chunk has an EMPTY `choices` array — reading
        // `chunk.choices[0]` unconditionally is a common runtime crash.
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        const text = choice?.delta?.content ?? '';
        if (text.length === 0) continue;

        yield { text, index };
        index += 1;
      }
    } catch (error) {
      if (abortSignal.aborted) return; // expected on client cancellation
      throw classifyProviderError(error);
    }

    // Terminal, text-less carrier: the pump records usage/finish reason without
    // writing anything to the socket.
    yield { text: '', index, usage, finishReason };
  }
}

/** Map provider finish reasons onto the service's terminal-state taxonomy. */
export function mapProviderFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}
