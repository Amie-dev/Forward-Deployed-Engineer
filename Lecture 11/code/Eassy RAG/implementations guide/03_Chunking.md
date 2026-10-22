# Chapter 03: Chunking

> **Chapter Goal:** Turn one long string of PDF text into the retrieval units the rest of the system treats as atomic — and understand exactly where the boundaries land, why the overlap is approximate, and the one input shape that makes the loop throw.

> **Lecture mapping:** Chapter 03 (Ingestion — documents to chunks). The notes' board example `1–1000 / 801–1800` is reproduced here as `1–1000 / 851–1850` because this code uses a 150-character overlap.

> **File details:**

| | |
| :--- | :--- |
| **Path** | `src/chunking.js` |
| **Lines** | 64 |
| **Imports** | `config` from `./config.js` |
| **Exports** | `chunkText(text, chunkSize?, overlap?)` |
| **Side effects** | none — pure function |
| **Used by** | `src/indexPdf.js` |

---

## 1. What a chunker actually decides

Everything downstream inherits this file's decisions:

| Decision made here | Consequence later |
| :--- | :--- |
| A chunk is ≤ 1,000 characters | The embedding model sees one coherent-ish fragment per vector |
| Chunks overlap by 150 | A sentence split by a boundary still appears whole in one of them |
| Chunks never end mid-word | Retrieval returns readable text, and the model does not see `middlew` |
| Whitespace is collapsed | Offsets are predictable; paragraph structure is lost |
| No metadata is attached | The payload's `chunkIndex` is the only locator |

That last row is the biggest limitation of this chunker, and it is the one the notes call *chunking is the ceiling*: if the boundary splits an answer across two chunks, no amount of embedding quality or prompt engineering recovers it.

---

## 2. Complete source code

#### 📄 `src/chunking.js`

```js
import { config } from "./config.js";

export function chunkText(
  text,
  chunkSize = config.chunking.chunkSize,
  overlap = config.chunking.chunkOverlap
) {
  if (typeof text !== "string") {
    throw new TypeError("Text must be a string");
  }

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("Chunk size must be a positive integer");
  }

  if (
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= chunkSize
  ) {
    throw new Error(
      "Chunk overlap must be non-negative and smaller than chunk size"
    );
  }

  const clean = text.replace(/\s+/g, " ").trim();

  if (!clean) return [];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);

    // Prefer a whitespace boundary to avoid splitting words.
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(" ", end);

      if (lastSpace > start) {
        end = lastSpace;
      }
    }

    const chunk = clean.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= clean.length) break;

    const nextStart = end - overlap;

    // Defensive check to ensure the loop always progresses.
    if (nextStart <= start) {
      throw new Error("Chunking failed to advance");
    }

    start = nextStart;
  }

  return chunks;
}
```

The whole algorithm is 30 effective lines: *take a window of up to `chunkSize`, pull its end back to the last space, push the slice, step forward by `size - overlap`, repeat.*


---

## 3. Block by block

### 3.1 Signature — defaults come from config, but callers can override

```js
import { config } from "./config.js";

export function chunkText(
  text,
  chunkSize = config.chunking.chunkSize,
  overlap = config.chunking.chunkOverlap
) {
```

- The defaults are **evaluated at call time**, not at import time, which requires `config.js` to have run before the first call. Import order handles that: `chunking.js` imports `config.js`.
- The two optional parameters exist so the function is testable in isolation. Every experiment in this chapter (`chunkSize 100 / overlap 20`) uses them.
- No options object, no strategy enum. A second strategy later means a second exported function (`chunkByHeadings`), not a branch inside this one.

### 3.2 Argument validation — three checks, before any work

```js
if (typeof text !== "string") {
  throw new TypeError("Text must be a string");
}

if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
  throw new Error("Chunk size must be a positive integer");
}

if (
  !Number.isInteger(overlap) ||
  overlap < 0 ||
  overlap >= chunkSize
) {
  throw new Error(
    "Chunk overlap must be non-negative and smaller than chunk size"
  );
}
```

- **`TypeError` for the wrong type, `Error` for a bad value.** A deliberate distinction: `TypeError` is a caller bug, `Error` is a bad number. Both messages are actionable.
- **`!Number.isInteger(overlap)`** rejects `NaN`, `"150"` and `1.5`. It matters because the parameter has a default: a caller who passes `undefined` gets the default, but a caller who passes `"150"` gets this error instead of a string-concatenation bug further down.
- **`overlap >= chunkSize`** is the same rule as `config.js`, repeated because `chunkText` can be called with explicit arguments that never passed through the environment. Verified message:

  ```
  Chunk overlap must be non-negative and smaller than chunk size
  ```

  Note that `overlap = 0` **is** allowed here, even though `.env` cannot express it (Chapter 02 §3.2).

