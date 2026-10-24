# Chapter 03 — Text Pipeline: Text → Tokens → Vectors

> **Goal of this chapter:** implement the pipeline images must *copy*. Chapter 03 of the
> notes exists because you cannot understand image handling until you can see the move text
> already makes: **replace the modality with a sequence of learned vectors.**
>
> **Lecture chapter:** [03 — From Text to Numbers: The Text Pipeline](../../../notes/03_From_Text_To_Numbers_The_Text_Pipeline.md).

---

## 3.1 File details

| | |
|---|---|
| **Path** | `src/services/textPipeline.js` |
| **Purpose** | text → tokens → token IDs → embedding vectors, deterministically |
| **Imports** | `config` (for `embeddingSize`) |
| **Exports** | `tokenize`, `tokenId`, `embed`, `runTextPipeline` |
| **Who imports it** | `visionPipeline` (`embed`), `demo.js`, `app.test.js` |
| **Depends on** | `src/config/config.js` only |

**Commands**

```bash
cd "Lecture 16/code/Basic Code"
node -e "import('./src/services/textPipeline.js').then(m => console.log(m.runTextPipeline('HI, my name is Aditya')))"
```

---

## 3.2 Full file

**Path:** `src/services/textPipeline.js`

```js
// Lecture 16 · Chapter 03 — the text pipeline: Text → Tokens → Token IDs → Vectors.
//
// "The model never sees English." Chapter 03 restates the pipeline we already know
// (Lecture 02) because images will follow exactly this shape in Chapter 04.
import { config } from '../config/config.js';

// Step 1 — split text into tokens.
// A real tokenizer (BPE) uses a 50k-200k entry vocabulary and splits sub-words.
// This word-level stand-in keeps the demo readable and reproducible.
export function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// Step 2 — every token has an ID.
// The board's example: "HI, my name is Aditya" becomes token IDs 23 41 56.
// Here the ID is a stable hash, so the same word always gets the same number —
// which is exactly the property a real vocabulary provides.
export function tokenId(token) {
  let hash = 7;
  for (const character of token) {
    hash = (hash * 31 + character.codePointAt(0)) % 4096;
  }
  return hash;
}

// Step 3 — the embedding: a dense vector of numbers (the board's v1, v2, v3 ...).
// Real embeddings are LEARNED by training. This deterministic pseudo-vector (a
// Lehmer generator) stands in for one, so identical input gives identical output
// and the demo is testable. Chapter 04.6 reuses it for images on purpose.
export function embed(seed, size = config.embeddingSize) {
  let state = (seed * 48271 + 11) % 2147483647 || 1;
  const vector = [];
  for (let index = 0; index < size; index += 1) {
    state = (state * 48271) % 2147483647;
    vector.push(Number(((state / 2147483647) * 2 - 1).toFixed(2)));
  }
  return vector;
}

// The whole pipeline in one call, used by the offline demo and the tests.
export function runTextPipeline(text) {
  return tokenize(text).map((token) => {
    const id = tokenId(token);
    return { token, id, vector: embed(id) };
  });
}
```

---

## 3.3 Block-by-block explanation

**Block 1 — the header and the single import**

```js
import { config } from '../config/config.js';
```

- The only dependency is the constant file: this module needs to know how long a vector is.
- `../config/config.js` walks up from `src/services/` to `src/`, then into `config/`. The
  `.js` suffix is required — ESM import specifiers are real file paths (Chapter 01).

**Block 2 — `tokenize`: text becomes units**

```js
export function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
```

- **What it does:** turns `"HI, my name is Aditya"` into
  `["hi", "my", "name", "is", "aditya"]`.
- `String(text)` defends against a non-string (a number, `undefined`) arriving from a request
  body, so this never throws on bad input.
- `.toLowerCase()` is what makes `HI` and `hi` the same token — a vocabulary is
  case-insensitive far more often than not.
- `/[a-z0-9]+/g` matches runs of letters and digits, which **discards punctuation and
  whitespace for free**: the comma after `HI,` is simply never matched.
- `?? []` handles the one case where `match` returns `null`: no matches at all (empty input).
  Without it, `runTextPipeline('')` would crash on `.map` of `null`.
- **How this differs from reality:** a production tokenizer is BPE — byte-pair encoding —
  which splits rare words into sub-word pieces (`"tokenization"` → `"token"` + `"ization"`)
  and has a vocabulary of 50,000–200,000 entries. Word-level is chosen here because it is
  legible in a printout, and Chapter 03's point survives the simplification: **the model's
  unit is not the word you typed.**

**Block 3 — `tokenId`: every token gets a number**

```js
export function tokenId(token) {
  let hash = 7;
  for (const character of token) {
    hash = (hash * 31 + character.codePointAt(0)) % 4096;
  }
  return hash;
}
```

- **What it does:** maps a token to a stable integer. `"cat"` always gives the same ID, on
  every machine, forever.
