import { contentWords } from './lib/text.js';
import { normalise } from './lib/vectors.js';

/**
 * Embeddings behind one narrow interface.
 *
 * Two implementations, and the difference is the whole lesson of Chapter 03:
 *  - `HashEmbeddingProvider` is deterministic and offline. It hashes words,
 *    five-character prefixes and bigrams into a fixed space, so documents that
 *    share vocabulary land close together. It is NOT semantic — it does not know
 *    that "refund" and "return" are related — which is exactly why the pipeline
 *    has to earn its quality with chunking, filters, hybrid search and reranking.
 *  - `OpenAiEmbeddingProvider` is the real thing, called over plain `fetch` so
 *    the request is visible instead of hidden in an SDK.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash';
  readonly model: string;
  readonly dimensions: number;

  constructor(config: { model?: string; dimensions: number }) {
    if (config.dimensions < 8) throw new Error('Hash embeddings need at least 8 dimensions.');
    this.model = config.model ?? 'hash-1024-v1';
    this.dimensions = config.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = contentWords(text);

    for (let position = 0; position < tokens.length; position++) {
      const token = tokens[position];
      this.addFeature(vector, token, 1);

      // A five-character prefix groups simple morphology: refund/refunds,
      // ship/shipping, deliver/delivered.
      this.addFeature(vector, `~${token.slice(0, 5)}`, 0.8);

      // Character 4-grams catch the rest of it: "delivered" and "delivery" share
      // most of their 4-grams even though no prefix rule connects them. This is
      // the cheapest known substitute for a real semantic model, and it is what
      // makes the offline arm of the ablation usable at all.
      if (token.length >= 7) {
        for (let start = 0; start + 4 <= token.length; start++) {
          this.addFeature(vector, `#${token.slice(start, start + 4)}`, 0.3);
        }
      }

      const next = tokens[position + 1];
      if (next) this.addFeature(vector, `${token}_${next}`, 0.6);
    }

    return normalise(vector);
  }

  /** Signed feature hashing: one index, one sign, no collisions map to a bias. */
  private addFeature(vector: number[], feature: string, weight: number): void {
    const hash = fnv1a(feature);
    const index = hash % this.dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;

  constructor(private readonly options: { apiKey: string; model: string; dimensions: number }) {
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  /**
   * Batched on purpose. Embedding APIs bill and rate-limit per request, so a
   * 5,000-chunk ingestion must not become 5,000 HTTP calls.
   */
  async embed(texts: readonly string[]): Promise<number[][]> {
    const output: number[][] = [];

    for (let start = 0; start < texts.length; start += 64) {
      const batch = texts.slice(start, start + 64);
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI embeddings failed (${response.status}): ${await response.text()}`);
      }

      const payload = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
      for (const item of payload.data.sort((a, b) => a.index - b.index)) {
        output.push(normalise(item.embedding));
      }
    }

    return output;
  }
}

/** FNV-1a: small, fast and stable across processes. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface EmbeddingConfig {
  provider: 'hash' | 'openai';
  model: string;
  dimensions: number;
  openaiApiKey?: string;
}

export function createEmbeddings(config: EmbeddingConfig): EmbeddingProvider {
  if (config.provider === 'openai') {
    if (!config.openaiApiKey) throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY.');
    return new OpenAiEmbeddingProvider({
      apiKey: config.openaiApiKey,
      model: config.model,
      dimensions: config.dimensions,
    });
  }

  return new HashEmbeddingProvider({ model: config.model, dimensions: config.dimensions });
}
