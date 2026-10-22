import { config } from "./config.js";

export function chunkText(
  text,
  chunkSize = config.chunking.chunkSize,
  overlap = config.chunking.chunkOverlap
) {
  if (typeof text !== "string") {
    throw new TypeError("Text must be a string");
  }

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("Chunk size must be a positive integer");
  }

  if (
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= chunkSize
  ) {
    throw new Error(
      "Chunk overlap must be non-negative and smaller than chunk size"
    );
  }

  const clean = text.replace(/\s+/g, " ").trim();

  if (!clean) return [];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);

    // Prefer a whitespace boundary to avoid splitting words.
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(" ", end);

      if (lastSpace > start) {
        end = lastSpace;
      }
    }

    const chunk = clean.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= clean.length) break;

    const nextStart = end - overlap;

    // Defensive check to ensure the loop always progresses.
    if (nextStart <= start) {
      throw new Error("Chunking failed to advance");
    }

    start = nextStart;
  }

  return chunks;
}