### 3.3 Normalisation — the line that rewrites the document

```js
const clean = text.replace(/\s+/g, " ").trim();
```

One regex rewrites the entire input:

| Input | Output |
| :--- | :--- |
| `"Line one\nLine two"` | `"Line one Line two"` |
| `"a\t\tb"` | `"a b"` |
| `"para\n\n\npara"` | `"para para"` |
| `"  padded  "` | `"padded"` |

Why do it:

- **Deterministic offsets.** PDF extraction emits ragged whitespace — soft wraps, multiple spaces between columns, stray form feeds. Collapsing them makes chunk lengths predictable and stops a chunk from being 30% whitespace.
- **The word snap depends on one separator.** `lastIndexOf(" ")` only works if spaces are the separator; normalising first means no chunk ends on a tab or newline the snap cannot see.

What it costs:

- **Paragraph structure is destroyed.** Headings lose their isolation, lists collapse into running text, and code blocks lose indentation. A chunk can begin mid-list or mid-table-row.
- **Layout-aware PDFs get worse.** Two-column documents often extract as interleaved lines; after collapsing, the interleaving is permanent.
- **No CJK handling.** Japanese/Chinese text has no spaces, so the snap never fires and chunks become hard 1,000-character cuts — still valid, just not word-aligned.

This is the distance between the notes' *structure-aware* chunking and this implementation: one regex and a character window here; paragraph-preserving, token-counted, heading-aware chunking in the sibling `Productions RAG` codebase.

### 3.4 The empty guard

```js
if (!clean) return [];
```

A scanned PDF with no text layer extracts to `""` or pure whitespace. Returning `[]` — not `[""]` — lets `indexPdf.js` detect the case and stop before calling the embedding API, which would reject an empty input with a 400. Chapter 06 shows that branch.

Verified: `chunkText("   \n\t ")` → `[]`.

### 3.5 The window loop — start, end, and the word snap

```js
const chunks = [];
let start = 0;

while (start < clean.length) {
  let end = Math.min(start + chunkSize, clean.length);

  // Prefer a whitespace boundary to avoid splitting words.
  if (end < clean.length) {
    const lastSpace = clean.lastIndexOf(" ", end);

    if (lastSpace > start) {
      end = lastSpace;
    }
  }
```

- **`end = min(start + chunkSize, length)`** — the ideal cut, clamped at the end of the document. Clamping is what lets the final chunk be short instead of out of range.
- **`if (end < clean.length)`** — the snap runs only for interior boundaries. The last chunk ends at the document end regardless of what character sits there.
- **`lastIndexOf(" ", end)`** — searches *backwards* from `end`, so the cut moves earlier, never later. Chunks are therefore ≤ `chunkSize`, never longer: measured 1,000-character maximum and 263-character minimum on a real deck, the minimum being the tail.
- **`if (lastSpace > start)`** — the floor. Without it, a very long unbroken token could pull `end` to `-1` or to a position at/before `start`, producing an empty or negative-length slice. With the floor, an unsplittable run is cut at exactly `start + chunkSize`, mid-word — the correct trade: a broken word beats a broken loop.
- **`slice` takes an exclusive `end`**, so `slice(0, 1000)` is exactly 1,000 characters. The space at index `end` remains as the first character of the next chunk and is removed by `.trim()` below.

### 3.6 Push, break, and the step

```js
    const chunk = clean.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= clean.length) break;

    const nextStart = end - overlap;

    // Defensive check to ensure the loop always progresses.
    if (nextStart <= start) {
      throw new Error("Chunking failed to advance");
    }

    start = nextStart;
  }

  return chunks;
}
```

