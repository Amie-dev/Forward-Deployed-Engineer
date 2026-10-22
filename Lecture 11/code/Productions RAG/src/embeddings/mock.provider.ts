import { contentWords } from '../lib/text.js';
import { normalise } from '../lib/vectors.js';
import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/**
 * Deterministic, offline, zero-cost embeddings.
 *
 * This is NOT a semantic model. It hashes words, character trigrams and word
 * bigrams into a fixed space, so texts that share vocabulary land close
 * together. That is enough to exercise ingestion, retrieval, citations and
 * evaluation with no API key, and it makes demos reproducible.
 *
 * Never ship this. It has no idea that "return" and "refund" are related.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model: string;
  readonly dimensions: number;

  constructor(config: { model?: string; dimensions: number }) {
    if (config.dimensions < 8) throw new Error('Mock embeddings need at least 8 dimensions.');
    this.model = config.model ?? 'mock-hash-v1';
    this.dimensions = config.dimensions;
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = contentWords(text);

    for (let position = 0; position < tokens.length; position++) {
      const token = tokens[position];
      this.addFeature(vector, token, 1);

      // A short prefix groups simple morphology: refund/refunds, ship/shipping.
      // Full trigrams were tried first and made unrelated text look similar.
      this.addFeature(vector, `~${token.slice(0, 5)}`, 0.5);

      const next = tokens[position + 1];
      if (next) this.addFeature(vector, `${token}_${next}`, 0.6);
    }

    return normalise(vector);
  }

  private addFeature(vector: number[], feature: string, weight: number): void {
    const hash = fnv1a(feature);
    const index = hash % this.dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] += sign * weight;
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
