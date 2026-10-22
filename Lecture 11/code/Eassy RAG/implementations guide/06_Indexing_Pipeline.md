# Chapter 06: The Indexing Pipeline

> **Chapter Goal:** Compose loading, chunking, embedding and storage into one function that is safe to re-run: deterministic ids, validated counts, batched writes, and a clear stop when the PDF has no text.

> **Lecture mapping:** Chapter 03 (Ingestion) and Chapter 05 (The Vector Index) — this is where the notes' ingestion pipeline becomes an executable.

> **File details:**

| | |
| :--- | :--- |
| **Path** | `src/indexPdf.js` |
| **Lines** | 104 |
| **Imports** | `node:fs/promises`, `node:path`, `node:crypto`, `pdf-parse`, `config`, `chunkText`, `embedTexts`, `qdrant` + `ensureCollection` |
| **Exports** | `indexPdf({ filePath, documentId })` |
| **Side effects** | Reads a file, calls OpenAI, creates/upserts into Qdrant, logs progress |
| **Used by** | `npm run index`, any script that imports it |

---

## 1. The six steps

```text
1. ensureCollection()          → collection exists and matches EMBEDDING_DIMENSIONS
2. readPdfText(filePath)       → fs.readFile → pdf(buffer) → data.text
3. chunkText(text)             → string[]   (Chapter 03)
4. embedTexts(chunks)          → number[][] (Chapter 04)
5. build points                → { id, vector, payload } per chunk
6. upsert in batches of 100    → Qdrant, wait: true
```

Two design choices are visible in that list. Steps 1 and 6 both hit Qdrant *around* the expensive OpenAI step, so a misconfigured collection fails in milliseconds rather than after paying to embed 150 chunks. And step 5 happens after step 4 completes, so a partial embedding failure never produces a partial index.

---

## 2. Complete source code

#### 📄 `src/indexPdf.js`

```js
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pdf from "pdf-parse";

import { config } from "./config.js";
import { chunkText } from "./chunking.js";
import { embedTexts } from "./embeddings.js";
import { qdrant, ensureCollection } from "./qdrant.js";

async function readPdfText(filePath) {
  const buffer = await fs.readFile(filePath);
  const data = await pdf(buffer);

  return data.text ?? "";
}

// Convert a SHA-256 hash into a UUID-shaped deterministic point ID.
// Qdrant supports UUID strings for point IDs.
function createPointId(documentId, chunkIndex) {
  const hash = crypto
    .createHash("sha256")
    .update(`${documentId}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export async function indexPdf({ filePath, documentId }) {
  if (!documentId?.trim()) {
    throw new Error("documentId is required");
  }

  const collection = await ensureCollection();

  console.log(`Reading PDF: ${filePath}`);

  const text = await readPdfText(filePath);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    return {
      chunks: 0,
      message: "No extractable text found in PDF",
    };
  }

  console.log(`Extracted ${text.length} characters`);
  console.log(`Created ${chunks.length} chunks`);

  const vectors = await embedTexts(chunks);

  // Validate the total number of vectors.
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: ${vectors.length} vectors ` +
      `for ${chunks.length} chunks`
    );
  }

  // Build one point per chunk.
  const points = chunks.map((chunk, index) => ({
    id: createPointId(documentId, index),
    vector: vectors[index],
    payload: {
      text: chunk,
      source: path.basename(filePath),
      documentId,
      chunkIndex: index,
    },
  }));

  // Upload in batches rather than sending an unlimited number of points
  // in one Qdrant request.
  const uploadBatchSize = 100;

  for (let i = 0; i < points.length; i += uploadBatchSize) {
    const batch = points.slice(i, i + uploadBatchSize);

    await qdrant.upsert(collection, {
      wait: true,
      points: batch,
    });

    console.log(
      `Stored ${Math.min(i + batch.length, points.length)}/${points.length} points`
    );
  }

  return {
    chunks: chunks.length,
    vectors: vectors.length,
    dimensions: config.openai.embeddingDimensions,
    collection,
    documentId,
  };
}
```


---

## 3. Block by block

### 3.1 Imports — four Node built-ins, one package, four local modules

