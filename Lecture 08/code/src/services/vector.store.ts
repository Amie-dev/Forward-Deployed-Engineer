import type { Movie, ScoredMovie, CatalogStatus } from '../types/movie.types.js';
import { MOVIE_CATALOG } from '../data/movies.js';
import { embeddingService } from './embedding.service.js';

/**
 * VectorStore — in-memory implementation of the STORE step.
 *
 * Responsibilities:
 *   1. Phase 1 (build)  — embed every movie description once, cache the result
 *   2. Phase 2 (query)  — compare a query vector against all stored vectors
 *
 * In production this would be backed by pgvector, Pinecone, or Qdrant.
 * For this learning demo, a simple in-memory array is sufficient and clear.
 */
export class VectorStore {
  private catalog: Movie[] = [];
  private isReady = false;

  /**
   * PHASE 1 — REPRESENT + STORE
   *
   * Embeds all movie descriptions in a single batch API call, then stores
   * each movie alongside its vector for future comparisons.
   *
   * Key engineering insight from notes:
   *   Movie descriptions are STABLE data → process once, reuse forever.
   *   User queries are CHANGING data  → process per request.
   */
  async build(): Promise<void> {
    console.log(`[VectorStore] Building catalog: ${MOVIE_CATALOG.length} movies...`);

    // Extract all descriptions for batch embedding (one API call, not N calls)
    const descriptions = MOVIE_CATALOG.map(m => m.description);
    const vectors = await embeddingService.embedBatch(descriptions);

    // Pair each movie with its embedding vector
    this.catalog = MOVIE_CATALOG.map((movie, i) => ({
      ...movie,
      vector: vectors[i],
    }));

    this.isReady = true;
    console.log(`[VectorStore] ✅ Catalog ready — ${this.catalog.length} movies embedded.`);
  }

  /**
   * PHASE 2, STEP 1 — COMPARE
   *
   * Score every movie in the catalog against the provided query vector
   * using cosine similarity, then sort descending (most similar first).
   *
   * @param queryVector   Embedding of the user's query or source movie
   * @param excludeId     Movie to exclude from results (used for "similar to X")
   * @returns             Scored and sorted list of movies
   */
  findSimilar(queryVector: number[], excludeId?: string): ScoredMovie[] {
    this.assertReady();

    return this.catalog
      .filter(movie => movie.id !== excludeId)
      .map(movie => ({
        movie,
        // COMPARE: Cosine similarity between query vector and movie vector
        score: cosineSimilarity(queryVector, movie.vector!),
      }))
      .sort((a, b) => b.score - a.score); // RANK: highest similarity first
  }

  /**
   * Look up a movie by its ID.
   */
  getById(id: string): Movie | undefined {
    return this.catalog.find(m => m.id === id);
  }

  /**
   * Return all movies (without their internal vectors).
   */
  getAllMovies(): Movie[] {
    return this.catalog;
  }

  status(): CatalogStatus {
    return {
      totalMovies: MOVIE_CATALOG.length,
      embeddedMovies: this.catalog.filter(m => m.vector !== undefined).length,
      isReady: this.isReady,
    };
  }

  private assertReady(): void {
    if (!this.isReady) {
      throw new Error(
        'VectorStore is not ready. Call build() first or wait for startup to complete.'
      );
    }
  }
}

// ─── Cosine Similarity ────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 *
 * Measures the angle between the vectors — ignores magnitude entirely.
 * This is exactly what we want for text embeddings: two semantically
 * identical texts may produce vectors of different magnitudes but they
 * should point in the same direction.
 *
 * Formula: cos(θ) = (A · B) / (|A| × |B|)
 *
 * Output range: -1.0 (opposite) to +1.0 (identical)
 * In practice for text:  0.0 (unrelated) to 1.0 (very similar)
 *
 * @see Chapter 05 of the lecture notes for full explanation
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  // Single loop — compute all three values together for efficiency
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0; // Guard against zero-vectors

  return dotProduct / magnitude;
}

// Singleton — one store shared across the application
export const vectorStore = new VectorStore();
