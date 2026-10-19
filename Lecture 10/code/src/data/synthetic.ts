import { createRng } from '../lib/rng.js';
import { prepare } from '../core/metrics.js';
import type { PreparedRecord, Vector } from '../types/vector.types.js';

export interface SyntheticPayload {
  [key: string]: unknown;
  cluster: number;
  tenant: 'acme' | 'globex';
  year: number;
  category: string;
}

export interface SyntheticDataset {
  records: PreparedRecord<SyntheticPayload>[];
  queries: Vector[];
  queryClusters: number[];
  dimensions: number;
}

export interface SyntheticOptions {
  count?: number;
  dimensions?: number;
  clusters?: number;
  seed?: number;
  noise?: number;
  /** `random` produces queries between clusters — a harder recall test. */
  querySource?: 'record' | 'random';
}

/**
 * Clustered synthetic vectors. Real embeddings are clustered too, which is why
 * IVF and HNSW work at all; uniform random points are the adversarial case.
 */
export function makeSyntheticDataset(options: SyntheticOptions = {}): SyntheticDataset {
  const {
    count = 1_000,
    dimensions = 32,
    clusters = 20,
    seed = 7,
    noise = 0.18,
    querySource = 'record',
  } = options;

  const rng = createRng(seed);
  const centres = Array.from({ length: clusters }, () =>
    Array.from({ length: dimensions }, () => gaussian(rng)),
  );

  const records: PreparedRecord<SyntheticPayload>[] = [];
  const categories = ['embeddings', 'ann', 'storage', 'ops'];

  for (let i = 0; i < count; i++) {
    const cluster = i % clusters;
    const vector = new Float32Array(dimensions);
    for (let d = 0; d < dimensions; d++) {
      vector[d] = centres[cluster][d] + gaussian(rng) * noise;
    }
    records.push({
      id: `vec-${String(i).padStart(5, '0')}`,
      vector,
      norm: prepare(vector).norm,
      payload: {
        cluster,
        tenant: cluster % 2 === 0 ? 'acme' : 'globex',
        year: 2020 + (cluster % 5),
        category: categories[cluster % categories.length],
      },
    });
  }

  const queries: Vector[] = [];
  const queryClusters: number[] = [];
  for (let q = 0; q < 25; q++) {
    const source = records[(q * 37) % records.length];
    const vector = new Float32Array(dimensions);
    if (querySource === 'random') {
      for (let d = 0; d < dimensions; d++) vector[d] = gaussian(rng);
    } else {
      for (let d = 0; d < dimensions; d++) {
        vector[d] = source.vector[d] + gaussian(rng) * noise * 0.6;
      }
    }
    queries.push(vector);
    queryClusters.push(source.payload.cluster);
  }

  return { records, queries, queryClusters, dimensions };
}

/** Box–Muller transform: two uniforms in, one standard normal out. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
