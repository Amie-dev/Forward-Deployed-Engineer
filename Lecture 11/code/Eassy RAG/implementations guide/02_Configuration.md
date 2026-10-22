# Chapter 02: Configuration

> **Chapter Goal:** Turn eleven environment variables into one validated object, and understand exactly which mistakes are caught at startup — plus the ones that are not.

> **Lecture mapping:** Chapter 03 (ingestion) and Chapter 04 (embeddings at query time): the model/dimension contract begins in this file.

> **File details:**

| | |
| :--- | :--- |
| **Path** | `src/config.js` |
| **Lines** | 62 |
| **Imports** | `dotenv/config` (side effect only) |
| **Exports** | `config` (the only export) |
| **Side effects** | Loads `.env`; throws on invalid configuration at import time |
| **Used by** | every other module — `chunking.js`, `embeddings.js`, `qdrant.js`, `indexPdf.js`, `queryPdf.js` |

---

## 1. Why this file exists

Every value here is read by **both** pipelines. `CHUNK_SIZE` shapes the index; `TOP_K` shapes the prompt; `EMBEDDING_DIMENSIONS` shapes the collection, the vectors and the query vector. If any of those were read independently in two files, the system could drift into a state where the index and the query live in different vector spaces — which does not raise an error anywhere, it just returns plausible nonsense.

So the file does two jobs:

1. **Read once** — no other module touches `process.env`.
2. **Refuse to start** — a configuration error becomes a crash at import, not a strange answer three steps later.

---

## 2. Complete source code

#### 📄 `src/config.js`

```js
import "dotenv/config";

function getNumber(name, fallback) {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return fallback;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return number;
}

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    embeddingModel:
      process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    embeddingDimensions: getNumber(
      "EMBEDDING_DIMENSIONS",
      1024
    ),
    chatModel: process.env.CHAT_MODEL ?? "gpt-4o-mini",
  },

  chunking: {
    chunkSize: getNumber("CHUNK_SIZE", 1000),
    chunkOverlap: getNumber("CHUNK_OVERLAP", 150),
  },

  embeddingBatchSize: getNumber("EMBEDDING_BATCH_SIZE", 100),

  qdrant: {
    url: process.env.QDRANT_URL ?? "http://localhost:6333",
    apiKey: process.env.QDRANT_API_KEY || undefined,
    collection: process.env.QDRANT_COLLECTION ?? "pdf_knowledge",
  },

  topK: getNumber("TOP_K", 5),
};

if (!config.openai.apiKey) {
  throw new Error("OPENAI_API_KEY is missing from .env");
}

if (config.chunking.chunkOverlap >= config.chunking.chunkSize) {
  throw new Error("Chunk overlap must be smaller than chunk size");
}

if (
  config.openai.embeddingDimensions > 1536 &&
  config.openai.embeddingModel === "text-embedding-3-small"
) {
  throw new Error(
    "text-embedding-3-small supports at most 1536 output dimensions"
  );
}
```

---

## 3. Block by block

### 3.1 `import "dotenv/config"` — load `.env` before anything reads it

```js
import "dotenv/config";
```

This imports `dotenv` purely for its side effect: it reads `.env` from the current working directory and assigns each `KEY=VALUE` into `process.env`, **without overwriting variables that already exist**. That last detail is what makes the guards in §3.9 testable from a shell:

```bash
OPENAI_API_KEY= node -e "import('./src/config.js')"   # → OPENAI_API_KEY is missing from .env
```

The empty value set in the shell already exists in `process.env`, so `dotenv` leaves it alone, and the guard fires. Without that rule, `.env` would silently win and you could never simulate a missing key.

Three consequences worth knowing:

- The file is ESM (`import`), so it must come first; ES module imports are hoisted and evaluated before the rest of the module body.
- `dotenv/config` resolves `.env` from `process.cwd()`, **not** from the file's location. Run the scripts from the project root, which is what both npm scripts do.
- In production you would not use `.env` at all — the platform injects environment variables and `dotenv` becomes a no-op. Nothing else in the file changes.


### 3.2 `getNumber(name, fallback)` — one parser for every numeric setting

```js
function getNumber(name, fallback) {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return fallback;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return number;
}
```

Four behaviours, each deliberate:

1. **`undefined` or `""` means "use the default".** A commented-out or blank line in `.env` falls back instead of producing `NaN`. This pair of checks — not a truthiness check — is what lets `0` be distinguished from "unset" (see the caveat below).
2. **`Number(value)`** parses `"1000"` → `1000`. It also accepts `"1e3"` → 1000, `" 42 "` → 42 and `"0x10"` → 16. None of those are rejected; only the next check matters.
3. **`!Number.isInteger(number) || number <= 0`** rejects `"abc"` (`NaN`), `"2.5"`, `"-1"`, `"0"` and `"Infinity"`. Verified messages:

   | `.env` value | Thrown message |
   | :--- | :--- |
   | `CHUNK_SIZE=0` | `CHUNK_SIZE must be a positive integer` |
   | `TOP_K=2.5` | `TOP_K must be a positive integer` |
   | `EMBEDDING_DIMENSIONS=abc` | `EMBEDDING_DIMENSIONS must be a positive integer` |

