export interface CorpusDocument {
  id: string;
  text: string;
  payload: {
    tenant: 'acme' | 'globex';
    category: 'embeddings' | 'ann' | 'storage' | 'operations';
    year: number;
    [key: string]: unknown;
  };
}

/**
 * A small, deliberately overlapping corpus. Dense retrieval finds paraphrases;
 * BM25 finds exact tokens such as "HNSW", "pgvector" or "recall@10". Having both
 * is the point of the hybrid-search chapter.
 */
export const CORPUS: CorpusDocument[] = [
  {
    id: 'doc-001',
    text: 'An embedding maps text, images or audio into a fixed-length vector of floating point numbers. Similar meanings land close together in this space.',
    payload: { tenant: 'acme', category: 'embeddings', year: 2026 },
  },
  {
    id: 'doc-002',
    text: 'Cosine similarity measures the angle between two vectors and ignores their magnitude. It is the default metric for normalized text embeddings.',
    payload: { tenant: 'acme', category: 'embeddings', year: 2026 },
  },
  {
    id: 'doc-003',
    text: 'Dot product similarity is sensitive to vector length. If vectors are normalized, dot product and cosine similarity produce the same ranking.',
    payload: { tenant: 'globex', category: 'embeddings', year: 2025 },
  },
  {
    id: 'doc-004',
    text: 'Euclidean distance measures straight-line distance between two points. It is useful when magnitude carries meaning, such as image features.',
    payload: { tenant: 'globex', category: 'embeddings', year: 2025 },
  },
  {
    id: 'doc-005',
    text: 'Never mix embeddings from different models in one collection. Dimension equality is not enough; each model defines its own coordinate system.',
    payload: { tenant: 'acme', category: 'embeddings', year: 2026 },
  },
  {
    id: 'doc-006',
    text: 'Exact KNN compares the query against every stored vector. It returns perfect recall but costs O(N times D) per query and does not scale to millions of vectors.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-007',
    text: 'Recall at K measures how many of the true nearest neighbours an approximate index returned. It is the contract that makes ANN tuning measurable.',
    payload: { tenant: 'globex', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-008',
    text: 'IVF partitions vectors into nlist Voronoi cells with k-means, then searches only nprobe cells at query time. Larger nprobe improves recall and latency.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-009',
    text: 'HNSW builds a multi-layer proximity graph. Upper layers are sparse highways and layer zero is dense. Queries greedily descend then search with efSearch.',
    payload: { tenant: 'globex', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-010',
    text: 'HNSW parameters trade resources for recall. M controls graph degree, efConstruction controls build quality, and efSearch controls query quality.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-011',
    text: 'Boundary vectors are the weakness of IVF. A point just across a cell boundary may be the true nearest neighbour but is never scanned when nprobe is small.',
    payload: { tenant: 'globex', category: 'ann', year: 2025 },
  },
  {
    id: 'doc-012',
    text: 'Product quantization splits a vector into sub-vectors, learns codewords per subspace, and stores only 8-bit codebook indices. ADC approximates distance from lookup tables.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-013',
    text: 'Scalar quantization stores each float as int8 instead of float32. It typically cuts memory four times with a small recall loss and is easy to enable in Qdrant.',
    payload: { tenant: 'globex', category: 'ann', year: 2025 },
  },
  {
    id: 'doc-014',
    text: 'Two-stage retrieval uses an ANN index to generate candidates and then rescores them with full-precision vectors. Final recall cannot exceed candidate recall.',
    payload: { tenant: 'acme', category: 'ann', year: 2026 },
  },
  {
    id: 'doc-015',
    text: 'A vector database stores an ID, a vector, and a payload. Collections fix the dimension, metric, and index so that records remain comparable.',
    payload: { tenant: 'acme', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-016',
    text: 'Qdrant is an HNSW-based vector database written in Rust. It supports payload filtering, scalar and product quantization, snapshots and multi-tenancy.',
    payload: { tenant: 'globex', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-017',
    text: 'pgvector adds a vector column type and HNSW or IVFFlat indexes to PostgreSQL. It is a strong choice when vectors must join relational data.',
    payload: { tenant: 'acme', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-018',
    text: 'A B-tree cannot index cosine similarity because embeddings have no total order. That is why dedicated ANN indexes such as HNSW and IVF exist.',
    payload: { tenant: 'globex', category: 'storage', year: 2025 },
  },
  {
    id: 'doc-019',
    text: 'Metadata filtering has three strategies: pre-filter, post-filter, and filter-aware search. Post-filtering can return fewer than K results when the filter is selective.',
    payload: { tenant: 'acme', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-020',
    text: 'Hybrid search fuses dense semantic retrieval with sparse lexical retrieval. Reciprocal rank fusion combines ranks without calibrating scores across systems.',
    payload: { tenant: 'globex', category: 'storage', year: 2026 },
  },
  {
    id: 'doc-021',
    text: 'Deletes in HNSW are usually tombstones. The graph keeps the node for navigation, filters it from results, and compacts later to reclaim memory.',
    payload: { tenant: 'acme', category: 'operations', year: 2026 },
  },
  {
    id: 'doc-022',
    text: 'Re-embedding a collection is a migration. Build the new collection, backfill with the new model, compare recall, then swap an alias and keep the old one for rollback.',
    payload: { tenant: 'globex', category: 'operations', year: 2026 },
  },
  {
    id: 'doc-023',
    text: 'Monitor p95 and p99 query latency, recall on a golden set, index build time, deletion backlog, and embedding provider error rates. Averages hide tail pain.',
    payload: { tenant: 'acme', category: 'operations', year: 2026 },
  },
  {
    id: 'doc-024',
    text: 'A tenant filter should be mandatory in every query. Use a tenant-aware payload index and, in Qdrant, is_tenant to keep each tenant isolated and fast.',
    payload: { tenant: 'globex', category: 'operations', year: 2026 },
  },
];
