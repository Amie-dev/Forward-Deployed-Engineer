import { getEncoding, type Tiktoken } from 'js-tiktoken';

import { sha256 } from '../lib/text.js';
import type { Chunk, SourceDocument } from '../types/rag.types.js';

export interface ChunkOptions {
  /** Target window size, in tokens. 300–500 is the usual sweet spot. */
  size: number;
  /** Tokens repeated at the start of the next window, so a rule is never cut in half. */
  overlap: number;
}

let cached: Tiktoken | undefined;

/** cl100k_base is the tokenizer used by text-embedding-3-* and GPT-4-class models. */
function tokenizer(): Tiktoken {
  cached ??= getEncoding('cl100k_base');
  return cached;
}

export function countTokens(text: string): number {
  return tokenizer().encode(text).length;
}

/**
 * Split a document into retrievable chunks.
 *
 * Two passes, because one is not enough:
 *   1. Structure — markdown headings become sections, so a chunk never mixes
 *      refund rules with shipping rules and every chunk inherits a real label.
 *   2. Size — each section is cut into overlapping token windows. A 300-token
 *      chunk with 50 tokens of overlap means a rule that straddles a boundary
 *      still appears whole in at least one chunk.
 *
 * Ids are `sha256(source:index:text)`, so re-ingesting unchanged documents
 * rewrites the same rows instead of duplicating the index.
 */
export function chunkDocument(document: SourceDocument, options: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of splitSections(document.text, document.title)) {
    for (const piece of splitByTokens(section.body, options.size, options.overlap)) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: sha256(document.source, String(chunkIndex), piece),
        text: piece,
        source: document.source,
        section: section.heading,
        chunkIndex,
        tokens: countTokens(piece),
      });
    }
  }

  return chunks;
}

/**
 * The string that is actually embedded.
 *
 * Retrieval only ever matches what the model has seen. Prefixing the document
 * and section name gives a bare sentence like "Apparel: 3 days." enough context
 * to be found by "refund window for apparel".
 */
export function toEmbeddingText(chunk: Chunk): string {
  return `${chunk.source} › ${chunk.section}\n${chunk.text}`;
}

interface Section {
  heading: string;
  body: string;
}

/** Headings are cheap structure. Use them before falling back to blind windows. */
function splitSections(text: string, fallbackTitle: string): Section[] {
  const sections: Section[] = [];
  let heading = fallbackTitle;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body) sections.push({ heading, body });
  };

  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1];
      continue;
    }
    buffer.push(line);
  }

  flush();
  return sections;
}

function splitByTokens(text: string, size: number, overlap: number): string[] {
  const encoder = tokenizer();
  const tokens = encoder.encode(text);

  if (tokens.length === 0) return [];
  if (tokens.length <= size) return [text.trim()];

  const stride = Math.max(1, size - overlap);
  const pieces: string[] = [];

  for (let start = 0; start < tokens.length; start += stride) {
    const piece = encoder.decode(tokens.slice(start, start + size)).trim();
    if (piece) pieces.push(piece);
    // Taking the last full window and stopping keeps the tail from becoming a
    // 12-token chunk that embeds to noise.
    if (start + size >= tokens.length) break;
  }

  return pieces;
}
