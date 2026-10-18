# Lecture 08 — Movie Recommendation Engine

> **Concept:** Build a movie recommendation system using Vector Embeddings and Cosine Similarity. No ChatGPT deciding what to recommend — pure embedding math.

> 📖 **Looking for the step-by-step tutorial?**
> Check out the **[Implementation Guide](./implementations%20guide/README.md)** — a chapter-by-chapter walkthrough (00 → 08) with the complete source of every file and block-by-block explanations.

## Mental Model

```
REPRESENT → STORE → COMPARE → RANK
```

| Step      | Who Does It             | When           |
|-----------|-------------------------|----------------|
| REPRESENT | OpenAI Embeddings API   | Startup (movies) + per request (queries) |
| STORE     | In-memory `VectorStore` | Startup once   |
| COMPARE   | `cosineSimilarity()`    | Per request    |
| RANK      | `.sort()` by score      | Per request    |

## Project Structure

```
src/
├── config/
│   └── env.ts                    # Zod-validated environment config
├── data/
│   └── movies.ts                 # 18-movie catalog across 5 genres
├── types/
│   └── movie.types.ts            # All domain types (Movie, SearchResult, etc.)
├── services/
│   ├── embedding.service.ts      # OpenAI embeddings API wrapper + mock mode
│   ├── vector.store.ts           # In-memory STORE + cosineSimilarity()
│   └── recommendation.service.ts # Orchestrates search & recommendation
├── routes/
│   └── movie.routes.ts           # Express routes + Zod request validation
├── app.ts                        # Express app factory
└── server.ts                     # Startup: build catalog → serve requests

implementations guide/            # Chapter-wise tutorial (00 → 08)
├── README.md
└── 00_Overview_and_File_Structure.md … 08_End_to_End_Verification.md
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — add your OPENAI_API_KEY

# 3. Run in development
npm run dev
```

> **No API key?** The server runs in MOCK MODE with stub vectors. The pipeline works end-to-end but similarity scores won't be semantically meaningful.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Service health check |
| `GET`  | `/api/movies` | List all movies in catalog |
| `GET`  | `/api/movies/status` | Catalog embedding status |
| `POST` | `/api/movies/search` | **Feature 1:** Semantic search by description |
| `GET`  | `/api/movies/:id/similar` | **Feature 2:** Similar movie recommendation |

## Example Requests

### Semantic Search

```bash
curl -X POST http://localhost:3008/api/movies/search \
  -H "Content-Type: application/json" \
  -d '{"query": "astronaut stranded alone trying to survive on another planet"}'
```

**Response:**
```json
{
  "query": "astronaut stranded alone trying to survive on another planet",
  "results": [
    { "movie": { "id": "2", "title": "The Martian", ... }, "score": 0.9124 },
    { "movie": { "id": "3", "title": "Gravity", ... },     "score": 0.8891 },
    { "movie": { "id": "1", "title": "Interstellar", ... }, "score": 0.8754 }
  ],
  "totalSearched": 18
}
```

### Similar Movie Recommendation

```bash
curl http://localhost:3008/api/movies/1/similar
```

**Response:**
```json
{
  "sourceMovie": { "id": "1", "title": "Interstellar", ... },
  "results": [
    { "movie": { "title": "The Martian", ... },  "score": 0.9412 },
    { "movie": { "title": "Gravity", ... },       "score": 0.9201 },
    { "movie": { "title": "Arrival", ... },       "score": 0.8934 }
  ],
  "totalSearched": 17
}
```

## Key Implementation Details

### Why Batch Embedding at Startup?
The OpenAI Embeddings API accepts a list of strings — we embed all 18 movies in **one API call** instead of 18 separate calls. Much cheaper and faster.

### Why Cosine Similarity (not Euclidean Distance)?
Text embedding vectors can vary in magnitude based on sentence length. Cosine similarity only cares about the **direction** (angle) between vectors — which is what encodes meaning.

### Why No LLM for Recommendation?
The recommendation result is pure math: `sort by cosine similarity`. No generative model is needed. LLMs can be optionally added _after_ the ranking step to generate natural language explanations (RAG pattern).

### Mock Mode
If `OPENAI_API_KEY` is not set, the server starts in mock mode with deterministic pseudo-random vectors. The API works end-to-end but similarity scores won't be semantically meaningful.
