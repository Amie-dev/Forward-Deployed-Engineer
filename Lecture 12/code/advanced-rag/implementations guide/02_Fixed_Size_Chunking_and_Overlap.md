# Chapter 02: Fixed-Size Chunking and Overlap

> **Chapter Goal:** Implement the baseline chunker properly — character windows *and*
> token windows — then measure what it costs: chunk count, storage multiplier, and the
> orphans it leaves behind. The failure has to be honest before the fix means anything.

> **Lecture mapping:** Notes Chapter 02 — why chunk at all, the sliding window, what overlap
> buys and what it costs, and the arithmetic of window size against document length.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/ingest/fixed-chunker.ts` | 124 | char and token windows, the advance guard, orphan detection, stats |
| `src/cli.ts` (`chunkReport`) | 60 | the comparison across five configurations |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- chunks          # the numbers per strategy
npm run cli -- chunks detail   # what the chunks actually look like
```

---

## 2. Measured Output

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts chunks detail

Corpus: 8 documents

strategy                   chunks  avg tok  storage  orphans  first breadcrumb
─────────────────────────  ──────  ───────  ───────  ───────  ──────────────────────────────────────────────────
fixed · 1,000 chars / 150  31      177      1.14×    22       —
fixed · 400 tokens / 80    17      326      1.15×    7        —
fixed · 400 tokens / 200   20      361      1.5×     12       —
structural · 400 / 80      27      172      0.96×    0        Damaged and Faulty Goods Policy › Reporting window
semantic · 400 max         73      62       0.94×    41       Damaged and Faulty Goods Policy

Orphans = chunks under 30 tokens or starting mid-sentence. They match on a
stray word and carry no subject to contradict the match.


Fixed · 1,000 chars / 150 — no heading, no parent, no context:
#  source         heading  tok  parent  context  text…
─  ─────────────  ───────  ───  ──────  ───────  ──────────────────────────────────
1  damaged-goods  (none)   210  no      no       # Damaged and Faulty Goods Policy
2  damaged-goods  (none)   205  no      no       licy. ## What the customer gets
3  damaged-goods  (none)   207  no      no       and one of the shipping box with t
4  damaged-goods  (none)   207  no      no       Escalation If a replacement is ou
5  damaged-goods  (none)   194  no      no       between EUR 50 and EUR 200 require
6  damaged-goods  (none)   110  no      no       ed after delivery. Claims that in


Structural · 400 tokens / 80 + contextual prefix:
#  source         heading                    tok  parent  context  text…
─  ─────────────  ─────────────────────────  ───  ──────  ───────  ──────────────────────────────────
1  damaged-goods  Reporting window           168  yes     yes      Damage or a fault that is visible
2  damaged-goods  What the customer gets     246  yes     yes      A validated transit-damage claim i
3  damaged-goods  Concealed damage           152  yes     yes      Damage that is only discovered aft
4  damaged-goods  Escalation matrix          385  yes     yes      The escalation path depends on the
5  exchanges      Exchange window            161  yes     yes      An item may be exchanged within 14
6  exchanges      Electronics and clearance  210  yes     yes      Electronics may be exchanged only
```

Five things are visible here, and each one is a decision:

1. **`fixed · 1,000 chars / 150` produces 31 chunks at 177 tokens average** — and
   **22 orphans**. The chunk count is not the problem; the orphans are. Look at the detail
   table: chunk 2 starts `licy. ## What the customer gets`, which is mid-word, and every
   chunk carries `heading = (none)`.
2. **Token windows are more predictable.** `400 tokens / 80` gives 17 chunks at 326 tokens.
   The same nominal size in characters gives 31 chunks at 177 tokens, because characters and
   tokens are not proportional.
3. **Overlap is not free.** Raising overlap from 80 to 200 tokens moves the storage
   multiplier from 1.15× to 1.5× for the *same* corpus: 50% more vectors to store, embed and
   search, for a marginal gain in boundary coverage.
4. **`structural · 400 / 80` has zero orphans** at 27 chunks and 172 tokens average, with a
   storage multiplier of **0.96×** — lower than the fixed chunker, because headings and
   merged siblings waste nothing.
5. **`semantic · 400 max` is a warning, not a win.** 73 chunks at 62 tokens with 41 orphans:
   the similarity threshold that looked reasonable produced fragments. This is why semantic
   chunking is not the default (Chapter 03 discusses it properly).

---

## 3. The Chunker — `src/ingest/fixed-chunker.ts`

