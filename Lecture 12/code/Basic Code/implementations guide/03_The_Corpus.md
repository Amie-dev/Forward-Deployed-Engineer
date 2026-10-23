# Chapter 03 — The Corpus

> **Goal of this chapter:** read the data everything else operates on. A retrieval
> system is only as good as the metadata its documents carry — Chapter 05's
> filters, Chapter 02's ids and Chapter 09's evaluation all depend on fields that
> must exist **before** the first ingest.
>
> **Lecture chapters:** [01](../../../notes/01_Why_Basic_RAG_Breaks.md) (the
> running example) and [05](../../../notes/05_Metadata_Filtering.md) (metadata as
> the authorisation boundary).

---

## 3.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/documents.ts` |
| **Layer** | data |
| **Purpose** | the corpus: 7 documents, each with the metadata the filters need |
| **Imports** | none |
| **Exports** | `type Category`, `type Document`, `DOCUMENTS` |
| **Imported by** | `services/store.ts`, `services/index.ts`, `src/index.ts` |
| **Lecture sections** | 01 §"the running example", 05 §"metadata, ACL, temporal" |

### The seven documents, and why each exists

| id | category | exists to demonstrate |
|---|---|---|
| `return-policy-general` | general | the **general** rule (30 days) that must not win |
| `return-policy-electronics` | electronics | the **specific** rule (7 days), effective 2026-03-01 |
| `return-policy-electronics-2025` | electronics | the **superseded** 14-day rule (`asOf`) |
| `damaged-product-policy` | damaged | the **exception** (48-hour reporting window) |
| `product-ax204` | product | the exact **SKU** hybrid search must find |
| `product-bx900` | product | a decoy dense search prefers by mistake |
| `refund-sop-internal` | internal | an ACL that must hide it from support |

---

## 3.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run chunks    # counts every document's chunks under both strategies
npm run filters   # shows which documents each filter makes eligible
```

---

## 3.3 Full file

**Path:** `src/services/documents.ts`

```ts
import type { Document } from "../models/types.js";

/**
 * Chapters 01–05 — the corpus.
 *
 * The lecture's running example: three policies that disagree about the same
 * question — "can I return my damaged headphones after 10 days?" — plus the
 * documents that make hybrid search, temporal filtering and access control
 * visible. Every document carries the metadata the notes require:
 *
 *   category       Chapter 05 — eligibility filter
 *   tenant + acl   Chapter 05 — the authorisation boundary
 *   effectiveFrom  Chapter 05 — the `asOf` temporal predicate
 *   supersededOn   Chapter 05 — so a superseded policy cannot win on similarity
 *
 * The `Document` contract itself lives in `models/types.ts` (Chapter 14); this
 * file is only the data.
 */

const northwind = "northwind";

export const DOCUMENTS: Document[] = [
  {
    id: "return-policy-general",
    title: "General Return Policy",
    category: "general",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-01-01",
    text: [
      "# General Return Policy",
      "## Scope",
      "This policy applies to every product we sell unless a category policy says otherwise.",
      "## Return window",
      "Customers may return an item within 30 days of delivery for a full refund.",
      "## Condition",
      "Returned items must be unused and in their original packaging.",
    ].join("\n"),
  },
  {
    id: "return-policy-electronics",
    title: "Electronics Return Policy",
    category: "electronics",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-03-01",
    text: [
      "# Electronics Return Policy",
      "## Scope",
      "This policy overrides the general return policy for all electronic products, including headphones and speakers.",
      "## Return window",
      "Electronic products can be returned within 7 days of delivery.",
      "## Fast charging",
      "Charging behaviour is described in the product datasheet, not in this policy.",
    ].join("\n"),
  },
  {
    // Superseded: for `asOf` before 2026-03-01 the 14-day rule is the live one.
    id: "return-policy-electronics-2025",
    title: "Electronics Return Policy (2025 edition)",
    category: "electronics",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2025-01-01",
    supersededOn: "2026-03-01",
    text: [
      "# Electronics Return Policy (2025 edition)",
      "## Return window",
      "Electronic products can be returned within 14 days of delivery.",
      "## Notes",
      "This edition was replaced on 1 March 2026 by the current 7-day policy.",
    ].join("\n"),
  },
  {
    id: "damaged-product-policy",
    title: "Damaged Product Reporting Policy",
    category: "damaged",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-01-01",
    text: [
      "# Damaged Product Reporting Policy",
      "## Reporting window",
      "Damage must be reported within 48 hours of delivery.",
      "## Exception",
      "Damage reported after 48 hours is treated as a normal return and follows the return policy for the product category.",
      "## Evidence",
      "A photograph of the damaged item is required for every damage claim.",
    ].join("\n"),
  },
  {
    id: "product-ax204",
    title: "AX-204 Wireless Headphone Datasheet",
    category: "product",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-02-01",
    text: [
      "# AX-204 Wireless Headphone Datasheet",
      "## Overview",
      "The AX-204 is an over-ear wireless headphone with active noise cancelling.",
      "## Charging",
      "The AX-204 supports fast charging: a 10 minute charge gives 6 hours of playback.",
      "## Warranty",
      "The AX-204 carries a 24 month limited warranty.",
    ].join("\n"),
  },
  {
    // Deliberately similar wording: the document dense search prefers by mistake.
    id: "product-bx900",
    title: "BX-900 Wireless Headphone Datasheet",
    category: "product",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-02-01",
    text: [
      "# BX-900 Wireless Headphone Datasheet",
      "## Overview",
      "The BX-900 is a wireless headphone with active noise cancelling and a fast charging case.",
      "## Charging",
      "The BX-900 charging case supports fast charging for the earbuds only.",
      "## Warranty",
      "The BX-900 carries a 12 month limited warranty.",
    ].join("\n"),
  },
  {
    // Wrong ACL: proves the filter is an authorisation boundary, not a relevance
    // feature. Same tenant as the customer, but not readable by support.
    id: "refund-sop-internal",
    title: "Refund Processing SOP",
    category: "internal",
    tenant: northwind,
    acl: ["finance"],
    effectiveFrom: "2026-01-01",
    text: [
      "# Refund Processing SOP",
      "## Steps",
      "Finance approves refunds above 500 euros before the support agent issues them.",
      "## Timeline",
      "Refunds are settled within 5 business days.",
    ].join("\n"),
  },
];
```

---

## 3.4 Block-by-block explanation

**Block 1 — the header comment is the schema documentation**

```ts
 *   category       Chapter 05 — eligibility filter
 *   tenant + acl   Chapter 05 — the authorisation boundary
 *   effectiveFrom  Chapter 05 — the `asOf` temporal predicate
 *   supersededOn   Chapter 05 — so a superseded policy cannot win on similarity
