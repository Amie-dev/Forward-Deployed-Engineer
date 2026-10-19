import {
  distanceFromScore,
  dot,
  manhattanDistance,
  normalize,
  prepare,
  scoreWithNorms,
  squaredEuclidean,
} from './metrics.js';
import { kmeans } from './kmeans.js';
import { TopK } from '../lib/topk.js';
import type {
  IndexSearchOptions,
  IndexSearchResult,
  IndexStats,
  Metric,
  PqConfig,
  PreparedRecord,
  Vector,
} from '../types/vector.types.js';

/**
 * Product Quantization.
 *
 * Split a D-dimensional vector into M sub-vectors, learn 256 codewords per
 * sub-space, and store only the 8-bit codeword index for each sub-vector:
 *
 *   1536 floats (6144 B)  ->  96 bytes   (64x smaller)
 *
 * Distances are approximated with asymmetric distance computation (ADC): build
 * one lookup table per query sub-space, then sum M table reads per candidate.
 * Optional exact rescoring recovers the precision lost by compression.
 */
export class PqIndex<T = Record<string, unknown>> {
  readonly kind = 'pq' as const;

  private records: PreparedRecord<T>[] = [];
  private codes: Uint8Array[] = [];
  private codebooks: Vector[][] = [];
  private readonly byId = new Map<string, number>();
  private readonly deleted = new Set<number>();
  private readonly m: number;
  private readonly requestedKsub: number;
  private readonly iterations: number;
  private readonly seed: number;
  private subDim = 0;
  private ksub = 0;
  private dimensions = 0;

  constructor(
    private readonly metric: Metric,
    config: PqConfig,
  ) {
    const m = config.m ?? 8;
    if (m < 1) throw new Error('PQ m must be >= 1.');
    this.m = m;
    this.requestedKsub = config.ksub ?? 256;
    this.iterations = config.iterations ?? 20;
    this.seed = config.seed ?? 42;
    if (this.requestedKsub < 1 || this.requestedKsub > 256) {
      throw new Error('PQ ksub must be between 1 and 256 (codes are Uint8).');
    }
  }

  get size(): number {
    return this.records.length - this.deleted.size;
  }

  build(records: readonly PreparedRecord<T>[]): void {
    if (records.length < 2) throw new Error('PQ needs at least two training vectors.');
    this.records = [...records];
    this.codes = [];
    this.byId.clear();
    this.deleted.clear();

    this.dimensions = this.records[0].vector.length;
    if (this.dimensions % this.m !== 0) {
      throw new Error(`Dimension ${this.dimensions} is not divisible by m=${this.m}.`);
    }
    this.subDim = this.dimensions / this.m;
    this.ksub = Math.min(this.requestedKsub, this.records.length);

    const training = this.records.map((record) => this.forMetric(record.vector));
    this.codebooks = [];
    for (let subspace = 0; subspace < this.m; subspace++) {
      const slices = training.map((vector) => this.slice(vector, subspace));
      const trained = kmeans(slices, {
        k: this.ksub,
        iterations: this.iterations,
        seed: this.seed + subspace,
      });
      this.codebooks.push(trained.centroids);
    }

    for (let i = 0; i < this.records.length; i++) {
      this.codes.push(this.encode(this.forMetric(this.records[i].vector)));
      this.byId.set(this.records[i].id, i);
    }
  }

