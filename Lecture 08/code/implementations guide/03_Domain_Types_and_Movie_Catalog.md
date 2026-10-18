# Chapter 03: Domain Types & Movie Catalog

> **Chapter Goal:** Define the shared vocabulary of the system before implementing behaviour. The types decide what can cross the HTTP boundary; the catalog decides what semantic clusters exist for the recommendation engine to discover.

> **Files covered:**

| File | Lines | Purpose |
| :--- | :--- | :--- |
| `src/types/movie.types.ts` | 68 | Domain entities, internal scoring shapes, API request/response contracts |
| `src/data/movies.ts` | 163 | The 18-movie catalog used for embeddings |

---

## 1. Complete Source Code

### 📄 `src/types/movie.types.ts` (68 lines)

```typescript
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
```

---

### 📄 `src/data/movies.ts` (163 lines)

```typescript
import type { Movie } from '../types/movie.types.js';

/**
 * Curated movie catalog — a real streaming platform would pull from a database.
 *
 * Deliberately covers several themes so similarity comparisons are meaningful:
 *   - Space / Sci-Fi survival cluster  →  Interstellar, The Martian, Gravity, Arrival, Life, Ad Astra
 *   - Action / superhero cluster       →  Batman, Avengers, Spider-Man
 *   - Romance cluster                  →  Titanic, La La Land, Notebook
 *   - Thriller / mystery cluster       →  Inception, Shutter Island, Knives Out
 *   - Drama cluster                    →  The Shawshank Redemption, Forrest Gump
 */
export const MOVIE_CATALOG: Movie[] = [
  // ── Space / Sci-Fi Survival ──────────────────────────────────────────────
  {
    id: '1',
    title: 'Interstellar',
    description:
      'A team of explorers travel through a wormhole in space in an attempt to ensure humanity\'s survival. A former NASA pilot leads the mission, leaving behind his family to search for a new home for humankind across the galaxy.',
    genre: 'Sci-Fi',
    year: 2014,
  },
  {
    id: '2',
    title: 'The Martian',
    description:
      'An astronaut becomes stranded on Mars after his team assumes him dead and leaves without him. Using only his scientific ingenuity and the resources left behind, he must find a way to signal Earth and survive until a rescue mission can reach him.',
    genre: 'Sci-Fi',
    year: 2015,
  },
  {
    id: '3',
    title: 'Gravity',
    description:
      'Two astronauts work together to survive after an accident leaves them stranded in space. Debris destroys their shuttle, leaving them adrift with diminishing oxygen and no way to contact Earth.',
    genre: 'Sci-Fi',
    year: 2013,
  },
  {
    id: '4',
    title: 'Arrival',
    description:
      'A linguist is recruited by the military to communicate with alien spacecraft that have landed on Earth. As she deciphers the alien language she begins to experience visions that change her understanding of time itself.',
    genre: 'Sci-Fi',
    year: 2016,
  },
  {
    id: '5',
    title: 'Life',
    description:
      'A crew aboard the International Space Station discovers a rapidly-evolving life form that caused extinction on Mars and now threatens Earth. As the creature grows stronger the crew must fight to stop it from reaching home.',
    genre: 'Sci-Fi',
    year: 2017,
  },
  {
    id: '6',
    title: 'Ad Astra',
    description:
      'An astronaut travels to the outer edges of the solar system to find his missing father whose failed experiment threatens the universe. The journey forces him to confront his own demons in the vast emptiness of space.',
    genre: 'Sci-Fi',
    year: 2019,
  },
  // ── Action / Superhero ──────────────────────────────────────────────────
  {
    id: '7',
    title: 'The Dark Knight',
    description:
      'Batman raises the stakes in his war on crime by facing a criminal mastermind known as the Joker who plunges Gotham City into chaos. With the help of allies the caped crusader fights to stop the anarchic villain and protect the city.',
    genre: 'Action',
    year: 2008,
  },
  {
    id: '8',
    title: 'Avengers: Endgame',
    description:
      'After the devastating events of Infinity War the Avengers assemble once more to undo Thanos\'s actions and restore order to the universe. The remaining heroes must travel through time to collect the Infinity Stones before Thanos does.',
    genre: 'Action',
    year: 2019,
  },
  {
    id: '9',
    title: 'Spider-Man: Into the Spider-Verse',
    description:
      'Miles Morales becomes the Spider-Man of his universe and must team up with multiple versions of Peter Parker from other dimensions to stop a threat to the multiverse. An animated coming-of-age story about identity and responsibility.',
    genre: 'Action',
    year: 2018,
  },
  // ── Romance ─────────────────────────────────────────────────────────────
  {
    id: '10',
    title: 'Titanic',
    description:
      'A young aristocrat falls in love with a kind but poor artist aboard the ill-fated luxury liner Titanic. Their romance blossoms as the ship makes its maiden voyage but is threatened by class differences and ultimately by tragedy.',
    genre: 'Romance',
    year: 1997,
  },
  {
    id: '11',
    title: 'La La Land',
    description:
      'A jazz pianist and an aspiring actress fall in love while pursuing their respective dreams in Los Angeles. The film explores the bittersweet tension between ambition and love through song and dance.',
    genre: 'Romance',
    year: 2016,
  },
  {
    id: '12',
    title: 'The Notebook',
    description:
      'A poor young man falls in love with a rich young woman during the 1940s. Years later an elderly man reads a love story from a faded notebook to a fellow nursing-home resident, revealing a timeless romance.',
    genre: 'Romance',
    year: 2004,
  },
  // ── Thriller / Mystery ──────────────────────────────────────────────────
  {
    id: '13',
    title: 'Inception',
    description:
      'A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea into the mind of a CEO. He assembles a team to execute this seemingly impossible heist inside layered dream states.',
    genre: 'Thriller',
    year: 2010,
  },
  {
    id: '14',
    title: 'Shutter Island',
    description:
      'A U.S. Marshal investigates the disappearance of a patient from a hospital for the criminally insane on a remote island. As his investigation deepens he begins to question his own sanity and the nature of reality.',
    genre: 'Thriller',
    year: 2010,
  },
  {
    id: '15',
    title: 'Knives Out',
    description:
      'A brilliant detective investigates the death of a wealthy crime novelist whose dysfunctional family are all suspects. The mystery unravels through sharp wit and unexpected twists in an elegant whodunit.',
    genre: 'Thriller',
    year: 2019,
  },
  // ── Drama ────────────────────────────────────────────────────────────────
  {
    id: '16',
    title: 'The Shawshank Redemption',
    description:
      'A banker is sentenced to life in Shawshank State Penitentiary for the murders of his wife and her lover. Over the following two decades he forms a friendship with a fellow prisoner as he plans his escape.',
    genre: 'Drama',
    year: 1994,
  },
  {
    id: '17',
    title: 'Forrest Gump',
    description:
      'The extraordinary life of a simple man from Alabama who inadvertently influences major historical events in the 20th century through his unique perspective on life and unwavering love for his childhood sweetheart Jenny.',
    genre: 'Drama',
    year: 1994,
  },
  {
    id: '18',
    title: 'Good Will Hunting',
    description:
      'A janitor at MIT possesses a genius-level intellect but struggles with emotional trauma. With the help of a therapist and encouragement from professors he must decide between a life of privilege or the south Boston neighborhood he grew up in.',
    genre: 'Drama',
    year: 1997,
  },
];
```

