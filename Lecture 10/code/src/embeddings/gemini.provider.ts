import { mapWithConcurrency, sleep } from '../lib/async.js';
import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingTask } from './provider.js';

interface GeminiBatchResponse {
  embeddings: { values: number[] }[];
}

/**
 * Gemini embeddings through the REST API (no extra SDK).
 *
 * Gemini distinguishes document and query tasks, which materially improves
 * retrieval quality. `outputDimensionality` exposes Matryoshka truncation:
 * 3072 -> 768 is a 4x storage cut, validated on your own recall set.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(config: EmbeddingProviderConfig) {
    if (!config.apiKey) throw new Error('GEMINI_API_KEY is required for the Gemini provider.');
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-embedding-001';
    this.dimensions = config.dimensions ?? 3072;
    if (this.dimensions < 128 || this.dimensions > 3072) {
      throw new Error('Gemini embedding dimensions must be between 128 and 3072.');
    }
  }

  async embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error('Embedding input must not contain empty strings.');
    }

    const batches = chunk(texts, 100);
    const vectors = await mapWithConcurrency(batches, 2, (batch) => this.embedBatch(batch, task));
    return vectors.flat();
  }

  private async embedBatch(texts: readonly string[], task: EmbeddingTask): Promise<number[][]> {
    const body = {
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        outputDimensionality: this.dimensions,
      })),
    };

    const response = await this.request(body);
    if (response.embeddings.length !== texts.length) {
      throw new Error(
        `Gemini returned ${response.embeddings.length} embeddings for ${texts.length} inputs.`,
      );
    }
    return response.embeddings.map((item) => item.values);
  }

  private async request(body: unknown): Promise<GeminiBatchResponse> {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(this.model)}:batchEmbedContents`;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });

        if (response.ok) return (await response.json()) as GeminiBatchResponse;

        const detail = (await response.text()).slice(0, 500);
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Gemini ${response.status}: ${detail}`);
        } else {
          throw new NonRetryableError(`Gemini embeddings failed (${response.status}): ${detail}`);
        }
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        lastError = error;
      }

      await sleep(300 * 2 ** attempt + Math.random() * 200);
    }

    throw lastError instanceof Error ? lastError : new Error('Gemini embeddings failed.');
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Marker so the retry loop never retries a deterministic 4xx. */
class NonRetryableError extends Error {}