4. **The error names the variable**, which is why `name` is a parameter. An inline `Number(process.env.X)` would throw `NaN is not a positive integer` and leave you hunting.

> **Caveat (verified):** because the guard requires a *positive* integer, `CHUNK_OVERLAP=0` throws `CHUNK_OVERLAP must be a positive integer`. `chunkText` itself accepts `0`, but you cannot reach that state through `.env`. For overlap-free chunks, call `chunkText(text, 1000, 0)` directly, or add a `getNonNegativeNumber` variant for that key.

### 3.3 `config.openai` — the provider block

```js
openai: {
  apiKey: process.env.OPENAI_API_KEY,
  embeddingModel:
    process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  embeddingDimensions: getNumber(
    "EMBEDDING_DIMENSIONS",
    1024
  ),
  chatModel: process.env.CHAT_MODEL ?? "gpt-4o-mini",
},
```

- **`apiKey`** is stored raw. `undefined` and `""` are both falsy, and §3.9 tests it with `!config.openai.apiKey`, so both are caught. Keeping the raw value also lets the error say "missing from .env" honestly.
- **`??` is not `||`.** `??` only falls back on `null`/`undefined`. A blank `EMBEDDING_MODEL=` line produces an **empty string**, which `??` keeps — verified:

  ```json
  {"apiKey":"your_openai_api_key","embeddingModel":"","embeddingDimensions":1024,"chatModel":"gpt-4o-mini"}
  ```

  That empty model then reaches `openai.embeddings.create({ model: "" })` and fails at the API with a 400. `||` here, or an `if (!model) throw`, would catch it at startup. This is a genuine (small) defect in the file, and it is exactly why §3.5 uses `||` on purpose.
- **`embeddingDimensions`** is the width of *every* vector in the system and of the Qdrant collection — the most expensive value to change later, because it invalidates the index.
- **`chatModel`** is independent of everything else. It can change between runs without touching the index, because generation never uses vectors.

### 3.4 `config.chunking` — the two numbers that define a retrieval unit

```js
chunking: {
  chunkSize: getNumber("CHUNK_SIZE", 1000),
  chunkOverlap: getNumber("CHUNK_OVERLAP", 150),
},
```

`chunkSize` is **characters**, not tokens. `chunkOverlap` is characters shared with the previous chunk. Their relationship (`overlap < size`) is checked twice: here, and again inside `chunkText`. That is not redundancy — `config.js` protects the *configured* path, `chunkText` protects *every* caller, including ones that pass explicit arguments (Chapter 03 runs `chunkText(text, 100, 20)`).

The step between chunk starts is `chunkSize - chunkOverlap` = **850**. That number drives the chunk count and is verified against real PDFs in Chapter 03.

### 3.5 `config.qdrant` — the store block

```js
qdrant: {
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY || undefined,
  collection: process.env.QDRANT_COLLECTION ?? "pdf_knowledge",
},
```

- **`url`** — the REST port. Qdrant's second port `6334` is gRPC and unused by this client.
- **`apiKey: … || undefined`** — the one place `||` is correct. A blank `QDRANT_API_KEY=` yields `""`; the client would send an empty `api-key` header or fail its own validation. `|| undefined` omits the field, which is what local Docker needs. Verified: the key exists on the object with value `undefined`.
- **`collection`** — one collection is one vector space. A different corpus, model or chunking scheme belongs in a different collection, because `size` and `distance` cannot change after creation.

### 3.6 `config.embeddingBatchSize` — a throughput dial, not a semantic one

```js
embeddingBatchSize: getNumber("EMBEDDING_BATCH_SIZE", 100),
```

This is the number of chunks sent in one `embeddings.create` call. It changes **how many requests** you make, never **which vectors** you get: the same chunk embedded alone or in a batch of 100 yields the same vector (up to floating-point determinism). 100 is a sane default — large enough to amortise latency, small enough to stay far from per-request token ceilings for 1,000-character chunks.

It also lives at the top level of `config`, not under `openai`, because it is the *embedder's* concern rather than the provider's (Chapter 04 shows the call signature that consumes it).

### 3.7 `topK` — how much evidence reaches the prompt

```js
topK: getNumber("TOP_K", 5),
```

Only read by `queryPdf.js`, as `limit` in the Qdrant query. It is the single knob that trades recall for prompt size and distraction: 5 chunks × ~1,000 characters ≈ 1,300 tokens of context per question, sent on every call.

### 3.8 The exported object

```js
export const config = { … };
```

