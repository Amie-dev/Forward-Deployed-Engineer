# Chapter 05 — Alignment: Position, Projection & Attention

> **Goal of this chapter:** close the gap between the two pipelines. Chapter 04 left us with
> *two* sets of vectors that are the same kind of object but not yet comparable. This chapter
> adds **position**, applies the **projection**, measures **attention**, and then answers
> Chapter 06's question: what does it mean for a picture and a word to *match*?
>
> **Lecture chapters:** [05 — Connecting Vision to Language](../../../notes/05_Connecting_Vision_To_Language_Projection_Position_And_Attention.md)
> and [06 — How Models Learn Vision-Language Alignment](../../../notes/06_How_Models_Learn_Vision_Language_Alignment.md).

---

## 5.1 File details

| | |
|---|---|
| **Path** | `src/services/alignmentService.js` |
| **Purpose** | position labels, projection into language space, cosine similarity, attention, training pairs |
| **Imports** | none — pure functions, no config, no I/O |
| **Exports** | `positionOf`, `project`, `cosine`, `averageVector`, `trainingPair`, `alignmentScore`, `attention` |
| **Who imports it** | `demo.js` |
| **Depends on** | nothing |

**Commands**

```bash
cd "Lecture 16/code/Basic Code"
npm run demo            # section 3 and 4 are this file
```

> **Why this file has no imports.** Everything here is arithmetic on arrays. Keeping it
> dependency-free makes the chapter's claims checkable in isolation — and it is why
> `alignmentService` can be read as *the mathematics of Chapters 05–06* rather than as code
> that happens to touch a config object.

---

## 5.2 Full file

**Path:** `src/services/alignmentService.js`

```js
// Lecture 16 · Chapters 05 / 06 — connecting vision to language.
//
// Chapter 05 is the machinery: position, projection, attention.
// Chapter 06 is the meaning: what it means for a picture and a word to "match".

// Chapter 05.3 — position is ADDED, never inferred.
// The board's label is "patch content + patch position" (top-left / bottom-right).
// Two identical patches in different places must NOT look identical to the model,
// otherwise "cat on the left" and "cat on the right" are the same sentence.
export function positionOf({ row, col }, { rows, cols }) {
  const vertical = row < rows / 2 ? 'top' : 'bottom';
  const horizontal = col < cols / 2 ? 'left' : 'right';
  return `${vertical}-${horizontal}`;
}

// Chapter 05.2 — the projection layer / adapter: visual vectors → the language
// model's space. Without it the two pipelines are in different coordinate systems
// and attention has nothing meaningful to compare.
export function project(vector) {
  return vector.map((value, index) => Number((value * 0.5 + index * 0.01).toFixed(2)));
}

// Chapter 06.3 — cosine similarity: how close two vectors point.
// This is the quantity alignment training pushes UP for a matching pair.
export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  // A zero vector has no direction, so it cannot be similar to anything.
  // Say so explicitly instead of letting 0/0 become NaN and leak downstream.
  return denominator === 0 ? 0 : dot / denominator;
}

// Chapter 06.2 — training data is IMAGES + DESCRIPTION. The pair is the lesson.
// Collapse a set of patch vectors into ONE image vector so it can be compared.
// Note: a real model LEARNS this pooling; averaging is the honest stand-in here.
// Keep the sample small — the mean of thousands of unrelated vectors is just noise.
export function averageVector(vectors) {
  return vectors[0].map((_, index) =>
    Number((vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length).toFixed(2)));
}

export function trainingPair(description, patches) {
  return { description, imageVector: averageVector(patches.map((patch) => patch.vector)) };
}

// Chapter 06.3 — "how well does this picture match this word?"
export function alignmentScore(textVector, imageVector) {
  return Number(cosine(textVector, imageVector).toFixed(3));
}

// Chapter 05.6 — attention across both modalities: which patch does each word lean on?
// Illustrative only. A real model runs this inside every layer, with softmax weights.
export function attention(textVectors, visualVectors) {
  return textVectors.map((text) => {
    const ranked = visualVectors
      .map((visual) => ({
        index: visual.index,
        score: Number(cosine(text.vector, visual.vector).toFixed(3)),
      }))
      .sort((a, b) => b.score - a.score);
    return { token: text.token, patch: ranked[0].index, score: ranked[0].score };
  });
}
```

---

## 5.3 Block-by-block explanation

**Block 1 — `positionOf`: position is added, never inferred**

```js
export function positionOf({ row, col }, { rows, cols }) {
  const vertical = row < rows / 2 ? 'top' : 'bottom';
  const horizontal = col < cols / 2 ? 'left' : 'right';
  return `${vertical}-${horizontal}`;
}
```

