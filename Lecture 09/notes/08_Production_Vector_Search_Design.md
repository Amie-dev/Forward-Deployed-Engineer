# Chapter 08: Production Vector Search Design

> **Chapter Goal:** Turn the theory into an operable system. This chapter covers the reference architecture, capacity planning with real numbers, ingestion and freshness, model-version migrations, sharding, evaluation, security, caching, and the vendor landscape. It closes with a production checklist, failure runbook, and the consolidated takeaways of the entire lecture.

---

## 8.1 Reference Architecture

A production vector search system is not "an app plus a vector database". It is a pipeline with a source of truth, an indexing path, a query path, and an observability layer.

```mermaid
flowchart TD
    subgraph SOURCE["Source of truth"]
        DB[("Postgres / object store<br/>documents, products, movies")]
    end

    subgraph INGEST["Indexing pipeline"]
        CDC["CDC / outbox<br/>change events"] --> Q["Queue<br/>Kafka / SQS"]
        Q --> W["Indexer workers"]
        W --> CH["Chunk + normalize"]
        CH --> EM["Embedding service<br/>batch + retry"]
        EM --> UP["Upsert vectors<br/>+ payload"]
    end

    subgraph STORE["Search layer"]
        VDB[("Vector DB<br/>HNSW / IVF-PQ")]
        META[("Metadata / cache<br/>Redis")]
    end

    subgraph QUERY["Query path"]
        API["API / BFF"] --> QE["Query embedding"]
        QE --> VS["Vector search<br/>+ filters"]
        VS --> RR["Rescore + business rank"]
        RR --> LLM["Optional LLM / reranker"]
        LLM --> RESP["Response"]
    end

    DB --> CDC
    UP --> VDB
    UP --> META
    VDB --> VS
    META --> RR
    VDB --> OBS["Metrics, traces, logs"]
    API --> OBS

    style DB fill:#89b4fa,color:#1e1e2e
    style EM fill:#cba6f7,color:#1e1e2e
    style VDB fill:#a6e3a1,color:#1e1e2e
    style LLM fill:#f9e2af,color:#1e1e2e
```

### The responsibilities, separated

| Component | Responsibility | Must not do |
|---|---|---|
| Source database | Truth, transactions, permissions | Store only vectors |
| CDC / queue | Reliable change propagation | Block the write path |
| Indexer | Chunking, embedding, upsert | Own business logic |
| Embedding service | Model calls, batching, retries, caching | Store vectors |
| Vector DB | ANN search, filters, payload | Be the source of truth |
| Retrieval API | Orchestration, rescoring, ranking | Expose raw DB errors |
| Reranker / LLM | Final relevance, explanation | Replace retrieval |

> **Architectural invariant:** the vector index must be **fully rebuildable** from the source of truth plus the embedding model. If it is not, you have a durability and disaster-recovery problem.

---

## 8.2 Capacity Planning: A Worked Example

Assume a document search product:

```text
Documents:            5,000,000
Chunks per document:  4 on average
Vectors:              20,000,000
Dimensions:           1536
Precision:            float32 (4 bytes)
Replicas:             2
```

### Raw vector memory

```text
bytes per vector = 1536 × 4 = 6,144 B ≈ 6 KB
raw vectors      = 20,000,000 × 6 KB = 120 GB
with 2 replicas  = 240 GB
```

### Add the index and payload

| Component | Estimate |
|---|---|
| Raw vectors (1 replica) | 120 GB |
| HNSW graph (`M = 32`, neighbour IDs + metadata) | 10–30 GB |
| Payload + IDs + document text | 40–100 GB |
| Working overhead (build, compaction) | 1.5× peak |
| **Total per replica** | **~200–300 GB** |
| **With 2 replicas** | **~400–600 GB** |

### Reduce it with quantization

```text
int8:   20M × 1536 B = 30 GB per replica   (4× reduction)
PQ:     20M × 192 B  = 3.8 GB per replica  (32× reduction)
```

With int8 plus a full-precision rescoring cache for the top candidates, a 200 GB deployment becomes roughly 50–80 GB — often the difference between "needs a fleet" and "fits on two nodes".

### Query capacity

```text
Peak QPS:            200
p95 latency target:  100 ms
Embedding call:      20-40 ms (cached: ~2 ms)
ANN search:          5-20 ms
Rescore + ranking:   5-15 ms
```