---

## 3. Block-by-Block Explanation

### Part A: `src/types/movie.types.ts`

#### Block 1: The `Movie` entity

```typescript
export interface Movie {
  id: string;
  title: string;
  description: string;
  genre: string;
  year: number;
  vector?: number[]; // Precomputed embedding — internal only
}
```

- **`id: string`** — stable identity used in URLs (`/api/movies/1/similar`). Strings avoid leaking database-specific numeric assumptions.
- **`description`** — the **only** field sent to the embedding model. It carries the plot semantics.
- **`genre` / `year`** — useful metadata for display and future filtering, but not part of the embedding in this implementation.
- **`vector?: number[]`** — optional because a catalog entry exists *before* precomputation and *after* it. The `?` models both states honestly. It is marked **internal only**: it must never be serialised to a client, because a 1536-number array per movie would bloat responses and expose implementation detail.

#### Block 2: The API-safe projection

```typescript
export type MovieResponse = Omit<Movie, 'vector'>;
```

`Omit<Movie, 'vector'>` is a **compile-time** guarantee that the response type has no `vector` property. It does not remove the property at runtime — JavaScript objects still carry it. Chapter 06 therefore has an explicit `toMovieResponse()` helper that destructures the vector out before returning data.

This is a useful TypeScript lesson: **types describe shapes; they do not enforce runtime behaviour.** The type and the helper must agree.

#### Block 3: Internal scoring shape

```typescript
export interface ScoredMovie {
  movie: Movie;
  score: number; // Cosine similarity: 0.0 (unrelated) → 1.0 (identical)
}
```

The vector store returns `ScoredMovie[]`, never plain `Movie[]`. Keeping the score next to the movie makes the ranking step a pure array sort and lets the service decide how many results to expose.

For text embeddings, cosine similarity usually lands in a narrower positive band (often roughly `0.0`–`1.0`), but the mathematical range is `-1` to `+1`. The comment describes the practical interpretation, not a hard clamp.

#### Block 4: Catalog status

```typescript
export interface CatalogStatus {
  totalMovies: number;
  embeddedMovies: number;
  isReady: boolean;
}
```

This is the response shape for `GET /api/movies/status`. It answers three operational questions:

1. How large is the catalog?
2. How many entries actually have vectors?
3. Is the store allowed to serve traffic yet?

During startup, `totalMovies` is known immediately (the source array is static), while `embeddedMovies` grows only after `build()` completes.

#### Block 5: Request and response contracts

```typescript
export interface SearchRequest {
  query: string;
  topN?: number;
}

export interface RecommendRequest {
  movieId: string;
  topN?: number;
}

export interface SearchResult {
  query: string;
  results: Array<{ movie: MovieResponse; score: number }>;
  totalSearched: number;
}

export interface RecommendResult {
  sourceMovie: MovieResponse;
  results: Array<{ movie: MovieResponse; score: number }>;
  totalSearched: number;
}
```

