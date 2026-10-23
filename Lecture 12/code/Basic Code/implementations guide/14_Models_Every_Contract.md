# Chapter 14 — Models: Every Contract in One File

> **Goal of this chapter:** read the file that has **no imports**. Every other
> layer speaks in these shapes, so this is the bottom of the dependency graph —
> which is what makes the layering in Chapter 01 possible.
>
> **Lecture chapters:** all of them. The contracts are the vocabulary the notes
> use: a *chunk*, a *hit*, a *filter*, the *trace*.

---

## 14.1 File details

| Property | Value |
|---|---|
| **Path** | `src/models/types.ts` |
| **Layer** | contracts (the bottom of the graph) |
| **Purpose** | one declaration per shape that crosses a layer boundary |
| **Imports** | **none** — deliberately |
| **Exports** | `Category`, `Document`, `Chunk`, `IndexedChunk`, `Filter`, `Hit`, `ContextBlock`, `AssembledContext`, `Answer`, `Trace`, `GoldenCase`, `CaseResult`, `Metrics`, `SearchRequest`, `AskRequest`, `ErrorResponse` |
| **Imported by** | every service, the controller, the middleware and the CLI |
| **Lecture sections** | all — this file is the glossary |

### Where each contract came from

| Contract | Was defined in | Now lives here because |
|---|---|---|
| `Document`, `Category` | `services/documents.ts` | the corpus is data; the *shape* is a contract |
| `Chunk` | `services/chunking.ts` | `store.ts` and `context.ts` both speak in chunks |
| `IndexedChunk`, `Filter` | `services/store.ts` | the controller and the CLI filter too |
| `Hit` | `services/search.ts` | the reranker and the context assembler both rank hits |
| `ContextBlock`, `AssembledContext` | `services/context.ts` | the generator reads them, the controller serialises them |
| `Answer` | `services/generate.ts` | the pipeline returns it |
| `Trace` | `services/index.ts` | the CLI prints it, the controller serialises it |
| `GoldenCase`, `CaseResult`, `Metrics` | `services/eval.ts` | the controller returns them as JSON |

That table is the whole justification for the move: each shape is needed by **at
least two** layers, so it cannot belong to either one of them.

---

## 14.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run typecheck   # every contract is checked against every use site
```

---

## 14.3 Full file

**Path:** `src/models/types.ts`

```ts
/**
 * Chapter 02 — every data contract in one place.
 *
 * This file has **no imports**: it is the bottom of the dependency graph, so any
 * layer can depend on it and nothing can create a cycle. A contract lives here
 * when more than one layer needs to speak about it.
 */

/* ── Corpus — Chapter 04 ─────────────────────────────────────────────────── */

export type Category = "general" | "electronics" | "damaged" | "product" | "internal";

export type Document = {
  id: string;
  title: string;
  category: Category;
  tenant: string;
  acl: string[];
  effectiveFrom: string;
  supersededOn?: string;
  text: string;
};

/* ── Chunking — Chapters 05 ──────────────────────────────────────────────── */

export type Chunk = {
  /** Chapter 05 — `source + index + contentHash`: same text → same id. */
  id: string;
  docId: string;
  /** What gets embedded: breadcrumb + body. */
  text: string;
  /** The body alone, for display. */
  body: string;
  breadcrumb: string;
  category: string;
  tenant: string;
  acl: string[];
  effectiveFrom: string;
  supersededOn?: string;
};

/* ── Store and eligibility — Chapters 07 ─────────────────────────────────── */

export type IndexedChunk = Chunk & { vector: number[] };

export type Filter = {
  tenant: string;
  acl: string[];
  asOf: string;
  categories: string[];
};

/* ── Retrieval — Chapter 08 ──────────────────────────────────────────────── */

/** One ranked chunk. The `score` is a cosine, a BM25 value or an RRF value —
 *  the pipeline only ever orders by it, never compares two different ones. */
export type Hit = { chunk: IndexedChunk; score: number };

/* ── Context — Chapter 10 ────────────────────────────────────────────────── */

export type ContextBlock = {
  label: number;
  chunkId: string;
  docId: string;
  heading: string;
  body: string;
  meta: string;
};

export type AssembledContext = {
  text: string;
  blocks: ContextBlock[];
  ids: string[];
  tokens: number;
};

/* ── Generation — Chapter 11 ─────────────────────────────────────────────── */

export type Answer = { text: string; citations: number[]; refused: boolean };

/* ── Pipeline — Chapter 12 ───────────────────────────────────────────────── */

export type Trace = {
  question: string;
  chunks: number;
  eligible: number;
  filter: Filter;
  dense: Hit[];
  lexical: Hit[];
  fused: Hit[];
  candidates: Hit[];
  reranked: Hit[];
  passed: boolean;
  context: AssembledContext;
  answer: Answer;
  timings: Record<string, number>;
};

/* ── Evaluation — Chapter 13 ─────────────────────────────────────────────── */

export type GoldenCase = {
  question: string;
  expectedDocs: string[];
  answerable: boolean;
};

export type CaseResult = {
  question: string;
  expected: string[];
  retrieved: string[];
  recall: number;
  precision: number;
  reciprocal: number;
  correct: number;
  tokens: number;
  refused: boolean;
};

export type Metrics = {
  chunks: number;
  recall: number;
  precision: number;
  mrr: number;
  refusal: number;
  contextTokens: number;
};

/* ── HTTP — Chapters 14–16 ───────────────────────────────────────────────── */

