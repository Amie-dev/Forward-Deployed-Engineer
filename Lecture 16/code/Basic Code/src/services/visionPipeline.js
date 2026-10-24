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
