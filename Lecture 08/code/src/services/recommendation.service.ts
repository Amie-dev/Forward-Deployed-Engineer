import type { Movie, MovieResponse, SearchResult, RecommendResult } from '../types/movie.types.js';
import { embeddingService } from './embedding.service.js';
import { vectorStore } from './vector.store.js';
import { env } from '../config/env.js';

/**
 * RecommendationService — orchestrates the full REPRESENT → STORE → COMPARE → RANK pipeline.
 *
 * This service exposes the two features described in the lecture:
 *   Feature 1: semanticSearch()       — user describes what they want
 *   Feature 2: findSimilarMovies()    — user is watching a movie, find similar ones
 *
 * Notice that both features share the same `vectorStore.findSimilar()` call.
 * The only difference is where the starting vector comes from.
 */
export class RecommendationService {

  /**
   * FEATURE 1: Semantic Movie Search
   *
   * Pipeline:
   *   Query Text → Embed (REPRESENT) → Compare (COMPARE) → Sort (RANK)
   *
   * The user doesn't need to know the exact movie title — they describe the kind
   * of movie they want and we find the closest matches semantically.
   */
  async semanticSearch(query: string, topN = env.DEFAULT_TOP_N): Promise<SearchResult> {
    console.log(`[Search] Query: "${query}" (topN=${topN})`);

    // REPRESENT: Convert the user's natural language query to a vector
    const queryVector = await embeddingService.embed(query);

    // COMPARE + RANK: Find and sort movies by cosine similarity
    const ranked = vectorStore.findSimilar(queryVector);

    return {
      query,
      results: ranked.slice(0, topN).map(({ movie, score }) => ({
        movie: toMovieResponse(movie),
        score: roundScore(score),
      })),
      totalSearched: ranked.length,
    };
  }

  /**
   * FEATURE 2: Similar Movie Recommendation
   *
   * Pipeline:
   *   Movie ID → Get Precomputed Vector (no new API call) → Compare → Sort
   *
   * Because the movie was embedded during Phase 1, we skip the embedding step.
   * We already have the vector — just compare it against all others.
   */
  findSimilarMovies(movieId: string, topN = env.DEFAULT_TOP_N): RecommendResult {
    console.log(`[Recommend] Movie ID: ${movieId} (topN=${topN})`);

    const sourceMovie = vectorStore.getById(movieId);
    if (!sourceMovie) {
      throw new NotFoundError(`Movie with id "${movieId}" not found in catalog.`);
    }

    if (!sourceMovie.vector) {
      throw new Error(`Movie "${sourceMovie.title}" has not been embedded yet.`);
    }

    // COMPARE + RANK: Use the precomputed vector directly — no API call needed
    const ranked = vectorStore.findSimilar(sourceMovie.vector, movieId);

    return {
      sourceMovie: toMovieResponse(sourceMovie),
      results: ranked.slice(0, topN).map(({ movie, score }) => ({
        movie: toMovieResponse(movie),
        score: roundScore(score),
      })),
      totalSearched: ranked.length,
    };
  }

  /**
   * Return all movies in the catalog (for browsing / display).
   */
  getAllMovies(): MovieResponse[] {
    return vectorStore.getAllMovies().map(toMovieResponse);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip the internal `vector` field before sending movies to clients. */
function toMovieResponse(movie: Movie): MovieResponse {
  const { vector: _omit, ...safe } = movie;
  return safe;
}

/** Round similarity scores to 4 decimal places for clean API output. */
function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/** Domain error for missing resources — handled by the route layer. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// Singleton
export const recommendationService = new RecommendationService();
