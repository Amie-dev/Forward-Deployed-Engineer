# Chapter 05: Qdrant Client & Collection

> **Chapter Goal:** Stand up the one piece of shared state in the system — a Qdrant collection whose vector size and distance metric match the embeddings — and refuse to operate against a collection that does not match.

> **Lecture mapping:** Chapter 05 (The Vector Index). Namespaces, the record model and the query anatomy from the notes map onto *collections*, *points* and `qdrant.query()` here.

> **File details:**

| | |
| :--- | :--- |
| **Path** | `src/qdrant.js` |
| **Lines** | 50 |
| **Imports** | `QdrantClient` from `@qdrant/js-client-rest`, `config` from `./config.js` |
| **Exports** | `qdrant` (client instance), `ensureCollection()` |
| **Side effects** | Creates a collection on first use; logs one line when it does |
| **Used by** | `src/indexPdf.js`, `src/queryPdf.js` |

---

## 1. What a collection is, and why it is created here

A Qdrant **collection** is a named index over **points**. Every point has an `id`, a `vector` and an optional `payload`. Three properties are fixed when the collection is created and cannot be changed afterwards:

| Property | This code | Consequence of changing it |
| :--- | :--- | :--- |
| Vector `size` | `EMBEDDING_DIMENSIONS` (1024) | Requires a new collection and a full re-embed |
| `distance` | `Cosine` | Requires a new collection; changes what `score` means |
| Payload schema / indexes | none | Can be added later, non-destructively |

That immutability is why the file is defensive: a collection created with the wrong size is not repairable in place, and every subsequent upsert or query fails in a way that looks like a client bug.

`ensureCollection()` therefore does **create-if-missing, verify-if-present**, and returns the collection name so callers never re-derive it from `config`.

---

## 2. Complete source code

#### 📄 `src/qdrant.js`

```js
import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";

export const qdrant = new QdrantClient({
  url: config.qdrant.url,
  apiKey: config.qdrant.apiKey,
});

export async function ensureCollection() {
  const collectionName = config.qdrant.collection;

  const { collections } = await qdrant.getCollections();

  const exists = collections.some(
    (collection) => collection.name === collectionName
  );

  if (!exists) {
    await qdrant.createCollection(collectionName, {
      vectors: {
        size: config.openai.embeddingDimensions,
        distance: "Cosine",
      },
    });

    console.log(
      `Created collection "${collectionName}" with ` +
      `${config.openai.embeddingDimensions} dimensions`
    );

    return collectionName;
  }

  // Do not silently use an existing collection with incompatible dimensions.
  const info = await qdrant.getCollection(collectionName);
  const vectorConfig = info.config.params.vectors;

  if (
    typeof vectorConfig.size !== "number" ||
    vectorConfig.size !== config.openai.embeddingDimensions
  ) {
    throw new Error(
      `Collection dimension mismatch. Expected ` +
      `${config.openai.embeddingDimensions}, but collection uses ` +
      `${vectorConfig.size}. Create a compatible collection or migrate it.`
    );
  }

  return collectionName;
}
```

---

## 3. Block by block

### 3.1 The client — one instance, exported

```js
import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";

export const qdrant = new QdrantClient({
  url: config.qdrant.url,
  apiKey: config.qdrant.apiKey,
});
```

- **Exported, not hidden.** `indexPdf.js` and `queryPdf.js` both import `{ qdrant, ensureCollection }` and call methods directly. That keeps the wrapper thin: this file owns *identity and readiness*, not every possible operation.
- **`apiKey: undefined`** is meaningful: for local Docker there is no key, and the client omits the header entirely (Chapter 02 §3.5). For Qdrant Cloud you set `QDRANT_API_KEY` and the same line authenticates.
- **REST, not gRPC.** `@qdrant/js-client-rest` speaks HTTP on `:6333`. Each call is a `fetch`, so no connection pool tuning is needed; the trade-off is slightly higher per-call overhead than gRPC on `:6334`.
- **`checkCompatibility` is left at its default (`true`)**, which makes the client fetch the server version once and warn on a mismatch. That check is the reason a version drift shows up as a console warning instead of an unexplained 400.
- **No timeouts configured.** A Qdrant call that hangs hangs the indexing run. Chapter 08 lists this as an operational gap.

### 3.2 `ensureCollection()` — the readiness gate

```js
export async function ensureCollection() {
  const collectionName = config.qdrant.collection;

  const { collections } = await qdrant.getCollections();

  const exists = collections.some(
    (collection) => collection.name === collectionName
  );
```

- **Two round trips, always.** `getCollections()` lists every collection, then `.some()` matches by name. There is no "does X exist" endpoint, so listing is the only way. On local Qdrant that is a fraction of a millisecond; on Qdrant Cloud it is a ~20–50 ms API call on **every index and every query**. This is the obvious thing to memoise once the collection is known to exist.
- **Name comparison is exact and case-sensitive** — `pdf_knowledge` ≠ `Pdf_Knowledge`.
- **The destructuring `{ collections }`** assumes the client's success shape (`{ result: { collections } }` unwrapped by the SDK). Verified response: `{"result":{"collections":[]},"status":"ok"}` over raw HTTP becomes `{ collections: [] }` through the client.

### 3.3 Create-if-missing

```js
  if (!exists) {
    await qdrant.createCollection(collectionName, {
      vectors: {
        size: config.openai.embeddingDimensions,
        distance: "Cosine",
      },
    });

    console.log(
      `Created collection "${collectionName}" with ` +
      `${config.openai.embeddingDimensions} dimensions`
    );

    return collectionName;
  }
```

