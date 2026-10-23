# Chapter 02 — Config: The Eight Controls

> **Goal of this chapter:** see all eight controls of the lecture as **data**. When
> every knob lives in one object, a chapter can be switched off from `.env`, and
> Chapter 12's ablation becomes one line: `{ ...config, ...overrides }`.
>
> **Lecture chapters:** [02](../../../notes/02_Fixed_Size_Chunking_and_Overlap.md)
> (chunking), [04](../../../notes/04_Top_K_and_Similarity_Thresholds.md) (K and
> the floor), [05](../../../notes/05_Metadata_Filtering.md) (eligibility),
> [06](../../../notes/06_Hybrid_Search_and_RRF.md) (hybrid + RRF),
> [07](../../../notes/07_Reranking_Two_Stage_Retrieval.md) (reranking),
> [08](../../../notes/08_Context_Engineering.md) (the prompt budget).

---

## 2.1 File details

| Property | Value |
|---|---|
| **Path** | `src/config/config.ts` |
| **Layer** | configuration |
| **Purpose** | read `.env` once and export one typed object of controls |
| **Imports** | `dotenv/config` |
| **Exports** | `config`, `type Config` |
| **Imported by** | `services/chunking.ts`, `store.ts`, `search.ts`, `rerank.ts`, `context.ts`, `services/index.ts`, `eval.ts`, `src/index.ts` |
| **Lecture sections** | 02 §"chunk size and overlap", 04 §"K and threshold", 05 §"filters", 06 §"RRF", 07 §"gate", 08 §"budget" |

### The eight controls, and the key that owns each

| # | Control (notes) | Keys in this file |
|---|---|---|
| 1 | Chunking | `chunkStrategy`, `chunkSize`, `chunkOverlap` |
| 2 | Top-K | `kRetrieve`, `kContext` |
| 3 | Similarity threshold | `minScore` |
| 4 | Metadata filtering | `tenantId`, `acl`, `asOf`, `categories` |
| 5 | Hybrid search | `hybrid`, `bm25K1`, `bm25B` |
| 6 | RRF | `rrfK` |
| 7 | Reranking | `rerank`, `rerankMinBest` |
| 8 | Context engineering | `maxContextTokens` |

---

## 2.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run typecheck   # types the object and every `Partial<Config>` preset
```

Any script can be run with an override without editing a file:

```bash
CHUNK_SIZE=60 HYBRID=off RERANK=off npm run ask
MIN_SCORE=0 npm run search          # turn the floor off and watch junk arrive
AS_OF=2026-02-01 npm run filters    # ask the same question in February 2026
```

---

## 2.3 Full file

**Path:** `src/config/config.ts`

```ts
import "dotenv/config";

/**
 * Chapter 04 — every control of the lecture, plus the server port, in one object.
 *
 * One key per knob in the notes, each with a default, so a chapter can be
 * switched off from `.env` and the Chapter 13 ablation becomes one line.
 */
export const config = {
  // ── Chapter 05 — chunking ─────────────────────────────────
  // `structural` cuts on headings; `fixed` cuts every `chunkSize` tokens and
  // steps by `chunkSize - chunkOverlap`.
  chunkStrategy: (process.env.CHUNK_STRATEGY ?? "structural") as "fixed" | "structural",
  // Scaled down from the lecture's 400–600 so the tiny corpus has visible cuts.
  chunkSize: Number(process.env.CHUNK_SIZE ?? 40),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP ?? 8),

  // ── Chapter 07 — how many, and how good ───────────────────
  // K is a budget: retrieve generously, present sparingly.
  kRetrieve: Number(process.env.K_RETRIEVE ?? 10),
  kContext: Number(process.env.K_CONTEXT ?? 4),
  // The floor is the only mechanism that lets the pipeline come back empty.
  minScore: Number(process.env.MIN_SCORE ?? 0.15),

  // ── Chapter 07 — eligibility, not preference ──────────────
  tenantId: process.env.TENANT_ID ?? "northwind",
  acl: (process.env.ACL ?? "support,customer").split(",").map((s) => s.trim()),
  asOf: process.env.AS_OF ?? "2026-06-01",
  categories: (process.env.CATEGORIES ?? "electronics,damaged,product,general")
    .split(",")
    .map((s) => s.trim()),

  // ── Chapter 08 — meaning + exact terms ────────────────────
  hybrid: (process.env.HYBRID ?? "rrf") as "off" | "rrf",
  rrfK: Number(process.env.RRF_K ?? 60),
  bm25K1: Number(process.env.BM25_K1 ?? 1.2),
  bm25B: Number(process.env.BM25_B ?? 0.75),

  // ── Chapter 09 — rerank a small candidate set ─────────────
  rerank: (process.env.RERANK ?? "on") as "off" | "on",
  // The gate: if the best candidate cannot reach this, refuse. Calibrated on
  // this corpus — a legitimate question scores ~0.27+, an off-topic one ~0.
  rerankMinBest: Number(process.env.RERANK_MIN_BEST ?? 0.2),

  // ── Chapter 10 — what reaches the prompt ──────────────────
  maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS ?? 900),

  // ── Chapters 14–17 — the HTTP layer ───────────────────────
  port: Number(process.env.PORT ?? 3100),
};