| Lever | Effect |
|---|---|
| Cache query embeddings | Removes 20–40 ms for repeated queries |
| Increase replicas | Linear read throughput |
| Reduce `efSearch` | Lower latency, lower recall |
| Quantize | Less memory bandwidth per query |
| Precompute popular results | Removes work for head queries |

> **Capacity planning rule:** size memory for the **index + payload + headroom**, not just the vectors. Then size replicas for **peak QPS at p95**, not average QPS.

---

## 8.3 Ingestion, Freshness, and Reindexing

A vector index is a **materialized view** of your data plus a model. Treat it like one.

### Ingestion patterns

| Pattern | How it works | Best for |
|---|---|---|
| **Batch job** | Nightly scan of changed rows | Catalogs, low freshness needs |
| **CDC** | Stream inserts/updates/deletes from the DB log | Near-real-time search |
| **Outbox table** | Write event in same transaction, relay later | Reliable events without CDC |
| **Dual write** | App writes DB and vector DB | Simple, but can drift |
| **Event-driven** | Domain events trigger re-indexing | Microservices |

```mermaid
flowchart LR
    A["Write to source DB"] --> B{"Event published?"}
    B -->|"Outbox / CDC"| C["Queue"]
    C --> D["Indexer"]
    D --> E["Embed changed chunks"]
    E --> F["Upsert by deterministic ID"]
    F --> G["Searchable"]

    B -->|"Dual write"| H["Direct upsert"]
    H --> G
    H -.->|"may drift"| I["Reconciliation job"]

    style C fill:#89b4fa,color:#1e1e2e
    style F fill:#cba6f7,color:#1e1e2e
    style G fill:#a6e3a1,color:#1e1e2e
    style I fill:#f9e2af,color:#1e1e2e
```

### Freshness targets

| Use case | Acceptable lag | Approach |
|---|---|---|
| Product catalogue | Minutes to hours | CDC + incremental embed |
| Support knowledge base | Minutes | Event-driven re-index |
| Chat with your own docs | Seconds | Streaming + chunk upsert |
| Compliance / audit search | Hours | Batch with verification |
| Recommendations | Hours | Batch rebuild |

### Handling deletes and updates

| Operation | Vector DB action | Pitfall |
|---|---|---|
| Insert | Upsert new ID | Duplicate IDs from non-deterministic chunking |
| Update text | Re-embed + upsert same ID | Forgetting to delete stale chunks if chunk count shrinks |
| Delete | Tombstone, then compact | Deleted vectors still returned if filtered incorrectly |
| Model upgrade | New collection + alias swap | Mixed-model vectors in one index |

> **Chunk-count shrink bug:** a document that once produced 8 chunks and now produces 5 leaves 3 orphaned vectors unless you delete `id:6..8` explicitly. Always version chunks or delete-by-source-id before re-inserting.

---

## 8.4 Model Versioning and Zero-Downtime Re-Embedding

The most expensive operational event in a vector system is changing the embedding model. Every stored vector becomes incompatible.

```mermaid
flowchart TD
    A["New model selected"] --> B["Create collection v2<br/>same dimensions, new metric if needed"]
    B --> C["Backfill: embed all documents<br/>in batches"]
    C --> D["Shadow traffic:<br/>compare v1 vs v2 results"]
    D --> E{"Quality and latency<br/>acceptable?"}
    E -->|"No"| F["Tune, or roll back<br/>keep serving v1"]
    E -->|"Yes"| G["Switch read alias to v2"]
    G --> H["Keep v1 warm for rollback"]
    H --> I["Delete v1 after cool-off"]

    style B fill:#cba6f7,color:#1e1e2e
    style D fill:#89b4fa,color:#1e1e2e
    style G fill:#a6e3a1,color:#1e1e2e
    style F fill:#f38ba8,color:#1e1e2e
```

### Migration rules

1. **Never mix models in one collection.** Use a new collection or a `modelVersion` filter.
2. **Backfill in batches** with checkpointing; assume it will be interrupted.
3. **Dual-serve** for a period: query both, compare recall and online metrics.
4. **Alias, don't hardcode.** Applications query `documents_live`, which points to a version.
5. **Keep the old index** until the rollback window closes.
6. **Record `modelId` and `modelVersion` in every payload** for auditability.