- **`size` comes from the embedding config**, not from a literal. That one dependency keeps the collection and the embedder in agreement — and it is why `EMBEDDING_DIMENSIONS` lives in `config.openai`, where the embedder reads it.
- **`distance: "Cosine"`** — the metric matches how these vectors are meant to be compared (direction, not magnitude). Alternatives are `Dot` (needs unit vectors to behave like cosine), `Euclid` and `Manhattan`. Whatever you choose must match the meaning of `score`, because nothing normalises the score afterwards.
- **No payload indexes at creation.** Filtering on `documentId` works without one — Qdrant just scans. Irrelevant for a few thousand points; for a multi-tenant collection, create a keyword index on `documentId` here.
- **The `return` inside the branch** skips the verification call: the collection was just created with the right size, so re-reading it is a wasted round trip.
- **The log line is the only confirmation a human gets** that the index was initialised. Verified:

  ```
  Created collection "pdf_knowledge" with 1024 dimensions
  ```

### 3.4 Verify-if-present — the dimension guard

```js
  // Do not silently use an existing collection with incompatible dimensions.
  const info = await qdrant.getCollection(collectionName);
  const vectorConfig = info.config.params.vectors;

  if (
    typeof vectorConfig.size !== "number" ||
    vectorConfig.size !== config.openai.embeddingDimensions
  ) {
    throw new Error(
      `Collection dimension mismatch. Expected ` +
      `${config.openai.embeddingDimensions}, but collection uses ` +
      `${vectorConfig.size}. Create a compatible collection or migrate it.`
    );
  }

  return collectionName;
}
```

- **`info.config.params.vectors`** is the shape for a collection with a single *unnamed* vector. Verified against a live server:

  ```json
  {"size":1024,"distance":"Cosine"}
  ```

  With **named vectors** (`{"text": {"size": 1024, …}}`) that object would be a map, `vectorConfig.size` would be `undefined`, and the `typeof … !== "number"` check turns it into the same clear error instead of a `NaN` comparison.

- **The error carries both numbers**, which is the entire diagnostic: *expected* comes from your `.env`, *actual* from the server. Verified by running with `EMBEDDING_DIMENSIONS=768` against a 1024 collection:

  ```
  Collection dimension mismatch. Expected 768, but collection uses 1024. Create a compatible collection or migrate it.
  ```

- **Fail, do not migrate.** Silently dropping and recreating the collection would delete the corpus on a typo. Migration means creating `pdf_knowledge_v2` with the new size, re-indexing and switching `QDRANT_COLLECTION` — an explicit operator decision, which is what the message asks for.

### 3.5 Why this function runs twice per query

`indexPdf.js` calls it first (so a fresh environment self-initialises) and `queryPdf.js` calls it too (so a query against a missing collection fails with a clear message rather than an opaque 404). The cost is two API calls per query — fine for a teaching system, wasteful for a service. A production version resolves the collection once at boot and caches it, invalidating only on admin action.



---

## 4. Verified behaviour

Run against `qdrant/qdrant` in Docker with `@qdrant/js-client-rest@1.19.0`:

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
curl -s localhost:6333/collections        # {"result":{"collections":[]},"status":"ok"}
```

| Step | Result |
| :--- | :--- |
| First `ensureCollection()` | `Created collection "pdf_knowledge" with 1024 dimensions`, returns `pdf_knowledge` |
| `getCollection()` right after | `config.params.vectors = {"size":1024,"distance":"Cosine"}`, `points_count: 0`, `status: "green"` |
| Second `ensureCollection()` | returns `pdf_knowledge`, no log, no error |
| Call with `EMBEDDING_DIMENSIONS=768` | throws the mismatch error quoted in §3.4 |
| After upserting 3 points | `points_count: 3` |
| Repeating the identical upsert | `points_count` stays `3` — same ids, overwritten |

That last row is the payoff of deterministic point ids (Chapter 06): **re-indexing is idempotent**, so a failed run can simply be run again.

---

## 5. Commands

```bash
cd "Lecture 11/code/Eassy RAG"

# Start / inspect / stop the store
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
curl -s localhost:6333/collections
curl -s localhost:6333/collections/pdf_knowledge | head -c 400

# Create the collection through the code under test
node --input-type=module -e '
import { ensureCollection } from "./src/qdrant.js";
console.log(await ensureCollection());
'

# Confirm the guard (against the existing 1024 collection)
EMBEDDING_DIMENSIONS=768 node --input-type=module -e '
import("./src/qdrant.js").then(m => m.ensureCollection())
  .catch(e => console.log(e.message));
'

# Remove everything and start clean
curl -s -X DELETE localhost:6333/collections/pdf_knowledge
docker rm -f qdrant
```

---

## 6. What this chapter established

| Decision | Value | Changeable later? |
| :--- | :--- | :--- |
| Store | Qdrant, REST client | yes (three calls to re-implement) |
| Collection name | `QDRANT_COLLECTION` | yes (new name) |
| Vector size | `EMBEDDING_DIMENSIONS` | **no — new collection** |
| Distance | `Cosine` | **no — new collection** |
| Payload indexes | none | yes |
| Missing collection | created | — |
| Mismatched collection | throws with both numbers | — |

**Next:** [Chapter 06 — The Indexing Pipeline](./06_Indexing_Pipeline.md)
