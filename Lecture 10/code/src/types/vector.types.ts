/**
 * Shared contracts for the whole codebase.
 *
 * A vector is a `Float32Array`, not `number[]`. Embeddings are float32 in every
 * real provider, and a typed array halves the memory of a JS number array while
 * keeping the math identical. The API converts incoming JSON arrays at the
 * boundary; the core never sees `number[]`.
 */

export type Metric = 'cosine' | 'dot' | 'euclid' | 'manhattan';

export type Vector = Float32Array;

/** A vector plus its precomputed L2 norm. Computing the norm once per record
 *  turns cosine from three passes into one dot product per comparison. */
export interface PreparedVector {
  data: Vector;
  norm: number;
}

/** The row a vector database actually stores and an index actually searches. */
export interface PreparedRecord<T = Record<string, unknown>> {
  id: string;
  vector: Vector;
  norm: number;
  payload: T;
  text?: string;
}

export type IndexKind = 'flat' | 'ivf' | 'hnsw' | 'pq';

export interface IvfConfig {
  nlist?: number;
  nprobe?: number;
  iterations?: number;
  seed?: number;
}

export interface HnswConfig {
  m?: number;
  efConstruction?: number;
  efSearch?: number;
  seed?: number;
}

export interface PqConfig {
  m?: number;
  ksub?: number;
  iterations?: number;
  seed?: number;
}

export interface IndexConfig {
  kind: IndexKind;
  ivf?: IvfConfig;
  hnsw?: HnswConfig;
  pq?: PqConfig;
}

export interface SearchHit<T = Record<string, unknown>> {
  id: string;
  /** Higher is always better. Distance metrics are negated internally. */
  score: number;
  /** Native distance when the metric has one: cosine distance `1 - cos`,
   *  Euclidean, Manhattan. For dot product this is `-score`. */
  distance: number;
  payload: T;
  text?: string;
}

export interface IndexStats {
  kind: IndexKind;
  size: number;
  deleted: number;
  memoryBytes: number;
  params: Record<string, number | string | boolean>;
}

export interface StoreStats {
  count: number;
  dimensions: number;
  metric: Metric;
  index: IndexStats | null;
  vectorBytes: number;
  totalMemoryBytes: number;
  embeddingModel?: string;
}

export type Scalar = string | number | boolean | null;

/** MongoDB-style operators, deliberately small and explicit. */
export interface FieldOperators {
  $eq?: Scalar;
  $ne?: Scalar;
  $in?: Scalar[];
  $nin?: Scalar[];
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $exists?: boolean;
  $contains?: string;
}

export type FieldCondition = Scalar | Scalar[] | FieldOperators;

export type Filter =
  | { $and: Filter[] }
  | { $or: Filter[] }
  | { $not: Filter }
  | { [field: string]: FieldCondition };

export interface UpsertInput<T = Record<string, unknown>> {
  id: string;
  vector: Vector | number[];
  payload?: T;
  text?: string;
}

export interface StoreQueryOptions {
  vector: Vector | number[];
  k?: number;
  filter?: Filter;
  index?: IndexKind;
  nprobe?: number;
  efSearch?: number;
  /** PQ only: exact rescoring depth. Set to 0 to disable. */
  rescore?: number;
}

export interface IndexSearchOptions<T = Record<string, unknown>> {
  k: number;
  filter?: (record: PreparedRecord<T>) => boolean;
  nprobe?: number;
  efSearch?: number;
  rescore?: number;
}

export interface IndexSearchResult<T = Record<string, unknown>> {
  id: string;
  score: number;
  distance: number;
  record: PreparedRecord<T>;
}