- The board's annotation is *token IDs `23 41 56`* — arbitrary-looking integers. This is a
  hash (a small polynomial rolling hash, the same `h = h*31 + c` shape Java's
  `String.hashCode` uses), which is exactly the right mental model: **the ID is an index into
  a lookup table, not a meaning.**
- `% 4096` keeps IDs in a small range. A real vocabulary would have 50k+ entries; 4096 keeps
  the demo's numbers short, and nothing else depends on the range.
- `codePointAt(0)` returns the character's numeric code — `'a'` is `97`. Using code points
  rather than raw bytes means the hash is not corrupted by multi-byte characters.
- **Why deterministic and not random?** Because the same input must produce the same output,
  or the pipeline is untestable. `app.test.js` runs `runTextPipeline(x)` twice and compares
  the results with `deepEqual`.


**Block 4 — `embed`: the number becomes a vector**

```js
export function embed(seed, size = config.embeddingSize) {
  let state = (seed * 48271 + 11) % 2147483647 || 1;
  const vector = [];
  for (let index = 0; index < size; index += 1) {
    state = (state * 48271) % 2147483647;
    vector.push(Number(((state / 2147483647) * 2 - 1).toFixed(2)));
  }
  return vector;
}
```

- **What it does:** turns a token ID into 8 numbers — the board's `v1 v2 v3`.
- This is a **Lehmer linear congruential generator**: `state = (state × 48271) mod 2³¹−1`.
  Given the same seed it produces the same sequence: a deterministic stand-in for a learned
  embedding table.
- `state / 2147483647` maps the state into `[0, 1)`; `* 2 - 1` maps it into `[-1, 1)`.
  Embedding components are signed in real models too, so the range is right.
- `.toFixed(2)` rounds to two decimals so the vectors print on one line. `Number(...)` turns
  the resulting string back into a number, because `toFixed` returns a **string**.
- The `|| 1` on the seed line is a guard: if `seed * 48271 + 11` were an exact multiple of the
  modulus, `state` would be `0`, and an LCG at `0` stays at `0` forever — producing a constant
  vector. `|| 1` breaks that degenerate case.
- `size = config.embeddingSize` is a **default parameter**, so callers can ask for a different
  length without this module changing. `visionPipeline` does exactly that.

> **The honest caveat.** Real embeddings are *learned*: training moves a word's vector so that
> `"cat"` ends up near `"kitten"` and far from `"bicycle"`. This generator produces vectors
> that are stable and signed but carry **no meaning**. That is deliberate — meaning arrives in
> Chapter 06 (alignment), and this chapter is only about *shape*. Chapter 04 then reuses this
> exact function for images, which is the lecture's **"two paths, one word: vectors"**.

**Block 5 — `runTextPipeline`: the whole pipeline in one call**

```js
export function runTextPipeline(text) {
  return tokenize(text).map((token) => {
    const id = tokenId(token);
    return { token, id, vector: embed(id) };
  });
}
```

- Composes the three steps and returns **one object per token**. `demo.js` prints
  `.map(t => t.token)` as the token list and `.map(t => t.id)` as the token IDs.
- Returning a list of records rather than parallel arrays is what lets the demo and the tests
  read the intermediate stages (`token`, then `id`, then `vector`) — the entire pedagogical
  value of this file.

---

## 3.4 Run / verify

```bash
cd "Lecture 16/code/Basic Code"
node -e "import('./src/services/textPipeline.js').then(m => console.log(m.runTextPipeline('HI, my name is Aditya')))"
```

Expected (verified on Node v24.22.0):

```text
tokens  : hi, my, name, is, aditya
token IDs: 1864, 2035, 3858, 1905, 3805
vector  : [0, 0.71, 0.16, -0.85, -0.54, -1, 0.1, -0.13]
```

In `npm run demo`, section 1 prints the same shape for the lecture's question:

```text
   tokens     : why, is, my, payment, failing
   token IDs  : 2657, 1905, 2035, 3103, 3613
   vector     : [0.86, 0.46, 0.25, 0.33, 0.31, -0.25, -0.65, 0.84]  (v1, v2, v3 ...)
```

Notice `is` has ID `1905` in **both** lists — same word, same ID, in any sentence. That is the
property a vocabulary provides.

---

## 3.5 Checkpoint

1. **Why does `tokenize` lower-case and strip punctuation?** → so `HI,` and `hi` are the same
   token; punctuation is not part of the model's unit set.
2. **Is `tokenId('cat')` meaningful?** → No. It is an index into a lookup table. Meaning lives
   in the *embedding*, and even there only after training (Chapter 06).
3. **Which line proves Chapter 04.6's "two paths, one word: vectors"?** → `embed` is exported
   and reused by `visionPipeline.encodePatches` — the vision encoder returns the same *kind*
   of object the text embedder returns.

**Next:** [Chapter 04 — Vision Pipeline: Pixels → Patches → Embeddings](./04_Vision_Pipeline_Pixels_Patches_Embeddings.md)