```ts
// Pseudo-code: versioned re-embedding with alias swap
async function migrateEmbeddingModel(from: string, to: string): Promise<void> {
  await vectorDb.createCollection({
    name: `documents_${to}`,
    dimensions: MODEL_DIMENSIONS[to],
    metric: "cosine",
    index: { type: "hnsw", params: { M: 32, efConstruction: 200 } },
  });

  await backfillInBatches({
    source: "documents",
    batchSize: 500,
    checkpointKey: `backfill:${to}`,
    handler: async (batch) => {
      const vectors = await embeddingModel.embedBatch(batch.map(d => d.text), { model: to });
      await vectorDb.upsert(`documents_${to}`, batch.map((d, i) => ({
        id: d.chunkId,
        embedding: vectors[i],
        payload: { ...d.payload, modelId: to, modelVersion: 2 },
      })));
    },
  });

  await vectorDb.setAlias("documents_live", `documents_${to}`);
}
```

### Cost of a re-embedding

```text
documents × chunks × tokens per chunk = total tokens
total tokens / 1,000,000 × price per million = API cost
```

For 5 million documents × 4 chunks × 400 tokens = 8 billion tokens. At a hypothetical USD 0.02 per million tokens, that is **USD 160** in embedding cost — usually far cheaper than the engineering time, but the **backfill duration** and **double storage** are the real constraints.

---

## 8.5 Sharding, Replication, and Multi-Tenancy

### Sharding

When the index no longer fits on one node, split it:

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **Hash by ID** | `shard = hash(id) % S` | Even distribution | Query must hit all shards |
| **Tenant-based** | One shard per large tenant | Isolation, locality | Skew for small tenants |
| **Semantic / cluster** | Route by nearest centroid | Fewer shards per query | Rebalancing complexity |
| **Time-based** | Recent vs archive shards | Cheap archival | Cross-shard queries |

For hash sharding, every query fans out to all shards, each returning top-K, then a coordinator merges:

```text
Query → shard 1 → top K
      → shard 2 → top K
      → ...
      → merge + rerank → final top K
```

```mermaid
flowchart LR
    Q["Query"] --> S1["Shard 1<br/>top K"]
    Q --> S2["Shard 2<br/>top K"]
    Q --> S3["Shard 3<br/>top K"]
    S1 --> M["Coordinator<br/>merge + rescore"]
    S2 --> M
    S3 --> M
    M --> R["Final top K"]

    style M fill:#cba6f7,color:#1e1e2e
    style R fill:#a6e3a1,color:#1e1e2e
```

> **Tail latency warning:** fan-out latency is determined by the **slowest shard**. With 20 shards, p99 of the query is roughly the p99.95 of a single shard. Keep shards balanced and use hedged requests if latency matters.

### Replication

| Purpose | Mechanism |
|---|---|
| Read throughput | Read replicas |
| High availability | Leader + followers, automatic failover |
| Disaster recovery | Cross-region snapshots |
| Zero-downtime rebuild | Build a new index alongside the old |

### Multi-tenancy

| Model | Isolation | Cost | Use when |
|---|---|---|---|
| Collection per tenant | Strongest | Highest | Few large enterprise tenants |
| Namespace / partition | Strong logical | Medium | Many tenants, shared infra |
| Payload `tenantId` filter | Logical only | Lowest | Very high tenant count |

Whatever you choose, **tenant filtering must happen inside the query**, and it must be tested with adversarial cases. A missing filter is a data breach, not a relevance bug.

---

## 8.6 Evaluation: How Do You Know It Works?

Vector search quality cannot be judged by eyeballing a few results. You need a repeatable evaluation harness.

### Offline metrics

| Metric | Definition | Use |
|---|---|---|
| **Recall@K** | Fraction of true top-K returned | Index tuning, ANN quality |
| **Precision@K** | Fraction of returned items that are relevant | Result quality |
| **MRR** | Mean reciprocal rank of first relevant result | Ranking quality |
| **nDCG@K** | Graded relevance, discounted by position | Search ranking |
| **Coverage** | Fraction of queries with at least one good result | Recall of the system |

```text
recall@K    = |returned ∩ relevant| / |relevant|
precision@K = |returned ∩ relevant| / K
MRR         = average(1 / rank_of_first_relevant)
```

### Online metrics