```ts
import { countTokens, sha256, tokenizer } from '../lib/text.js';
import type { Chunk, SourceDocument } from '../types.js';

/**
 * Fixed-size chunking — the baseline, implemented properly so its failure is
 * honest rather than an artifact of a bug.
 *
 * Two units, because real systems use both:
 *  - `chars`: what most quick-start tutorials do (1,000 characters, 150 overlap).
 *    Characters are cheap and wrong: a 1,000-character window is 180 tokens of
 *    German or 320 tokens of English, so token budgets move underneath you.
 *  - `tokens`: what an embedding model actually counts. A 400-token window with
 *    80 tokens of overlap is a defensible starting point.
 *
 * What this chunker cannot do is the point of the next chapter: it has no idea
 * what a heading is, so every chunk it produces has `heading: ''`, no breadcrumb,
 * and no parent. `chunkIndex` is the only position information it keeps.
 */

export interface FixedChunkOptions {
  size: number;
  overlap: number;
  unit: 'tokens' | 'chars';
}

export function chunkFixed(doc: SourceDocument, options: FixedChunkOptions): Chunk[] {
  const stride = options.size - options.overlap;

  // Chapter 02's classic bug: overlap >= size means the window never advances,
  // and the ingestion loop either hangs or emits thousands of duplicates.
  if (stride <= 0) {
    throw new Error(`Invalid chunking: size=${options.size}, overlap=${options.overlap} never advances.`);
  }

  const pieces =
    options.unit === 'tokens'
      ? splitByTokens(doc.text, options.size, options.overlap)
      : splitByChars(doc.text, options.size, options.overlap);

  return pieces.map((piece, index) => ({
    id: sha256(doc.source, 'fixed', index, piece),
    text: piece,
    source: doc.source,
    title: doc.title,
    heading: '',
    breadcrumb: '',
    chunkIndex: index,
    tokens: countTokens(piece),
    parentId: null,
    meta: doc.meta,
  }));
}

function splitByTokens(text: string, size: number, overlap: number): string[] {
  const encoder = tokenizer();
  const tokens = encoder.encode(text);
  if (tokens.length === 0) return [];
  if (tokens.length <= size) return [text.trim()];

  const stride = size - overlap;
  const pieces: string[] = [];

  for (let start = 0; start < tokens.length; start += stride) {
    const piece = encoder.decode(tokens.slice(start, start + size)).trim();
    if (piece) pieces.push(piece);
    if (start + size >= tokens.length) break;
  }

  return pieces;
}

function splitByChars(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text.trim()];

  const stride = size - overlap;
  const pieces: string[] = [];

  for (let start = 0; start < text.length; start += stride) {
    const raw = text.slice(start, start + size);
    // Snap forward to the next space so a word is not cut in half. The cost is a
    // window that is a few characters longer than requested — never shorter.
    const piece = start + size >= text.length ? raw : raw.slice(0, Math.max(raw.lastIndexOf(' '), 1));
    if (piece.trim()) pieces.push(piece.trim());
  }

  return pieces;
}

/**
 * Chunks that should never exist.
 *
 * An orphan is a chunk with no heading (blind window), that is too short to embed
 * meaningfully, or that starts mid-sentence. These are the chunks that produce
 * confident nonsense: they match a query on a stray word, and they carry no
 * subject to contradict the match.
 */
export function findOrphans(chunks: readonly Chunk[], minTokens = 30): Chunk[] {
  return chunks.filter((chunk) => {
    const startsMidSentence = /^[a-z(]/.test(chunk.text);
    return chunk.tokens < minTokens || startsMidSentence;
  });
}

export interface ChunkStats {
  chunks: number;
  tokens: number;
  averageTokens: number;
  orphans: number;
  /** Chunks ÷ documents covered if the corpus were one stream — the 1/(1-ρ) factor. */
  storageMultiplier: number;
}

export function chunkStats(docs: readonly SourceDocument[], chunks: readonly Chunk[], options: FixedChunkOptions): ChunkStats {
  const tokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
  const documentTokens = docs.reduce((sum, doc) => sum + countTokens(doc.text), 0);

  return {
    chunks: chunks.length,
    tokens,
    averageTokens: chunks.length === 0 ? 0 : Math.round(tokens / chunks.length),
    orphans: findOrphans(chunks).length,
    storageMultiplier: documentTokens === 0 ? 0 : Number((tokens / documentTokens).toFixed(2)),
  };
}
```

**Block by block:**

- **`FixedChunkOptions`** exposes the three things that matter: `size`, `overlap` and `unit`.
  Two units exist because both are used in the wild, and the difference is worth seeing:
  `chars` is what quick-start tutorials do, `tokens` is what an embedding model counts.