- **`.trim()` on each chunk** — removes the leading space left by the snap and any trailing space before it. It is the reason chunk lengths in practice are 993–1,000 rather than exactly 1,000.
- **`if (chunk)`** — a chunk that is only whitespace is skipped rather than pushed. With the guards above this is rare, but it keeps `[]` the only representation of "nothing".
- **`if (end >= clean.length) break;`** — the terminal condition. Without it, the loop would compute `nextStart = length - overlap`, re-slice the tail and loop forever on the same final chunk.
- **`nextStart = end - overlap`** — the overlap is implemented by *rewinding* the start, which is what makes `1–1000 / 851–1850` instead of `1–1000 / 1001–2000`. Note that `end` here is the **snapped** end, so the rewind is measured from the actual cut, not from the ideal `start + chunkSize`.
- **The progress guard** — the loop invariant is `nextStart > start`, i.e. `end - overlap > start`. It is unreachable for normal prose, and it is the one place this chunker can throw on real input. §5 documents exactly when.
- **No return of offsets, page numbers or ids.** The caller gets strings only; Chapter 06 rebuilds locators from the array index.

---

## 4. Worked traces and measured numbers

### 4.1 The board example, with this code's numbers

The notes show `1–1000`, then `801–1800` — a 200-character overlap. This code uses 150, so the second chunk starts at 851:

| Chunk | Start | End (ideal) | Step from previous | Overlap with previous |
| :---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1000 | — | — |
| 2 | 850 | 1850 | 850 | 150 |
| 3 | 1700 | 2700 | 850 | 150 |
| 4 | 2550 | 3550 | 850 | 150 |

(1-based readers: chunk 1 covers characters 1–1000, chunk 2 covers 851–1850.) After snapping, each `end` lands a few characters earlier — the table is the ideal, and §4.3 shows the real lengths.

### 4.2 Chunk count formula

```text
approximate chunks ≈ ceil((length - overlap) / (chunkSize - overlap))
exact chunks        = ceil((length - overlap) / (chunkSize - overlap))   for length > chunkSize
```

With the defaults, divide by **850** and add a partial tail. Three measurements from this machine:

| Input | Characters | Chunks | Lengths |
| :--- | ---: | ---: | :--- |
| Synthetic prose, repeated sentence | 130,074 | **154** | 499–1,000 |
| `Lecture 01/notes/Notes.pdf` (57 pages) | 47,665 | **56** | 263–1,000 |
| `Lecture 10/notes/Notes.pdf` (57 pages) | 32,381 | **36** | 816–1,000 |

Two things to notice. First, **chunks scale with characters, not pages**: two 57-page decks differ by 47% in chunk count because one is denser. Second, the minimum length is not `chunkSize - overlap`: it is whatever the last partial window holds after snapping.

The practical consequence for the article's scenario — a 20-page, 20,000-word PDF — is the number the article quotes: roughly 130,000 characters, roughly **153 chunks**, and therefore **2 embedding requests** at `EMBEDDING_BATCH_SIZE=100` (100 + 53). This machine's 130,074-character synthetic text produced 154 chunks, one more than the article's illustration, because the synthetic text has no spaces at its final boundary.

### 4.3 The overlap is approximate, not exact

With word snapping and per-chunk `.trim()`, consecutive chunks do **not** share exactly the last/first 150 characters. Verified on a 1,200-character prose sample at `chunkSize 100, overlap 20`:

- 3 of 17 boundaries did not match exactly;
- **every** mismatch was whitespace only — `" alpha bravo charlie"` vs `"alpha bravo charlie "` — because `.trim()` removes the shared space from one side.

So the guaranteed property is: **the content is repeated, the exact characters may be shifted by whitespace.** That is enough for retrieval (a sentence broken at a boundary appears intact in one neighbour), and it is not enough for exact reconstruction of the original text. If you need byte-exact provenance, store offsets instead of trusting the overlap.


---

## 5. Known limitation: `Chunking failed to advance`

This is the one input shape that makes the loop throw instead of chunking. It is not hypothetical — PDFs produce it — so it belongs in the guide rather than in a footnote.

### 5.1 The condition

> The chunker throws when the document contains a run of **whitespace-free text at least `chunkSize - overlap` characters long** (850 by default) in the middle of the text.

Why: after a window snaps its `end` back to the last space `p`, the next window starts at `p - overlap` and extends to `p - overlap + chunkSize = p + 850`. If there is **no space** in `(p, p + 850]`, the next `lastIndexOf(" ")` returns `p` again, `end` becomes `p`, and `nextStart = p - overlap` equals the current `start` → the progress guard fires.

### 5.2 Verified repro

```js
import { chunkText } from "./src/chunking.js";

const prose = "alpha bravo charlie … ".repeat(30);          // ordinary text
chunkText(prose + "y".repeat(849) + " " + prose);           // ok  → 7 chunks
chunkText(prose + "y".repeat(850) + " " + prose);           // throws
chunkText(prose + "y".repeat(2000) + " " + prose);          // throws
```

