import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { VectorStore } from '../store/vector-store.js';
import type { Match } from '../types/rag.types.js';
import { lexicalOverlap } from './lexical.js';

export interface RetrievalOptions {
  topK: number;
  /** How many candidates to fetch per requested result, before the score floor. */
  candidateMultiplier: number;
  /** Similarity floor. Calibrate it on a golden set; never guess. */
  minScore: number;
  /** 0 = pure vector search, 1 = pure keyword matching. 0.3–0.4 is a good start. */
  lexicalWeight: number;
}

export interface RetrievalResult {
  matches: Match[];
  candidates: number;
  embedMs: number;
  searchMs: number;
}

/**
 * Query-time retrieval: one embedding call, one vector search, one filter.
 *
 * Over-fetch then trim. Fetching exactly `topK` means a low-scoring chunk
 * occupies a slot that a better one behind it could have filled; fetching 3×
 * and dropping everything under the floor gives the ranking room to work
 * without paying for a reranker.
 */
export class Retriever {
  constructor(
    private readonly deps: {
      store: VectorStore;
      embeddings: EmbeddingProvider;
      options: RetrievalOptions;
    },
  ) {}

  async retrieve(question: string): Promise<RetrievalResult> {
    const embedStarted = performance.now();
    const [vector] = await this.deps.embeddings.embed([question], 'query');
    const embedMs = performance.now() - embedStarted;

    if (!vector) throw new Error('The embedding provider returned no vector for the query.');

    const searchStarted = performance.now();
    const candidates = await this.deps.store.query({
      vector,
      topK: this.deps.options.topK * this.deps.options.candidateMultiplier,
    });
    const searchMs = performance.now() - searchStarted;

    const matches = candidates
      .map((candidate) => {
        const lexical = lexicalOverlap(question, `${candidate.section}\n${candidate.text}`);
        const score =
          (1 - this.deps.options.lexicalWeight) * candidate.score +
          this.deps.options.lexicalWeight * lexical;

        return { ...candidate, score };
      })
      .sort((left, right) => right.score - left.score)
      .filter((candidate) => candidate.score >= this.deps.options.minScore)
      .slice(0, this.deps.options.topK);

    return { matches, candidates: candidates.length, embedMs, searchMs };
  }
}