- **The advance guard** — `if (stride <= 0) throw` — is the single most valuable line in the
  file. Overlap greater than or equal to size means the window never advances; in production
  that is either an infinite loop or thousands of duplicate chunks, and it is discovered from
  a bill, not from a test. `env.ts` rejects the same combination at boot, so the failure is
  caught twice.
- **`splitByTokens`** encodes once, slices token ids, and decodes each window. It stops after
  the window that reaches the end, so the tail does not become a 12-token chunk that embeds
  to noise. The break condition (`start + size >= tokens.length`) is what prevents the classic
  duplicate-final-chunk bug.
- **`splitByChars`** snaps the *end* of a window forward to the last space, so a word is not
  cut in half. It does **not** snap the start, which is why the detail table shows chunk 2
  beginning mid-word: that is what real fixed chunkers do, and pretending otherwise would
  make the comparison dishonest.
- **`chunkFixed` produces chunks with `heading: ''`, `breadcrumb: ''` and `parentId: null`.**
  Those three empty fields are the entire reason the next chapter exists. Everything this
  chunker can know about position is `chunkIndex`.
- **`findOrphans`** flags two conditions: fewer than 30 tokens, or starting with a lowercase
  letter or `(` — that is, mid-sentence. An orphan will match on a stray word and carry no
  subject to contradict the match. It is the most common cause of a confidently wrong answer,
  and it is invisible without a report like this.
- **`chunkStats`** computes the storage multiplier as `chunk tokens ÷ document tokens` — the
  honest cost of overlap. It is what turns "let's raise overlap to be safe" into a number.

---

## 4. The Arithmetic, Checked Against the Code

The numbers in the notes are not decoration; they are what this chunker produces. For a
document of `N` tokens, a window of `S` with overlap `O`:

```text
stride        = S − O
chunk count   = ceil((N − O) / stride)
storage       ≈ S / stride  =  S / (S − O)
```

Applied to the same 8-document corpus, with the measured values from `npm run cli -- chunks`:

| size | overlap | overlap % | stride | chunks | storage | orphans |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 400 | 0 | 0% | 400 | 16 | 1.00× | — |
| 400 | 80 | 20% | 320 | 17 | 1.15× | 7 |
| 400 | 200 | 50% | 200 | 20 | 1.50× | 12 |
| 1,000 chars | 150 | 15% | 850 | 31 | 1.14× | 22 |

Two conclusions, both visible in the table:

- **Overlap is a recall insurance premium, and it is priced per token.** Doubling overlap
  does not double coverage of a boundary — a rule that straddles a boundary is either caught
  by a window or it is not — but it does add 35% more vectors between the first and third
  rows.
- **Character windows are not comparable across languages or documents.** The 1,000-character
  window produced 31 chunks at 177 tokens; a German version of the same policies would
  produce 180-token chunks from the same 1,000 characters. `CHUNK_UNIT=tokens` removes that
  variable, which is why it is the default.

---

## 5. Reading the Orphans

The 22 orphans in the 1,000-character configuration come in three flavours, all visible in
the detail table:

| Symptom | Example from the output | Why it is dangerous |
| :--- | :--- | :--- |
| Starts mid-word | `licy. ## What the customer gets` | The chunk has no subject. A query about "customer" matches it; nothing in the chunk says *what* customer rule it is. |
| No heading | every row shows `(none)` | The chunk cannot be cited precisely, and it cannot be found by its own section title. |
| Markdown markers inside | `## What the customer gets` inside the text | `##` is embedded as content and adds noise to the vector. |

None of these are bugs in the chunker — they are the *definition* of chunking without
structure. The repair is the next chapter, and the report is how you know when it worked:
`structural` shows **0 orphans**.

---

## 6. What to Take Away

- **A sliding window is a position, not a unit of meaning.** `chunkIndex` is all it knows.
- **Overlap costs `S / (S − O)` in storage.** Say the number out loud before choosing 50%.
- **Guard the stride.** `overlap >= size` is the bug that costs money at 3 a.m.
- **Count orphans.** A chunk under 30 tokens or starting mid-sentence is a wrong answer
  waiting for a query that happens to share a word with it.
- **Measure in tokens.** Characters are a proxy that changes meaning across languages.

> **Where This Goes Next:** [Chapter 03](./03_Structural_Semantic_and_Contextual_Chunking.md)
> fills in the three fields this chunker leaves empty — `heading`, `breadcrumb` and
> `parentId` — and adds the context prefix that makes a bare sentence findable.