```js
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pdf from "pdf-parse";

import { config } from "./config.js";
import { chunkText } from "./chunking.js";
import { embedTexts } from "./embeddings.js";
import { qdrant, ensureCollection } from "./qdrant.js";
```

- **`node:` prefixes** make it explicit that these are built-ins, not npm packages — and they cannot be shadowed by a dependency called `fs`.
- **`fs/promises`** gives `await fs.readFile(filePath)` with no callback and no manual buffer handling.
- **`path`** is used for exactly one thing: `path.basename(filePath)`, so the payload records `backend-guide.pdf` and not `./documents/backend-guide.pdf`.
- **`crypto`** is the point-id hash (§3.4).
- **`pdf` (default import)** — this is the line that breaks on modern Node. Read §3.3 before you run it.
- **The local imports are ordered by pipeline stage**, which is also the dependency order: config → chunk → embed → store.

### 3.2 `readPdfText` — one function, four outcomes

```js
async function readPdfText(filePath) {
  const buffer = await fs.readFile(filePath);
  const data = await pdf(buffer);

  return data.text ?? "";
}
```

- **`fs.readFile` with no encoding** returns a `Buffer`, which is what `pdf-parse` expects; a UTF-8 string would corrupt binary streams.
- **`await pdf(buffer)`** runs pdf.js over the buffer and resolves to `{ numpages, text, info, metadata, version }`.
- **`?? ""`** normalises a missing `text` field to a string, so `chunkText`'s `typeof` guard is satisfied and the empty case flows into §3.5 instead of throwing.
- **What can go wrong, and what you see:**

  | Input | Behaviour |
  | :--- | :--- |
  | File missing / wrong path | `ENOENT: no such file or directory, open './documents/x.pdf'` |
  | Corrupt or encrypted PDF | pdf.js parse error (`PasswordException` for encrypted files) |
  | Scanned PDF with no text layer | `data.text === ""` → 0 chunks → clean early return |
  | Bad encoding / ligatures | Text arrives with `ﬁ`, `ﬂ` or replacement characters; nothing sanitises them here |

- **No page mapping.** `data.text` is the document concatenated; page boundaries are lost, so `chunkIndex` is the only locator the payload has. `data.numpages` is available and unused — extracting page by page would let you record the page per chunk, at the cost of N parser invocations.

Measured on this machine (`pdf-parse@1.1.1`, Node v24.22.0):

| File | Pages | Characters | Chunks |
| :--- | ---: | ---: | ---: |
| `Lecture 01/notes/Notes.pdf` | 57 | 47,665 | 56 |
| `Lecture 10/notes/Notes.pdf` | 57 | 32,381 | 36 |

### 3.3 ⚠️ The import that fails: `pdf-parse` under ESM

The line `import pdf from "pdf-parse"` is in the file as shipped, and on current Node it throws **before** any of your code runs:

```
Error: ENOENT: no such file or directory, open './test/data/05-versions-space.pdf'
    at Object.<anonymous> (.../node_modules/pdf-parse/index.js:15:25)
```

**Why.** `pdf-parse@1.1.1`'s `index.js` ends with a debug block:

```js
let isDebugMode = !module.parent;

if (isDebugMode) {
    let PDF_FILE = './test/data/05-versions-space.pdf';
    let dataBuffer = Fs.readFileSync(PDF_FILE);      // ← throws
    …
}
```

### 3.4 `createPointId` — deterministic UUIDs

```js
// Convert a SHA-256 hash into a UUID-shaped deterministic point ID.
// Qdrant supports UUID strings for point IDs.
function createPointId(documentId, chunkIndex) {
  const hash = crypto
    .createHash("sha256")
    .update(`${documentId}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}
