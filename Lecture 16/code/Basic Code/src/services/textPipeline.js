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
