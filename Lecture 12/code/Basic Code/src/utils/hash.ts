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
