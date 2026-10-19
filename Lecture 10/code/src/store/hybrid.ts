import { TopK } from '../lib/topk.js';

export interface LexicalDoc {
  id: string;
  text: string;
}

export interface LexicalHit {
  id: string;
  score: number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it',
  'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'with',
]);

/**
 * BM25 — the lexical half of hybrid search.
 *
 * Dense vectors capture meaning but lose exact tokens (IDs, names, error codes).
 * BM25 captures term overlap and rare-term importance. Fusing both is standard
 * production retrieval; generation is deliberately out of scope for Lecture 10.
 */
export class Bm25Index {
  private readonly docs: { id: string; tokens: string[]; length: number }[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private averageLength = 0;

  constructor(
    documents: readonly LexicalDoc[],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    for (const document of documents) {
      const tokens = tokenize(document.text);
      this.docs.push({ id: document.id, tokens, length: tokens.length });
      for (const token of new Set(tokens)) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
    }
    this.averageLength =
      this.docs.length === 0
        ? 0
        : this.docs.reduce((sum, document) => sum + document.length, 0) / this.docs.length;
  }

  search(query: string, k = 10): LexicalHit[] {
    if (this.docs.length === 0 || k <= 0) return [];
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const top = new TopK(k);
    for (const document of this.docs) {
      const frequencies = new Map<string, number>();
      for (const token of document.tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }

      let score = 0;
      for (const term of new Set(terms)) {
        const tf = frequencies.get(term) ?? 0;
        if (tf === 0) continue;
        const df = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (document.length / (this.averageLength || 1)));
        score += idf * ((tf * (this.k1 + 1)) / denominator);
      }
      if (score > 0) top.push(document.id, score);
    }
    return top.results();
  }
}

/**
 * Reciprocal Rank Fusion: score = Σ weight / (k + rank).
 *
 * It needs only ranks, not comparable scores, which is why it can fuse cosine
 * similarity (0..1), BM25 (unbounded) and reranker scores without calibration.
 */
export function reciprocalRankFusion(
  resultSets: readonly (readonly LexicalHit[])[],
  options: { k?: number; weights?: readonly number[]; limit?: number } = {},
): LexicalHit[] {
  const k = options.k ?? 60;
  const weights = options.weights ?? [];
  const scores = new Map<string, number>();

  resultSets.forEach((results, setIndex) => {
    const weight = weights[setIndex] ?? 1;
    [...results]
      .sort((a, b) => b.score - a.score)
      .forEach((result, rank) => {
        scores.set(result.id, (scores.get(result.id) ?? 0) + weight / (k + rank + 1));
      });
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, options.limit ?? 10);
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(singularize);
}

function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}
