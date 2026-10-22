# Chapter 04: Embeddings

> **Chapter Goal:** Turn an array of chunk strings into an array of 1,024-float vectors — in batches, in the right order, with every response validated — and understand the two invariants (model and dimension) that make the index searchable at query time.

> **Lecture mapping:** Chapter 04 (Embeddings at Query Time). The same function serves ingestion and querying, which is exactly the point of the embedding-space contract.

> **File details:**

| | |
| :--- | :--- |
| **Path** | `src/embeddings.js` |
| **Lines** | 75 |
| **Imports** | `OpenAI` from `openai`, `config` from `./config.js` |
| **Exports** | `embedTexts(texts, batchSize?)` |
| **Side effects** | Creates one OpenAI client at import; network calls per batch; one `console.log` per batch |
| **Used by** | `src/indexPdf.js` (many chunks), `src/queryPdf.js` (one question) |

---

## 1. What one call has to guarantee

`embedTexts` is used for two very different workloads: 150 chunks during indexing and 1 question at query time. Both need the same four guarantees, and every line in the file exists to provide one of them:

| Guarantee | Why it matters |
| :--- | :--- |
| **Same model + dimension every call** | Otherwise the query vector and the stored vectors are incomparable |
| **Output position == input position** | `chunks[i]` must correspond to `vectors[i]`, or every point gets the wrong text |
| **No missing vectors** | A hole in the array becomes a corrupt point (or a crash later) |
| **No malformed vectors** | A vector of the wrong width makes Qdrant reject the whole upsert batch |

---

## 2. Complete source code

#### 📄 `src/embeddings.js`

```js
import OpenAI from "openai";
import { config } from "./config.js";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

export async function embedTexts(
  texts,
  batchSize = config.embeddingBatchSize
) {
  if (!Array.isArray(texts)) {
    throw new TypeError("texts must be an array");
  }

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  if (texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("Every input text must be a non-empty string");
  }

  // Keep the output position aligned with the input position.
  const vectors = new Array(texts.length);

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await openai.embeddings.create({
      model: config.openai.embeddingModel,
      dimensions: config.openai.embeddingDimensions,
      input: batch,
      encoding_format: "float",
    });

    for (const item of response.data) {
      const originalIndex = i + item.index;

      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= batch.length
      ) {
        throw new Error("Invalid embedding index returned by OpenAI");
      }

      if (vectors[originalIndex] !== undefined) {
        throw new Error(`Duplicate embedding index: ${originalIndex}`);
      }

      if (
        !Array.isArray(item.embedding) ||
        item.embedding.length !== config.openai.embeddingDimensions ||
        !item.embedding.every(Number.isFinite)
      ) {
        throw new Error(
          `Invalid vector at input index ${originalIndex}`
        );
      }

      vectors[originalIndex] = item.embedding;
    }

    console.log(
      `Embedded ${Math.min(i + batch.length, texts.length)}/${texts.length} chunks`
    );
  }

  if (vectors.includes(undefined)) {
    throw new Error("Some input chunks did not receive embeddings");
  }

  return vectors;
}
```


---

## 3. Block by block

### 3.1 The module-level client

```js
const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});
```

- **One client per process.** The SDK holds an HTTP agent with keep-alive sockets and its own retry/timeout settings; recreating it per call throws away connection reuse and adds a TLS handshake to every batch.
- **The key is read once at import**, after `config.js` has loaded `.env` and thrown if the key is missing. By the time this line runs, the key is known-good.
- **No `baseURL`, no `timeout`, no `maxRetries`.** You get the SDK defaults: a 10-minute timeout and 2 retries on connection errors, 408, 409, 429 and 5xx. That default retry behaviour is the only resilience in the pipeline (Chapter 08 discusses what is missing).
- `queryPdf.js` builds a **second** client of its own for chat completions. Two clients, one key. Sharing a single exported client would be tidier; the article kept each file self-contained.

### 3.2 Signature — one array in, one array out

