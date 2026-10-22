# Lecture 12 — Advanced RAG (TypeScript)

> **The code behind the notes.** A small, framework-free Advanced RAG system that makes
> every control in Lecture 12 measurable: chunking, top-K, score floors, metadata and
> access filters, hybrid search with RRF, reranking, context assembly and evaluation.

**Runs with no API key.** The offline `hash` embedder and the extractive generator are
deterministic, so `npm run baseline` and `npm run ablation` reproduce the numbers in the
guide on any machine. Set `OPENAI_API_KEY` and the same code calls real embeddings and a
real model; set `COHERE_API_KEY` and the reranker becomes a real cross-encoder.

```bash
cd "Lecture 12/code/advanced-rag"
npm install

npm run baseline     # the naive pipeline: 8 of 14 cases fail, each with a named stage
npm run chunks       # fixed vs structural vs semantic, measured on the same 8 documents
npm run search -- "What is the return window for your headphones?"
npm run ask -- "Is the AX-204 still covered after 18 months?"
npm run calibrate    # sweeps both score floors against the golden set
npm run filters      # tenant, ACL, temporal and pre/post-filter behaviour
npm run ablation     # one control at a time, same questions
npm run eval -- full # per-case scores for one preset
npm run dev          # HTTP API on :3100
```

---

## What it measures

```
preset      chunks  recall  mrr    ndcg   refusal  falseRef  ctx tok  p50
naive       31      0.571   0.399  0.442  0.000    0.000     725      4ms
structural  27      0.643   0.488  0.528  1.000    0.167     348      2ms
hybrid      27      0.750   0.548  0.595  0.000    0.000     756      4ms
rerank      27      0.821   0.586  0.640  1.000    0.000     566      7ms
full        27      0.821   0.586  0.640  1.000    0.000     865      10ms
full-wide   27      0.821   0.586  0.640  1.000    0.000     918      13ms
```

Read it as: chunking raises recall and halves the context; hybrid search buys the next
seven points of recall but stops refusing anything; the reranker buys the rest of the
recall *and* restores refusal at a lower token cost. Parent expansion adds context tokens
and nothing else on a corpus this small — which is a result, not a failure.

`npm run eval` adds the answer-level view: recall 0.821, MRR 0.586, nDCG 0.640, facts
0.583, refusal 1.000.

---

## Layout

```
advanced-rag/
├── data/
│   ├── policies/           8 markdown policies with front-matter metadata
│   └── eval/golden.json    14 questions: expected sources, required facts, asOf date
└── src/
    ├── types.ts            every data contract in one file
    ├── config/env.ts       validated config; the ablation copies it
    ├── lib/                text + vector maths (tokenizer, stemming, cosine, blend)
    ├── embeddings.ts       hash (offline) | openai, behind one interface
    ├── ingest/             loader → fixed/structural/semantic chunker → context → index
    ├── store/              filter DSL, ACL/temporal rules, in-memory vector store
    ├── search/             dense + MMR, BM25, RRF, reranker + gate, calibration
    ├── context/assemble.ts parents, dedupe, precedence, budget, bookending, labels
    ├── generate.ts         grounded prompt, extractive + OpenAI generators, citations
    ├── pipeline.ts         the orchestrator that produces the trace
    ├── eval/               metrics, the failure tree, golden-set runner, ablation presets
    ├── cli.ts              one subcommand per chapter
    └── server.ts           Express API: /health, /search, /ask
```

26 TypeScript files, ~4,200 lines including comments.


---

## Chapter map

| Guide chapter | Code | Notes |
| :--- | :--- | :--- |
| [00 — Overview, structure & file map](../implementations%20guide/00_Overview_Provider_Structure_and_File_Map.md) | everything | all |
| [01 — Contracts, config, loader, and the broken baseline](../implementations%20guide/01_Contracts_Config_and_Loader.md) | `types.ts`, `config/env.ts`, `lib/`, `ingest/loader.ts` | 01 |
| [02 — Fixed-size chunking and overlap](../implementations%20guide/02_Fixed_Size_Chunking_and_Overlap.md) | `ingest/fixed-chunker.ts` | 02 |
| [03 — Structural, semantic and contextual chunking](../implementations%20guide/03_Structural_Semantic_and_Contextual_Chunking.md) | `ingest/structural-chunker.ts`, `semantic-chunker.ts`, `context.ts` | 03 |
| [04 — Indexing: embeddings and the vector store](../implementations%20guide/04_Indexing_Embeddings_and_the_Vector_Store.md) | `embeddings.ts`, `ingest/indexer.ts`, `store/vector-store.ts` | 02, 03 |
| [05 — Top-K, thresholds and calibration](../implementations%20guide/05_TopK_Thresholds_and_Calibration.md) | `search/dense.ts`, `search/calibrate.ts` | 04 |
| [06 — Metadata filters, ACL and time](../implementations%20guide/06_Metadata_Filters_ACL_and_Time.md) | `store/filters.ts` | 05 |
| [07 — Hybrid search and RRF](../implementations%20guide/07_Hybrid_Search_and_RRF.md) | `search/bm25.ts`, `search/hybrid.ts` | 06 |
| [08 — Reranking and two-stage retrieval](../implementations%20guide/08_Reranking_Two_Stage_Retrieval.md) | `search/rerank.ts` | 07 |
| [09 — Context engineering](../implementations%20guide/09_Context_Engineering.md) | `context/assemble.ts`, `generate.ts` | 08 |
| [10 — Evaluation, ablation and the API](../implementations%20guide/10_Evaluation_Ablation_and_the_API.md) | `eval/`, `pipeline.ts`, `cli.ts`, `server.ts` | 09 |

---

## Honest limits

- **The offline embedder is lexical, not semantic.** It hashes words, stems and character
  4-grams, so it handles morphology but not paraphrase. A question that shares no
  vocabulary with the corpus is only findable through BM25 or a real embedding model.
  Every number above is therefore a *lower bound* on what the same pipeline does with
  `EMBEDDING_PROVIDER=openai`.
- **The reranker is a joint lexical scorer, not a cross-encoder.** It scores query and
  chunk together (coverage, heading, phrase, proximity — all IDF-weighted), which is
  enough to demonstrate the stage and to earn its keep in the ablation, but a real
  cross-encoder is better. Set `RERANK=cohere`.
- **The extractive generator quotes sentences; it does not reason.** It cannot conclude
  that 10 days is past a 7-day window. That is why `eval` reports `facts 0.583` while
  `refusal` is 1.000, and why the failure tree calls those cases `generation-miss`.
- **The store is in memory.** It implements pre- and post-filtering so the difference is
  demonstrable, not so it can hold a corpus.
