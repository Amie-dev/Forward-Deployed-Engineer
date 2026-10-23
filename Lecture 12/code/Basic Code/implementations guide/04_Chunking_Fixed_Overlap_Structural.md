# Chapter 04 — Chunking: Fixed, Overlap, Structural

> **Goal of this chapter:** answer *where a document gets cut*, and see why the
> answer is irreversible. Chunking is the first decision of the whole pipeline: a
> rule separated from its exception at ingest **cannot** be reunited at query time.
>
> **Lecture chapters:** [02](../../../notes/02_Fixed_Size_Chunking_and_Overlap.md)
> (fixed size, overlap arithmetic, ids, the parameter trap) and
> [03](../../../notes/03_Structural_Semantic_and_Contextual_Chunking.md)
> (structure beats statistics; the breadcrumb).

---

## 4.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/chunking.ts` |
| **Layer** | ingest |
| **Purpose** | turn a `Document` into `Chunk[]` — with an id, a breadcrumb and metadata |
| **Imports** | `type Config` (config), `type Document` (documents) |
| **Exports** | `type Chunk`, `fixedChunks`, `structuralChunks`, `chunkDocument`, `chunkCorpus` |
| **Imported by** | `services/store.ts` |
| **Lecture sections** | 02 §"the arithmetic", §"ids", §"parameter trap"; 03 §"three families", §"the heading is disambiguating context" |

### The two strategies, side by side

| | `fixed` | `structural` |
|---|---|---|
| Cuts on | token count | `##` headings |
| Step | `S − O` | section boundary |
| Chunks on this corpus | 12 | 19 |
| Breadcrumb | the document title | `Title → Section` |
| Fixes | a sentence straddling a cut | a rule separated from its scope |

---

## 4.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run chunks                       # both strategies, with counts and ids
CHUNK_SIZE=40 CHUNK_OVERLAP=8 npm run chunks
CHUNK_STRATEGY=fixed CHUNK_OVERLAP=0 npm run chunks
```

---

## 4.3 Full file

**Path:** `src/services/chunking.ts`

```ts
import type { Config } from "../config/config.js";
import type { Chunk, Document } from "../models/types.js";
import { contentHash } from "../utils/hash.js";

/**
 * Chapters 02 and 03 — chunking.
 *
 * A chunk is a promise that this text can be found, cited and reasoned about on
 * its own. Two strategies from the notes:
 *
 *   fixed       cut every `chunkSize` tokens, step by `chunkSize - chunkOverlap`
 *   structural  cut on the document's own headings (structure beats statistics)
 *
 * Both attach a **breadcrumb** (`Title → Section`) to the embedded text, because
 * "Electronic products can be returned within 7 days" is ambiguous without it.
 *
 * The `Chunk` contract lives in `models/types.ts` (Chapter 14) and the content
 * hash in `utils/hash.ts` (Chapter 15); this file owns *where* the cuts happen.
 */

function toChunk(doc: Document, index: number, breadcrumb: string, body: string): Chunk {
  const text = `${breadcrumb}\n${body}`.trim();
  return {
    id: `${doc.id}#${index}#${contentHash(text)}`,
    docId: doc.id,
    text,
    body: body.trim(),
    breadcrumb,
    category: doc.category,
    tenant: doc.tenant,
    acl: doc.acl,
    effectiveFrom: doc.effectiveFrom,
    supersededOn: doc.supersededOn,
  };
}

/**
 * Chapter 02 — fixed-size chunking with overlap.
 *
 *   step        = S - O
 *   chunk i     = tokens [i*step, i*step + S)
 *   chunk count = ceil((N - O) / (S - O))
 *
 * Overlap is insurance against a sentence straddling a cut. It does **not** fix
 * a rule separated from its exception — that is what Chapter 03 is for.
 */
export function fixedChunks(doc: Document, cfg: Config): Chunk[] {
  const size = Math.max(cfg.chunkSize, 1);
  const overlap = Math.min(Math.max(cfg.chunkOverlap, 0), size - 1);
  const step = size - overlap;
  const tokens = doc.text.split(/\s+/).filter(Boolean);
  const chunks: Chunk[] = [];

  for (let start = 0, index = 0; start < tokens.length; index++) {
    const window = tokens.slice(start, start + size);
    chunks.push(toChunk(doc, index, doc.title, window.join(" ")));
    if (start + size >= tokens.length) break;
    start += step;
  }
  return chunks;
}

/**
 * Chapter 03 — structural chunking.
 *
 * Cut where the document says to cut: on `##` headings. The heading path becomes
 * the breadcrumb, so the rule and its scope travel together.
 *
 * Note the Chapter 02 "parameter trap": Spring AI's `withMinChunkSizeChars(150)`
 * is the minimum length considered *while seeking a boundary*, not a strict
 * minimum chunk length — so this function does not merge small sections either.
 */
