# Chapter 08: Run, Verify & Troubleshoot

> **Chapter Goal:** Take a clean machine to a cited answer, prove each stage works without spending money, and recognise every failure mode this codebase can produce — including the two that are in the code as shipped.

> **Lecture mapping:** Chapter 08 (Evaluation and Debugging) and Chapter 09 (Production System Design) — the *smallest honest* version of each.

> **Files covered:** no new source files. This chapter is the operator's view of the six you have read.

---

## 1. Prerequisites

| Requirement | Why | Check |
| :--- | :--- | :--- |
| Node.js 20+ | top-level `await`, `node:` imports, modern ESM loader | `node --version` |
| Docker | Qdrant on `:6333` | `docker --version` |
| OpenAI API key | embeddings + chat | `echo $OPENAI_API_KEY` |
| A text-based PDF | the corpus | open it and try to select text |
| ~500 MB disk | dependencies + Qdrant image | — |

Node v24.22.0 is what this guide was verified on.

---

## 2. First run, step by step

### Step 1 — install

```bash
cd "Lecture 11/code/Eassy RAG"
npm install
```

Installs `openai@4.104.0`, `@qdrant/js-client-rest@1.19.0`, `pdf-parse@1.1.1`, `dotenv@16.6.1`.

### Step 2 — configure

```bash
cp .env .env.local 2>/dev/null || true      # optional backup
```

Edit `.env` and set a real key. Keep everything else at defaults for the first run:

```ini
OPENAI_API_KEY=sk-…
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1024
CHAT_MODEL=gpt-4o-mini
CHUNK_SIZE=1000
CHUNK_OVERLAP=150
EMBEDDING_BATCH_SIZE=100
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=pdf_knowledge
TOP_K=5
```

> `.env` is already git-ignored here — `.gitignore` lists `.env` and `node_modules/`. Keep it that way before a real key lands in a commit.

Confirm the config parses:

```bash
node -e "import('./src/config.js').then(m => console.log(JSON.stringify(m.config, null, 2)))"
```

### Step 3 — patch the PDF loader (Node 20+)

`import pdf from "pdf-parse"` fails under ESM (Chapter 06 §3.3). Apply Fix A in `src/indexPdf.js`:

```js
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdf = require("pdf-parse/lib/pdf-parse.js");
```

(replacing the `import pdf from "pdf-parse";` line)

### Step 4 — start Qdrant

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
curl -s localhost:6333/collections
# {"result":{"collections":[]},"status":"ok"}
```

### Step 5 — add a PDF

```bash
cp /path/to/your.pdf ./documents/backend-guide.pdf
```

### Step 6 — index

```bash
npm run index
```

```text
Reading PDF: ./documents/backend-guide.pdf
Extracted 47665 characters
Created 56 chunks
Embedded 56/56 chunks
Stored 56/56 points
{ chunks: 56, vectors: 56, dimensions: 1024,
  collection: 'pdf_knowledge', documentId: 'backend-guide-v1' }
```

If you see `Created collection "pdf_knowledge" with 1024 dimensions` first, that is the collection initialising.

### Step 7 — query

```bash
npm run query -- "What is middleware in Express?"
```

```text
ANSWER

Middleware functions run before the route handler and can read the request,
change the response, or end the request cycle [Source 1]. Error handlers take
four arguments [Source 3].

RETRIEVED SOURCES

[ { sourceNumber: 1, document: 'backend-guide.pdf', chunkIndex: 0,
    score: 0.8123, text: 'Express middleware runs before…' }, … ]
```

If you get the refusal string instead, jump to §4 row *"Every question is refused"* — it is almost always the hard-coded `documentId` in `queryPdf.js`.


---

## 3. Verify without spending money

Chapters 02, 03 and 05 each showed one-off probes. This is the combined suite: **13 checks, no OpenAI key, no PDF, ~2 seconds.** Save it as `verify.mjs` in the project root and run it against a live Qdrant.

```js
// verify.mjs — offline verification for the Eassy RAG pipeline.
// Proves chunking and the Qdrant layer without calling OpenAI.
//   docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
//   QDRANT_COLLECTION=pdf_knowledge_verify node verify.mjs
import crypto from "node:crypto";
import { config } from "./src/config.js";
import { chunkText } from "./src/chunking.js";
import { qdrant, ensureCollection } from "./src/qdrant.js";

let passed = 0;
let total = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed++;
};

