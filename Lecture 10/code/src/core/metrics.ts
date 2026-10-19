import type { Metric, PreparedVector, Vector } from '../types/vector.types.js';

/**
 * Similarity and distance primitives.
 *
 * Contract used everywhere above this module:
 *   `score` is always HIGHER-IS-BETTER.
 *   cosine / dot  -> native similarity
 *   euclid / manhattan -> negated distance
 *
 * That single convention prevents the classic bug where one endpoint sorts
 * ascending and another sorts descending. The native distance is still exposed
 * on search hits when you need to report it.
 */

export function toVector(input: Vector | number[]): Vector {
  if (input instanceof Float32Array) return input;
  if (Array.isArray(input)) return Float32Array.from(input);
  throw new TypeError('Vector must be a Float32Array or an array of numbers.');
}

export function assertSameDimensions(a: Vector, b: Vector): void {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}.`);
  }
}

export function assertValidVector(vector: Vector): void {
  if (vector.length === 0) throw new Error('Vector must not be empty.');
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(`Vector contains a non-finite value at index ${i}.`);
    }
  }
}

export function dot(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  // A plain indexed loop is faster than reduce/map for typed arrays.
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a: Vector): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

export function normalize(a: Vector): Vector {
  const length = norm(a);
  const out = new Float32Array(a.length);
  if (length === 0) return out; // Zero vector stays zero; never emit NaN.
  const inverse = 1 / length;
  for (let i = 0; i < a.length; i++) out[i] = a[i] * inverse;
  return out;
}

export function cosineSimilarity(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  const denominator = norm(a) * norm(b);
  if (denominator === 0) return 0;
  return dot(a, b) / denominator;
}

export function euclideanDistance(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function manhattanDistance(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

/** Squared L2 — the right form for k-means and ADC: no sqrt in hot loops. */
export function squaredEuclidean(a: Vector, b: Vector): number {
  assertSameDimensions(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export function prepare(vector: Vector): PreparedVector {
  assertValidVector(vector);
  return { data: vector, norm: norm(vector) };
}

/** Hot path: norms arrive precomputed with the record, so cosine costs one dot. */
export function scoreWithNorms(
  metric: Metric,
  query: Vector,
  queryNorm: number,
  vector: Vector,
  vectorNorm: number,
): number {
  switch (metric) {
    case 'cosine': {
      const denominator = queryNorm * vectorNorm;
      return denominator === 0 ? 0 : dot(query, vector) / denominator;
    }
    case 'dot':
      return dot(query, vector);
    case 'euclid':
      return -euclideanDistance(query, vector);
    case 'manhattan':
      return -manhattanDistance(query, vector);
  }
}

export function scorePrepared(metric: Metric, query: PreparedVector, vector: PreparedVector): number {
  return scoreWithNorms(metric, query.data, query.norm, vector.data, vector.norm);
}

/** Convenience wrapper for tests and demos; not used in hot loops. */
export function score(metric: Metric, a: Vector, b: Vector): number {
  return scoreWithNorms(metric, a, norm(a), b, norm(b));
}

/** Convert the internal higher-is-better score back to a native distance. */
export function distanceFromScore(metric: Metric, scoreValue: number): number {
  switch (metric) {
    case 'cosine':
      return 1 - scoreValue;
    case 'dot':
    case 'euclid':
    case 'manhattan':
      return -scoreValue;
  }
}

export const METRIC_LABELS: Record<Metric, string> = {
  cosine: 'cosine similarity',
  dot: 'dot product',
  euclid: 'Euclidean distance',
  manhattan: 'Manhattan distance',
};