| Metric | What it tells you |
|---|---|
| CTR / click-through | Whether results attract attention |
| Conversion / task success | Whether search achieves the goal |
| Zero-result rate | Queries the index cannot serve |
| Query reformulation rate | Users not finding what they want |
| p50 / p95 / p99 latency | User-perceived speed |
| Freshness lag | Time from source write to searchable |
| Empty-after-filter rate | Filtering is too aggressive |

### Building a golden set

```text
1. Sample 500–2,000 real queries (stratified by frequency).
2. Label the truly relevant items for each (human or LLM-assisted, audited).
3. Freeze the set and version it.
4. Run every index/model change against it.
5. Track recall@10 and nDCG@10 over time.
```

```ts
// Pseudo-code: offline evaluation report
interface EvalCase {
  query: string;
  relevantIds: string[];
}

async function evaluate(cases: EvalCase[], retriever: Retriever): Promise<Report> {
  let recallSum = 0;
  let mrrSum = 0;
  let latencySum = 0;

  for (const testCase of cases) {
    const started = performance.now();
    const results = await retriever.search(testCase.query, 10);
    latencySum += performance.now() - started;

    const returned = results.map(r => r.id);
    const hits = returned.filter(id => testCase.relevantIds.includes(id));
    recallSum += hits.length / testCase.relevantIds.length;

    const firstHit = returned.findIndex(id => testCase.relevantIds.includes(id));
    mrrSum += firstHit >= 0 ? 1 / (firstHit + 1) : 0;
  }

  return {
    recallAt10: recallSum / cases.length,
    mrr: mrrSum / cases.length,
    avgLatencyMs: latencySum / cases.length,
  };
}
```

> **Evaluate retrieval and generation separately.** In a RAG system, a bad answer can come from bad retrieval or a bad LLM. Measure `recall@K` first; only then blame the model.

---

## 8.7 Caching and Cost Optimization

Vector search has several expensive stages, and each can be cached at a different level.

| Cache | Key | Hit saves | Invalidation |
|---|---|---|---|
| **Query embedding cache** | hash(normalized query + model) | 20–40 ms + API cost | Model version change |
| **Result cache** | hash(query + filters + k + index version) | Entire search | Index update, permission change |
| **Semantic cache** | nearest cached query above threshold | Full pipeline incl. LLM | High risk; needs guardrails |
| **Payload cache** | document ID | DB round-trip | Content update |
| **Warm popular results** | top-N trending queries | Compute per request | Periodic refresh |

```mermaid
flowchart LR
    Q["User query"] --> E{"Embedding cached?"}
    E -->|"Yes"| EV["Reuse vector"]
    E -->|"No"| EM["Embedding API"]
    EM --> EV
    EV --> R{"Result cached?"}
    R -->|"Yes"| OUT["Return cached results"]
    R -->|"No"| S["Vector search + rank"]
    S --> W["Write cache with TTL"]
    W --> OUT

    style E fill:#89b4fa,color:#1e1e2e
    style R fill:#89b4fa,color:#1e1e2e
    style OUT fill:#a6e3a1,color:#1e1e2e
```

### Semantic cache warning

A semantic cache returns the answer to a *similar* query. It can be a large win for FAQs and a subtle source of wrong answers for personalized or time-sensitive queries.

```text
Safe:     "What is your refund policy?"
Unsafe:   "What is my order status?"      (per-user)
Unsafe:   "What is the stock price?"      (time-sensitive)
Unsafe:   anything with authorization-scoped results
```

Rule: **never semantically cache results that depend on user identity, permissions, or fresh data** unless the cache key includes all of those dimensions.

### Cost levers, ordered by impact

1. **Reduce vector count** — better chunking, deduplication, fewer redundant chunks.
2. **Quantize** — int8 or PQ cuts memory 4×–32×.
3. **Cache embeddings** — repeated queries are common in production.
4. **Use smaller embedding models** where quality allows (384 vs 1536 dimensions).
5. **Reduce `efSearch`** to the lowest value that meets recall targets.
6. **Batch ingestion** to reduce embedding API overhead.
7. **Archive cold data** to a separate, cheaper index.

---

## 8.8 Security, Privacy, and Compliance

Vector search introduces unusual security risks because embeddings can leak information and filters control access.