/** The shape every service accepts, so a preset can be `{ ...config, ... }`. */
export type Config = typeof config;
```

---

## 2.4 Block-by-block explanation

**Block 1 — load `.env` as a side effect**

```ts
import "dotenv/config";
```

- This import has no binding: it *runs* dotenv, which reads `.env` from the
  working directory and assigns each line to `process.env`. Doing it here means no
  other file has to think about it, and it happens exactly once — before any
  module below reads a value.
- Because the entry point (`src/index.ts`) imports this file transitively, `.env`
  is loaded before the first question is asked.

**Block 2 — chunking, with a type that constrains the values**

```ts
chunkStrategy: (process.env.CHUNK_STRATEGY ?? "structural") as "fixed" | "structural",
chunkSize: Number(process.env.CHUNK_SIZE ?? 40),
chunkOverlap: Number(process.env.CHUNK_OVERLAP ?? 8),
```

- `process.env.X` is always `string | undefined`, so every value needs two things:
  a **default** (`??`) and either a **conversion** (`Number(...)`) or a **cast**
  (`as "fixed" | "structural"`).
- The cast is the interesting one. Without it `chunkStrategy` would be `string`,
  and `chunking.ts` could not switch on it exhaustively — a typo in `.env` would
  silently fall through to the structural branch. The union documents the two
  legal values where a reader will look for them.
- `chunkSize`/`chunkOverlap` are Chapter 02's arithmetic: the chunker computes
  `step = chunkSize - chunkOverlap`.

**Block 3 — the two Ks and the floor**

```ts
kRetrieve: Number(process.env.K_RETRIEVE ?? 10),
kContext: Number(process.env.K_CONTEXT ?? 4),
minScore: Number(process.env.MIN_SCORE ?? 0.15),
```

- `kRetrieve` is Chapter 04's *budget for recall*; `kContext` is the *budget for
  precision and cost*. Two numbers, two jobs — that is the two-K architecture:
  retrieve 10, present 4.
- `minScore` is the floor, and it is a **cosine** floor: it is applied to dense
  scores *before* fusion, because an RRF score lives around 0.016–0.033 and a 0.15
  floor applied after fusion would delete everything (Chapter 06's "rename the
  score" rule).

**Block 4 — eligibility (Chapter 05)**

```ts
tenantId: process.env.TENANT_ID ?? "northwind",
acl: (process.env.ACL ?? "support,customer").split(",").map((s) => s.trim()),
asOf: process.env.AS_OF ?? "2026-06-01",
categories: (process.env.CATEGORIES ?? "electronics,damaged,product,general").split(",").map((s) => s.trim()),
```

- `acl` and `categories` are lists in the environment and arrays in the code —
  `split(",")` then `trim()` each item, so `ACL=support, customer` and
  `ACL=support,customer` behave identically.
- `categories` defaults to a **tiered** set. That is deliberate: the notes' bug is
  `category == 'electronics'`, which excludes the general policy that supplies the
  exception. The default here is the fix, and `npm run filters` shows both.
- `asOf` is the temporal predicate. It is a date *string* compared
  lexicographically (`"2026-03-01" > "2026-02-01"`), which works because ISO dates
  sort correctly as text — no date library needed.

**Block 5 — hybrid search and RRF (Chapter 06)**

```ts
hybrid: (process.env.HYBRID ?? "rrf") as "off" | "rrf",
rrfK: Number(process.env.RRF_K ?? 60),
bm25K1: Number(process.env.BM25_K1 ?? 1.2),
bm25B: Number(process.env.BM25_B ?? 0.75),
```

- `hybrid: "off"` is the naive baseline (dense only). Keeping the switch in config
  is what lets Chapter 12's ablation *measure* the gain from hybrid search instead
  of asserting it.
- `rrfK = 60` is the conventional smoothing constant from the notes: it damps the
  difference between rank 1 and rank 10 to about 13%, so **agreement between the
  two retrievers matters more than winning one of them**.
- `bm25K1` and `bm25B` are BM25's two knobs: term-frequency saturation and length
  normalisation.

**Block 6 — the rerank gate (Chapter 07)**

```ts
rerank: (process.env.RERANK ?? "on") as "off" | "on",
rerankMinBest: Number(process.env.RERANK_MIN_BEST ?? 0.2),
```

- `rerankMinBest` is the second refusal mechanism: if the best candidate cannot
  reach it, the pipeline returns **no context at all** and the answer refuses.
- The default 0.2 is *calibrated on this corpus*, not copied: a legitimate question
  scores about 0.27–0.62, an off-topic one scores 0. Chapter 04's rule —
  "calibrate, don't copy" — is why the comment says so.

**Block 7 — the prompt budget (Chapter 08)**

```ts
maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS ?? 900),
```

- The assembly stage stops adding chunks once this budget is reached, dropping
  **whole** chunks rather than truncating one — because truncating a chunk can
  delete the exception clause.

**Block 8 — the type that makes presets possible**

```ts
export type Config = typeof config;
```

- `typeof config` derives the type from the value, so adding a key here
  automatically updates every function signature. Nothing can drift.
- Because every service accepts `cfg: Config`, a preset is a spread:
  `{ ...config, chunkStrategy: "fixed", hybrid: "off" }`. That single expression
  *is* the ablation table in Chapter 12.

---

## 2.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"

npm run typecheck
CHUNK_STRATEGY=fixed CHUNK_OVERLAP=0 npm run chunks
```

Expected: `typecheck` prints nothing; the second command prints `fixed: 12 chunks`
and then `structural: 19 chunks` — the same corpus, two chunkings, no code change.

---

## 2.6 Checkpoint

1. **Why does every value use `??`?** So the project runs with `.env` absent, and
   the README's "no API key, no configuration" claim stays true.
2. **Why is the threshold applied before fusion?** Because after RRF the score is
   a rank-fusion score (0.016–0.033), not a similarity — a similarity floor there
   would delete everything.
3. **What makes the ablation one line?** `export type Config = typeof config`, so
   every service takes `cfg` and a preset is `{ ...config, ...overrides }`.

**Next:** [Chapter 03 — The corpus](./03_The_Corpus.md)

