# Lecture 12 — Advanced RAG (Basic Code)

> **The minimum code behind the notes, in a conventional layered structure.**
> One small, offline, no-API-key TypeScript project that makes each of Lecture
> 12's eight retrieval controls visible: chunking + overlap, top-K, the
> similarity floor, metadata / ACL / time filters, hybrid search with RRF,
> reranking, context engineering — and a small evaluation that measures them one
> at a time. Served over HTTP **and** from a CLI, from one domain layer.

**Runs offline.** The embedder is a deterministic token-hash vector and the
generator is extractive, so every number below reproduces on any machine. Swap in
a real embedding model or an LLM and nothing else in the code changes.

```bash
cd "Lecture 12/code/Basic Code"
npm install          # express, cors, dotenv + tsx / typescript

# ── the HTTP API ────────────────────────────────────────────
npm run dev          # http://localhost:3100

curl localhost:3100/health
curl -X POST localhost:3100/ask -H 'content-type: application/json' \
     -d '{"question":"Can I return my damaged headphones after 10 days?"}'

# ── the chapter CLI ─────────────────────────────────────────
npm run ask        # Chapters 11–12 — the whole pipeline, ending in an answer
npm run search     # Chapters 09–10 — the same pipeline, stage by stage
npm run chunks     # Chapters 06–07 — fixed vs structural chunking, overlap maths
npm run filters    # Chapter 08 — eligibility, access control and `asOf`
npm run eval       # Chapter 14 — per-case retrieval and generation metrics
npm run ablation   # Chapter 14 — one control at a time
npm run typecheck  # tsc --noEmit
```

Pass your own question to any CLI command:

```bash
npm run ask -- "Does the AX-204 wireless headphone support fast charging?"
npm run search -- "Who won the Indian Premier League in 2026?"
```

---

## The HTTP API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | liveness + the controls that produced the last answer |
| `GET` | `/filters` | — | four eligibility scenarios (the bug, fail-closed, `asOf`) |
| `GET` | `/eval` | — | the golden set: metrics + per-case results |
| `GET` | `/ablation` | — | the preset table |
| `POST` | `/search` | `{ "question": "…" }` | the trace: dense · lexical · fused · reranked · gate · timings |
| `POST` | `/ask` | `{ "question": "…" }` | the answer, citations, refusal flag, sources and the prompt |

**What the API deliberately does not accept:** a tenant, an ACL or an `asOf`
date. Those come from configuration, which is what makes Chapter 05's IDOR case
impossible over HTTP. A body that is not `{ question: string }` is a `400`.

---

## What it measures

```text
preset       chunks  recall  prec   mrr    refusal  ctx tok
naive        12      1.000   0.500  0.750  1.000    327
structural   19      1.000   0.600  0.833  1.000    250
hybrid       19      1.000   0.600  0.833  1.000    250
rerank       19      1.000   0.650  0.833  1.000    214
full         19      1.000   0.650  0.833  1.000    214
```

Read it honestly, because that is Chapter 09's lesson:

- **Chunking is the biggest single win.** Structural chunks raise context
  precision 0.50 → 0.60, raise MRR 0.750 → 0.833 and *cut the prompt from 327 to
  250 tokens* — better answers for less money.
- **Reranking buys precision, not recall.** 0.60 → 0.65 and another 36 tokens
  off the prompt, while the candidate set is untouched — exactly Chapter 07's
  "reranking changes the ordering; it does not create information".
- **Hybrid search does not move this table.** On a 7-document corpus BM25 adds
  no new candidates. It shows its value on the *SKU* question, where dense
  search confuses the AX-204 with the BX-900 — try
  `npm run search -- "Does the AX-204 wireless headphone support fast charging?"`.
- **Recall is saturated at 1.000.** A metric that cannot move tells you nothing;
  that is why context precision, MRR and context tokens are on the same row.

`npm run eval` adds the answer-level view: recall 1.000, context precision 0.65,
MRR 0.833, refusal 1.000, 214 context tokens per question.

---

## Layout

```text
Basic Code/
├── .env                    # the eight controls + PORT (gitignored; see .env.example)
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts                      # server entry — binds the app to PORT
    ├── app.ts                        # the Express app: middleware → routes → failure path
    ├── cli.ts                        # the chapter CLI (one command per chapter)
    ├── config/
    │   └── config.ts                 # every control in one typed object
    ├── models/
    │   └── types.ts                  # every data contract (no imports)
    ├── utils/
    │   └── hash.ts                   # FNV-1a: chunk ids + embedder buckets
    ├── middleware/
    │   └── errorHandler.ts           # 404 + the single error handler
    ├── routes/
    │   └── index.ts                  # the route table
    ├── controllers/
    │   └── ragController.ts          # request → service → response
    └── services/
        ├── documents.ts              # the 7-document corpus + metadata
        ├── chunking.ts               # fixed + structural chunking, ids, breadcrumbs
        ├── embeddings.ts             # the offline embedder and the analyzer
        ├── store.ts                  # the index and the eligibility filter
        ├── search.ts                 # dense, BM25, RRF
        ├── rerank.ts                 # the joint reranker and its gate
        ├── context.ts                # assemble: dedupe, order, label, budget, frame
        ├── generate.ts               # grounded answer or refusal
        ├── index.ts                  # the pipeline that produces the trace
        └── eval.ts                   # golden set, metrics, ablation presets
```

