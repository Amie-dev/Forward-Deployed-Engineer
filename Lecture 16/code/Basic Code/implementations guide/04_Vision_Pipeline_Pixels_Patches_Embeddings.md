# Chapter 04 — Vision Pipeline: Pixels → Patches → Embeddings

> **Goal of this chapter:** deliver Chapter 03's promise for images. An image is *already*
> numbers — the work is not conversion, it is **reshaping a 2-D grid into a sequence** and
> then compressing each region into a vector.
>
> **Lecture chapter:** [04 — Images Are Numbers: Pixels, Patches and Visual Embeddings](../../../notes/04_Images_Are_Numbers_Pixels_Patches_And_Visual_Embeddings.md).

---

## 4.1 File details

| | |
|---|---|
| **Path** | `src/services/visionPipeline.js` |
| **Purpose** | measure an image, cut it into patches, encode each patch into a vector |
| **Imports** | `config` (`patchSize`), `embed` from `./textPipeline.js` |
| **Exports** | `rawNumbers`, `readDimensions`, `toPatches`, `encodePatches`, `runVisionPipeline` |
| **Who imports it** | `chatService` (`readDimensions`), `demo.js`, `app.test.js` |
| **Depends on** | `src/config/config.js`, `src/services/textPipeline.js` |

**Commands**

```bash
cd "Lecture 16/code/Basic Code"
npm run demo            # section 2 is this file
npm test -- --test-name-pattern "Chapter 04"
```

---

## 4.2 Full file

**Path:** `src/services/visionPipeline.js`

```js
// Lecture 16 · Chapter 04 — the vision pipeline: Pixels → Patches → Visual Embeddings.
//
// "An image is already a grid of numbers; the problem is its SHAPE, not its type."
import { config } from '../config/config.js';
import { embed } from './textPipeline.js';

// Chapter 04.1 — cat.jpg at 1920 x 1080 is 2,073,600 pixels ≈ 6.2 million numbers
// once the three colour channels are counted.
export function rawNumbers({ width, height }) {
  return width * height * 3;
}

// Read the real width/height out of the bytes, so the patch arithmetic is measured
// rather than guessed. PNG keeps them in the IHDR chunk; JPEG in the Start-Of-Frame.
export function readDimensions(buffer) {
  // An 8-byte signature + IHDR is 24 bytes, so the minimum is exactly 24.
  if (buffer.length >= 24 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  const error = new Error('Unsupported image format: only PNG and JPEG can be measured.');
  error.status = 400;
  throw error;
}

// Chapter 04.3 — Step 1: cut the grid into patches (the board's "p1 p2 ... 16 * 16").
// This is the move that turns a 2-D grid into a SEQUENCE — the shape text already has.
export function toPatches({ width, height }, patchSize = config.patchSize) {
  const cols = Math.ceil(width / patchSize);
  const rows = Math.ceil(height / patchSize);
  const patches = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      patches.push({ index: patches.length, row, col });
    }
  }
  return { rows, cols, patchSize, patches };
}

// Chapter 04.5 — Step 2: the vision encoder turns each patch into a dense vector
// like [0.12, -0.55, 1.04, ...]. Notice it reuses the SAME `embed` as text: Chapter
// 04.6's whole point is that text and visual embeddings are the same KIND of object.
export function encodePatches(patches) {
  return patches.map((patch) => ({ ...patch, vector: embed(patch.index + 101) }));
}

// The whole vision pipeline in one call.
export function runVisionPipeline(buffer) {
  const dimensions = readDimensions(buffer);
  const { rows, cols, patchSize, patches } = toPatches(dimensions);
  return {
    dimensions,
    rows,
    cols,
    patchSize,
    rawNumbers: rawNumbers(dimensions),
    patches: encodePatches(patches),
  };
}
```

---

## 4.3 Block-by-block explanation

**Block 1 — the imports (and the deliberate cross-service one)**

```js
import { config } from '../config/config.js';
import { embed } from './textPipeline.js';
```

