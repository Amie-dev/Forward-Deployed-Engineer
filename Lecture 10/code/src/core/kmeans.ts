import { squaredEuclidean } from './metrics.js';
import { createRng, randomInt } from '../lib/rng.js';
import type { Vector } from '../types/vector.types.js';

export interface KMeansOptions {
  k: number;
  iterations?: number;
  seed?: number;
}

export interface KMeansResult {
  centroids: Vector[];
  assignments: Int32Array;
  inertia: number;
  iterations: number;
}

/**
 * Lloyd's algorithm with k-means++ seeding.
 *
 * IVF uses this to learn `nlist` regions; PQ uses the same function once per
 * sub-space. It always clusters with squared L2 — for cosine workloads the
 * caller normalizes first, which makes L2 and cosine rank identically.
 */
export function kmeans(points: readonly Vector[], options: KMeansOptions): KMeansResult {
  const { k, iterations = 25, seed = 42 } = options;
  if (points.length === 0) throw new Error('k-means needs at least one point.');
  if (k < 1) throw new Error('k must be >= 1.');
  if (k > points.length) throw new Error(`k (${k}) cannot exceed points (${points.length}).`);

  const dimensions = points[0].length;
  for (const point of points) {
    if (point.length !== dimensions) throw new Error('All points must share one dimension.');
  }

  const rng = createRng(seed);
  const centroids = initializeKMeansPlusPlus(points, k, rng);
  let assignments = new Int32Array(points.length).fill(-1);
  let inertia = 0;
  let completed = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    completed = iteration + 1;
    const next = new Int32Array(points.length);
    const sums = Array.from({ length: k }, () => new Float64Array(dimensions));
    const counts = new Int32Array(k);
    let nextInertia = 0;

    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const distance = squaredEuclidean(points[i], centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      next[i] = best;
      counts[best]++;
      nextInertia += bestDistance;
      const sum = sums[best];
      for (let d = 0; d < dimensions; d++) sum[d] += points[i][d];
    }

    // Empty clusters are a real failure mode, not a theoretical one. Re-seed
    // them at the point currently worst represented by its centroid.
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        const centroid = new Float32Array(dimensions);
        for (let d = 0; d < dimensions; d++) centroid[d] = sums[c][d] / counts[c];
        centroids[c] = centroid;
        continue;
      }
      let farthest = 0;
      let farthestDistance = -1;
      for (let i = 0; i < points.length; i++) {
        const distance = squaredEuclidean(points[i], centroids[next[i]]);
        if (distance > farthestDistance) {
          farthestDistance = distance;
          farthest = i;
        }
      }
      centroids[c] = Float32Array.from(points[farthest]);
    }

    inertia = nextInertia;
    const converged = assignments.every((value, index) => value === next[index]);
    assignments = next;
    if (converged) break;
  }

  return { centroids, assignments, inertia, iterations: completed };
}

function initializeKMeansPlusPlus(
  points: readonly Vector[],
  k: number,
  rng: () => number,
): Vector[] {
  const centroids: Vector[] = [Float32Array.from(points[randomInt(rng, points.length)])];
  const closest = new Float64Array(points.length).fill(Infinity);

  while (centroids.length < k) {
    const latest = centroids[centroids.length - 1];
    let total = 0;

    for (let i = 0; i < points.length; i++) {
      const distance = squaredEuclidean(points[i], latest);
      if (distance < closest[i]) closest[i] = distance;
      total += closest[i];
    }

    // All points identical: any point is a valid centroid.
    if (total === 0) {
      centroids.push(Float32Array.from(points[randomInt(rng, points.length)]));
      continue;
    }

    let target = rng() * total;
    let chosen = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      target -= closest[i];
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(Float32Array.from(points[chosen]));
  }

  return centroids;
}
