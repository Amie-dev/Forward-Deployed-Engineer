// ─── Core Domain Types ────────────────────────────────────────────────────────

/**
 * A movie in the catalog.
 * `vector` is populated during Phase 1 precomputation — never exposed via API.
 */
export interface Movie {
  id: string;
  title: string;
  description: string;
  genre: string;
  year: number;
  vector?: number[]; // Precomputed embedding — internal only
}

/**
 * A movie as returned by the API — no internal vector field exposed.
 */
export type MovieResponse = Omit<Movie, 'vector'>;

/**
 * A movie with its similarity score — used internally during ranking.
 */
export interface ScoredMovie {
  movie: Movie;
  score: number; // Cosine similarity: 0.0 (unrelated) → 1.0 (identical)
}

// ─── Catalog State ────────────────────────────────────────────────────────────

/**
 * Status of the in-memory movie catalog.
 */
export interface CatalogStatus {
  totalMovies: number;
  embeddedMovies: number;
  isReady: boolean;
}

// ─── API Request / Response Types ────────────────────────────────────────────

export interface SearchRequest {
  query: string;           // Natural language description e.g. "astronaut stranded on Mars"
  topN?: number;           // How many results to return (default: env.DEFAULT_TOP_N)
}

export interface RecommendRequest {
  movieId: string;         // ID of the movie to find similar titles for
  topN?: number;
}

export interface SearchResult {
  query: string;
  results: Array<{
    movie: MovieResponse;
    score: number;         // Cosine similarity score
  }>;
  totalSearched: number;
}

export interface RecommendResult {
  sourceMovie: MovieResponse;
  results: Array<{
    movie: MovieResponse;
    score: number;
  }>;
  totalSearched: number;
}