```js
export async function embedTexts(
  texts,
  batchSize = config.embeddingBatchSize
) {
```

An array is the interface even when the caller has a single string: `queryPdf.js` calls `embedTexts([question])` and destructures `const [queryVector] = …`. One code path, one validation story for both workloads. A scalar `embedText` wrapper would duplicate the request shape and let the two drift.

`batchSize` is overridable for tests and tight rate limits; the default is `EMBEDDING_BATCH_SIZE` (100).

### 3.3 Input validation — three cheap checks before spending money

```js
if (!Array.isArray(texts)) {
  throw new TypeError("texts must be an array");
}

if (!Number.isInteger(batchSize) || batchSize <= 0) {
  throw new Error("batchSize must be a positive integer");
}

if (texts.some((text) => typeof text !== "string" || !text.trim())) {
  throw new Error("Every input text must be a non-empty string");
}
```

- **`Array.isArray`** catches `embedTexts(chunk)` — a plausible mistake that would otherwise send a plain string as `input` and produce a single-vector response the loop then misreads.
- **`batchSize`** must be a positive integer: `0` makes `i += 0` an infinite loop, and `2.5` produces ragged slices.
- **The `some` check** rejects two failure shapes in one pass: a non-string element (`undefined` from a bad `map`) and an empty/whitespace-only string. Both are 400s from the API, and both cost a round trip to discover. Because it runs **before** batching, one bad chunk fails the whole call immediately instead of halfway through a paid run.
- **Empty array is legal.** `[].some(...)` is `false`, the loop never runs, `new Array(0).includes(undefined)` is `false`, and the function returns `[]`. Callers guard upstream (`indexPdf.js` returns early when `chunks.length === 0`).

### 3.4 Pre-allocation — the alignment trick

```js
// Keep the output position aligned with the input position.
const vectors = new Array(texts.length);
```

`new Array(n)` creates a **sparse** array of length `n` with no elements — all holes. That is deliberate:

- Writing `vectors[originalIndex] = …` later places each vector at its input position, regardless of the order the API returns items in.
- A hole that is never written is detectable at the end (§3.8), and is *distinguishable* from a written value because `undefined` is never a valid vector.
- `push` would rely on response ordering and would silently misalign every point if the API ever returned items out of order. It does not today; the code simply does not depend on it.

### 3.5 The batch loop

```js
for (let i = 0; i < texts.length; i += batchSize) {
  const batch = texts.slice(i, i + batchSize);
```

Sequential, not parallel. Three consequences:

| Property | Effect |
| :--- | :--- |
| Sequential `await` | Simple progress logging, predictable rate-limit behaviour, no partial-failure storm |
| `slice` copies references | No copying cost for the strings themselves |
| Batches are independent | A failure in batch 3 leaves batches 1–2 completed *in memory*; the throw discards them, because nothing has reached Qdrant yet |

Batch count is `ceil(n / batchSize)`. Measured inputs:

