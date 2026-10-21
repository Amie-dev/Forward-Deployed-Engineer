# Chapter 04: Chunking

> **Chapter Goal:** Turn one document into retrievable, citable, idempotently-identifiable chunks. Chunking is not preprocessing — it sets the ceiling on what retrieval can ever find.

> **Lecture mapping:** Notes Chapter 03, sections on chunk size, overlap, structure-aware splitting, metadata and deterministic ids.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/ingest/chunker.ts` | 108 | Section splitting, token windows with overlap, ids, embedding text. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run demo | sed -n '18,24p'
# refund-policy.md        6 chunks  first: "Refund window"
# shipping-policy.md      7 chunks  first: "Delivery options"
# warranty-policy.md      6 chunks  first: "Warranty covers"
# indexed 19 chunks / 870 tokens
```

Change the window and watch the count move:

```bash
CHUNK_SIZE=150 CHUNK_OVERLAP=25 npm run demo | sed -n '18,24p'
```

Smaller windows produce more chunks and sharper matches; larger windows produce fewer, broader ones. That trade-off is the whole subject of this chapter.

---

## 2. The Chunker — `src/ingest/chunker.ts`

#### 📄 `src/ingest/chunker.ts`

```ts
import { getEncoding, type Tiktoken } from 'js-tiktoken';

import { sha256 } from '../lib/text.js';
import type { Chunk, SourceDocument } from '../types/rag.types.js';

export interface ChunkOptions {
  /** Target window size, in tokens. 300–500 is the usual sweet spot. */
  size: number;
  /** Tokens repeated at the start of the next window, so a rule is never cut in half. */
  overlap: number;
}

let cached: Tiktoken | undefined;

/** cl100k_base is the tokenizer used by text-embedding-3-* and GPT-4-class models. */
function tokenizer(): Tiktoken {
  cached ??= getEncoding('cl100k_base');
  return cached;
}

export function countTokens(text: string): number {
  return tokenizer().encode(text).length;
}

/**
 * Split a document into retrievable chunks.
 *
 * Two passes, because one is not enough:
 *   1. Structure — markdown headings become sections, so a chunk never mixes
 *      refund rules with shipping rules and every chunk inherits a real label.
 *   2. Size — each section is cut into overlapping token windows. A 300-token
 *      chunk with 50 tokens of overlap means a rule that straddles a boundary
 *      still appears whole in at least one chunk.
 *
 * Ids are `sha256(source:index:text)`, so re-ingesting unchanged documents
 * rewrites the same rows instead of duplicating the index.
 */
export function chunkDocument(document: SourceDocument, options: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of splitSections(document.text, document.title)) {
    for (const piece of splitByTokens(section.body, options.size, options.overlap)) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: sha256(document.source, String(chunkIndex), piece),
        text: piece,
        source: document.source,
        section: section.heading,
        chunkIndex,
        tokens: countTokens(piece),
      });
    }
  }

  return chunks;
}

/**
 * The string that is actually embedded.
 *
 * Retrieval only ever matches what the model has seen. Prefixing the document
 * and section name gives a bare sentence like "Apparel: 3 days." enough context
 * to be found by "refund window for apparel".
 */
export function toEmbeddingText(chunk: Chunk): string {
  return `${chunk.source} › ${chunk.section}\n${chunk.text}`;
}

interface Section {
  heading: string;
  body: string;
}

/** Headings are cheap structure. Use them before falling back to blind windows. */
function splitSections(text: string, fallbackTitle: string): Section[] {
  const sections: Section[] = [];
  let heading = fallbackTitle;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body) sections.push({ heading, body });
  };

  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1];
      continue;
    }
    buffer.push(line);
  }

  flush();
  return sections;
}

function splitByTokens(text: string, size: number, overlap: number): string[] {
  const encoder = tokenizer();
  const tokens = encoder.encode(text);

  if (tokens.length === 0) return [];
  if (tokens.length <= size) return [text.trim()];

  const stride = Math.max(1, size - overlap);
  const pieces: string[] = [];

  for (let start = 0; start < tokens.length; start += stride) {
    const piece = encoder.decode(tokens.slice(start, start + size)).trim();
    if (piece) pieces.push(piece);
    // Taking the last full window and stopping keeps the tail from becoming a
    // 12-token chunk that embeds to noise.
    if (start + size >= tokens.length) break;
  }

  return pieces;
}
```

**Block by block:**