A plain frozen-by-convention object (not `Object.freeze`d). Modules import it by reference, so anything that mutates `config` at runtime changes behaviour everywhere. Nothing in this codebase does; in a larger system you would freeze it.

Shaped like this at defaults (verified by printing the whole object):

```json
{
  "openai": { "apiKey": "your_openai_api_key", "embeddingModel": "text-embedding-3-small",
              "embeddingDimensions": 1024, "chatModel": "gpt-4o-mini" },
  "chunking": { "chunkSize": 1000, "chunkOverlap": 150 },
  "embeddingBatchSize": 100,
  "qdrant": { "url": "http://localhost:6333", "collection": "pdf_knowledge" },
  "topK": 5
}
```

(`qdrant.apiKey` is absent from the JSON because its value is `undefined`.)

### 3.9 The three startup guards

```js
if (!config.openai.apiKey) {
  throw new Error("OPENAI_API_KEY is missing from .env");
}

if (config.chunking.chunkOverlap >= config.chunking.chunkSize) {
  throw new Error("Chunk overlap must be smaller than chunk size");
}

if (
  config.openai.embeddingDimensions > 1536 &&
  config.openai.embeddingModel === "text-embedding-3-small"
) {
  throw new Error(
    "text-embedding-3-small supports at most 1536 output dimensions"
  );
}
```

**1. Missing key.** Both pipelines need the key, so failing here costs nothing — the very first API call would fail anyway, but only after paying the cost of reading and chunking a PDF. Throwing at import time means `npm run index` dies before it touches the filesystem.

**2. Overlap ≥ size.** With `overlap === size` the step becomes 0 and `chunkText` would loop forever (or throw its defensive guard). With `overlap > size` the step is negative and `start` moves backwards. Catching it here means the messages are better than the generic loop guard in Chapter 03.

**3. Dimensions after truncation.** `text-embedding-3-small` cannot return more than its native 1536; `EMBEDDING_DIMENSIONS=3072` with that model is an API error waiting to happen. The check is model-specific on purpose: verified that `EMBEDDING_MODEL=text-embedding-3-large` with `EMBEDDING_DIMENSIONS=3072` passes, because 3-large supports 3072.

What is **not** guarded here:

| Un-guarded mistake | Where it surfaces instead |
| :--- | :--- |
| `EMBEDDING_MODEL=` (blank) | 400 from OpenAI on the first embedding call |
| Dimension ≠ existing collection size | `ensureCollection()` — a clear error (Chapter 05) |
| `TOP_K` larger than the collection | Fine — Qdrant returns fewer points; the prompt just gets shorter |
| Wrong `QDRANT_URL` | Connection error on the first Qdrant call |
| `CHUNK_SIZE` far too small (e.g. 50) | No error at all — silently terrible retrieval |

The last row is the important one. **Configuration validation protects consistency, not quality.** Chunk size and `TOP_K` are quality decisions, and the only way to judge them is evaluation (Lecture 11, Chapter 08 of the notes; `npm run eval` in the sibling `Productions RAG` codebase).

---

## 4. Commands and verification

All five commands below were executed against this file:

```bash
cd "Lecture 11/code/Eassy RAG"

# 1. Print the resolved configuration
node -e "import('./src/config.js').then(m => console.log(JSON.stringify(m.config, null, 2)))"

# 2. Missing key (an empty value in the shell wins over .env)
OPENAI_API_KEY= node -e "import('./src/config.js').catch(e => console.log(e.message))"
# → OPENAI_API_KEY is missing from .env

# 3. Overlap must be smaller than size
CHUNK_OVERLAP=1000 node -e "import('./src/config.js').catch(e => console.log(e.message))"
# → Chunk overlap must be smaller than chunk size

# 4. Dimensions are model-capped
EMBEDDING_DIMENSIONS=1537 node -e "import('./src/config.js').catch(e => console.log(e.message))"
# → text-embedding-3-small supports at most 1536 output dimensions

# 5. Parsing rejects non-integers
CHUNK_SIZE=0 node -e "import('./src/config.js').catch(e => console.log(e.message))"
# → CHUNK_SIZE must be a positive integer
```

Note the pattern: a `node -e` shell variable override, plus `.catch`, is enough to exercise every guard without Qdrant or an API key. That is the cheapest unit test this codebase has.

---

## 5. What this chapter established

| Rule | Enforced where |
| :--- | :--- |
| `.env` is loaded once, from `cwd` | `import "dotenv/config"` |
| Numeric settings are positive integers or defaults | `getNumber` |
| Missing API key is fatal | guard 1 |
| `overlap < chunkSize` | guard 2 **and** `chunkText` |
| Dimensions fit the model | guard 3 |
| Dimensions fit the collection | `ensureCollection()` (Chapter 05) |

**Next:** [Chapter 03 — Chunking](./03_Chunking.md)