```

- Four fields, four jobs. Metadata is easy to add and hard to justify, so each
  line answers *"what breaks if this field is missing?"* — and `store.ts` refuses
  to ingest a chunk that is missing one.

**Block 2 — the closed category union**

```ts
export type Category = "general" | "electronics" | "damaged" | "product" | "internal";
```

- A closed union, not `string`. This makes Chapter 05's missing-field trap
  impossible to create by accident: `category: "electronic"` (typo) is a compile
  error, and `config.categories` can only ever name a legal value.
- It is also what lets the specificity ordering in `context.ts` be exhaustive —
  every category has a place in that table.

**Block 3 — the Document type**

```ts
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
```

- `id` is the **stable source identifier**: the first component of every chunk id
  (`docId#index#hash`), and what the golden set's `expectedDocs` refers to — so
  evaluation compares documents, not chunk hashes.
- `acl` is an array because a document can be readable by several roles; the
  filter asks "does the reader hold *any* of these roles?".
- `supersededOn?` is optional, and the `?` is the point: most documents are never
  superseded, and `undefined` means "still in force". The filter treats
  `undefined` as eligible.
- `text` is **markdown with `#` and `##` headings**, because Chapter 04's
  structural chunker needs a structure to cut on.

**Block 4 — one tenant constant**

```ts
const northwind = "northwind";
```

- Every document belongs to the same tenant, so the constant removes six chances
  to typo a tenant id. `refund-sop-internal` stays in the *same* tenant
  deliberately: its exclusion is then caused by the **ACL alone**, and
  `npm run filters` shows exactly that.

**Block 5 — the three policies that disagree**

```ts
  { id: "return-policy-general",     ... "Customers may return an item within 30 days ..." },
  { id: "return-policy-electronics", ... "Electronic products can be returned within 7 days ..." },
  { id: "damaged-product-policy",    ... "Damage must be reported within 48 hours ..." },
```

- The lecture's running example, verbatim. All three are *relevant* to "can I
  return my damaged headphones after 10 days?" and they give three different
  answers — so the failure cannot be fixed by a better prompt alone; it needs
  eligibility, ranking and precedence.
- `return-policy-electronics` contains an explicit **overrides** sentence. That
  sentence is the evidence Chapter 09's assembler puts first, and the one a
  reader would cite for "specific beats general".

**Block 6 — the temporal pair**

```ts
  { id: "return-policy-electronics-2025", effectiveFrom: "2025-01-01", supersededOn: "2026-03-01", ... },
  { id: "return-policy-electronics",      effectiveFrom: "2026-03-01", ... },
```

- Two documents, one category, overlapping text. Without the temporal predicate
  both are "eligible" and the superseded 14-day rule can win on similarity — the
  failure the notes call *"superseded policy wins on similarity"*.
- With `asOf = 2026-02-01` the 2025 edition is the live policy; with
  `asOf = 2026-06-01` it is gone. `npm run filters` prints both rows.

**Block 7 — the SKU pair**

```ts
  { id: "product-ax204", ... "The AX-204 supports fast charging ..." },
  { id: "product-bx900", ... "The BX-900 charging case supports fast charging ..." },
```

- `product-bx900` exists to *fail*. It is a near-copy of the AX-204 wording, so a
  dense retriever ranks it highly for "does the AX-204 support fast charging?" —
  precisely Chapter 06's argument that *embeddings blur exact strings*. BM25 then
  puts the real SKU first and RRF lets agreement decide.

**Block 8 — the ACL decoy**

```ts
    // Wrong ACL: proves the filter is an authorisation boundary, not a relevance
    // feature. Same tenant as the customer, but not readable by support.
    id: "refund-sop-internal",
    acl: ["finance"],
```

- The comment states the intent, because this document's *content* is perfectly
  relevant to a refund question. If it ever appears in a support answer the filter
  is broken — and that is a security bug, not a quality bug.

---

## 3.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run filters
```

Expected: the default reader (`support`, `customer`) sees 5 documents and
`refund-sop-internal` never appears — while the `acl = [finance]` row shows
exactly that one document.

---

## 3.6 Checkpoint

1. **Why does every document carry `category`, `tenant`, `acl` and
   `effectiveFrom`?** Because Chapter 05's filter is evaluated per chunk, and
   ingest fails loudly when one is missing.
2. **Which document exists only to make dense search look bad?** `product-bx900`,
   the decoy SKU.
3. **What does `supersededOn: undefined` mean?** The document is still in force
   and stays eligible for any `asOf`.

**Next:** [Chapter 04 — Chunking: fixed, overlap, structural](./04_Chunking_Fixed_Overlap_Structural.md)