- **What it does:** turns a patch's grid coordinates into a human label. Patch `0` of a
  `68 × 120` grid → `"top-left"`; the last patch → `"bottom-right"`. Those are exactly the two
  labels the board draws.
- **Why this matters (Chapter 05.3).** A patch vector on its own is a "bag of patches": the
  model would have no idea whether the cat is in the top-left or the bottom-right. Two
  identical patches in different places would look identical, and `"cat on the left"` and
  `"cat on the right"` would become the same sentence. **Position must be supplied.**
- `row < rows / 2` is a midpoint test, not a per-patch enumeration. A real model uses *learned
  positional embeddings* — one vector per grid slot, added to the patch vector. The midpoint
  label here is a readable stand-in for "position information is attached to the patch", which
  is the board's `patch content + patch position`.
- Destructuring `{ row, col }` and `{ rows, cols }` in the signature means the function accepts
  a patch and the grid **shape** directly, with no property lookups in the body. `demo.js`
  passes `vision.patches[0]` and the whole `vision` object, because `vision` carries `rows`
  and `cols`.

**Block 2 — `project`: the adapter into language space**

```js
export function project(vector) {
  return vector.map((value, index) => Number((value * 0.5 + index * 0.01).toFixed(2)));
}
```

- **What it does:** maps a visual vector into a *different* vector, the way the projection
  layer / adapter maps vision output into the language model's space (Chapter 05.2).
- `value * 0.5` rescales the components; `index * 0.01` makes the transform depend on the
  position *within the vector*, so it is not a simple scalar multiplication. The output is
  therefore not merely a resized copy of the input — it is a genuinely different vector, which
  is the point.
- **Why the adapter exists at all.** Text embeddings and visual embeddings come from two
  separately trained encoders. They are the same *kind* of object (Chapter 04.6) but live in
  different coordinate systems — the same numbers do not mean the same thing. The projection
  is what makes `"cat"`'s vector and a cat-patch's vector **comparable**.
- **What this is not.** A real adapter is a small trained neural network (often a linear layer
  or a two-layer MLP). This is an affine transform with hand-picked constants — a shape
  demonstration, not a learned mapping.

**Block 3 — `cosine`: how close two vectors point**

```js
export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
```

- **What it does:** returns a number in `[-1, 1]` describing the *angle* between two vectors.
  `1` = same direction, `0` = unrelated, `-1` = opposite.
- The formula is `dot(a,b) / (|a| · |b|)`: the dot product measures alignment, and dividing by
  both lengths removes **magnitude** from the answer. That is why cosine is the right measure
  here — we care whether two vectors *point* the same way, not how long they are.
- One loop computes all three quantities (`dot`, `normA`, `normB`) in a single pass. Norm is
  the square root of the sum of squares — the vector's length.
- **The explicit zero guard.** If either vector is all zeros, `denominator` is `0` and `0/0` is
  `NaN`. An earlier version wrote `dot / (denominator || 1)`, which silently turned that `NaN`
  into a score of **1** — "perfectly similar" for a vector that has no direction at all. The
  guard now returns `0`, and says why in a comment. This is a small but real example of a
  plausible-looking expression producing a confidently wrong answer.
- `a[index] ** 2` is the exponentiation operator: `a[index]²`. Written this way to avoid the
  visual noise of `Math.pow`.

**Block 4 — `averageVector`: many patch vectors become one image vector**

```js
export function averageVector(vectors) {
  return vectors[0].map((_, index) =>
    Number((vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length).toFixed(2)));
}
```

- **What it does:** element-wise mean across a list of vectors — 32 patch vectors become one
  "image vector".
- `vectors[0].map((_, index) => …)` is the standard way to iterate *by dimension* when you need
  the index: take the shape from the first vector and reduce down each column. `_` marks the
  unused value.
- **Two honest caveats, both in the comments:**
  1. A real multimodal model **learns** its pooling step — the image representation is
     produced by a trained layer, not by a mean.
  2. Keep the sample small. The mean of 8,160 unrelated pseudo-random vectors rounds to
     `0.00` in every dimension — mathematically correct, and completely uninformative. That is
     why `demo.js` passes `vision.patches.slice(0, 32)`.


**Block 5 — `trainingPair`: the lesson is the pair**

```js
export function trainingPair(description, patches) {
  return { description, imageVector: averageVector(patches.map((patch) => patch.vector)) };
}
```

- **What it does:** builds the shape of one training example — Chapter 06.2's
  *images + description*.
- `patches.map(p => p.vector)` discards the patch geometry and keeps only the vectors, because
  `averageVector` works on a list of vectors.
