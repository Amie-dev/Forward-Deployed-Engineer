/**
 * Vector maths. Four functions, because retrieval only ever needs four.
 *
 * Everything here assumes L2-normalised vectors when cosine is used, which is
 * what every embedding API returns. The `normalise` guard matters: an all-zero
 * vector (an empty chunk) has no direction, and dividing by its norm produces
 * NaN scores that poison sorting in ways that are painful to debug.
 */

export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare vectors of different sizes: ${a.length} vs ${b.length}.`);
  }
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot(a, b) / denominator;
}

/** Unit length, so cosine and dot-product search agree numerically. */
export function normalise(vector: number[]): number[] {
  const length = norm(vector);
  if (length === 0) return vector;
  return vector.map((value) => value / length);
}

/**
 * Linear interpolation — the whole of "late chunking (approximated)".
 *
 * `blend(child, parent, 0.25)` keeps three quarters of the child's own signal and
 * one quarter of the context it sits in. That is enough for a bare sentence like
 * "This does not apply to electronics." to be findable by "electronics return
 * window" without erasing what makes the child specific.
 */
export function blend(child: readonly number[], parent: readonly number[], alpha: number): number[] {
  const a = Math.min(1, Math.max(0, alpha));
  return normalise(child.map((value, index) => (1 - a) * value + a * (parent[index] ?? 0)));
}

/** Rounded scores are for display only — never sort on the rounded value. */
export function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