- `config` supplies the patch size.
- `embed` comes from the **text** pipeline. This is not an accident of refactoring — it is the
  code expressing Chapter 04.6's claim: *text embeddings and visual embeddings are the same
  kind of object: vectors.* Reusing the function makes that claim structural instead of
  rhetorical, and `demo.js` prints both vectors side by side to show it.

**Block 2 — `rawNumbers`: the arithmetic that motivates everything**

```js
export function rawNumbers({ width, height }) {
  return width * height * 3;
}
```

- **What it does:** for `1920 × 1080` it returns `6,220,800` — the ~6.2 million numbers from
  Chapter 04.1, because every pixel carries three channels (R, G, B).
- This function exists for one reason: to make Chapter 04.2's **Volume** row concrete. Six
  million numbers per image, when a text prompt is a few hundred tokens, is why attention over
  raw pixels is fatal.

**Block 3 — `readDimensions`: measuring instead of guessing**

```js
export function readDimensions(buffer) {
  if (buffer.length >= 24 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  const error = new Error('Unsupported image format: only PNG and JPEG can be measured.');
  error.status = 400;
  throw error;
}
```

- **Why this exists at all:** Chapters 04 and 08 both need the real width and height. Reading
  them from the file header costs ~20 lines and **no dependency** — versus pulling in an image
  library and decoding 6 million pixels just to learn two integers.
- **The PNG branch.** A PNG starts with an 8-byte signature (`\x89PNG\r\n\x1a\n`), then a chunk
  named `IHDR` whose payload begins with width and height as big-endian 32-bit integers.
  Counting bytes: signature `0–7`, chunk length `8–11`, chunk type `12–15`, **width `16–19`,
  height `20–23`**. Hence `readUInt32BE(16)` and `readUInt32BE(20)`.
- `buffer.toString('latin1', 1, 4) === 'PNG'` checks bytes 1–3. `latin1` maps each byte to one
  character, so this is a byte comparison without decoding anything.
- The length guard is `>= 24` because 24 bytes is *exactly* the minimum for signature + IHDR.
  (An earlier version used `> 24` and rejected its own 24-byte test fixture — a good reminder
  that off-by-one bugs in byte parsing are found by tests, not by reading.)
- **The JPEG branch.** JPEG has no header with a size. It is a sequence of marker segments
  starting `FF D8`. The loop walks segment by segment: `FF` begins a marker, the next byte is
  the marker id, and the two bytes after that give the segment length. `offset += 2 + length`
  skips to the next marker.
- The size lives in a **Start-Of-Frame** marker, `SOF0`–`SOF15` (`0xC0`–`0xCF`) — *except*
  `0xC4` (Huffman tables), `0xC8` (JPEG extension) and `0xCC` (arithmetic coding tables), which
  sit in that numeric range but are not frame headers. That exclusion list is the whole reason
  the check is three conditions long.
- Inside a SOF segment: `+5` is height and `+7` is width, as big-endian 16-bit integers.
- **The failure path.** An unmeasurable buffer does not return a default or a guess — it
  throws. `error.status = 400` tags it as a *client* error, so `middleware/upload.js`'s error
  handler will answer `400` instead of `502`. This is Chapter 07.9's "do not guess the missing
  part" applied to metadata.


**Block 4 — `toPatches`: the grid becomes a sequence**

```js
export function toPatches({ width, height }, patchSize = config.patchSize) {
  const cols = Math.ceil(width / patchSize);
  const rows = Math.ceil(height / patchSize);
  const patches = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      patches.push({ index: patches.length, row, col });
    }
  }
  return { rows, cols, patchSize, patches };
}
```

- **What it does:** for `1920 × 1080` at patch size `16` it produces a **120 × 68** grid —
  **8,160 patches**. That single number is Chapter 04.3's "Step 1" *and* Chapter 08.2's invoice.
- `Math.ceil`, not `Math.floor`. A 1920-wide image divides evenly by 16, but 1080 does not:
  `1080 / 16 = 67.5`. Rounding down would silently drop the bottom half-row of the image.
  Real vision models pad the last row instead; `ceil` is the honest approximation, and the
  demo prints `68 x 120` to match.