| Input | Default `1000 / 150` |
| :--- | :--- |
| prose + 840-character token + prose | 7 chunks |
| prose + 849-character token + prose | 7 chunks |
| prose + **850**-character token + prose | **throws `Chunking failed to advance`** |
| prose + 2,000-character token + prose | **throws `Chunking failed to advance`** |
| 500-character runs with `chunkSize 100, overlap 20` | **throws** (the 500 > 80 gap) |
| 5,000 characters with **no spaces at all** | 6 chunks — the snap never fires, so no stall |

That last row is the counter-intuitive one: a *completely* space-free document is fine, because `lastIndexOf` returns `-1` and the floor `lastSpace > start` rejects it, leaving the hard `start + chunkSize` cut. The failure needs **spaces somewhere** plus **one long gap between them**.

### 5.3 What produces such a gap in a real PDF

- A long URL or a signed link (`https://…?token=…`) longer than 850 characters.
- Base64 blobs, JWTs, hashes, minified JSON or JavaScript embedded in a document.
- Tables extracted as one row per line with no inter-column spaces, or a wide table collapsed into one line.
- Chinese/Japanese pages where only a few spaces exist around Latin terms — the gaps between those spaces are enormous.
- A PDF page of monospaced code, where indentation survives extraction but word spacing does not.

### 5.4 The one-line fix

Change the snap condition so a boundary that cannot advance the window is rejected, and the loop falls back to the hard cut:

```js
    // Prefer a whitespace boundary to avoid splitting words.
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(" ", end);

      // Only snap when the snapped boundary can still advance the window.
      if (lastSpace > start && lastSpace - overlap > start) {
        end = lastSpace;
      }
    }
```

Verified with this exact patch, applied in a scratch copy of the file:

| Input | Before | After |
| :--- | :--- | :--- |
| prose + 849-token + prose | 7 chunks | 7 chunks |
| prose + 850-token + prose | throws | 7 chunks |
| prose + 2,000-token + prose | throws | 8 chunks |
| 500-character runs at `100 / 20` | throws | 20 chunks |
| 130,074-character prose | 154 chunks | **154 chunks, byte-identical content** |

So the patch is behaviour-preserving on ordinary text and turns a hard failure into an over-long-chunk cut on pathological text. It is **not** applied in the repository — this chapter documents the code as shipped. If you index real-world PDFs, apply it (or pre-clean the text: strip URLs, collapse base64 blobs).

---

## 6. Commands and verification

```bash
cd "Lecture 11/code/Eassy RAG"

# Syntax check
node --check src/chunking.js

# Behavioural probe (run it as ./probe.mjs so the relative import resolves)
cat > probe.mjs <<'EOF'
import { chunkText } from "./src/chunking.js";

console.log("defaults:", chunkText("hello world").length);        // 1
console.log("empty:", chunkText("   \n\t ").length);              // 0
console.log("short windows:", chunkText("alpha bravo ".repeat(50), 100, 20).length);
console.log("token 849:", chunkText("w ".repeat(400) + "y".repeat(849) + " " + "w ".repeat(400)).length);
try { chunkText("abc", 10, 10); } catch (e) { console.log("guard:", e.message); }
EOF
node probe.mjs
```

A full ingestion of a real 57-page deck measured on this machine:

```bash
node --input-type=module -e '
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { chunkText } from "./src/chunking.js";
const pdf = createRequire(import.meta.url)("pdf-parse/lib/pdf-parse.js");
const data = await pdf(await fs.readFile("../../../Lecture 01/notes/Notes.pdf"));
const chunks = chunkText(data.text);
console.log(data.numpages, "pages |", data.text.length, "chars |", chunks.length, "chunks");
'
# 57 pages | 47665 chars | 56 chunks
```

---

## 7. What this chapter established

| Property | Value |
| :--- | :--- |
| Unit | characters (not tokens) |
| Window | `chunkSize` = 1,000 |
| Step | `chunkSize - overlap` = 850 |
| Maximum chunk length | 1,000 characters |
| Minimum chunk length | whatever the tail holds (263 observed) |
| Overlap | approximate; whitespace may shift the boundary |
| Separator | single space, after `\s+` collapse |
| Output | `string[]`, no offsets, no metadata |
| Failure mode | >= 850-character whitespace-free run → throws (§5) |

**Next:** [Chapter 04 — Embeddings](./04_Embeddings.md)