// ---- chunking -------------------------------------------------------------
const prose = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet ").repeat(60);
const chunks = chunkText(prose, 100, 20);
check("chunks respect the size ceiling", chunks.every((c) => c.length <= 100));
check("overlap repeats content", chunks.slice(1).every((c, i) => c.slice(0, 20).trim() === chunks[i].slice(-20).trim()));
check("empty input yields no chunks", chunkText("   \n\t ").length === 0);
check("short input yields one chunk", chunkText("hello world").length === 1);

let guarded = false;
try { chunkText("abc", 10, 10); } catch { guarded = true; }
check("overlap >= size is rejected", guarded);

// ---- qdrant ---------------------------------------------------------------
const collection = await ensureCollection();
check("collection exists", collection === config.qdrant.collection, collection);

const dims = config.openai.embeddingDimensions;
const fake = (seed) => {
  const v = Array.from({ length: dims }, (_, i) => Math.sin(seed + i));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};
const pointId = (docId, i) => {
  const h = crypto.createHash("sha256").update(`${docId}:${i}`).digest("hex").slice(0, 32);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
};

const texts = ["middleware runs before the handler", "middleware can end the cycle", "errors need four arguments"];
const points = texts.map((text, i) => ({
  id: pointId("verify-v1", i),
  vector: fake(i + 1),
  payload: { text, source: "verify.pdf", documentId: "verify-v1", chunkIndex: i },
}));

await qdrant.upsert(collection, { wait: true, points });
await qdrant.upsert(collection, { wait: true, points });          // idempotency
const info = await qdrant.getCollection(collection);
check("upsert is idempotent", info.points_count >= 3, `points_count=${info.points_count}`);
check("collection is 1024/cosine", info.config.params.vectors.size === dims && info.config.params.vectors.distance === "Cosine");

const res = await qdrant.query(collection, { query: points[0].vector, limit: config.topK, with_payload: true });
check("nearest neighbour is the query point", res.points[0].id === points[0].id, `score=${res.points[0].score.toFixed(4)}`);
check("payload text comes back", typeof res.points[0].payload.text === "string", `"${res.points[0].payload.text}"`);

const filtered = await qdrant.query(collection, {
  query: points[1].vector, limit: config.topK, with_payload: true,
  filter: { must: [{ key: "documentId", match: { value: "verify-v1" } }] },
});
check("documentId filter matches", filtered.points.length === 3);

const none = await qdrant.query(collection, {
  query: points[1].vector, limit: config.topK, with_payload: true,
  filter: { must: [{ key: "documentId", match: { value: "nope" } }] },
});
check("unknown documentId returns nothing (refusal path)", none.points.length === 0);

// cleanup
await qdrant.delete(collection, { wait: true, points: points.map((p) => p.id) });
const after = await qdrant.getCollection(collection);
check("test points deleted", after.points_count === 0, `points_count=${after.points_count}`);

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
```


Run it on a throwaway collection so a real index is never touched:

```bash
QDRANT_COLLECTION=pdf_knowledge_verify node verify.mjs
```

Measured output on this machine:

```text
PASS chunks respect the size ceiling
PASS overlap repeats content
PASS empty input yields no chunks
PASS short input yields one chunk
PASS overlap >= size is rejected
Created collection "pdf_knowledge_verify" with 1024 dimensions
PASS collection exists — pdf_knowledge_verify
PASS upsert is idempotent — points_count=3
PASS collection is 1024/cosine
PASS nearest neighbour is the query point — score=1.0000
PASS payload text comes back — "middleware runs before the handler"
PASS documentId filter matches
PASS unknown documentId returns nothing (refusal path)
PASS test points deleted — points_count=0