```

- **Why not let Qdrant generate ids?** Auto-generated ids make re-indexing *append*: index the same PDF twice and you get 112 points, half of them duplicates with equal scores. Deterministic ids make the operation **idempotent** — an upsert to an existing id overwrites the vector and payload in place.
- **Why a hash and not `${documentId}-${chunkIndex}`?** Qdrant accepts either unsigned integers or UUID strings. `backend-guide-v1-0` is neither, so it must be UUID-shaped. The hash buys the shape and a fixed width.
- **Why `sha256` and not `randomUUID()`?** Random ids are not reproducible; the same chunk would get a new id on every run.
- **Why `documentId:chunkIndex` and not the chunk text?** Because the id must be stable when the chunk's *content* is re-embedded (for example with a new model). Content-hashed ids would create a second copy of every point when the text shifts by a character.
- **Inputs are string-interpolated**, so `("doc", 12)` → `"doc:12"` and `("doc1", 2)` → `"doc1:2"`. Two different pairs cannot collide through the separator, because the chunk index is always a number with no colon.
- **`slice(0, 32)`** takes 128 bits of the 256-bit digest: collision probability stays astronomically small for any realistic corpus, and 32 hex characters is exactly what a UUID needs.

Verified values for `documentId = "backend-guide-v1"`:

| chunkIndex | id |
| ---: | :--- |
| 0 | `3dcdd949-b7cc-1f05-5008-d43640b21c9e` |
| 1 | `b42e10f1-ca09-bc7c-cb77-711cd3baf237` |
| 2 | `b5812165-4fa3-f316-4c84-958eb5f7eab3` |

Note that these are **UUID-shaped, not RFC-compliant v4 UUIDs** — the version nibble is whatever the hash produced. Qdrant accepts them because it only validates the format. Do not feed them to libraries that enforce UUID version rules.

### 3.5 `indexPdf` — argument validation and readiness

```js
export async function indexPdf({ filePath, documentId }) {
  if (!documentId?.trim()) {
    throw new Error("documentId is required");
  }

  const collection = await ensureCollection();
```

- **Destructured object, not positional arguments.** Two same-typed strings (`indexPdf("./documents/x.pdf", "x-v1")`) are easy to swap; `{ filePath, documentId }` is not. It also leaves room for future options without breaking callers.
- **`documentId?.trim()`** rejects `undefined`, `null`, `""` and `"   "`. This matters more than it looks: `documentId` is half of every point id and the filter key in Chapter 07, so an empty value would produce `:0`, `:1`… ids and an un-filterable corpus.
- **`ensureCollection()` runs before the PDF is read** — deliberately. A wrong `EMBEDDING_DIMENSIONS` or an unreachable Qdrant fails in milliseconds, before paying for PDF parsing and embedding.
- **`filePath` is not validated.** A missing file surfaces as `ENOENT` from `fs.readFile` — accurate enough, and it avoids duplicating what the OS already reports.

### 3.6 Read, chunk, and the empty-corpus branch

```js
  console.log(`Reading PDF: ${filePath}`);

  const text = await readPdfText(filePath);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    return {
      chunks: 0,
      message: "No extractable text found in PDF",
    };
  }

  console.log(`Extracted ${text.length} characters`);
  console.log(`Created ${chunks.length} chunks`);
```

- **The log before the slow call** is what makes a hung run diagnosable: if you see `Reading PDF:` and nothing else, the problem is the file or the parser, not the network.
- **`chunkText(text)` uses config defaults** — the same `CHUNK_SIZE`/`CHUNK_OVERLAP` that Chapter 03 documents, with no per-call override.
- **The empty branch returns instead of throwing.** A scanned PDF is a *data* problem, not a *code* problem; the caller gets `{ chunks: 0, message }` and can decide. Throwing would force every caller to wrap the call in a try/catch to distinguish "no text" from "API down".
- **The returned object's shape differs from the success shape** — it has `chunks` and `message`, but no `vectors`, `dimensions`, `collection` or `documentId`. Callers that do `result.chunks` are fine; callers that do `result.vectors.length` must handle `undefined`.
- **Both counts are logged** because they answer different questions: `text.length` tells you whether extraction worked at all (0 or 20 characters = a broken PDF), `chunks.length` tells you how many embeddings you are about to buy.


Under CommonJS, `require()`-ing the package sets `module.parent`, so the block is skipped. Under the **ESM loader**, `module.parent` is not set when the CommonJS module is translated, so `isDebugMode` is `true` and the package tries to read a fixture that exists only inside its own repository.

**Fix A — bypass `index.js`, verified working:**

```js
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdf = require("pdf-parse/lib/pdf-parse.js");
```

**Fix B — keep the CJS entry point:** put the loader in a `pdf-loader.cjs` file (`module.exports = require("pdf-parse")`) and `import` that, or require it with `createRequire`. Slower to explain, identical result.

With Fix A a real 57-page PDF extracts to 47,665 characters and chunks into 56 pieces — the measurement in §3.2 came from exactly that path.

**Why the fix is not in the repository:** this guide documents the code as shipped. Apply Fix A in your copy before running `npm run index` on Node 20+.


### 3.7 Embed, then check the count

```js
  const vectors = await embedTexts(chunks);

  // Validate the total number of vectors.
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: ${vectors.length} vectors ` +
      `for ${chunks.length} chunks`
    );
  }
```