| Risk | Description | Mitigation |
|---|---|---|
| **Cross-tenant retrieval** | Missing tenant filter returns another customer's data | Enforce tenant filter in a shared query builder; test adversarially |
| **ACL post-filtering** | Result counts reveal inaccessible documents | Filter inside the query |
| **Embedding inversion** | Embeddings can partially reconstruct source text | Treat embeddings as sensitive data; encrypt at rest |
| **PII in payload** | Metadata stores emails, phone numbers | Minimize payload; tokenize or hash |
| **Prompt injection via retrieved text** | Malicious document instructs the LLM | Delimit retrieved content; instruct the model to treat it as data |
| **Model provider data retention** | Query text sent to an external API | Use a zero-retention endpoint or self-hosted model |
| **Index poisoning** | Attacker inserts content to manipulate results | Validate ingestion sources; sign documents; monitor anomalies |

> **Security invariant:** authorization is a **query constraint**, never a presentation-layer filter. If the vector database returns a document to your application, your application must be allowed to see it.

### Data residency

Embeddings are derived from content. If content is regulated, its embeddings usually are too. Plan for:

- region-pinned collections,
- separate indexes per jurisdiction,
- deletion propagation (source delete → vector delete → backup expiry),
- audit logs for retrieval of sensitive collections.

---

## 8.9 Technology Landscape

| Option | Type | Strengths | Watch-outs |
|---|---|---|---|
| **pgvector** | Postgres extension | ACID, joins, familiar ops, HNSW/IVFFlat | Scaling beyond a few million; index build memory |
| **Pinecone** | Managed SaaS | Zero ops, serverless, metadata filters | Vendor lock-in, cost at scale |
| **Qdrant** | Open source / cloud | Strong filtering, payload indexes, Rust performance | Operational ownership if self-hosted |
| **Weaviate** | Open source / cloud | Hybrid search, modules, GraphQL | Complexity, resource usage |
| **Milvus** | Open source / cloud | Billion-scale, many index types | Heavy infrastructure (etcd, object storage) |
| **FAISS** | Library | Fastest research-grade indexes, full control | Not a database: no persistence, auth, or filtering |
| **Chroma** | Lightweight DB | Great DX for prototypes | Not built for large-scale production |
| **OpenSearch / Elasticsearch** | Search engine | BM25 + kNN + aggregations in one system | Vector performance trails dedicated DBs |
| **Redis** | In-memory store | Sub-millisecond, good for caching + small indexes | Memory cost; persistence trade-offs |
| **LanceDB** | Embedded columnar | Local/embedded, versioned datasets | Smaller ecosystem |

### Decision framework

```mermaid
flowchart TD
    A["Start"] --> B{"Already on Postgres<br/>and under ~5M vectors?"}
    B -->|"Yes"| C["pgvector"]
    B -->|"No"| D{"Need managed<br/>zero-ops?"}
    D -->|"Yes"| E["Pinecone / Qdrant Cloud /<br/>Weaviate Cloud"]
    D -->|"No"| F{"Billion scale or<br/>custom research?"}
    F -->|"Yes"| G["Milvus / FAISS / DiskANN"]
    F -->|"No"| H["Qdrant / Weaviate / OpenSearch"]
    C --> I["Measure recall + p95<br/>before committing"]
    E --> I
    G --> I
    H --> I

    style C fill:#a6e3a1,color:#1e1e2e
    style E fill:#89b4fa,color:#1e1e2e
    style G fill:#f9e2af,color:#1e1e2e
    style I fill:#cba6f7,color:#1e1e2e
```

> **Vendor selection rule:** benchmark with **your** embeddings, **your** filters, and **your** query distribution. Public benchmarks use different data and rarely include filtered search, which is where most systems actually fail.

---

## 8.10 Failure Modes and Runbook

| Symptom | Probable cause | First checks | Fix |
|---|---|---|---|
| Zero results | Filters too strict, empty collection | `count()`, filter selectivity | Relax filters; verify ingestion |
| Sudden relevance drop | Model mismatch or bad deploy | `modelVersion` in payload, recent config diff | Roll back alias |
| Latency spike | Index rebuild, memory pressure, huge filter | p95 by stage, node memory, `efSearch` | Scale out, reduce candidates |
| Memory OOM | float32 + graph + replicas | bytes/vector × count | Quantize, shard, add RAM |
| Stale results | CDC lag or failed consumer | queue depth, consumer lag | Replay events, reconcile |
| Duplicates | Non-deterministic chunk IDs | ID generation logic | Deterministic IDs + dedupe |
| Deleted docs still appear | Tombstone not filtered | delete pipeline, cache TTL | Fix delete propagation |
| Cross-tenant leak | Missing filter in one code path | audit query builder | Enforce centrally, add tests |