| Chunks | Requests at 100 |
| ---: | ---: |
| 36 (`Lecture 10/notes/Notes.pdf`) | 1 |
| 56 (`Lecture 01/notes/Notes.pdf`) | 1 |
| 153 (the article's 20-page PDF) | 2 (100 + 53) |
| 154 (synthetic 130,074 chars) | 2 (100 + 54) |


### 3.6 The request — four fields, each load-bearing

```js
const response = await openai.embeddings.create({
  model: config.openai.embeddingModel,
  dimensions: config.openai.embeddingDimensions,
  input: batch,
  encoding_format: "float",
});
```

```jsonc
// What goes on the wire
{
  "model": "text-embedding-3-small",
  "input": ["chunk one…", "chunk two…", "…"],
  "dimensions": 1024,
  "encoding_format": "float"
}
```

- **`model`** — decides the vector space. Changing it invalidates every stored vector; there is no compatibility layer.
- **`dimensions`** — asks for 1024 instead of the native 1536 (Matryoshka truncation: the model is trained so a prefix of the vector is itself a usable embedding). Fewer dimensions means less storage and faster search at some fidelity cost. It must equal the Qdrant collection's `size`.
- **`input`** — an **array of strings**, which is what makes this batching rather than looping. The API accepts up to 2,048 inputs and a per-request token ceiling; 100 × ~250 tokens sits comfortably inside both.
- **`encoding_format: "float"`** — plain JSON numbers. The alternative, `"base64"`, returns a compact blob that must be decoded into a `Float32Array`; this code implements no such path, so the explicit value documents the choice.

What comes back — one item per input:

```jsonc
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0153, -0.0071, …] },
    { "object": "embedding", "index": 1, "embedding": [ … ] }
  ],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 248, "total_tokens": 248 }
}
```

`usage.prompt_tokens` is the number to log for cost per document; this code ignores it.

### 3.7 The response loop — re-basing the index

```js
for (const item of response.data) {
  const originalIndex = i + item.index;

  if (
    !Number.isInteger(item.index) ||
    item.index < 0 ||
    item.index >= batch.length
  ) {
    throw new Error("Invalid embedding index returned by OpenAI");
  }
```

- **`item.index` is relative to the batch**, not to the whole array. For batch 2 (`i = 100`), `item.index = 0` is vector number 100. `originalIndex = i + item.index` is the line that prevents the classic "every chunk after the first batch is off by one batch" bug.
- **The range check** rejects an index that is not an integer, negative, or ≥ batch length. Without it, `vectors[originalIndex]` could write outside the intended slots (or, worse, silently overlap the next batch's slots) and the final hole check would still pass.
- The order of the two checks matters: `originalIndex` is computed first, but it is only *used* after the range check validates `item.index`.

### 3.8 Three defences per vector

```js
  if (vectors[originalIndex] !== undefined) {
    throw new Error(`Duplicate embedding index: ${originalIndex}`);
  }

  if (
    !Array.isArray(item.embedding) ||
    item.embedding.length !== config.openai.embeddingDimensions ||
    !item.embedding.every(Number.isFinite)
  ) {
    throw new Error(
      `Invalid vector at input index ${originalIndex}`
    );
  }

  vectors[originalIndex] = item.embedding;
}
```

1. **Duplicate detection.** Two items claiming the same index means one chunk would silently lose its vector while another gets the wrong one. Caught here rather than at query time, months later.
2. **Shape and width.** `Array.isArray` + `length === embeddingDimensions` enforce the contract the Qdrant collection was created with. A 1536-length vector dropped into a 1024 collection fails the *entire* upsert batch — and the error from Qdrant would not tell you which chunk caused it.
3. **Finite values.** `every(Number.isFinite)` rejects `NaN`, `Infinity` and `null`-ish entries. A single `NaN` makes cosine similarity `NaN`, which makes sort order undefined and scores meaningless. This is the cheapest possible place to stop it.

Only then is the vector written. Verified against a replica of this logic with a fake client:

| Simulated response | Thrown message |
| :--- | :--- |
| items returned in reverse order | no error — vectors still align by `index` |
| one item missing | `Some input chunks did not receive embeddings` |
| two items with `index: 0` | `Duplicate embedding index: 0` |
| vector of length 3 (expected 4) | `Invalid vector at input index 0` |
| vector containing `NaN` | `Invalid vector at input index 0` |

### 3.9 Progress logging

```js
console.log(
  `Embedded ${Math.min(i + batch.length, texts.length)}/${texts.length} chunks`
);
```

Per batch, not per chunk: 154 chunks produce two lines (`100/154`, `154/154`). It goes to stdout, not to a logger, so it interleaves with the indexing script's own output. The `Math.min` clamps the last partial batch so it prints `154/154` rather than `200/154`.

### 3.10 The final hole check — and why it is `includes`

```js
if (vectors.includes(undefined)) {
  throw new Error("Some input chunks did not receive embeddings");
}

return vectors;
```

This single line is the difference between "one chunk has no vector" and "the whole index is silently wrong". Verified array semantics:

```js
new Array(3).some(() => true)        // false  ← some SKIPS holes
new Array(3).includes(undefined)     // true   ← includes does not
```

`Array.prototype.some` skips holes in sparse arrays (as do `forEach`, `filter` and `map`), so a `vectors.some((v) => v === undefined)` check would return `false` for a completely unwritten array — a check that can never fail. `includes` treats a hole as the value `undefined`, so it works. The article's own `guide.md` calls this out; the source implements it correctly.



---

## 4. Two things this function deliberately does *not* do

### 4.1 No normalisation

OpenAI's embedding vectors are already unit-length (L2 norm ≈ 1), and Qdrant's `Cosine` distance normalises internally anyway. So there is no `/ norm` line here. If you swap in a provider that returns unnormalised vectors (some local models do) **and** a store that uses raw dot product, the scores change meaning — that is the metric-consistency rule from Lecture 10, and it becomes your responsibility.

### 4.2 No cache

Every run re-embeds every chunk. Re-indexing the same PDF twice means paying for the same 47,665 characters twice. For a teaching pipeline that is fine (it makes idempotency visible). In production you would key a cache by `hash(model + dimensions + text)` — the same inputs the vector actually depends on — and skip unchanged chunks. Note that this is only possible because chunking is deterministic.

---

## 5. Cost and latency, in the only units that matter

Embedding cost scales with **input tokens**, not chunks, and roughly 4 characters ≈ 1 token for English prose.

| Input | Characters | ≈ Tokens | Embedding requests |
| :--- | ---: | ---: | ---: |
| One question | ~40 | ~10 | 1 |
| `Lecture 10/notes/Notes.pdf` | 32,381 | ~8,100 | 1 |
| `Lecture 01/notes/Notes.pdf` | 47,665 | ~11,900 | 1 |
| 20-page article PDF | 130,000 | ~32,500 | 2 |

Two observations:

- **Indexing is cheap once, expensive to repeat.** A single document is a fraction of a cent at `text-embedding-3-small` pricing; the real cost is doing it on every deploy, or on every question if you accidentally re-index at query time.
- **Query embedding is negligible; prompt tokens are not.** One question costs ~10 embedding tokens, but the chat call receives 5 × ~250-token chunks (~1,300 tokens) plus the question and the system prompt. Generation, not embedding, dominates per-query cost and latency.

---

## 6. Commands and verification

There is no API key in this environment, so the network path was not executed. Everything else was:

```bash
cd "Lecture 11/code/Eassy RAG"

# 1. Parse check
node --check src/embeddings.js

# 2. Confirm the module loads and validates before any network call
node --input-type=module -e '
import { embedTexts } from "./src/embeddings.js";
try { await embedTexts("not an array"); } catch (e) { console.log("array check:", e.message); }
try { await embedTexts(["ok", "  "]); } catch (e) { console.log("content check:", e.message); }
try { await embedTexts(["ok"], 0); } catch (e) { console.log("batch check:", e.message); }
'
# array check: texts must be an array
# content check: Every input text must be a non-empty string
# batch check: batchSize must be a positive integer

# 3. Sparse-array semantics that justify `includes`
node -e 'console.log(new Array(3).some(() => true), new Array(3).includes(undefined))'
# false true
```

To exercise the happy path you need `OPENAI_API_KEY` set; then any of the chapter 06 commands will run this function for real.

---

## 7. What this chapter established

| Invariant | Enforced by |
| :--- | :--- |
| `input` is an array of non-empty strings | three validation checks |
| Output position == input position | pre-allocated array + `i + item.index` |
| Every slot filled | `vectors.includes(undefined)` |
| Every vector is `number[1024]` of finite numbers | length + `Number.isFinite` |
| No duplicate or out-of-range indices | explicit guards |
| Model and dimension are the same everywhere | `config` (Chapter 02) |
| Batch size affects throughput, never meaning | `slice` + sequential calls |

**Next:** [Chapter 05 — Qdrant Client & Collection](./05_Qdrant_Client_and_Collection.md)

