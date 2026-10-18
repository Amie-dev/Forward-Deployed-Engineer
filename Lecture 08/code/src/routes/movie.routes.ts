import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { recommendationService, NotFoundError } from '../services/recommendation.service.js';
import { vectorStore } from '../services/vector.store.js';
import { env } from '../config/env.js';

export const movieRouter = Router();

// ─── Input Validation Schemas ─────────────────────────────────────────────────

const SearchSchema = z.object({
  query: z.string().min(3, 'Query must be at least 3 characters').max(500),
  topN: z.coerce.number().int().min(1).max(20).optional(),
});

const RecommendSchema = z.object({
  topN: z.coerce.number().int().min(1).max(20).optional(),
});

// ─── GET /api/movies ──────────────────────────────────────────────────────────

/**
 * List all movies in the catalog.
 * Useful for browsing — the UI would render these for the user to click on.
 */
movieRouter.get('/', (_req: Request, res: Response) => {
  const movies = recommendationService.getAllMovies();
  res.json({
    count: movies.length,
    movies,
  });
});

// ─── GET /api/movies/status ───────────────────────────────────────────────────

/**
 * Catalog readiness status — shows how many movies have been embedded.
 * Useful during startup to know when the store is ready to serve requests.
 */
movieRouter.get('/status', (_req: Request, res: Response) => {
  res.json(vectorStore.status());
});

// ─── POST /api/movies/search ──────────────────────────────────────────────────

/**
 * FEATURE 1: Semantic Movie Search
 *
 * The user describes what they want in natural language.
 * We embed the description and find the closest movies by cosine similarity.
 *
 * Body: { query: string, topN?: number }
 *
 * Example:
 *   POST /api/movies/search
 *   { "query": "astronaut stranded alone trying to survive in space" }
 */
movieRouter.post('/search', async (req: Request, res: Response) => {
  const parsed = SearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'ValidationError',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { query, topN = env.DEFAULT_TOP_N } = parsed.data;

  try {
    const result = await recommendationService.semanticSearch(query, topN);
    res.json(result);
  } catch (err: any) {
    console.error('[POST /movies/search] Error:', err.message);
    res.status(500).json({ error: 'InternalServerError', message: err.message });
  }
});

// ─── GET /api/movies/:id/similar ─────────────────────────────────────────────

/**
 * FEATURE 2: Similar Movie Recommendation
 *
 * The user is watching a movie and clicks "Show Similar Movies".
 * We use the movie's precomputed vector — no new embedding API call needed.
 *
 * Params:  id     — movie ID from the catalog
 * Query:   topN   — how many results to return (optional, default from env)
 *
 * Example:
 *   GET /api/movies/1/similar          → movies similar to Interstellar
 *   GET /api/movies/1/similar?topN=3   → top 3 similar to Interstellar
 */
movieRouter.get('/:id/similar', (req: Request, res: Response) => {
  const parsed = RecommendSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'ValidationError',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { topN = env.DEFAULT_TOP_N } = parsed.data;
  const movieId = String(req.params.id);

  try {
    const result = recommendationService.findSimilarMovies(movieId, topN);
    res.json(result);
  } catch (err: any) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'NotFound', message: err.message });
      return;
    }
    console.error('[GET /movies/:id/similar] Error:', err.message);
    res.status(500).json({ error: 'InternalServerError', message: err.message });
  }
});