20 TypeScript files, ~950 lines including comments.

### Layer by layer

| Layer | Folder / file | Owns | May import |
|---|---|---|---|
| contracts | `models/` | the shapes every other layer speaks in | **nothing** |
| helpers | `utils/` | pure functions with no domain knowledge | nothing |
| configuration | `config/` | the eight controls, read once from `.env` | nothing |
| domain | `services/` | the eight retrieval controls | models, utils, config |
| HTTP in | `controllers/` | request → one service → response | services, models, config |
| binding | `routes/` | path + method → controller | controllers |
| failure path | `middleware/` | the 404 and the single error handler | models |
| composition | `app.ts` | wires middleware + routes + failure path | routes, middleware |
| entries | `index.ts`, `cli.ts` | the two doors into the domain | everything above |

The arrows only ever point **down that table**. `services/` knows nothing about
Express, and `controllers/` contains no retrieval logic — which is why the CLI
and the HTTP API cannot drift apart: they call the same functions.

---

## Chapter map

| Guide chapter | File | Notes chapter |
| :--- | :--- | :--- |
| [00 — Overview & file map](./implementations%20guide/README.md) | everything | all |
| [01 — Project structure & file map](./implementations%20guide/01_Project_Structure_and_File_Map.md) | `package.json`, `tsconfig.json`, `.env`, the folder map | all |
| [02 — Config: the eight controls](./implementations%20guide/02_Config_The_Eight_Controls.md) | `config/config.ts` | 02–08 |
| [03 — The corpus](./implementations%20guide/03_The_Corpus.md) | `services/documents.ts` | 01, 05 |
| [04 — Chunking: fixed, overlap, structural](./implementations%20guide/04_Chunking_Fixed_Overlap_Structural.md) | `services/chunking.ts` | 02, 03 |
| [05 — Embeddings and the analyzer](./implementations%20guide/05_Embeddings_and_the_Analyzer.md) | `services/embeddings.ts` | 03, 06 |
| [06 — The index and the eligibility filter](./implementations%20guide/06_The_Index_and_the_Eligibility_Filter.md) | `services/store.ts` | 04, 05 |
| [07 — Dense, BM25 and RRF](./implementations%20guide/07_Dense_BM25_and_RRF.md) | `services/search.ts` | 04, 06 |
| [08 — Reranking and the gate](./implementations%20guide/08_Reranking_and_the_Gate.md) | `services/rerank.ts` | 07 |
| [09 — Context engineering](./implementations%20guide/09_Context_Engineering.md) | `services/context.ts` | 08 |
| [10 — Grounded answer or refusal](./implementations%20guide/10_Grounded_Answer_or_Refusal.md) | `services/generate.ts` | 08 |
| [11 — The pipeline](./implementations%20guide/11_The_Pipeline.md) | `services/index.ts` | 01–08 |
| [12 — Evaluation and ablation](./implementations%20guide/12_Evaluation_and_Ablation.md) | `services/eval.ts` | 09 |
| [13 — The CLI](./implementations%20guide/13_The_CLI.md) | `cli.ts` | all |
| [14 — Models: every contract in one file](./implementations%20guide/14_Models_Every_Contract.md) | `models/types.ts` | all |
| [15 — Utils: one hash, two uses](./implementations%20guide/15_Utils_One_Hash_Two_Uses.md) | `utils/hash.ts` | 02, 06 |
| [16 — The controller](./implementations%20guide/16_The_Controller.md) | `controllers/ragController.ts` | all |
| [17 — The routes](./implementations%20guide/17_The_Routes.md) | `routes/index.ts` | all |
| [18 — Middleware: the failure path](./implementations%20guide/18_Middleware_The_Failure_Path.md) | `middleware/errorHandler.ts` | all |
| [19 — The app and the server entry](./implementations%20guide/19_The_App_and_the_Server_Entry.md) | `app.ts`, `index.ts` | all |


---

## Honest limits

- **The corpus is seven short documents.** It is the lecture's running example
  plus the documents that make hybrid search, `asOf` and ACLs visible — not a
  retrieval benchmark. Recall is therefore saturated at 1.000.
- **Chunk size is 40 tokens, not 400.** Real settings are 400–600 tokens
  (Chapter 02). The corpus is tiny, so the size is scaled down until the cuts
  are visible on screen.
- **The embedder is lexical, not semantic.** It hashes tokens, so it handles
  morphology and exact terms but not paraphrase. Every number above is a lower
  bound on what the same pipeline does with a real embedding model.
- **The reranker is a joint lexical scorer, not a cross-encoder.** It reads the
  query and the chunk together (coverage, phrase, heading) — enough to
  demonstrate the stage and its gate, not enough to replace `bge-reranker`.
- **The generator quotes sentences; it does not reason.** It cannot conclude
  that 10 days is past a 7-day window. That is why the answer to the running
  example is *evidence*, not *"No"* — and it is exactly the failure Chapter 09's
  diagnostic tree calls `generation-miss`.
- **The store is in memory.** It implements pre-filtering so the difference is
  demonstrable, not so it can hold a corpus.

**Next:** [Implementation guide](./implementations%20guide/README.md) ·
[Lecture 12 notes](../../notes/README.md)

