import { performance } from 'node:perf_hooks';
import { exactKnn } from '../core/exact-knn.js';
import { IvfIndex } from '../core/ivf.js';
import { HnswIndex } from '../core/hnsw.js';
import { PqIndex } from '../core/pq.js';
import { percentile, recallAtK } from '../core/evaluation.js';
import { makeSyntheticDataset } from '../data/synthetic.js';

interface Row {
  name: string;
  buildMs: number;
  memoryBytes: number;
  p50: number;
  p95: number;
  recall: number;
}

async function main(): Promise<void> {
  const dataset = makeSyntheticDataset({
    count: 3_000,
    dimensions: 48,
    clusters: 300,
    seed: 21,
    noise: 0.5,
    querySource: 'random',
  });
  const k = 10;
  const queries = dataset.queries.slice(0, 40);
  const exactIds = queries.map((query) =>
    exactKnn(dataset.records, query, { metric: 'cosine', k }).map((hit) => hit.id),
  );

  const rows: Row[] = [
    measure(
      'flat (exact)',
      (query) => exactKnn(dataset.records, query, { metric: 'cosine', k }),
      queries,
      exactIds,
      k,
      0,
      0,
    ),
  ];

  const ivf = new IvfIndex('cosine', {
    nlist: Math.round(Math.sqrt(dataset.records.length)),
    nprobe: 1,
    seed: 4,
  });
  const ivfBuild = time(() => ivf.build(dataset.records));
  rows.push(
    measure(
      'ivf',
      (query) => ivf.search(query, { k, nprobe: 8 }),
      queries,
      exactIds,
      k,
      ivfBuild,
      ivf.stats().memoryBytes,
    ),
  );

  const hnsw = new HnswIndex('cosine', {
    m: 16,
    efConstruction: 100,
    efSearch: 12,
    seed: 4,
  });
  const hnswBuild = time(() => hnsw.build(dataset.records));
  rows.push(
    measure(
      'hnsw',
      (query) => hnsw.search(query, { k, efSearch: 12 }),
      queries,
      exactIds,
      k,
      hnswBuild,
      hnsw.stats().memoryBytes,
    ),
  );

  const pq = new PqIndex('cosine', { m: 12, ksub: 128, iterations: 12, seed: 4 });
  const pqBuild = time(() => pq.build(dataset.records));
  rows.push(
    measure(
      'pq + rescore',
      (query) => pq.search(query, { k, rescore: 20 }),
      queries,
      exactIds,
      k,
      pqBuild,
      pq.stats().memoryBytes,
    ),
  );

  console.log(
    `\nDataset: ${dataset.records.length} vectors, ${dataset.dimensions} dims, ` +
      `${queries.length} queries, K=${k}\n`,
  );
  console.log('| Index | Build (ms) | Index memory (KB) | p50 (ms) | p95 (ms) | Recall@10 |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    console.log(
      `| ${row.name} | ${row.buildMs.toFixed(1)} | ${(row.memoryBytes / 1024).toFixed(1)} | ` +
        `${row.p50.toFixed(2)} | ${row.p95.toFixed(2)} | ${(row.recall * 100).toFixed(1)}% |`,
    );
  }
  console.log('\nIndex memory excludes raw vectors, which are still needed for exact rescoring.\n');
}

function measure(
  name: string,
  search: (query: Float32Array) => { id: string }[],
  queries: readonly Float32Array[],
  exactIds: readonly string[][],
  k: number,
  buildMs: number,
  memoryBytes: number,
): Row {
  search(queries[0]); // warm-up

  const times: number[] = [];
  let recall = 0;
  queries.forEach((query, index) => {
    const started = performance.now();
    const results = search(query);
    times.push(performance.now() - started);
    recall += recallAtK(
      results.map((hit) => hit.id),
      exactIds[index],
      k,
    );
  });

  return {
    name,
    buildMs,
    memoryBytes,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    recall: recall / queries.length,
  };
}

function time(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
