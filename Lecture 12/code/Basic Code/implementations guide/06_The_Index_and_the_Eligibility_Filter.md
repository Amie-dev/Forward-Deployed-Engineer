# Chapter 06 — The Index and the Eligibility Filter

> **Goal of this chapter:** build the index, then put a **guard** in front of it.
> Chapter 05's controls are the only ones in the pipeline that can make a document
> *unfindable* — which is why they are a security boundary first and a relevance
> feature second.
>
> **Lecture chapter:** [05 — Metadata Filtering](../../../notes/05_Metadata_Filtering.md)
> (the third control, the restrictiveness trap, pre- vs post-filter, the four
> production requirements, the missing-field trap). The index itself belongs to
> [04](../../../notes/04_Top_K_and_Similarity_Thresholds.md).

---

## 6.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/store.ts` |
| **Layer** | store |
| **Purpose** | build the index (chunk → validate → embed) and decide eligibility |
| **Imports** | `type Config`, `chunkCorpus`/`type Chunk`, `DOCUMENTS`/`type Document`, `embed` |
| **Exports** | `type IndexedChunk`, `type Filter`, `isEligible`, `filterFrom`, `buildIndex`, `chunkStats` |
| **Imported by** | `services/search.ts` (type only), `services/index.ts`, `src/index.ts` |
| **Lecture sections** | 05 §"the third control", §"pre-filter vs post-filter", §"the four production requirements", §"the missing-field trap" |

### What the filter decides, line by line

| Check | Requirement from the notes |
|---|---|
| `!filter.tenant → false` | **fail closed** — a missing tenant matches nothing |
| `chunk.tenant !== filter.tenant` | server-derived scope (never from the request) |
| `chunk.acl ∩ filter.acl` | the authorisation boundary |
| `filter.categories.includes(...)` | eligibility, not preference |
| `effectiveFrom > asOf` | the temporal predicate, part 1 |
| `supersededOn <= asOf` | the temporal predicate, part 2 |

---

## 6.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run filters                      # every filter scenario, side by side
AS_OF=2026-02-01 npm run filters     # the superseded policy becomes the live one
TENANT_ID= npm run filters           # fail-closed: nothing is eligible
```

---

## 6.3 Full file

**Path:** `src/services/store.ts`

```ts
import type { Config } from "../config/config.js";
import type { Document, Filter, IndexedChunk } from "../models/types.js";
import { chunkCorpus } from "./chunking.js";
import { DOCUMENTS } from "./documents.js";
import { embed } from "./embeddings.js";

/**
 * Chapters 04 and 05 — the index and the eligibility filter.
 *
 * The store is in memory on purpose: it is big enough to demonstrate
 * pre-filtering, access control and time travel, and small enough to read.
 *
 * `IndexedChunk` and `Filter` are contracts (Chapter 14); this file owns the
 * ingest and the predicate.
 */

/**
 * Chapter 05 — the four production requirements, in one predicate.
 *
 *   server-derived scope  the caller never passes `tenantId` in the request
 *   fail closed           a missing tenant matches nothing, not everything
 *   same filter on both   the caller applies this before dense *and* lexical
 *   temporal predicate    `asOf` stops a superseded policy winning on similarity
 */
export function isEligible(chunk: IndexedChunk, filter: Filter): boolean {
  if (!filter.tenant) return false; // fail closed
  if (chunk.tenant !== filter.tenant) return false;
  if (!chunk.acl.some((role) => filter.acl.includes(role))) return false;
  if (!filter.categories.includes(chunk.category)) return false;
  if (chunk.effectiveFrom > filter.asOf) return false; // not yet in force
  if (chunk.supersededOn && chunk.supersededOn <= filter.asOf) return false; // replaced
  return true;
}

export function filterFrom(cfg: Config): Filter {
  return {
    tenant: cfg.tenantId,
    acl: cfg.acl,
    asOf: cfg.asOf,
    categories: cfg.categories,
  };
}

/**
 * Chapters 03–05 — ingest: chunk, validate, embed.
 *
 * The missing-field trap: a chunk without a category matches neither
 * `category == 'electronics'` nor `category != 'electronics'`, so we fail loudly
 * at ingest instead of defaulting silently.
 */
