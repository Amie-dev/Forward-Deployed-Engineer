import { normalize } from '../core/metrics.js';
import type { EmbeddingProvider, EmbeddingTask } from './provider.js';

/**
 * Deterministic, offline, zero-cost embeddings.
 *
 * This is NOT a semantic model. It hashes words and character trigrams into a
 * fixed space, so texts that share vocabulary land close together. That is
 * enough to exercise every storage and retrieval path without an API key, and
 * it makes demos and tests reproducible.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock-hash-v1';
  readonly dimensions: number;

  constructor(dimensions = 128) {
    if (dimensions < 8) throw new Error('Mock embeddings need at least 8 dimensions.');
    this.dimensions = dimensions;
  }

  async embed(texts: readonly string[], _task: EmbeddingTask): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Float32Array(this.dimensions);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

    for (const token of tokens) {
      this.addFeature(vector, token, 1);
      const padded = `^${token}$`;
      for (let i = 0; i < padded.length - 2; i++) {
        this.addFeature(vector, padded.slice(i, i + 3), 0.35);
      }
    }

    return [...normalize(vector)];
  }

  private addFeature(vector: Float32Array, feature: string, weight: number): void {
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