### Runbook: relevance regression

```text
1. Confirm the regression is real: run the golden set, compare recall@10.
2. Check whether the embedding model or index alias changed.
3. Compare ANN results against exact search for 50 queries.
4. Inspect filter selectivity and empty-after-filter rate.
5. Roll back the alias or config if the cause is a deploy.
6. Add the failing queries to the golden set.
```

### Runbook: latency regression

```text
1. Break down p95 by stage: embed, ANN, filter, rescore, rerank.
2. If embed: check cache hit rate and provider status.
3. If ANN: check efSearch/nprobe changes, segment count, memory pressure.
4. If filter: check for low-selectivity filters forcing a scan.
5. If rescore/rerank: check candidate count explosion.
6. Add a load test that reproduces the traffic shape.
```

---

## 8.11 Production Checklist

### Data and indexing

- [ ] Deterministic chunk IDs (idempotent upserts)
- [ ] Chunk size and overlap chosen and documented
- [ ] Deletes propagated (including orphaned chunks)
- [ ] Source of truth can rebuild the entire index
- [ ] `modelId`, `modelVersion`, `updatedAt` stored in payload
- [ ] Incremental re-indexing for changed content
- [ ] Reconciliation job for dual-write drift

### Index and query

- [ ] Metric matches the embedding model
- [ ] Dimensions fixed and validated at write time
- [ ] ANN parameters tuned against exact recall
- [ ] `efSearch >= K` enforced
- [ ] Filtering strategy chosen (pre / filtered ANN / post)
- [ ] Two-stage retrieval with exact rescoring
- [ ] Query embedding cache with model-version key

### Operations

- [ ] p50/p95/p99 latency dashboards
- [ ] Recall@K tracked on a versioned golden set
- [ ] Queue lag and freshness lag alerts
- [ ] Memory and disk alerts
- [ ] Snapshot and restore tested
- [ ] Zero-downtime reindex procedure documented
- [ ] Rollback plan for model and index changes

### Security

- [ ] Tenant/ACL filters inside the query
- [ ] Adversarial tests for cross-tenant leakage
- [ ] Embeddings treated as sensitive data
- [ ] PII minimized in payloads
- [ ] Retrieved content delimited against prompt injection
- [ ] Provider data-retention policy reviewed
- [ ] Audit logging for sensitive collections

---

## 8.12 The Lecture in Twenty Takeaways

1. **Toy search is exact and linear.** 30 vectors is not a scale test.
2. **Storage and search are different problems.** Solve them separately.
3. **Relational databases can store vectors.** They cannot index similarity with a B-tree.
4. **Traditional queries ask "does it match?"** Vector queries ask "how close is it?"
5. **An embedding model understands meaning.** A vector database only handles coordinates.
6. **A vector record is ID + vector + metadata.** Everything else is production detail.
7. **The metric is part of the schema.** Use it consistently at build and query time.
8. **Brute force is the correct baseline.** `O(N × D)` per query, 100% recall.
9. **10M × 1536 = 15.36 billion operations.** For a single query.
10. **Storage math is unforgiving.** 6 KB per vector, 6 GB per million, 600 GB per 100M.
11. **Memory bandwidth often beats CPU as the bottleneck.**
12. **Indexes work by proving regions irrelevant.** Order enables proof; geometry enables it only in low dimensions.
13. **A B-tree needs a total order.** Vectors do not have one.
14. **A k-d tree splits one axis at a time.** It prunes beautifully in 2D and fails in 1536D.
15. **The curse of dimensionality is gradual.** More dimensions → more boundaries → fewer safe prunes.
16. **Distance concentration destroys pruning margins.** Nearest and farthest become similar.
17. **Sub-linear search requires approximation.** IVF, HNSW, PQ, LSH bet on data structure.
18. **Recall is the quality metric for ANN.** Measure it against exact search, always.
19. **Two-stage retrieval is the production pattern.** Cheap candidates, exact rescoring, business ranking.
20. **The index is a derived artifact.** Design it to be rebuilt, versioned, and rolled back.