13/13 checks passed
```

Clean up afterwards:

```bash
curl -s -X DELETE localhost:6333/collections/pdf_knowledge_verify
```

The suite covers everything except the two OpenAI calls — exactly the split between "logic you can test" and "provider you must observe".

---

## 4. Troubleshooting matrix

Every message below was produced by running the code, not inferred.

### 4.1 Startup and configuration

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `OPENAI_API_KEY is missing from .env` | key unset or empty | set it in `.env`; an empty shell value wins over `.env` |
| `CHUNK_SIZE must be a positive integer` | `0`, `2.5`, `abc` | integers > 0 only |
| `CHUNK_OVERLAP must be a positive integer` | you tried `CHUNK_OVERLAP=0` | not expressible via `.env`; call `chunkText(text, size, 0)` |
| `Chunk overlap must be smaller than chunk size` | `overlap >= size` | the step would be zero or negative |
| `text-embedding-3-small supports at most 1536 output dimensions` | `EMBEDDING_DIMENSIONS > 1536` with that model | use 1024/1536, or `text-embedding-3-large` |
| Embeddings 400 with `model: ""` | blank `EMBEDDING_MODEL=` line — `??` keeps `""` | remove the line or set a value (Chapter 02 §3.3) |

### 4.2 PDF and chunking

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `ENOENT: ./test/data/05-versions-space.pdf` | `pdf-parse` ESM debug block | `createRequire` + `pdf-parse/lib/pdf-parse.js` (Chapter 06 §3.3) |
| `ENOENT: no such file … ./documents/x.pdf` | path is relative to the project root | run from the root; check `filePath` |
| `No extractable text found in PDF` | scanned PDF, no text layer | OCR first |
| `Chunking failed to advance` | a >= 850-character whitespace-free run | one-line patch in Chapter 03 §5.4, or pre-clean URLs/base64 |
| Chunks look like gibberish | two-column PDF extracted out of order | layout-aware extractor; this chunker cannot fix it |
| Chunk count much higher than expected | `CHUNK_SIZE` lowered | chunks ≈ characters / (size − overlap) |

### 4.3 Qdrant

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `fetch failed` / `ECONNREFUSED 127.0.0.1:6333` | Qdrant not running | `docker run -d -p 6333:6333 qdrant/qdrant` |
| 401 / 403 from Qdrant Cloud | `QDRANT_API_KEY` empty | set it; `|| undefined` omits the header otherwise |
| `Collection dimension mismatch. Expected 768, but collection uses 1024…` | `EMBEDDING_DIMENSIONS` changed after indexing | new collection + re-index |
| "Not existing vector name" error | collection uses **named** vectors | this code assumes one unnamed vector |
| Upload rejects a point | vector length ≠ collection size | check `EMBEDDING_DIMENSIONS` and Chapter 04's validation |
| `points_count` keeps growing | `documentId` changed between runs | delete the old version (Chapter 06 §6) |

### 4.4 Answers

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| **Every** question returns the refusal string | `queryPdf.js` filters on the hard-coded `"backend-guide-v1"` | pass the id you indexed, or `undefined` |
| Refusal on a topic you know is in the PDF | chunk boundary, embedding mismatch, or low recall | inspect `sources`; try `TOP_K=8`; confirm a chunk contains the fact |
| Answer ignores the sources | prompt not obeyed | lower `temperature`, tighten the system prompt, add a score floor |
| Answer cites `[Source 9]` with 5 sources | no citation verification | add the check in Chapter 07 §5.2 |
| Answer is truncated | no `max_tokens`; `finish_reason: "length"` | set `max_tokens`, inspect `finish_reason` |
| `No answer was generated.` | empty `choices` or `content` | inspect the raw response; usually a content filter |

### 4.5 The debug tree in one table

| Observation | First suspect | Then |
| :--- | :--- | :--- |
| Refusal with `sources: []` | retrieval (filter, collection, index) | check `points_count`; query without the filter |
| Refusal with five sources listed | model obedience, not retrieval | inspect the context string; check `temperature` |
| Wrong sources retrieved | chunking / embedding space | read the top chunk's text; confirm model + dimensions match the index |
| Right sources, wrong answer | prompt or model | replay the exact prompt in a playground |
| Right answer, no citation | prompt clause, no verification | add marker verification (Chapter 07 §5.2) |


---

## 5. Sizing and cost worksheet

### 5.1 Index size

Each point stores 1024 `float32` values = **4,096 bytes** of vector, plus ~300–1,100 bytes of payload text.

| Chunks | Vectors | Raw vector bytes | With payload + index overhead |
| ---: | ---: | ---: | ---: |
| 56 (one 57-page deck) | 56 | 229 KB | ~0.5 MB |
| 154 (130k characters) | 154 | 631 KB | ~1.3 MB |
| 10,000 | 10,000 | 41 MB | ~90–120 MB |

Qdrant's in-memory HNSW index roughly doubles the footprint — plan on 2–3× the raw vector size.

### 5.2 Tokens per operation

| Operation | Tokens | Notes |
| :--- | :--- | :--- |
| Index one 57-page deck | ~12,000 embedding tokens | 47,665 chars ÷ ~4 |
| Embed one question | ~10 | below the pricing resolution of most invoices |
| Generate one answer | ~1,300 input + ~150 output | 5 chunks × ~250 tokens + prompt + question |

The asymmetry is the economic argument for RAG: **pay the corpus cost once, the context cost per question** — and `TOP_K` sets the second. Doubling `TOP_K` to 10 roughly doubles prompt tokens per query; it never changes indexing cost.

Use the provider's current per-million-token prices against those counts. At any recent `text-embedding-3-small` / `gpt-4o-mini` pricing, indexing a 57-page document and answering a hundred questions is measured in cents — which is why this pipeline is cheap to prototype with, and why stamping it into a loop without caching is not.

---

## 6. The gap to production (and where it is closed)

This codebase answers "what is the minimum honest RAG pipeline?". It does not answer "what do I ship?".

| Concern | Here | Where it is implemented properly |
| :--- | :--- | :--- |
| HTTP API | none — CLI only | `Productions RAG`: Express + Zod validation + error mapping |
| Multi-document / multi-tenant | one collection, optional `documentId` filter, no payload index | namespaces or indexed tenant fields |
| Refusal policy | model-dependent (no score floor) | calibrated floor, refuse before generating |
| Citation integrity | labels supplied, never verified | citation linker, invented ids counted and stripped |
| Conversation | stateless | TTL session store + query rewriting |
| Retrieval quality | pure vector, top-5 | hybrid BM25+vector, RRF, reranking |
| Evaluation | none | 12-case golden set: recall@K, citation validity, refusal accuracy |
| Observability | `console.log` | per-request trace: query, matches, budget, latency |
| Resilience | SDK default retries only | explicit retry with backoff, timeouts, degradation paths |
| Re-indexing | manual, whole document | blue/green collections keyed by `corpusVersion` |
| Secrets | `.env` on disk, git-ignored, placeholder only | env injection, secrets manager |
| Tests | none | offline providers + assertions + the `verify.mjs` from §3 |

The sibling guide is the natural continuation: it takes every row in that table and shows the code.

---

## 7. Cleanup

```bash
# Stop and delete the container (all vectors are lost — rebuild with npm run index)
docker rm -f qdrant

