# Lecture 12 — Basic Code · Implementation Guide

> **A chapter-wise, order-wise walkthrough of the `Basic Code` project.**
> Every chapter covers **one source file**: what it is for, the commands you
> need, the **complete file** verbatim, and then a **block-by-block**
> explanation of what each block does and *how* it works. Read the chapters in
> order — each one builds on the previous file.

This guide explains the runnable code behind the lecture notes
([`../../../notes`](../../../notes/README.md)). The notes explain *why* advanced
RAG exists and which control fixes which failure; this guide explains *how the
code is built*, one file at a time.

---

## What this project is

A single, offline, **no-API-key** TypeScript implementation of the eight
retrieval controls from Lecture 12, arranged as a **conventional layered
service**: contracts, helpers and configuration at the bottom; the domain
pipeline in the middle; an HTTP layer on top. 20 source files — small enough to
read in an evening, complete enough to be shaped like real code.

```text
  ┌── entries ───────────────────────────────────────────────────────────────┐
  │  index.ts  (HTTP server)                      cli.ts  (chapter commands) │
  └───────┬──────────────────────────────────────────────────────────┬───────┘
          ▼                                                          ▼
  ┌── app.ts ─ middleware/ ─ routes/ ─ controllers/ragController.ts ─────────┐
  │  cors · json · 404 · error handler    route table    request → service   │
  └───────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
  ┌── services/ ─────────────────────────────────────────────────────────────┐
  │  store.ts ──▶ search.ts ──▶ rerank.ts ──▶ context.ts ──▶ generate.ts     │
  │  filter+index  dense+BM25+RRF  gate+order   assemble      answer/refuse  │
  │      ▲               ▲                                                   │
  │  chunking.ts ──▶ embeddings.ts                        eval.ts            │
  │                    ▲                                     │              │
  │              utils/hash.ts        models/types.ts   config/config.ts     │
  └──────────────────────────────────────────────────────────────────────────┘
```

- **Everything is one question.** The lecture's running example — *"Can I return
  my damaged headphones after 10 days?"* — travels through every file, so the
  effect of each control is visible on the same input.
- **There is no LLM and no API key.** The embedder hashes tokens; the generator
  quotes sentences. That is what makes the output reproducible.
- **Two doors, one domain.** The CLI (`cli.ts`) and the HTTP API
  (`controllers/`) call the same service functions, so neither can drift.

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | `>= 20.0.0` | `package.json` sets `engines.node`; the code uses modern ESM |
| **npm** | any recent | installs dependencies and runs the scripts |

No API key, no network, no database. Everything runs locally.

---

## Quickstart

```bash
cd "Lecture 12/code/Basic Code"

npm install        # express, cors, dotenv + tsx / typescript
npm run typecheck  # tsc --noEmit — should print nothing and exit 0

# the HTTP API (chapters 15–19)
npm run dev        # http://localhost:3100
curl -X POST localhost:3100/ask -H 'content-type: application/json' \
     -d '{"question":"Can I return my damaged headphones after 10 days?"}'

# the chapter CLI (chapter 13)
npm run chunks     # Chapters 06–07 — fixed vs structural chunking, overlap maths
npm run ask        # Chapters 09–12 — the pipeline, ending in an answer + citations
npm run filters    # Chapter 08 — eligibility, access control, `asOf`
npm run eval       # Chapter 14 — per-case retrieval and generation metrics
npm run ablation   # Chapter 14 — one control at a time
```

`npm run ablation` prints (this is the whole lecture in six numbers):

```text
Chapter 13 — ablation (one control at a time)

preset       chunks  recall  prec   mrr    refusal  ctx tok
naive        12      1.000   0.500  0.750  1.000    327
structural   19      1.000   0.600  0.833  1.000    250
hybrid       19      1.000   0.600  0.833  1.000    250
rerank       19      1.000   0.650  0.833  1.000    214
full         19      1.000   0.650  0.833  1.000    214
```

---

## Chapter map

Read top to bottom. **Part I (01–13)** is the domain pipeline in the order the
code depends on itself; **Part II (14–19)** is the layered service built around
it.

**Part I — the domain pipeline**