export function structuralChunks(doc: Document): Chunk[] {
  const sections: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } = { heading: doc.title, lines: [] };

  for (const line of doc.text.split("\n")) {
    if (line.startsWith("## ")) {
      sections.push(current);
      current = { heading: line.slice(3).trim(), lines: [] };
    } else if (line.startsWith("# ")) {
      continue; // the document title already owns the breadcrumb
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const kept = sections.filter((s) => s.lines.join(" ").trim().length > 0);
  return kept.map((section, index) =>
    toChunk(doc, index, `${doc.title} → ${section.heading}`, section.lines.join("\n")),
  );
}

/** Chapter 02 — the strategy is a switch, not a rewrite. */
export function chunkDocument(doc: Document, cfg: Config): Chunk[] {
  return cfg.chunkStrategy === "fixed" ? fixedChunks(doc, cfg) : structuralChunks(doc);
}

export function chunkCorpus(docs: Document[], cfg: Config): Chunk[] {
  return docs.flatMap((doc) => chunkDocument(doc, cfg));
}
```

---

## 4.4 Block-by-block explanation

**Block 1 — the Chunk type: three things a chunk must carry**

```ts
export type Chunk = {
  id: string;
  docId: string;
  text: string;
  body: string;
  breadcrumb: string;
  category: string;
  tenant: string;
  acl: string[];
  effectiveFrom: string;
  supersededOn?: string;
};
```

- The notes' rule: *"a chunk must carry its breadcrumb, its metadata and a
  deterministic id."* This type is that sentence.
- **`text` vs `body`** is the most important distinction in the file. `text` is
  what gets **embedded** — breadcrumb plus body — because the heading is
  disambiguating context (Chapter 03). `body` is what gets **displayed**, because a
  citation should not repeat the heading twice.
- The metadata fields are copied from the document, not looked up later. That is
  deliberate: the filter in Chapter 06 is evaluated per chunk, so every chunk must
  be independently filterable.

**Block 2 — the deterministic id**

```ts
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
```

- FNV-1a: a 32-bit hash in nine lines, no dependency. `Math.imul` keeps the
  multiplication in 32-bit space; `>>> 0` converts the signed result back to an
  unsigned integer.
- Why a content hash at all? Chapter 02's id table:

  | scheme | re-ingest behaviour |
  |---|---|
  | `source + index` | an edited policy reuses the old id |
  | **`source + index + contentHash`** | same text → same id; edited text → new id |
  | random UUID | duplicates on every run |

  With the hash, re-ingesting an unchanged corpus is **idempotent**, and an edited
  document produces *new* ids — which is what makes delete-by-source safe.

**Block 3 — `toChunk`, the one place a chunk is constructed**

```ts
function toChunk(doc: Document, index: number, breadcrumb: string, body: string): Chunk {
  const text = `${breadcrumb}\n${body}`.trim();
  return {
    id: `${doc.id}#${index}#${contentHash(text)}`,
    ...
  };
}
```

- Every chunk in the project goes through this function, so there is exactly one
  definition of "what a chunk is". The two chunkers differ only in how they
  compute `breadcrumb` and `body`.
- The id format `docId#index#hash` is readable on purpose: `npm run chunks` prints
  it, and `docId` is recoverable by splitting on `#` — which is exactly what
  `eval.ts` does to map a retrieved chunk back to a document.

**Block 4 — fixed-size chunking and the overlap arithmetic**

```ts
const size = Math.max(cfg.chunkSize, 1);
const overlap = Math.min(Math.max(cfg.chunkOverlap, 0), size - 1);
const step = size - overlap;
```

- Two lines of defensive clamping, and they matter:
  - `size >= 1` — a zero-size window would loop forever.
  - `0 <= overlap <= size - 1` — an overlap equal to `size` makes `step = 0`,
    which would also loop forever, and an overlap larger than the window is
    meaningless.
- `step = S − O` is Chapter 02's first formula. With `S = 40`, `O = 8`, the window
  advances 32 tokens at a time, and the last 8 tokens of one chunk are the first 8
  of the next.

```ts
for (let start = 0, index = 0; start < tokens.length; index++) {
  const window = tokens.slice(start, start + size);
  chunks.push(toChunk(doc, index, doc.title, window.join(" ")));
  if (start + size >= tokens.length) break;
  start += step;
}
```

- `tokens.slice(start, start + size)` is `chunk i = tokens [i·step, i·step + S)`.
- The `break` *before* `start += step` is what makes the count
  `ceil((N − O) / (S − O))` instead of producing a final, mostly-duplicate window.
- **Note the breadcrumb is just `doc.title`.** Fixed chunking is *structure-blind*:
  it does not know the text contains `##` headings, so those markers end up inside
  the embedded text. `npm run chunks` shows this — the fixed chunk for the
  electronics policy literally starts with
  `# Electronics Return Policy ## Scope`. That is the honest cost of cutting on
  token count.

**Block 5 — structural chunking**

```ts
  for (const line of doc.text.split("\n")) {
    if (line.startsWith("## ")) {
      sections.push(current);
      current = { heading: line.slice(3).trim(), lines: [] };
    } else if (line.startsWith("# ")) {
      continue; // the document title already owns the breadcrumb
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
```

- A three-branch line scanner — this is the whole "cut where the document says to
  cut" idea:
  - `## ` starts a new section: flush the previous one and begin a new heading.
  - `# ` is the document title, which is already in the breadcrumb, so it is
    dropped from the body (otherwise it would be embedded twice).
  - anything else is content for the current section.
- `sections.push(current)` *after* the loop flushes the final section — the
  classic off-by-one in any accumulate-and-flush loop.

```ts
  const kept = sections.filter((s) => s.lines.join(" ").trim().length > 0);
  return kept.map((section, index) =>
    toChunk(doc, index, `${doc.title} → ${section.heading}`, section.lines.join("\n")),
  );
```

- `kept` drops empty sections (a heading with no body), so the index stays dense.
- The breadcrumb is `Title → Section`. That arrow string is the single most
  valuable piece of text in the project: it turns *"can be returned within 7
  days"* into *"Electronics Return Policy → Return window: can be returned within
  7 days"*.
- Note what this function deliberately does **not** do: merge small sections. The
  header comment records why — Spring AI's `withMinChunkSizeChars(150)` is a
  boundary-*seeking* minimum, not a strict minimum chunk length, and implementing
  it as a merge would silently produce different chunks than the framework it
  documents (Chapter 02's parameter trap).

**Block 6 — the switch and the corpus map**

```ts
export function chunkDocument(doc: Document, cfg: Config): Chunk[] {
  return cfg.chunkStrategy === "fixed" ? fixedChunks(doc, cfg) : structuralChunks(doc);
}

export function chunkCorpus(docs: Document[], cfg: Config): Chunk[] {
  return docs.flatMap((doc) => chunkDocument(doc, cfg));
}
```

- The strategy is a **switch, not a rewrite** — Chapter 02's point about chunking
  being configuration. Turning `structural` into `fixed` is one environment
  variable, and the ablation can measure the difference.
- `flatMap` is `map` + `flatten` in one pass: seven documents become twelve or
  nineteen chunks in a single expression.

---

## 4.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run chunks
```

Expected (excerpt):

```text
chunk size = 40 tokens, overlap = 8 tokens
step = S - O = 32   storage multiplier = S / (S - O) = 1.25x

fixed: 12 chunks
  return-policy-general#0#9cfdc319
    General Return Policy
  ...
structural: 19 chunks
  return-policy-electronics#1#7cfa05be
    Electronics Return Policy → Return window
  ...

── the same document, both ways ──────────────────────
fixed:
  • # Electronics Return Policy ## Scope This policy overrides the general return policy for all electronic products, including headphones and speakers. ## Return window Electronic products can be returned within 7 days of delivery. ## Fast charging Charging behaviour is
  • of delivery. ## Fast charging Charging behaviour is described in the product datasheet, not in this policy.
structural:
  • Electronics Return Policy → Scope
    This policy overrides the general return policy for all electronic products, including headphones and speakers.
  • Electronics Return Policy → Return window
    Electronic products can be returned within 7 days of delivery.
```

Three things to notice in that output:

1. **`1.25x`** — the storage multiplier `S / (S − O)` from the notes. The same text
   now costs 25% more vectors.
2. **The fixed chunks keep the markdown** and cut mid-sentence (`• of delivery.`)
   — structure-blindness, visible.
3. **The structural chunks are self-describing** — each one names its own section.

---

## 4.6 Checkpoint

1. **What is the difference between `text` and `body` on a `Chunk`?** `text`
   (breadcrumb + body) is embedded; `body` alone is displayed.
2. **Why `docId#index#contentHash` and not `docId#index`?** So re-ingesting
   unchanged text is idempotent and an edited document gets new ids — the
   prerequisite for safe delete-by-source.
3. **What does overlap fix, and what does it not?** It fixes a sentence straddling
   a cut; it does not fix a rule separated from its exception — that is structure.

**Next:** [Chapter 05 — Embeddings and the analyzer](./05_Embeddings_and_the_Analyzer.md)