export type SearchRequest = { question: string };
export type AskRequest = { question: string };
export type ErrorResponse = { error: string };
```

---

## 14.4 Block-by-block explanation

**Block 1 — the rule at the top of the file**

```ts
/**
 * Chapter 02 — every data contract in one place.
 *
 * This file has **no imports**: it is the bottom of the dependency graph, so any
 * layer can depend on it and nothing can create a cycle. A contract lives here
 * when more than one layer needs to speak about it.
 */
```

- "No imports" is not a style preference — it is what makes the layering safe. If
  this file imported `Config`, then `services/` would depend on `models/` which
  would depend on `config/`, and a later refactor could produce a cycle.
- The second sentence is the *inclusion rule*: a type moves here when two layers
  need it. `Preset` stayed in `services/eval.ts` precisely because only the
  evaluation layer rewrites the configuration.

**Block 2 — the corpus contracts**

```ts
export type Category = "general" | "electronics" | "damaged" | "product" | "internal";

export type Document = {
  id: string; title: string; category: Category; tenant: string; acl: string[];
  effectiveFrom: string; supersededOn?: string; text: string;
};
```

- `Category` is a closed union, which is what makes Chapter 05's missing-field
  trap impossible to introduce by typo.
- `Document` is the *source* shape: everything a document must declare before
  ingest.
- `supersededOn?` is optional, and `undefined` means "still in force" — the
  temporal predicate depends on that meaning.

**Block 3 — the chunk contract**

```ts
export type Chunk = {
  id: string; docId: string; text: string; body: string; breadcrumb: string;
  category: string; tenant: string; acl: string[]; effectiveFrom: string; supersededOn?: string;
};
```

- The notes' rule — *"a chunk must carry its breadcrumb, its metadata and a
  deterministic id"* — as a type.
- `text` (breadcrumb + body) is what gets embedded; `body` alone is what gets
  displayed. That distinction is the Chapter 06 decision, preserved here.
- The metadata is **copied per chunk**, not referenced from the document, because
  the eligibility filter is evaluated per chunk (Chapter 08).

**Block 4 — the store contracts**

```ts
export type IndexedChunk = Chunk & { vector: number[] };

export type Filter = { tenant: string; acl: string[]; asOf: string; categories: string[] };
```

- `IndexedChunk` is an intersection, so an indexed chunk *is* a chunk with one
  extra field — nothing downstream has to know which one it holds.
- `Filter` is a small, inspectable **value**, not a query string. There is no
  `userId` and no request object in it, which is the shape that makes Chapter 07's
  fail-closed rule expressible.

**Block 5 — the retrieval and context contracts**

```ts
export type Hit = { chunk: IndexedChunk; score: number };

export type ContextBlock = { label: number; chunkId: string; docId: string; heading: string; body: string; meta: string };
export type AssembledContext = { text: string; blocks: ContextBlock[]; ids: string[]; tokens: number };
```

- `Hit.score` is intentionally unlabelled. It holds a cosine, then a BM25 value,
  then an RRF value as the pipeline progresses — and the doc comment says the
  pipeline only ever *orders* by it, never compares two different ones.
- `ContextBlock` keeps the structure **and** `AssembledContext.text` keeps the
  rendered string. The generator scores per block; the controller returns `text`.
  Rendering once and discarding the structure would force a re-parse.
- `ids` is the flat list of chunk ids that reached the prompt — the join key the
  evaluation uses.

**Block 6 — the answer and the trace**

```ts
export type Answer = { text: string; citations: number[]; refused: boolean };
export type Trace = {
  question; chunks; eligible; filter; dense; lexical; fused;
  candidates; reranked; passed; context; answer; timings;
};
```

- `refused` is a first-class boolean, never inferred from the answer text — that
  is what makes `refusal correctness` (Chapter 13) robust to a wording change.
- `Trace` is the observability contract: every stage's output, in pipeline order,
  so the notes' diagnostic tree can be walked from data rather than memory.
  `candidates` and `fused` are both present because they differ by the cut at K.
- `timings: Record<string, number>` is deliberately loose, so a new stage can be
  added without changing the contract.

**Block 7 — the evaluation and HTTP contracts**

```ts
export type GoldenCase = { question: string; expectedDocs: string[]; answerable: boolean };
export type CaseResult = { … };
export type Metrics = { chunks; recall; precision; mrr; refusal; contextTokens };

export type SearchRequest = { question: string };
export type AskRequest = { question: string };
export type ErrorResponse = { error: string };
```

- The evaluation contracts live here because the **controller** returns them as
  JSON (Chapter 16) while the evaluation service produces them (Chapter 13) — two
  layers, so a shared contract.
- `SearchRequest` and `AskRequest` are identical on purpose: two endpoints, two
  names, so either can grow without renaming the other. Note what they *do not*
  contain: no tenant, no ACL, no `asOf` — that is Chapter 05's rule expressed as
  a request shape.
- `ErrorResponse` is shared by the 404 handler and the error handler
  (Chapter 18), so both failure paths return the same JSON.

---

## 14.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run typecheck
```

Expected: no output. If a service still declared its own `Chunk` or `Hit`, the
compiler would report two incompatible declarations the moment both were used —
which is how the move was verified.

---

## 14.6 Checkpoint

1. **Why must this file have no imports?** So it can sit at the bottom of the
   dependency graph and no cycle is possible.
2. **When does a type belong here rather than next to the service that produces
   it?** When more than one layer needs to speak about it — `Preset` stayed in
   `eval.ts` for exactly that reason.
3. **Why is `refused` a boolean rather than a string comparison?** So the refusal
   metric cannot break when the refusal sentence is reworded.

**Next:** [Chapter 15 — Utils: one hash, two uses](./15_Utils_One_Hash_Two_Uses.md)


