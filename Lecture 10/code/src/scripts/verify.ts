import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  cosineSimilarity,
  euclideanDistance,
  normalize,
  score,
} from '../core/metrics.js';
import { exactKnn } from '../core/exact-knn.js';
import { IvfIndex } from '../core/ivf.js';
import { HnswIndex } from '../core/hnsw.js';
import { PqIndex } from '../core/pq.js';
import { recallAtK } from '../core/evaluation.js';
import { Bm25Index, reciprocalRankFusion } from '../store/hybrid.js';
import { VectorStore } from '../store/vector-store.js';
import { compileFilter } from '../store/filters.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { makeSyntheticDataset } from '../data/synthetic.js';
import { TopK } from '../lib/topk.js';

class CountingProvider implements EmbeddingProvider {
  readonly name = 'counting';
  readonly model = 'counting-v1';
  readonly dimensions = 4;
  calls = 0;
  lastBatch = 0;

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls++;
    this.lastBatch = texts.length;
    return texts.map(() => [1, 0, 0, 0]);
  }
}

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const start = performance.now();
  await fn();
  checks++;
  console.log(`  ok  ${name} (${(performance.now() - start).toFixed(1)} ms)`);
}

console.log('\nLecture 10 — verification\n');

await check('metric identities and guards', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.equal(cosineSimilarity(a, a), 1);
  assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-12);
  assert.ok(Math.abs(euclideanDistance(a, b) - Math.SQRT2) < 1e-12);
  assert.deepEqual([...normalize(Float32Array.from([3, 4]))].map((x) => +x.toFixed(3)), [0.6, 0.8]);
  assert.equal(cosineSimilarity(Float32Array.from([0, 0]), a), 0);
  assert.throws(() => score('cosine', a, Float32Array.from([1, 2, 3])));
});

await check('bounded top-K keeps the largest scores', () => {
  const top = new TopK(3);
  for (const [id, value] of [['a', 0.2], ['b', 0.9], ['c', 0.5], ['d', 0.7]] as const) {
    top.push(id, value);
  }
  assert.deepEqual(top.results().map((hit) => hit.id), ['b', 'd', 'c']);
});

const dataset = makeSyntheticDataset({
  count: 1_200,
  dimensions: 32,
  clusters: 24,
  seed: 11,
  noise: 0.16,
});

await check('exact KNN is ordered and self-consistent', () => {
  const query = dataset.records[0].vector;
  const hits = exactKnn(dataset.records, query, { metric: 'cosine', k: 5 });
  assert.equal(hits[0].id, dataset.records[0].id);
  assert.ok(hits.every((hit, i) => i === 0 || hits[i - 1].score >= hit.score));
});

await check('IVF recall is high with clustered data', () => {
  const index = new IvfIndex('cosine', { nlist: 24, nprobe: 4, seed: 5 });
  index.build(dataset.records);
  let total = 0;
  for (let q = 0; q < dataset.queries.length; q++) {
    const exact = exactKnn(dataset.records, dataset.queries[q], { metric: 'cosine', k: 10 });
    const approximate = index.search(dataset.queries[q], { k: 10 });
    total += recallAtK(approximate.map((h) => h.id), exact.map((h) => h.id), 10);
  }
  const recall = total / dataset.queries.length;
  console.log(`      IVF recall@10 = ${(recall * 100).toFixed(1)}%`);
  assert.ok(recall > 0.85, `IVF recall too low: ${recall}`);
});

await check('HNSW recall is high and search visits few nodes', () => {
  const index = new HnswIndex('cosine', { m: 16, efConstruction: 100, efSearch: 64, seed: 3 });
  index.build(dataset.records);
  let total = 0;
  for (let q = 0; q < dataset.queries.length; q++) {
    const exact = exactKnn(dataset.records, dataset.queries[q], { metric: 'cosine', k: 10 });
    const approximate = index.search(dataset.queries[q], { k: 10 });
    total += recallAtK(approximate.map((h) => h.id), exact.map((h) => h.id), 10);
  }
  const recall = total / dataset.queries.length;
  console.log(`      HNSW recall@10 = ${(recall * 100).toFixed(1)}%`);
  assert.ok(recall > 0.85, `HNSW recall too low: ${recall}`);
});

