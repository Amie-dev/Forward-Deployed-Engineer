# Chapter 15 — Utils: One Hash, Two Uses

> **Goal of this chapter:** read the smallest file in the project, and see why it
> exists at all. Two services needed the same hash; a `utils/` layer is where a
> pure helper goes when it has no domain knowledge.
>
> **Lecture chapters:** [02](../../../notes/02_Fixed_Size_Chunking_and_Overlap.md)
> (the deterministic chunk id) and
> [06](../../../notes/06_Hybrid_Search_and_RRF.md) (the embedder's token buckets).

---

## 15.1 File details

| Property | Value |
|---|---|
| **Path** | `src/utils/hash.ts` |
| **Layer** | helpers (pure functions) |
| **Purpose** | one FNV-1a implementation, used by the chunker and the embedder |
| **Imports** | **none** |
| **Exports** | `fnv1a`, `contentHash` |
| **Imported by** | `services/chunking.ts` (via `contentHash`), `services/embeddings.ts` (via `fnv1a`) |
| **Lecture sections** | 02 §"ids: the unsexy requirement"; 06 §"BM25 in one line" |

### Why a `utils/` folder and not a copy

| Option | Consequence |
|---|---|
| Copy FNV-1a into `chunking.ts` and `embeddings.ts` | two implementations that can silently diverge |
| Put it in `services/` | it is not a domain service — it has no idea what a chunk is |
| **`utils/hash.ts`** | one implementation, no domain knowledge, importable by any layer |

---

## 15.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run chunks     # prints chunk ids — every one ends in contentHash(text)
npm run ask        # embeds text, which uses fnv1a per token
```

---

## 15.3 Full file

**Path:** `src/utils/hash.ts`

```ts
/**
 * Chapter 03 — one hash, used in two places.
 *
 * The chunk id needs a deterministic content hash (Chapter 05) and the embedder
 * needs a deterministic bucket per token (Chapter 06). Both are FNV-1a, so it
 * lives here instead of being copied into two services.
 */

/** FNV-1a: a 32-bit hash in six lines, no dependency. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned, so `% n` is never negative
}

/** Chapter 05 — `source + index + contentHash`: same text → same id. */
export function contentHash(text: string): string {
  return fnv1a(text).toString(16).padStart(8, "0");
}
```

---

## 15.4 Block-by-block explanation

**Block 1 — the header comment states the rule**

```ts
/**
 * Chapter 03 — one hash, used in two places.
 *
 * The chunk id needs a deterministic content hash (Chapter 05) and the embedder
 * needs a deterministic bucket per token (Chapter 06). Both are FNV-1a, so it
 * lives here instead of being copied into two services.
 */
```

- The rule a `utils/` file must satisfy: **no domain knowledge, and more than one
  caller.** A helper with one caller belongs next to that caller; a helper that
  knows what a chunk is belongs in `services/`.
- "Deterministic" is the operative word in both sentences. The whole project's
  reproducibility — the ablation table, the golden set, the chunk ids — rests on
  this function returning the same value for the same input forever.

**Block 2 — `fnv1a`**

```ts
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned, so `% n` is never negative
}
```

- FNV-1a is an XOR-then-multiply hash: the offset basis `0x811c9dc5` and the
  prime `0x01000193` are the published constants.
- `Math.imul` is required, not optional. A plain `hash * 0x01000193` overflows
  JavaScript's double-precision integers and silently loses the low bits — the
  hash would still *look* random but would stop being FNV-1a. `Math.imul` keeps
  the multiplication in 32-bit space.
- `>>> 0` converts the signed 32-bit result into an unsigned integer, which is
  the reason the embedder can write `h % DIMENSIONS` without worrying about a
  negative index.
- Six lines, no dependency — which matters because the alternative is a crypto
  import for a job that only needs "spread tokens evenly".

**Block 3 — `contentHash`, and why it is a separate export**

```ts
export function contentHash(text: string): string {
  return fnv1a(text).toString(16).padStart(8, "0");
}
```

- `toString(16)` renders the hash as hexadecimal, `padStart(8, "0")` makes it
  fixed-width so ids are visually comparable. The result is the last component of
  `docId#index#contentHash`.
- Keeping it as a second named export rather than a local helper in `chunking.ts`
  means the *meaning* of a chunk id is documented in one place: same text → same
  id → re-ingest is idempotent, an edited document gets a new id.
- `embeddings.ts` imports only `fnv1a`, so the hex formatting is not dragged into
  the vector path — the module boundary is doing its job.

---

## 15.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run chunks
```

Expected: every chunk id ends in eight hex characters, and running the command
twice produces **identical** ids — e.g. `return-policy-electronics#1#7cfa05be`.
That reproducibility is `contentHash`, and the same function is what makes the
ablation table stable across runs.

---

## 15.6 Checkpoint

1. **What two rules make something a `utils/` helper?** No domain knowledge, and
   more than one caller.
2. **Why `Math.imul` and not `*`?** A plain multiply overflows the float's exact
   integer range and loses the low bits; `imul` multiplies in 32-bit space.
3. **Which half does the embedder import, and why not both?** Only `fnv1a` — the
   hex formatting belongs to chunk ids, not to vectors.

**Next:** [Chapter 16 — The controller](./16_The_Controller.md)