export function buildIndex(docs: Document[] = DOCUMENTS, cfg: Config): IndexedChunk[] {
  return chunkCorpus(docs, cfg).map((chunk) => {
    if (!chunk.category || !chunk.tenant || chunk.acl.length === 0) {
      throw new Error(`Ingest error: chunk ${chunk.id} is missing category/tenant/acl metadata.`);
    }
    return { ...chunk, vector: embed(chunk.text) };
  });
}

/** How many chunks the corpus produced — the Chapter 02/03 measurement. */
export function chunkStats(cfg: Config): { total: number; perDoc: Map<string, number> } {
  const chunks = chunkCorpus(DOCUMENTS, cfg);
  const perDoc = new Map<string, number>();
  for (const chunk of chunks) perDoc.set(chunk.docId, (perDoc.get(chunk.docId) ?? 0) + 1);
  return { total: chunks.length, perDoc };
}
```

---

## 6.4 Block-by-block explanation

**Block 1 — `IndexedChunk`: a chunk plus its vector**

```ts
export type IndexedChunk = Chunk & { vector: number[] };
```

- An intersection type, so an indexed chunk *is* a chunk with one extra field.
  Nothing downstream needs to know whether it holds a `Chunk` or an
  `IndexedChunk` — the metadata, the breadcrumb and the body are all still there.
- This is the same trick a real vector store plays: the payload travels with the
  vector, so the retriever never has to fetch a second time.

**Block 2 — `Filter`: the filter as a value, not a query string**

```ts
export type Filter = { tenant: string; acl: string[]; asOf: string; categories: string[] };
```

- Four fields, and notice what is *not* here: no user id, no request object, no raw
  expression string. A filter is a small, inspectable value that the caller builds
  from *server-side* configuration.
- `asOf` is a plain string, compared lexicographically. ISO dates sort correctly as
  text, so `"2026-03-01" > "2026-02-01"` — the temporal predicate costs no
  dependency and no parsing.

**Block 3 — `isEligible`: six lines, four requirements**

```ts
export function isEligible(chunk: IndexedChunk, filter: Filter): boolean {
  if (!filter.tenant) return false; // fail closed
  if (chunk.tenant !== filter.tenant) return false;
  if (!chunk.acl.some((role) => filter.acl.includes(role))) return false;
  if (!filter.categories.includes(chunk.category)) return false;
  if (chunk.effectiveFrom > filter.asOf) return false; // not yet in force
  if (chunk.supersededOn && chunk.supersededOn <= filter.asOf) return false; // replaced
  return true;
}
```

- **Line 1 is the security line.** `if (!filter.tenant) return false` — a missing
  tenant returns *nothing*, not everything. That is the notes' *fail closed*
  requirement: the failure mode of a broken configuration must be "no data", never
  "all data".
- **Line 3 is set intersection.** `chunk.acl.some(role => filter.acl.includes(role))`
  asks "does the reader hold **any** role the chunk allows?" — `some`, not `every`,
  because a document readable by support *or* finance is readable by a support
  agent.
- **Line 4 is the restrictiveness trap.** The filter takes a *list* of categories,
  so `["electronics"]` (the bug) and `["electronics", "general"]` (the fix) are two
  configurations of one line. `npm run filters` prints both outcomes.
- **Lines 5–6 are the temporal predicate, and they are two different questions:**
  - `effectiveFrom > asOf` → *has this document come into force yet?*
  - `supersededOn <= asOf` → *has it been replaced by now?*
  With both, a document is live exactly in the window `[effectiveFrom,
  supersededOn)`. On this corpus that is what makes `asOf = 2026-02-01` return the
  2025 edition and `asOf = 2026-06-01` return its replacement.
- The order of the checks is deliberate: cheap identity checks first, then ACL, then
  the category set, then the two date comparisons — the most selective conditions
  short-circuit first.

**Block 4 — `filterFrom`: config → filter**

```ts
export function filterFrom(cfg: Config): Filter {
  return { tenant: cfg.tenantId, acl: cfg.acl, asOf: cfg.asOf, categories: cfg.categories };
}
```

- A one-line adapter, and its job is to make the boundary explicit: the *only* way
  a filter comes into existence is from configuration. There is no
  `filterFromRequest(...)`, and that absence is the point — a caller cannot widen
  its own scope.

**Block 5 — `buildIndex`: the ingest contract**

```ts
export function buildIndex(docs: Document[] = DOCUMENTS, cfg: Config): IndexedChunk[] {
  return chunkCorpus(docs, cfg).map((chunk) => {
    if (!chunk.category || !chunk.tenant || chunk.acl.length === 0) {
      throw new Error(`Ingest error: chunk ${chunk.id} is missing category/tenant/acl metadata.`);
    }
    return { ...chunk, vector: embed(chunk.text) };
  });
}
```

- Three steps in three lines: **chunk → validate → embed**.
- The validation is the notes' *missing-field trap* made operational. A chunk
  without a `category` matches neither `category == 'electronics'` nor
  `category != 'electronics'` on most stores, so it becomes invisible to *every*
  query — a silent, unexplainable recall loss. Throwing at ingest turns that into a
  loud failure at the earliest possible moment, with the offending chunk id in the
  message.
- The error names the chunk id because the notes' rule is that *error messages are
  instructions*: `chunk return-policy-general#0#9cfdc319 is missing
  category/tenant/acl metadata` tells you exactly which document to fix.
- `docs: Document[] = DOCUMENTS` gives the parameter a default, so
  `buildIndex(undefined, cfg)` and `buildIndex(DOCUMENTS, cfg)` are the same call.
- `{ ...chunk, vector: embed(chunk.text) }` embeds `chunk.text` — the breadcrumb
  **plus** the body — not `chunk.body`. That is the Chapter 04 decision paying off:
  the heading is part of what makes the chunk findable.

**Block 6 — `chunkStats`: the measurement helper**

```ts
export function chunkStats(cfg: Config): { total: number; perDoc: Map<string, number> } {
  const chunks = chunkCorpus(DOCUMENTS, cfg);
  const perDoc = new Map<string, number>();
  for (const chunk of chunks) perDoc.set(chunk.docId, (perDoc.get(chunk.docId) ?? 0) + 1);
  return { total: chunks.length, perDoc };
}
```

- The per-document count is the number the notes call the *orphan/dup audit*: a
  document with **zero** chunks has silently disappeared from the index, and an
  unexpected count usually means the chunker cut somewhere you did not intend.
- `(perDoc.get(docId) ?? 0) + 1` is the standard map-increment idiom: `?? 0`
  handles the first occurrence.

**A note on what is deliberately missing: pre-filter vs post-filter**

The notes compare pre-filtering (filter *during* the search) with post-filtering
(filter *after* it) and conclude that post-filtering is **unsafe** — data crosses
the authorisation boundary before it is filtered. This implementation only ever
pre-filters: `services/index.ts` builds the eligible set *before* either retriever
runs, so an unauthorised chunk never reaches a ranking function. The safe behaviour
is the default, and the unsafe one is not implemented at all.

---

## 6.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run filters
```