---

## 8.13 Exercises

1. **Cost estimation.** A catalogue has 40 million products, 2 vectors each, 768 dimensions, float32. Compute raw vector bytes, bytes with int8, and a provisioned RAM estimate with 2 replicas and 1.5× headroom.

2. **Metric check.** A team stores normalized embeddings but builds the index with L2 and queries with cosine. Explain why results may still look reasonable, and why this is still a bug waiting to surface.

3. **KNN by hand.** For `Q = [1, 1]` and points `A = [0, 0]`, `B = [2, 2]`, `C = [1, 3]`, compute L2 distance and cosine similarity, then rank for each metric. Do the rankings agree?

4. **k-d tree.** Insert `[5,4]`, `[2,7]`, `[8,1]`, `[1,2]`, `[9,6]`, `[3,3]` alternating axes. Search for `[6,5]` and list every node visited. Then count how many nodes a brute-force scan would inspect.

5. **Pruning proof.** Prove that if `planeDistance >= bestDistance`, no point on the far side of an axis-aligned splitting plane can be strictly closer than `bestDistance`.

6. **IVF sizing.** For `N = 8,000,000`, choose `nlist` and `nprobe` to scan about 2% of the data. Estimate the number of centroid comparisons per query.

7. **Recall measurement.** Design an experiment to compare HNSW `efSearch = 40` vs `efSearch = 200` on 500 real queries. Specify the ground truth, metrics, and acceptance criteria.

8. **Filtering bug.** A query uses `k = 10` and a filter matching 0.5% of the corpus. Post-filtering returns 2 results. Explain why, and propose two fixes with their trade-offs.

9. **Freshness design.** A support chatbot must reflect edited help articles within 60 seconds. Sketch the ingestion pipeline and identify the two most likely sources of staleness.

10. **Model migration.** Plan a zero-downtime move from a 768-dimension model to a 1536-dimension model for 30 million chunks. Include storage, backfill, shadow evaluation, alias switch, and rollback.

---

## 8.14 Chapter Summary

| Area | Key decision |
|---|---|
| Architecture | Source of truth → CDC/queue → embed → index → retrieve → rerank |
| Capacity | Size for vectors + index + payload + headroom; replicate for QPS |
| Freshness | Batch, CDC, or event-driven depending on the product promise |
| Model changes | New collection, batched backfill, shadow eval, alias swap, rollback |
| Scale | Shard by hash/tenant, replicate for reads, fan-out with tail-latency care |
| Quality | Golden set, recall@K, MRR/nDCG, online CTR and zero-result rate |
| Cost | Fewer vectors, quantization, embedding cache, tuned `efSearch` |
| Security | Tenant/ACL filters inside the query; embeddings are sensitive data |
| Tooling | pgvector for simple, dedicated DB for scale, FAISS for research |

> **Final mental model of Lecture 09:**
>
> A vector database is not an "AI database". It is an ordinary database whose index is geometric.
>
> Exact search is simple, correct, and linear: `N × D` work per query. At scale that bill is too large.
>
> The natural fix — a tree that prunes space — works in 2D and 3D, then collapses under the curse of dimensionality. Not because the code is wrong, but because high-dimensional geometry stops allowing safe pruning.
>
> So we make a deliberate bargain: search a small part of the data, return results that are *almost always* the true nearest neighbours, and **measure the difference**. That measurement is recall. That bargain is ANN.
>
> **REPRESENT → STORE → INDEX → RETRIEVE → RERANK → MEASURE.**

---

## 8.15 Where This Leads

| Next topic | Why it follows naturally |
|---|---|
| **RAG** | Retrieval is the "R"; this lecture builds the retrieval layer |
| **Hybrid search** | Lexical + vector fusion for exact tokens and paraphrases |
| **Reranking** | Cross-encoders and LLMs improve the top of the ranking |
| **Vector DB operations** | Backups, upgrades, cost governance, multi-region |
| **Evaluation engineering** | Golden sets, human labels, online experiments |
| **Multi-modal retrieval** | CLIP-style shared spaces for image, audio, and video |

---

**End of Lecture 09 — Vector Embedding Search & Storage.**

Back to the [Lecture 09 Index](./README.md).