  add(records: readonly PreparedRecord<T>[]): void {
    if (this.codebooks.length === 0) {
      this.build(records);
      return;
    }
    for (const record of records) {
      const index = this.records.length;
      this.records.push(record);
      this.codes.push(this.encode(this.forMetric(record.vector)));
      this.byId.set(record.id, index);
    }
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      const index = this.byId.get(id);
      if (index === undefined) continue;
      this.deleted.add(index);
      this.byId.delete(id);
    }
  }

  search(query: Vector, options: IndexSearchOptions<T>): IndexSearchResult<T>[] {
    const { k, filter } = options;
    if (k <= 0 || this.records.length === 0) return [];

    const preparedQuery = prepare(query);
    const queryVector = this.forMetric(query);
    const table = this.buildAdcTable(queryVector);
    const rescoreDepth = Math.max(0, options.rescore ?? Math.min(50, Math.max(k * 4, k)));

    // Candidate generation must return at least as many points as we intend to
    // rescore; otherwise rescoring can only reorder the same K candidates.
    const top = new TopK(Math.max(k, rescoreDepth));

    for (let i = 0; i < this.records.length; i++) {
      if (this.deleted.has(i)) continue;
      const record = this.records[i];
      if (filter && !filter(record)) continue;
      const approximate = this.sumCodes(this.codes[i], table);
      const score =
        this.metric === 'cosine'
          ? 1 - approximate / 2 // ||a-b||² = 2 - 2cos for unit vectors
          : this.metric === 'euclid' || this.metric === 'manhattan'
            ? -approximate
            : approximate;
      top.push(record.id, score);
    }

    const ranked = top.results();

    if (rescoreDepth > 0) {
      // Exact rescoring on full-precision vectors. The candidate stage still
      // decides *which* points are eligible; rescoring only fixes their order.
      return ranked
        .slice(0, Math.min(rescoreDepth, ranked.length))
        .map((candidate) => {
          const record = this.records[this.byId.get(candidate.id)!];
          const exact = scoreWithNorms(
            this.metric,
            preparedQuery.data,
            preparedQuery.norm,
            record.vector,
            record.norm,
          );
          return {
            id: record.id,
            score: exact,
            distance: distanceFromScore(this.metric, exact),
            record,
          };
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, k);
    }

    return ranked.slice(0, k).map((candidate) => {
      const record = this.records[this.byId.get(candidate.id)!];
      return {
        id: record.id,
        score: candidate.score,
        distance: this.approximateDistance(candidate.score),
        record,
      };
    });
  }

  stats(): IndexStats {
    const originalVectorBytes = this.records.reduce(
      (sum, record) => sum + record.vector.byteLength,
      0,
    );
    const codeBytes = this.records.length * this.m;
    const codebookBytes = this.codebooks.reduce(
      (sum, codebook) => sum + codebook.reduce((inner, word) => inner + word.byteLength, 0),
      0,
    );
    return {
      kind: this.kind,
      size: this.size,
      deleted: this.deleted.size,
      memoryBytes: codeBytes + codebookBytes,
      params: {
        m: this.m,
        ksub: this.ksub,
        subDim: this.subDim,
        metric: this.metric,
        codeBytes,
        codebookBytes,
        originalVectorBytes,
        compressionRatio:
          codeBytes + codebookBytes > 0
            ? Number((originalVectorBytes / (codeBytes + codebookBytes)).toFixed(2))
            : 0,
      },
    };
  }

  // ── Encoding / ADC internals ──────────────────────────────────────────────

  private buildAdcTable(query: Vector): Float32Array {
    const table = new Float32Array(this.m * this.ksub);
    for (let subspace = 0; subspace < this.m; subspace++) {
      const querySlice = this.slice(query, subspace);
      const offset = subspace * this.ksub;
      for (let codeword = 0; codeword < this.ksub; codeword++) {
        const word = this.codebooks[subspace][codeword];
        if (this.metric === 'euclid' || this.metric === 'cosine') {
          // For unit vectors, L2² = 2 - 2cos, so L2 ADC is cosine ADC without
          // the codeword-norm bias of a raw dot-product table.
          table[offset + codeword] = squaredEuclidean(querySlice, word);
        } else if (this.metric === 'manhattan') {
          table[offset + codeword] = manhattanDistance(querySlice, word);
        } else {
          table[offset + codeword] = dot(querySlice, word);
        }
      }
    }
    return table;
  }

  private encode(vector: Vector): Uint8Array {
    const code = new Uint8Array(this.m);
    for (let subspace = 0; subspace < this.m; subspace++) {
      const slice = this.slice(vector, subspace);
      const codebook = this.codebooks[subspace];
      let best = 0;
      let bestDistance = Infinity;
      for (let codeword = 0; codeword < this.ksub; codeword++) {
        const distance = squaredEuclidean(slice, codebook[codeword]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = codeword;
        }
      }
      code[subspace] = best;
    }
    return code;
  }

  private sumCodes(code: Uint8Array, table: Float32Array): number {
    let sum = 0;
    for (let subspace = 0; subspace < this.m; subspace++) {
      sum += table[subspace * this.ksub + code[subspace]];
    }
    return sum;
  }

  private slice(vector: Vector, subspace: number): Vector {
    return vector.subarray(subspace * this.subDim, (subspace + 1) * this.subDim);
  }

  private forMetric(vector: Vector): Vector {
    // Cosine is angle: normalize once and the dot product becomes the answer.
    return this.metric === 'cosine' ? normalize(vector) : vector;
  }

  private approximateDistance(score: number): number {
    switch (this.metric) {
      case 'euclid':
        return Math.sqrt(Math.max(0, -score));
      case 'manhattan':
      case 'dot':
        return -score;
      case 'cosine':
        return 1 - score;
    }
  }
}