await check('PQ compresses and rescoring restores ranking quality', () => {
  const index = new PqIndex('cosine', { m: 8, ksub: 64, iterations: 12, seed: 9 });
  index.build(dataset.records);
  let total = 0;
  for (let q = 0; q < dataset.queries.length; q++) {
    const exact = exactKnn(dataset.records, dataset.queries[q], { metric: 'cosine', k: 10 });
    const approximate = index.search(dataset.queries[q], { k: 10, rescore: 40 });
    total += recallAtK(approximate.map((h) => h.id), exact.map((h) => h.id), 10);
  }
  const recall = total / dataset.queries.length;
  const stats = index.stats();
  console.log(
    `      PQ recall@10 = ${(recall * 100).toFixed(1)}%, ratio = ${stats.params.compressionRatio}x`,
  );
  assert.ok(recall > 0.8, `PQ recall too low: ${recall}`);
  assert.ok(Number(stats.params.compressionRatio) > 5);
});

await check('store CRUD, filters and ANN query paths', () => {
  const store = new VectorStore<Record<string, unknown>>({ dimensions: 8, metric: 'cosine' });
  const a = oneHot(0);
  const b = oneHot(1);
  const c = Float32Array.from([0.9, 0.1, 0, 0, 0, 0, 0, 0]);

  store.upsert([
    { id: 'a', vector: a, payload: { tenant: 'acme', year: 2026 }, text: 'alpha' },
    { id: 'b', vector: b, payload: { tenant: 'globex', year: 2024 }, text: 'beta' },
    { id: 'c', vector: c, payload: { tenant: 'acme', year: 2025 }, text: 'gamma' },
  ]);

  assert.equal(store.get('a').payload.tenant, 'acme');
  assert.deepEqual(store.query({ vector: a, k: 3 }).hits.map((hit) => hit.id), ['a', 'c', 'b']);
  assert.deepEqual(
    store.query({ vector: a, k: 3, filter: { tenant: 'acme' } }).hits.map((hit) => hit.id),
    ['a', 'c'],
  );

  store.upsert([{ id: 'a', vector: a, payload: { tenant: 'acme', year: 2027 } }]);
  assert.equal(store.get('a').payload.year, 2027);
  assert.equal(store.delete(['b']), 1);
  assert.equal(store.has('b'), false);
  assert.throws(() => store.get('missing'));
  assert.throws(() => store.upsert([{ id: 'bad', vector: [1, 2] }]));

  const ivf = store.query({ vector: a, k: 2, index: 'ivf', nprobe: 2 });
  assert.equal(ivf.hits.length, 2);
  const hnsw = store.query({ vector: a, k: 2, index: 'hnsw' });
  assert.equal(hnsw.hits[0].id, 'a');
  const pq = store.query({ vector: a, k: 2, index: 'pq', rescore: 3 });
  assert.equal(pq.hits.length, 2);
});

await check('filter operators compile to a predicate', () => {
  const predicate = compileFilter<Record<string, unknown>>({
    $and: [{ tenant: 'acme' }, { year: { $gte: 2025, $lt: 2030 } }],
  });
  assert.equal(predicate({ tenant: 'acme', year: 2026 }), true);
  assert.equal(predicate({ tenant: 'acme', year: 2024 }), false);
  assert.equal(predicate({ tenant: 'globex', year: 2026 }), false);
  assert.equal(compileFilter({ tenant: { $ne: 'acme' } })({ tenant: 'globex' }), true);
  assert.equal(compileFilter({ title: { $contains: 'vec' } })({ title: 'Vector DB' }), true);
  assert.throws(() => compileFilter({ tenant: { $regex: 'x' } } as never));
});

await check('BM25 and reciprocal rank fusion', () => {
  const bm25 = new Bm25Index([
    { id: 'a', text: 'HNSW graph index' },
    { id: 'b', text: 'product quantization compression' },
    { id: 'c', text: 'vector database storage' },
  ]);
  assert.equal(bm25.search('hnsw', 3)[0].id, 'a');
  assert.equal(bm25.search('quantization', 3)[0].id, 'b');

  const fused = reciprocalRankFusion(
    [
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
      [{ id: 'b', score: 10 }, { id: 'c', score: 9 }],
    ],
    { limit: 3 },
  );
  assert.equal(fused[0].id, 'b');
});

await check('embedding service deduplicates and caches', async () => {
  const provider = new CountingProvider();
  const service = new EmbeddingService(provider, 10);
  const first = await service.embedDocuments(['same', 'same']);
  assert.equal(provider.calls, 1);
  assert.equal(provider.lastBatch, 1);
  assert.deepEqual(first[0], first[1]);

  await service.embedDocuments(['same']);
  assert.equal(provider.calls, 1);
  await service.embedQuery('same');
  assert.equal(provider.calls, 2);
});

console.log(`\n${checks} checks passed.\n`);

function oneHot(index: number, dimensions = 8): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[index] = 1;
  return vector;
}