| # | Guide chapter | File covered | Lecture chapter |
|---|---|---|---|
| 01 | [Project structure & file map](./01_Project_Structure_and_File_Map.md) | `package.json`, `tsconfig.json`, `.env`, the folder map | all |
| 02 | [Config: the eight controls](./02_Config_The_Eight_Controls.md) | `src/config/config.ts` | 02, 04–08 |
| 03 | [The corpus](./03_The_Corpus.md) | `src/services/documents.ts` | 01, 05 |
| 04 | [Chunking: fixed, overlap, structural](./04_Chunking_Fixed_Overlap_Structural.md) | `src/services/chunking.ts` | 02, 03 |
| 05 | [Embeddings and the analyzer](./05_Embeddings_and_the_Analyzer.md) | `src/services/embeddings.ts` | 03, 06 |
| 06 | [The index and the eligibility filter](./06_The_Index_and_the_Eligibility_Filter.md) | `src/services/store.ts` | 04, 05 |
| 07 | [Dense, BM25 and RRF](./07_Dense_BM25_and_RRF.md) | `src/services/search.ts` | 04, 06 |
| 08 | [Reranking and the gate](./08_Reranking_and_the_Gate.md) | `src/services/rerank.ts` | 07 |
| 09 | [Context engineering](./09_Context_Engineering.md) | `src/services/context.ts` | 08 |
| 10 | [Grounded answer or refusal](./10_Grounded_Answer_or_Refusal.md) | `src/services/generate.ts` | 08 |
| 11 | [The pipeline](./11_The_Pipeline.md) | `src/services/index.ts` | 01–08 |
| 12 | [Evaluation and ablation](./12_Evaluation_and_Ablation.md) | `src/services/eval.ts` | 09 |
| 13 | [The CLI](./13_The_CLI.md) | `src/cli.ts` | all |

**Part II — the layered service around it**

| # | Guide chapter | File covered | Lecture chapter |
|---|---|---|---|
| 14 | [Models: every contract in one file](./14_Models_Every_Contract.md) | `src/models/types.ts` | all |
| 15 | [Utils: one hash, two uses](./15_Utils_One_Hash_Two_Uses.md) | `src/utils/hash.ts` | 02, 06 |
| 16 | [The controller](./16_The_Controller.md) | `src/controllers/ragController.ts` | all |
| 17 | [The routes](./17_The_Routes.md) | `src/routes/index.ts` | all |
| 18 | [Middleware: the failure path](./18_Middleware_The_Failure_Path.md) | `src/middleware/errorHandler.ts` | all |
| 19 | [The app and the server entry](./19_The_App_and_the_Server_Entry.md) | `src/app.ts`, `src/index.ts` | all |

---

## How each chapter is structured

Every chapter follows the same six-part shape so you can follow along
mechanically:

1. **File details** — path, purpose, imports/exports, and the lecture chapter it implements.
2. **Commands** — the exact command(s) to run this piece in isolation.
3. **Full file** — the complete, verbatim source (never a snippet).
4. **Block-by-block explanation** — the file split into numbered blocks; for each
   block you get *what it does* and *how it works*.
5. **Run / verify** — the command and the output you should see.
6. **Checkpoint** — the two or three things to understand before moving on.

---

## The order, and why

```text
── Part I: the domain pipeline ─────────────────────────────
01 structure      → know the map before walking the streets
02 config.ts      → the eight controls as data, so each can be switched off
03 documents.ts   → the corpus and the metadata every later filter depends on
04 chunking.ts    → where a document is cut, and the deterministic chunk id
05 embeddings.ts  → what "similar" means in this project (and the analyzer)
06 store.ts       → the index, and the eligibility filter that guards it
07 search.ts      → dense + BM25 + RRF: the candidate set
08 rerank.ts      → reorder the candidate set, and gate it
09 context.ts     → assemble, order, label and budget the prompt
10 generate.ts    → cite, or refuse
11 services/index → the pipeline that wires 03–10 together and emits a trace
12 eval.ts        → the golden set, the metrics and the ablation
13 cli.ts         → one command per chapter, so each claim can be seen

── Part II: the layers that serve it ───────────────────────
14 models/types   → the contracts every layer shares
15 utils/hash     → the one hash used by chunk ids and the embedder
16 controllers    → request → one service → response
17 routes         → path + method → controller
18 middleware     → the 404 and the single error handler
19 app + entry    → middleware → routes → failure path, then listen(PORT)
```

> **Note on chapter numbering.** This guide numbers chapters by *file/build order*
> (Chapter 01 is the file-structure overview, as requested). The "Lecture
> chapter" column maps each guide chapter back to the corresponding chapter in
> [`../../../notes`](../../../notes/README.md).

**Back to:** [Lecture 12 notes](../../../notes/README.md) · [Basic Code README](../README.md)