| Type | Used by | Notes |
| :--- | :--- | :--- |
| `SearchRequest` | Documentation / client contract | The route validates the body with an equivalent Zod schema |
| `RecommendRequest` | Documentation / client contract | The movie ID travels in the URL; only `topN` is validated from the query string |
| `SearchResult` | `semanticSearch()` return type | Echoes the original query so logs and UIs can correlate |
| `RecommendResult` | `findSimilarMovies()` return type | Includes the source movie so the client can render “Because you watched…” |

`totalSearched` means **how many candidates were scored**, not how many were returned. With 18 movies, a search reports `18`; a similar-movie request reports `17` because the source movie is excluded. This distinction matters when explaining ranking behaviour.

---

### Part B: `src/data/movies.ts`

#### Block 1: Type-only import

```typescript
import type { Movie } from '../types/movie.types.js';
```

`import type` is erased at compile time. It produces **no runtime import**, which avoids a needless module load and makes the dependency direction explicit: data depends on the type contract, not the other way round.

The `.js` extension is required by `NodeNext` resolution (see Chapter 01), even though the source file is `.ts`.

#### Block 2: The exported catalog

```typescript
export const MOVIE_CATALOG: Movie[] = [
  // ...
];
```

The catalog is a plain array, imported directly by the vector store. There is no database, repository, or async loader because the lecture's focus is the embedding pipeline.

The declared type is `Movie[]`, not `readonly Movie[]`. The vector store does **not** mutate the source objects; it creates new objects with `{ ...movie, vector }`. A production codebase would likely make the source `readonly` and freeze it to prevent accidental mutation.

#### Block 3: Cluster design

The 18 movies are intentionally grouped so that **semantic neighbourhoods exist**:

| Cluster | Titles | Shared meaning |
| :--- | :--- | :--- |
| Space / survival | Interstellar, The Martian, Gravity, Arrival, Life, Ad Astra | astronauts, isolation, survival, space |
| Action / superhero | The Dark Knight, Avengers: Endgame, Spider-Man: Into the Spider-Verse | heroes, villains, protecting a city/world |
| Romance | Titanic, La La Land, The Notebook | love, relationships, emotional stakes |
| Thriller / mystery | Inception, Shutter Island, Knives Out | investigation, reality-bending, suspense |
| Drama | The Shawshank Redemption, Forrest Gump, Good Will Hunting | personal struggle, friendship, life journey |

If every description were unique with no shared themes, cosine similarity would have nothing meaningful to discover. The dataset is small enough to scan linearly and varied enough to demonstrate clustering.

#### Block 4: Why descriptions are long and natural

Each `description` is two sentences of ordinary prose. This matters because an embedding model encodes **meaning from context**, not a list of tags.

Compare:

```text
"Sci-Fi, space, survival"                         ← keyword list
"An astronaut becomes stranded on Mars after..."  ← natural language
```

The second form gives the model relational context (“stranded”, “survive”, “rescue mission”), which is exactly what makes `"astronaut stranded alone trying to survive"` land near The Martian and Gravity.

#### Block 5: Why only `description` is embedded

`build()` maps `MOVIE_CATALOG.map(m => m.description)`. Title, genre, and year are **not** embedded.

- The description carries the richest semantic signal.
- Including the title can bias the vector toward the title's wording rather than the plot.
- `genre` and `year` are structured metadata; a production system might use them as **hard filters** before vector comparison, not as embedding text.

This is a design decision worth stating explicitly: embeddings capture unstructured meaning; structured constraints belong in the query layer.

#### Block 6: Catalog completeness

There are exactly 18 entries with IDs `'1'` through `'18'`, one per movie. IDs are strings and are unique, which is required because `getById()` and the `excludeId` filter rely on exact identity.

The separate `movies.json` at the project root contains 30 movies and belongs to the legacy `jsDemo/`. The TypeScript service does not read it, so changing that JSON does **not** change the API catalog.

---

## 4. Verification

### Typecheck

```bash
npm run build
```

Expected: no errors, including no `Object is possibly 'undefined'` around `Movie.vector`.

### Catalog sanity check

```bash
npx tsx -e "import { MOVIE_CATALOG } from './src/data/movies.ts'; console.log(MOVIE_CATALOG.length); console.log(new Set(MOVIE_CATALOG.map(m => m.id)).size); console.log(MOVIE_CATALOG.map(m => m.genre).join(','));"
```

Expected:

```text
18
18
Sci-Fi,Sci-Fi,Sci-Fi,Sci-Fi,Sci-Fi,Sci-Fi,Action,Action,Action,Romance,Romance,Romance,Thriller,Thriller,Thriller,Drama,Drama,Drama
```

The two equal numbers prove that all IDs are unique.

---

**Next:** [Chapter 04 — Embedding Service: REPRESENT](./04_Embedding_Service_REPRESENT.md)
