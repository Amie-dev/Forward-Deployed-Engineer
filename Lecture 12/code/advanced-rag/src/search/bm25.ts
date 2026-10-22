import { terms } from '../lib/text.js';
import type { DocMeta, IndexRecord, ScoredChunk } from '../types.js';

/**
 * BM25 — the lexical half of hybrid search, implemented rather than imported.
 *
 * Why not a library: BM25 is six formulas, and every one of them explains a
 * failure mode you will meet in production.
 *
 *   idf(t)    = ln(1 + (N − df + 0.5) / (df + 0.5))     rare terms matter more
 *   tfNorm    = tf·(k1 + 1) / (tf + k1·(1 − b + b·|d|/avgdl))
 *   score(q,d)= Σ idf(t) · tfNorm(t,d)
 *
 * `k1` controls how quickly repeated terms stop helping (1.2 is the usual
 * saturation point). `b` controls length normalisation: 1 = fully normalised,
 * 0 = not at all. On policy documents, where one long document would otherwise
 * outrank every short one, 0.75 is a sane default.
 *
 * The reason this exists at all: dense retrieval is bad at exact strings. An SKU
 * ("AX-204"), an error code, a version number and a date are *tokens*, not
 * concepts, and a bi-encoder happily returns a semantically similar product.
 */

export interface Bm25Options {
  k1: number;
  b: number;
}

export class Bm25Index {
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly lengths: number[] = [];
  private readonly records: readonly IndexRecord[];
  private readonly idf = new Map<string, number>();
  private readonly averageLength: number;
  private readonly options: Bm25Options;

  constructor(records: readonly IndexRecord[], options: Bm25Options) {
    this.records = records;
    this.options = options;

    let totalLength = 0;

    records.forEach((record, index) => {
      // The heading is part of the searchable text: "Return window" must match
      // "return window", even when the phrase is only in the heading.
      const tokens = terms(`${record.breadcrumb} ${record.text}`);
      this.lengths[index] = tokens.length;
      totalLength += tokens.length;

      for (const token of tokens) {
        let posting = this.postings.get(token);
        if (!posting) {
          posting = new Map<number, number>();
          this.postings.set(token, posting);
        }
        posting.set(index, (posting.get(index) ?? 0) + 1);
      }
    });

    this.averageLength = records.length === 0 ? 0 : totalLength / records.length;

    const total = records.length;
    for (const [token, posting] of this.postings) {
      const df = posting.size;
      this.idf.set(token, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
    }
  }

  /** How many documents contain a term — the `df` a reviewer will ask for. */
  documentFrequency(token: string): number {
    return this.postings.get(token.toLowerCase())?.size ?? 0;
  }

  search(query: string, topK: number, predicate?: (meta: DocMeta) => boolean): ScoredChunk[] {
    const queryTerms = [...new Set(terms(query).filter((term) => !STOP.has(term)))];
    const scores = new Array<number>(this.records.length).fill(0);

    for (const term of queryTerms) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const idf = this.idf.get(term) ?? 0;

      for (const [index, tf] of posting) {
        const length = this.lengths[index] || 1;
        const denominator =
          tf + this.options.k1 * (1 - this.options.b + (this.options.b * length) / this.averageLength);
        scores[index] += idf * ((tf * (this.options.k1 + 1)) / denominator);
      }
    }

    const hits: ScoredChunk[] = [];

    this.records.forEach((record, index) => {
      const score = scores[index];
      if (score <= 0) return;
      if (predicate && !predicate(record.meta)) return;

      const { vector: _vector, embedText: _embedText, ...chunk } = record;
      hits.push({ chunk, score, origin: 'lexical' });
    });

    hits.sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
    return hits.slice(0, topK);
  }

  /** Terms shared by query and text — used by the offline reranker. */
  coverage(query: string, text: string): number {
    const queryTerms = [...new Set(terms(query).filter((term) => !STOP.has(term)))];
    if (queryTerms.length === 0) return 0;

    const textTerms = new Set(terms(text));
    let hits = 0;
    for (const term of queryTerms) if (textTerms.has(term)) hits++;
    return hits / queryTerms.length;
  }
}

/** Query-side stopwords only. Removing them from documents costs recall. */
const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'for', 'of',
  'to', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'if', 'it', 'its', 'this', 'that', 'my', 'i',
  'what', 'how', 'when', 'where', 'which', 'who', 'why', 'you', 'your', 'we', 'our', 'still', 'after',
]);