# Or delete only the data inside a running instance
curl -s -X DELETE localhost:6333/collections/pdf_knowledge

# Remove dependencies
rm -rf node_modules
```

The corpus (`documents/*.pdf`) is the only irreplaceable input; everything else is derived and reproducible.

---

## 8. Acceptance checklist

Tick these before calling the pipeline working:

- [ ] `node --check src/*.js` passes for all six files
- [ ] `node -e "import('./src/config.js')"` prints the resolved config with the expected dimensions
- [ ] Each of the five configuration guards fires with its documented message
- [ ] `docker run … qdrant/qdrant` responds on `:6333`
- [ ] `npm run index` prints `Extracted … characters`, `Created … chunks`, `Embedded n/n`, `Stored n/n`
- [ ] `curl localhost:6333/collections/pdf_knowledge` shows `points_count` equal to your chunk count
- [ ] Running `npm run index` twice leaves `points_count` unchanged
- [ ] `npm run query -- "…"` returns an answer containing `[Source n]`
- [ ] `sources` has at least as many entries as the answer's distinct citation labels
- [ ] A question about something absent from the PDF produces either the refusal string or a clear "not in the context" answer (this codebase cannot guarantee which — §6)
- [ ] Deleting the collection makes the next query return the refusal string, not a crash

---

## 9. The guide, in one map

```text
PDF ──► text ──► chunks ──► vectors ──► points ──► collection
        ch06     ch03       ch04        ch06       ch05
question ──► vector ──► matches ──► labels ──► answer + sources
            ch04       ch05/07     ch07       ch07
               config: ch02 · map: ch01 · run & prove: ch08
```

| Chapter | One-line takeaway |
| :--- | :--- |
| **01** | Four dependencies, six modules, two pipelines, one record shape. |
| **02** | Read env once; refuse to start on a contract violation. |
| **03** | 1,000-character window, 150 overlap, word snap; watch the 850-character run. |
| **04** | Same model and dimensions everywhere; align by index; validate every vector. |
| **05** | Collection size and metric are forever; verify, never silently migrate. |
| **06** | Deterministic ids + upsert = re-runnable ingestion. |
| **07** | Labels before generation; refusal before generation; sources always returned. |
| **08** | Prove what you can offline, and know exactly what you did not prove. |

---

**Back to:** [Guide index](./README.md) · **Production counterpart:** [`../../Productions RAG/implementations guide/README.md`](../../Productions%20RAG/implementations%20guide/README.md) · **Theory:** [`../../../notes/README.md`](../../../notes/README.md)
