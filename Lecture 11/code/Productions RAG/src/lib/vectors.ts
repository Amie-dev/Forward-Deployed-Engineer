/**
 * Vector helpers.
 *
 * Vectors are stored unit-length, so cosine similarity is a plain dot product
 * and one less pass over the array per candidate. That is the same trick the
 * managed vector databases use when you choose the cosine metric.
 */

/** Scale a vector to unit length. A zero vector is returned unchanged. */
export function normalise(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;

  const length = Math.sqrt(sumSquares);
  if (length === 0) return [...vector];

  const unit = new Array<number>(vector.length);
  for (let i = 0; i < vector.length; i++) unit[i] = vector[i] / length;
  return unit;
}

/** Cosine similarity with a defensive fallback for non-normalised input. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}.`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