- **Chapter 06's load-bearing idea, in code:** the model is never told what a cat is. It sees
  millions of pairs like `(this picture, "a cat sleeping")` and is trained so that the two
  representations move **closer together**. The description is the supervision signal.
- Returning `{ description, imageVector }` rather than a single vector keeps the **pair**
  visible in the return value — which is what the demo prints.

**Block 6 — `alignmentScore`: does this picture match this word?**

```js
export function alignmentScore(textVector, imageVector) {
  return Number(cosine(textVector, imageVector).toFixed(3));
}
```

- A thin, named wrapper around `cosine`, rounded to three decimals for display. The name is the
  point: the same arithmetic that measures "similarity" is the *objective* that alignment
  training maximises.
- In the demo it prints `-0.659` for `"a screenshot of a failed payment"` against the image
  vector. **A negative score is the honest result here** — the vectors are pseudo-random, so an
  untrained "model" has no reason to agree with the description. That is precisely what
  Chapter 06 says training *fixes*: millions of pairs push this number up for matching pairs
  and down for mismatches.

**Block 7 — `attention`: which patch does each word lean on?**

```js
export function attention(textVectors, visualVectors) {
  return textVectors.map((text) => {
    const ranked = visualVectors
      .map((visual) => ({
        index: visual.index,
        score: Number(cosine(text.vector, visual.vector).toFixed(3)),
      }))
      .sort((a, b) => b.score - a.score);
    return { token: text.token, patch: ranked[0].index, score: ranked[0].score };
  });
}
```

- **What it does:** for every word, scores it against every patch and returns the best-matching
  patch. That is Chapter 05.6's *"combining text and image"* reduced to its core question:
  **which part of the picture is this word about?**
- `.sort((a, b) => b.score - a.score)` sorts **descending** — largest score first. Sorting
  ascending is the classic mistake here and would report the *least* related patch.
- `ranked[0]` is the argmax. Returning `{ token, patch, score }` gives one readable row per
  word, which is what the demo prints.
- **Why the demo shows only 8 patches.** If you score a word against all 8,160 patches, the
  *maximum* of 8,160 near-random similarities is always ≈ 1, so every word reports `1.000` and
  the output teaches nothing. Restricting the candidate set makes the numbers interpretable.
  This is a genuine property of argmax over many candidates, not a bug.
- **What this is not.** Real attention is computed *inside every layer* of the model, with
  learned query/key/value projections, and the weights are normalised with a **softmax** so
  they sum to 1 across patches. This function has no softmax and no learned weights — it shows
  the *question* attention asks, not how the model answers it.

---

## 5.4 Run / verify

```bash
cd "Lecture 16/code/Basic Code"
npm run demo        # sections 3 and 4
```

Expected (verified):

```text
3. CONNECTING VISION TO LANGUAGE (Chapter 05)
   p1 position: top-left   last patch: bottom-right
   projected  : [0.09, 0.18, 0.19, 0.1, 0.34, -0.35, 0.42, 0.5]  (into the language model space)
   attention  : which patch does each word lean on?
      "why" -> patch 3 (score 0.626)
      "is" -> patch 2 (score 0.736)
      "my" -> patch 6 (score 0.7)
      "payment" -> patch 2 (score 0.909)
      "failing" -> patch 5 (score 0.826)

4. HOW IT LEARNS IT (Chapter 06) — training data is images + description
   training pair : image + "a screenshot of a failed payment"
   image vector  : [0, -0.01, -0.02, 0.02, 0.05, -0.02, -0.12, 0.01]
   text vector   : [0.48, 0.24, 0.22, -0.07, -0.15, 0.11, 0.42, 0.12]
   alignment     : -0.659  (cosine, -1..1; training pushes it up)
```

Read those two sections together and you have the whole lecture: **position** makes the picture
make sense, the **projection** makes the two spaces comparable, **cosine** says how comparable,
and **training** is what moves the number in the right direction.

---

## 5.5 Checkpoint

1. **Why must position be *added* rather than inferred from the vector?** → otherwise the model
   has a bag of patches; `"cat on the left"` and `"cat on the right"` would be identical.
2. **What does dividing by `|a|·|b|` in `cosine` remove, and why does that matter?** →
   magnitude. We care whether two vectors *point* the same way, not how long they are.
3. **Why does the demo only score 8 patches?** → the argmax over 8,160 near-random
   similarities is always ≈ 1, so every word would report `1.000` and teach nothing.

**Next:** [Chapter 06 — Cost Guard: The Image Token Budget](./06_Cost_Guard_Image_Token_Budget.md)

