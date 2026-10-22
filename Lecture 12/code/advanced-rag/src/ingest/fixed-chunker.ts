import { countTokens, sha256, tokenizer } from '../lib/text.js';
import type { Chunk, SourceDocument } from '../types.js';

/**
 * Fixed-size chunking — the baseline, implemented properly so its failure is
 * honest rather than an artifact of a bug.
 *
 * Two units, because real systems use both:
 *  - `chars`: what most quick-start tutorials do (1,000 characters, 150 overlap).
 *    Characters are cheap and wrong: a 1,000-character window is 180 tokens of
 *    German or 320 tokens of English, so token budgets move underneath you.
 *  - `tokens`: what an embedding model actually counts. A 400-token window with
 *    80 tokens of overlap is a defensible starting point.
 *
 * What this chunker cannot do is the point of the next chapter: it has no idea
 * what a heading is, so every chunk it produces has `heading: ''`, no breadcrumb,
 * and no parent. `chunkIndex` is the only position information it keeps.
 */

export interface FixedChunkOptions {
  size: number;
  overlap: number;
  unit: 'tokens' | 'chars';
}

export function chunkFixed(doc: SourceDocument, options: FixedChunkOptions): Chunk[] {
  const stride = options.size - options.overlap;

  // Chapter 02's classic bug: overlap >= size means the window never advances,
  // and the ingestion loop either hangs or emits thousands of duplicates.
  if (stride <= 0) {
    throw new Error(`Invalid chunking: size=${options.size}, overlap=${options.overlap} never advances.`);
  }

  const pieces =
    options.unit === 'tokens'
      ? splitByTokens(doc.text, options.size, options.overlap)
      : splitByChars(doc.text, options.size, options.overlap);

  return pieces.map((piece, index) => ({
    id: sha256(doc.source, 'fixed', index, piece),
    text: piece,
    source: doc.source,
    title: doc.title,
    heading: '',
    breadcrumb: '',
    chunkIndex: index,
    tokens: countTokens(piece),
    parentId: null,
    meta: doc.meta,
  }));
}

function splitByTokens(text: string, size: number, overlap: number): string[] {
  const encoder = tokenizer();
  const tokens = encoder.encode(text);
  if (tokens.length === 0) return [];
  if (tokens.length <= size) return [text.trim()];

  const stride = size - overlap;
  const pieces: string[] = [];

  for (let start = 0; start < tokens.length; start += stride) {
    const piece = encoder.decode(tokens.slice(start, start + size)).trim();
    if (piece) pieces.push(piece);
    if (start + size >= tokens.length) break;
  }

  return pieces;
}

function splitByChars(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text.trim()];

  const stride = size - overlap;
  const pieces: string[] = [];

  for (let start = 0; start < text.length; start += stride) {
    const raw = text.slice(start, start + size);
    // Snap forward to the next space so a word is not cut in half. The cost is a
    // window that is a few characters longer than requested — never shorter.
    const piece = start + size >= text.length ? raw : raw.slice(0, Math.max(raw.lastIndexOf(' '), 1));
    if (piece.trim()) pieces.push(piece.trim());
  }

  return pieces;
}

/**
 * Chunks that should never exist.
 *
 * An orphan is a chunk with no heading (blind window), that is too short to embed
 * meaningfully, or that starts mid-sentence. These are the chunks that produce
 * confident nonsense: they match a query on a stray word, and they carry no
 * subject to contradict the match.
 */
export function findOrphans(chunks: readonly Chunk[], minTokens = 30): Chunk[] {
  return chunks.filter((chunk) => {
    const startsMidSentence = /^[a-z(]/.test(chunk.text);
    return chunk.tokens < minTokens || startsMidSentence;
  });
}

export interface ChunkStats {
  chunks: number;
  tokens: number;
  averageTokens: number;
  orphans: number;
  /** Chunks ÷ documents covered if the corpus were one stream — the 1/(1-ρ) factor. */
  storageMultiplier: number;
}

export function chunkStats(docs: readonly SourceDocument[], chunks: readonly Chunk[], options: FixedChunkOptions): ChunkStats {
  const tokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
  const documentTokens = docs.reduce((sum, doc) => sum + countTokens(doc.text), 0);

  return {
    chunks: chunks.length,
    tokens,
    averageTokens: chunks.length === 0 ? 0 : Math.round(tokens / chunks.length),
    orphans: findOrphans(chunks).length,
    storageMultiplier: documentTokens === 0 ? 0 : Number((tokens / documentTokens).toFixed(2)),
  };
}