- **`ChunkOptions`** — `size` and `overlap` in tokens, not characters. A character budget drifts between English, code and non-Latin scripts; a token budget is what the embedding model and the invoice actually count.
- **`tokenizer()`** — a lazily created singleton around `cl100k_base`. Building the BPE table is not free, and ingestion calls `encode` thousands of times.
- **`countTokens`** — exported because three other modules need it: the context assembler (chapter 08), the ingest report, and any future budget check.
- **`chunkDocument`** — two nested loops, and the order matters: *sections first, then windows*. A window that straddled two `##` headings would produce a chunk that is half refund policy and half shipping policy, and no query could match it well.
- **`splitSections`** — walks lines, and each `#{1,6} ` heading starts a new section. `flush()` pushes the previous section only if it has a body, so the document's `# H1` title (which has no body before the first `##`) is skipped instead of becoming an empty chunk.
- **`splitByTokens`** — the sliding window:
  - `if (tokens.length <= size) return [text.trim()]` — short sections stay whole.
  - `stride = size - overlap` — the step between window starts. With `size=300, overlap=50`, windows start every 250 tokens.
  - `encoder.decode(tokens.slice(start, start + size))` — decoding back to text, because the store and the prompt need strings, not token ids.
  - `if (start + size >= tokens.length) break` — the tail rule. Without it, the loop emits a final 12-token fragment that embeds to noise and can outrank a real chunk on a short query. The last full window already contains the tail.
  - `if (piece) pieces.push(piece)` — guards against a window that decodes to whitespace only.
- **`sha256(document.source, String(chunkIndex), piece)`** — the id. Stable for identical bytes, different for any edit. That is the property that makes re-ingestion idempotent and makes deleting stale chunks possible.
- **`tokens: countTokens(piece)`** — stored on the chunk, so the context budget can be computed without decoding text again.
- **`toEmbeddingText`** — what actually gets embedded:

```text
refund-policy.md › Refund window
Customers may request a refund within the following windows…
```

The header is not decoration. A bare sentence like `- Apparel: 3 days.` is nearly unretrievable on its own; with `refund-policy.md › Refund window` in front of it, the same sentence answers "refund window for apparel".

### The arithmetic, concretely

For one section of 700 tokens with `size=300, overlap=50`:

| Window | Token range | New tokens |
| :--- | :--- | ---: |
| 1 | 0 – 299 | 300 |
| 2 | 250 – 549 | 250 |
| 3 | 500 – 699 | 200 |

Three chunks, 50 tokens of shared context between neighbours. The general count is `ceil((T − overlap) / (size − overlap))`, which for `T = 700` gives `ceil(650 / 250) = 3`.

### Why overlap exists

A rule that straddles a boundary would otherwise be cut in half:

```text
chunk 1: … Refunds for apparel are accepted within 3
chunk 2: days of delivery, provided the tags are attached …
```

Neither chunk answers "what is the apparel refund window?". With 50 tokens of overlap, at least one window contains the whole sentence. Overlap is insurance paid in storage and index size — 10–20% of the chunk size is the usual premium.

---

## 3. What a Chunk Actually Contains

Running the chunker on the refund policy produces chunks like this one:

```text
source     refund-policy.md
section    Refund window
chunkIndex 0
tokens     91
id         3f9c… (sha256 of source:0:text)
text       Customers may request a refund within the following windows, measured
           from the delivery date:

           - Apparel (shirts, jackets, dresses): 3 days.
           - Footwear (shoes, boots, sandals): 7 days.
           - Electronics (phones, laptops, headphones): 14 days.

           Requests opened after the window has closed are declined automatically
           by the returns system.
```

Everything a citation needs is present: which file, which section, which position. Everything a debugger needs is present too: the token count explains why it fit, the id explains which record to delete.

### Chunk size is a decision, not a default

| If chunks are… | Retrieval looks like | Fix |
| :--- | :--- | :--- |
| Too large (1500+ tokens) | Near-misses; the answer is in there but diluted by three other topics | 300–500, or parent-child retrieval |
| Too small (< 100 tokens) | Fragmentary answers; rules split across chunks | 400–600, or merge sections |
| Overlap too high (> 50%) | Duplicate hits, wasted context budget | 10–20% overlap + dedupe |
| Boundaries ignore structure | A clause cut in half | Section-aware splitting (this file) |
| Tables flattened at extraction | Numbers attached to the wrong row | Element-aware parsing, then chunk |

The only reliable way to choose is to measure: change `CHUNK_SIZE`, run `npm run eval`, compare recall@4 and the expected-fact count.

---

## 4. Verify the Chapter

```bash
npm run ingest
# [ingest] store=memory documents=3 chunks=19 tokens=870 31ms
```

```bash
npm run demo | sed -n '30,46p'    # the prompt shows real chunk boundaries
```

Look for two things in that output: every block starts with `[n] source · section`, and no block ends mid-sentence. If a block ends mid-rule, your window is too small relative to the overlap — or the document has a paragraph longer than the window, which is the case overlap exists for.

**Next:** [Chapter 05 — Embedding Providers](./05_Embedding_Providers.md)