- The double loop is **row-major order**: left to right, then top to bottom. That is exactly
  the order the board's `p1 p2 p3 ...` implies, and it is what makes `index` a meaningful
  position in a sequence.
- `index: patches.length` is evaluated *before* the push, so the first patch is index `0`.
- Returning `{ rows, cols, patchSize, patches }` rather than just the array keeps the grid
  **shape** alongside the flattened list. `alignmentService.positionOf` needs `rows` and `cols`
  to decide whether a patch is `top-left` or `bottom-right` — the flattening must not lose the
  geometry.
- **The key sentence for this block:** this is the move that turns a 2-D grid into a
  **sequence**. Once it is a sequence, it is the shape a transformer already consumes.

**Block 5 — `encodePatches`: the vision encoder**

```js
export function encodePatches(patches) {
  return patches.map((patch) => ({ ...patch, vector: embed(patch.index + 101) }));
}
```

- **What it does:** gives every patch a dense vector — the board's `[0.12, -0.55, …]` coming
  out of the **Vision Encoder**.
- `{ ...patch, vector }` spreads the existing `{ index, row, col }` and **adds** `vector`. The
  patch keeps its identity *and* gains its embedding, which is what Chapter 05.3 will need:
  *patch content + patch position*.
- `embed(patch.index + 101)` reuses the text embedder. The `+ 101` offset simply keeps patch
  seeds away from the small token-ID range so the demo's two vector families do not collide —
  it has no deeper meaning.
- **What this is not.** A real vision encoder is a trained Vision Transformer: its output is a
  *learned feature vector* that encodes edges, textures and object parts (Chapter 04.5). This
  function produces a stable pseudo-vector that encodes nothing. The point being demonstrated
  is the **interface**, not the intelligence: *patches in, vectors out*.

**Block 6 — `runVisionPipeline`: the whole pipeline in one call**

```js
export function runVisionPipeline(buffer) {
  const dimensions = readDimensions(buffer);
  const { rows, cols, patchSize, patches } = toPatches(dimensions);
  return {
    dimensions,
    rows,
    cols,
    patchSize,
    rawNumbers: rawNumbers(dimensions),
    patches: encodePatches(patches),
  };
}
```

- Reads the size, builds the grid, encodes it, and returns one object containing every
  intermediate the demo prints: `dimensions`, `rows`, `cols`, `patchSize`, `rawNumbers`, and
  the encoded `patches`.
- `rawNumbers` is included here rather than computed by the caller so the "6.2 million" figure
  is always consistent with the measured dimensions.

---

## 4.4 Run / verify

```bash
cd "Lecture 16/code/Basic Code"
npm run demo        # section 2
```

Expected (verified):

```text
2. VISION PIPELINE (Chapter 04) — an image is already numbers
   pixels     : 2073600 (~6220800 raw numbers)
   patch grid : 68 x 120 patches of 16 x 16
   patch count: 8160 visual units (a grid became a sequence)
   p1 vector  : [0.18, 0.34, 0.34, 0.14, 0.61, -0.8, 0.73, 0.86]
```

`2,073,600 = 1920 × 1080`, `~6,220,800 = 2,073,600 × 3`, and `8,160 = 120 × 68`. Those three
numbers are Chapters 04.1, 04.2 and 04.3 in one screen.

---

## 4.5 Checkpoint

1. **An image is already numbers — so what is the actual problem?** → the **shape**. A
   continuous 2-D grid with no natural unit; patches turn it into a sequence of units.
2. **Why `Math.ceil` and not `Math.floor`?** → `1080 / 16 = 67.5`; flooring would silently
   discard the bottom of the image.
3. **Why does `encodePatches` import `embed` from the text pipeline?** → to make Chapter 04.6
   structural: the vision encoder returns the same *kind* of object the text embedder does — a
   vector. "Two paths, one word: vectors."

**Next:** [Chapter 05 — Alignment: Position, Projection & Attention](./05_Alignment_Position_Projection_and_Attention.md)

