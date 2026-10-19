import { cosineSimilarity } from '../core/metrics.js';
import { exactKnn } from '../core/exact-knn.js';
import { IvfIndex } from '../core/ivf.js';
import { HnswIndex } from '../core/hnsw.js';
import { PqIndex } from '../core/pq.js';
import { Bm25Index, reciprocalRankFusion } from '../store/hybrid.js';
import { MockEmbeddingProvider } from '../embeddings/mock.provider.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import { CORPUS } from '../data/corpus.js';
import { VectorStore } from '../store/vector-store.js';

async function main(): Promise<void> {
  const embeddings = new EmbeddingService(new MockEmbeddingProvider(128));
  const sentences = [
    'A vector database indexes embeddings for similarity search.',
    'HNSW is a graph-based approximate nearest neighbour index.',
    'PostgreSQL can store vectors with the pgvector extension.',
  ];
  const vectors = (await embeddings.embedDocuments(sentences)).map((vector) =>
    Float32Array.from(vector),
  );

  console.log('\n1. Cosine similarity matrix\n');
  console.log(''.padEnd(12) + sentences.map((_, i) => `s${i + 1}`.padStart(8)).join(''));
  vectors.forEach((vector, row) => {
    const cells = vectors.map((other) => cosineSimilarity(vector, other).toFixed(3).padStart(8));
    console.log(`s${row + 1}`.padEnd(12) + cells.join(''));
  });

  const store = new VectorStore<Record<string, unknown>>({
    dimensions: embeddings.dimensions,
    metric: 'cosine',
  });
  const corpusVectors = await embeddings.embedDocuments(CORPUS.map((document) => document.text));
  store.upsert(
    CORPUS.map((document, index) => ({
      id: document.id,
      vector: corpusVectors[index],
      payload: document.payload,
      text: document.text,
    })),
  );

  const queryText = 'graph based approximate nearest neighbour index';
  const query = Float32Array.from(await embeddings.embedQuery(queryText));

  console.log(`\n2. The same query through four indexes: "${queryText}"\n`);
  const exact = exactKnn(store.all(), query, { metric: 'cosine', k: 3 });
  print('flat (exact)', exact.map((hit) => hit.id));

  const ivf = new IvfIndex('cosine', { nlist: 6, nprobe: 2, seed: 4 });
  ivf.build(store.all());
  print('ivf', ivf.search(query, { k: 3 }).map((hit) => hit.id));

  const hnsw = new HnswIndex('cosine', { m: 8, efConstruction: 60, efSearch: 40, seed: 4 });
  hnsw.build(store.all());
  print('hnsw', hnsw.search(query, { k: 3 }).map((hit) => hit.id));

  const pq = new PqIndex('cosine', { m: 16, ksub: 24, iterations: 12, seed: 4 });
  pq.build(store.all());
  print('pq + rescore', pq.search(query, { k: 3, rescore: 12 }).map((hit) => hit.id));

  console.log('\n3. Metadata filter: tenant = acme\n');
  const filtered = store.query({ vector: query, k: 3, filter: { tenant: 'acme' } });
  for (const hit of filtered.hits) {
    console.log(`  ${hit.id}  score=${hit.score.toFixed(4)}  ${hit.text?.slice(0, 70)}...`);
  }

  console.log('\n4. Hybrid retrieval (dense + BM25, fused with RRF)\n');
  const lexical = new Bm25Index(
    store.all().map((record) => ({ id: record.id, text: record.text ?? '' })),
  ).search(queryText, 5);
  const fused = reciprocalRankFusion(
    [exact.map((hit) => ({ id: hit.id, score: hit.score })), lexical],
    { limit: 3 },
  );
  for (const hit of fused) console.log(`  ${hit.id}  rrf=${hit.score.toFixed(5)}`);

  const stats = store.stats();
  console.log(`\nStore: ${stats.count} documents, ${stats.dimensions} dims, metric=${stats.metric}`);
  console.log('Done. Start the API with `npm run dev` for CRUD and query endpoints.\n');
}

function print(label: string, ids: string[]): void {
  console.log(`  ${label.padEnd(14)} ${ids.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