Expected (excerpt):

```text
category in [electronics, general]   (correct tiers)
    2 docs: return-policy-general, return-policy-electronics
category == electronics              (the bug)
    1 docs: return-policy-electronics
tenant = ""                          (fail closed)
    0 docs: (none)
acl = [support, customer]            (default)
    5 docs: return-policy-general, return-policy-electronics, damaged-product-policy, product-ax204, product-bx900
acl = [finance]                      (internal SOP visible)
    1 docs: refund-sop-internal
asOf = 2026-02-01                    (before the new policy)
    2 docs: return-policy-general, return-policy-electronics-2025
asOf = 2026-06-01                    (superseded policy gone)
    2 docs: return-policy-general, return-policy-electronics
```

Read the second row carefully: `category == electronics` returns **one** document,
and the one it drops is the general policy — the document that supplies the
exception. That single line is the lecture's whole argument for tiered filters.

---

## 6.6 Checkpoint

1. **What does a missing tenant do, and why?** It matches nothing (fail closed), so
   a broken configuration cannot leak another tenant's data.
2. **Why is the temporal predicate two comparisons?** `effectiveFrom <= asOf` asks
   whether the document is in force; `supersededOn > asOf` asks whether it has been
   replaced. Both are needed to describe a window.
3. **Why does ingest throw instead of defaulting a missing category?** Because a
   chunk with no category is invisible to *every* filter — a silent recall loss —
   and the notes' rule is to validate presence and fail loudly.

**Next:** [Chapter 07 — Dense, BM25 and RRF](./07_Dense_BM25_and_RRF.md)