- **`embedTexts(chunks)`** uses the configured batch size; 153 chunks become two requests (Chapter 04).
- **The length check is a last line of defence.** `embedTexts` already fails on holes, so this can only fire if the function itself were changed — which is precisely why it is cheap insurance at the one place where a mismatch would corrupt the index. It also catches a future refactor that returns `vectors.flat()` or filters empties.
- **The failure is total, not partial:** the throw happens before any point is built, so Qdrant still holds the *previous* good index. This is the property that makes the pipeline safe to re-run.

### 3.8 Build one point per chunk

```js
  // Build one point per chunk.
  const points = chunks.map((chunk, index) => ({
    id: createPointId(documentId, index),
    vector: vectors[index],
    payload: {
      text: chunk,
      source: path.basename(filePath),
      documentId,
      chunkIndex: index,
    },
  }));
```

The `map` index is the join key for all four fields:

| Field | Value | Why it is here |
| :--- | :--- | :--- |
| `id` | hash of `documentId:index` | idempotent re-indexing |
| `vector` | `vectors[index]` | the searchable representation |
| `payload.text` | `chunk` | the evidence returned to the model |
| `payload.source` | `path.basename(filePath)` | human-readable attribution (`backend-guide.pdf`) |
| `payload.documentId` | argument | filter key + version handle |
| `payload.chunkIndex` | `index` | ordering and citation granularity |

Creating all points in memory first is fine at this scale (~150 × 1024 floats ≈ 600 KB). For a 10,000-page corpus you would stream chunk-by-chunk batches instead, keeping the same point shape.

### 3.9 Upload in batches

```js
  // Upload in batches rather than sending an unlimited number of points
  // in one Qdrant request.
  const uploadBatchSize = 100;

  for (let i = 0; i < points.length; i += uploadBatchSize) {
    const batch = points.slice(i, i + uploadBatchSize);

    await qdrant.upsert(collection, {
      wait: true,
      points: batch,
    });

    console.log(
      `Stored ${Math.min(i + batch.length, points.length)}/${points.length} points`
    );
  }
```

- **`upsert`, not `insert`** — upsert overwrites an existing id, which is what makes re-indexing safe. `insert` semantics (fail on duplicate) would break the second run.
- **`wait: true`** makes the call resolve only after the write is applied and indexed. That costs a little latency and buys a guarantee: the next query sees the new points. With `wait: false` you would get eventual consistency and occasional "I just indexed it, why is it missing?" results.
- **`uploadBatchSize = 100` is a literal here**, separate from `EMBEDDING_BATCH_SIZE`. The two are unrelated limits — embedding request size and Qdrant request size — and hard-coding the second one keeps the upload loop independent of the embedding configuration. It also means a failure at point 150 of 300 leaves the first 100 stored, and re-running overwrites them harmlessly.
- **The progress line clamps with `Math.min`** so the last partial batch prints `153/153`, not `200/153`.
- **No deletes.** Chapter 07 shows how to remove stale versions; the indexing pipeline only ever adds or overwrites.

### 3.10 The return value

```js
  return {
    chunks: chunks.length,
    vectors: vectors.length,
    dimensions: config.openai.embeddingDimensions,
    collection,
    documentId,
  };
}
```

A small receipt, and every field is diagnostic:

```json
{
  "chunks": 56,
  "vectors": 56,
  "dimensions": 1024,
  "collection": "pdf_knowledge",
  "documentId": "backend-guide-v1"
}
```

`chunks === vectors` is the invariant; `dimensions` confirms which space the points live in; `collection` and `documentId` confirm *where* they went. This is the value `npm run index` prints.


---

## 4. Verified behaviour

The full function needs an OpenAI key, so the network half was validated with deterministic fake vectors driven through the **same** Qdrant calls, on Docker `qdrant/qdrant` with client 1.19.0:

| Check | Result |
| :--- | :--- |
| 3 chunks → 3 points, ids `3dcdd949…`, `b42e10f1…`, `b5812165…` | stored, `points_count: 3` |
| Upsert the same points again | `points_count` stays `3` |
| Upsert with a changed `payload.text` | payload overwritten, still `3` points |
| `retrieve(collection, { ids: [id] })` | 1 point, payload text returned |
| Query with the vector of point 0 | point 0 first, `score: 1` |
| Query filtered on a `documentId` unknown to the collection | 0 points |

So the id formula, payload shape, upsert semantics and retrieval contract behave as documented; the only unverified step is the OpenAI round trip, whose request body is in Chapter 04.

---

## 5. Failure modes

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `ENOENT: ./test/data/05-versions-space.pdf` | `pdf-parse` ESM debug block (§3.3) | apply Fix A |
| `documentId is required` | empty/whitespace id | pass a version handle |
| `No extractable text found in PDF` | scanned PDF, no text layer | OCR the PDF first, or use a text-based source |
| `Collection dimension mismatch…` | `EMBEDDING_DIMENSIONS` ≠ collection size | new collection + re-index |
| `Some input chunks did not receive embeddings` | partial API response | re-run; ids are deterministic, so nothing duplicates |
| `Embedding count mismatch…` | code edited / provider misbehaving | inspect `embedTexts`, do not bypass the check |
| Point count doubles after re-index | `documentId` changed between runs | delete the old version (§6) |
| Indexing succeeds but queries return nothing | query path filters on a different `documentId` | pass the same id to `answerQuestion` |

---

## 6. Commands

```bash
cd "Lecture 11/code/Eassy RAG"

# The shipped script (path and documentId live inside package.json)
npm run index

# The same thing, but parameterised
node --input-type=module -e '
import { indexPdf } from "./src/indexPdf.js";
console.log(await indexPdf({
  filePath: "./documents/backend-guide.pdf",
  documentId: "backend-guide-v1"
}));
'

# Re-index after the PDF changes — new version, new ids
node --input-type=module -e '
import { indexPdf } from "./src/indexPdf.js";
console.log(await indexPdf({
  filePath: "./documents/backend-guide.pdf",
  documentId: "backend-guide-v2"
}));
'

# Retire the old version (Qdrant payload filter, no code required)
curl -s -X POST "localhost:6333/collections/pdf_knowledge/points/delete?wait=true" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"must":[{"key":"documentId","match":{"value":"backend-guide-v1"}}]}}'
```

Expected console output for a healthy run:

```text
Reading PDF: ./documents/backend-guide.pdf
Extracted 47665 characters
Created 56 chunks
Embedded 56/56 chunks
Stored 56/56 points
{ chunks: 56, vectors: 56, dimensions: 1024,
  collection: 'pdf_knowledge', documentId: 'backend-guide-v1' }
```

---

## 7. What this chapter established

| Property | Implementation |
| :--- | :--- |
| Idempotent re-indexing | deterministic ids + `upsert` |
| No partial index on failure | points built only after embedding completes |
| Early failure on misconfiguration | `ensureCollection()` first |
| Honest empty result | `{ chunks: 0, message }` instead of a throw |
| One point per chunk, fully attributed | `id + vector + payload{text, source, documentId, chunkIndex}` |
| Bounded request sizes | 100 points per upsert, `wait: true` |
| Versioning by id, not by overwrite | `documentId` suffix, old points deleted explicitly |

**Next:** [Chapter 07 — The Query Pipeline & Grounded Answers](./07_Query_Pipeline_and_Grounded_Answers.md)
