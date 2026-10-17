# Chapter 06: The Core Mental Model — REPRESENT → STORE → COMPARE → RANK

> **Chapter Goal:** Internalize the four-step mental model that drives all embedding-powered systems. This model applies not just to movies but to any problem where you need to find "the most relevant items in your dataset." It's the universal framework behind semantic search, recommendation systems, RAG, and more.

---

## 6.1 The Four-Operation Mental Model

Before thinking about APIs, databases, frameworks, or deployment — lock in four core operations:

```mermaid
flowchart LR
    A["REPRESENT\nConvert meaning\ninto numbers"] --> B["STORE\nSave those\nvector representations"]
    B --> C["COMPARE\nMeasure closeness\nbetween vectors"]
    C --> D["RANK\nSort by similarity\nReturn top results"]

    style A fill:#6c5ce7,color:#fff
    style B fill:#00b894,color:#fff
    style C fill:#e17055,color:#fff
    style D fill:#fdcb6e,color:#2d3436
```

Every embedding-powered system — no matter how complex — comes down to these four steps.

---

## 6.2 Step 1 — REPRESENT

**Convert meaning into numbers.**

```
Text
    ↓
Embedding Model
    ↓
Vector
```

**Example:**
```
"The Martian is about survival on Mars."
    ↓
Embedding Model
    ↓
[0.12, -0.43, 0.08, 0.91, -0.22, ...]
```

The embedding model is the **translation layer** between human language and machine mathematics. Think of it as a universal translator that converts any piece of text into a fixed-size array of numbers that encodes its semantic meaning.

### What Needs to Be Represented?

```mermaid
mindmap
  root((Things to REPRESENT))
    In our Movie System
      Movie descriptions
      User queries
      Movie titles
    In Other Systems
      Product descriptions
      Support tickets
      Knowledge base articles
      Job postings
      Code snippets
      Images captions
```

---

## 6.3 Step 2 — STORE

**Save those vector representations so they can be reused.**

```
Interstellar → [0.11, 0.42, -0.07, ...]  →  💾 Saved
The Martian  → [0.12, 0.39, -0.05, ...]  →  💾 Saved
Gravity      → [0.10, 0.45, -0.08, ...]  →  💾 Saved
Arrival      → [0.08, 0.31, -0.03, ...]  →  💾 Saved
```

For our project, storage is a simple in-memory list:

```js
// Simple in-memory storage
const movieCatalog: Movie[] = [
  { id: "1", title: "Interstellar", description: "...", vector: [0.11, 0.42, ...] },
  { id: "2", title: "The Martian",  description: "...", vector: [0.12, 0.39, ...] },
  // ...
];
```

### Storage Options at Scale

```mermaid
flowchart TD
    A["Vector Storage"] --> B["In-Memory\nList / Array"]
    A --> C["SQL with vector extension\npgvector, sqlite-vss"]
    A --> D["Dedicated Vector DB\nPinecone / Qdrant / Weaviate"]
    A --> E["Search Platform\nElasticsearch / OpenSearch"]

    B --> F["Demo projects ✅\nNo persistence ❌"]
    C --> G["Medium scale ✅\nFamiliar SQL ✅"]
    D --> H["Billion-scale ✅\nANN search ✅"]
    E --> I["Hybrid search ✅\nProduction-ready ✅"]

    style A fill:#6c5ce7,color:#fff
```

> **For this project:** In-memory storage (a `List<Movie>` or array) is sufficient. Don't over-engineer for scale before you have scale.

---

## 6.4 Step 3 — COMPARE

**Take a starting vector and compare it against all stored vectors.**

The starting vector can come from:
- A **search query**: user types text → embed it → get query vector
- An **existing item**: movie already has a vector → use it directly

The comparison question is always:

```
"How close is this vector to every other vector?"
```

We use **Cosine Similarity** (covered in Chapter 05):

```js
// Compare one vector against all others
function compareAgainstAll(
  sourceVector: number[],
  allMovies: Movie[]
): Array<{ movie: Movie; score: number }> {
  return allMovies.map(movie => ({
    movie,
    score: cosineSimilarity(sourceVector, movie.vector)
  }));
}
```

### Two Different Sources, Same Comparison

```mermaid
flowchart LR
    subgraph SEARCH["Feature: Search"]
        S1["User Types Query"] --> S2["Embed Query"] --> S3["Query Vector"]
    end

    subgraph REC["Feature: Recommendation"]
        R1["User Opens Movie"] --> R2["Movie Already Has Vector"] --> R3["Movie Vector"]
    end

    S3 --> C["compareAgainstAll()"]
    R3 --> C
    C --> D["Similarity Scores"]

    style C fill:#6c5ce7,color:#fff
```

---

## 6.5 Step 4 — RANK

**Sort the similarity scores and surface the most relevant results.**

Suppose our comparison gives:

| Movie      | Similarity Score |
|------------|-----------------|
| Movie A    | 0.89            |
| Movie B    | 0.84            |
| Movie C    | 0.78            |
| Movie D    | 0.21            |

Sort descending:

```
1st → Movie A (0.89)
2nd → Movie B (0.84)
3rd → Movie C (0.78)
4th → Movie D (0.21)
```

The **highest similarity = most relevant** = appears first.

```js
function rankByScore(
  scored: Array<{ movie: Movie; score: number }>
): Movie[] {
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.movie);
}
```

This simple sort gives us both:
- ✅ Semantic search results
- ✅ Content-based movie recommendations

---

## 6.6 The Complete Pipeline in Pseudo-Code

```js
// === PHASE 1: REPRESENT + STORE (run once) ===

async function buildCatalog(movies: Movie[]): Promise<void> {
  for (const movie of movies) {
    // REPRESENT: Convert description to vector
    movie.vector = await embeddingModel.embed(movie.description);
    // STORE: Save in our in-memory catalog (or DB)
    catalog.push(movie);
  }
}

// === PHASE 2: COMPARE + RANK (run per request) ===

async function search(query: string, topN = 5): Promise<Movie[]> {
  // REPRESENT: Embed the user's query
  const queryVector = await embeddingModel.embed(query);

  // COMPARE: Score all movies
  const scored = catalog.map(movie => ({
    movie,
    score: cosineSimilarity(queryVector, movie.vector)
  }));

  // RANK: Sort and return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map(s => s.movie);
}

function recommend(movie: Movie, topN = 5): Movie[] {
  // No REPRESENT step needed — vector already exists

  // COMPARE: Score all other movies
  const scored = catalog
    .filter(m => m.id !== movie.id)
    .map(m => ({ movie: m, score: cosineSimilarity(movie.vector, m.vector) }));

  // RANK: Sort and return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map(s => s.movie);
}
```

---

## 6.7 The Mental Model Applied to Other Domains

This four-step model is universal. Whenever the problem is:

```
"Find the items in my dataset whose meaning is closest to this input."
```

The solution is:

```
REPRESENT → STORE → COMPARE → RANK
```

```mermaid
mindmap
  root((REPRESENT → STORE → COMPARE → RANK))
    Movies
      Description → Vector
      Semantic search
      Content recommendation
    E-commerce
      Product description → Vector
      "Find similar products"
      Visual search
    Support
      Ticket text → Vector
      Find similar past tickets
      Auto-suggest solutions
    Recruiting
      Job description → Vector
      Resume → Vector
      Match candidates to roles
    Code
      Function description → Vector
      Find similar code snippets
      Documentation search
    Knowledge Base
      Article → Vector
      Find relevant FAQ
      RAG pipeline
```

---

## 6.8 No Generative LLM Required for Recommendation

This is a critical insight:

```mermaid
flowchart LR
    A["Movie Description"] --> B["Embedding Model"]
    B --> C["Vector"]
    C --> D["Cosine Similarity"]
    D --> E["Ranking"]
    E --> F["Recommendation Result"]

    G["❌ No Generative LLM\nrequired here"] -.-> D

    style B fill:#6c5ce7,color:#fff
    style G fill:#e17055,color:#fff
    style F fill:#fdcb6e,color:#2d3436
```

The recommendation comes from **mathematical comparison of vectors** — not from an LLM generating text. The embedding model is used to create vectors, but the actual recommendation logic is pure math.

This means:
- **Faster** — no sequential token generation
- **Cheaper** — no generative model inference per recommendation
- **Deterministic** — same input always gives same result
- **Explainable** — similarity scores are concrete numbers

---

## 6.9 The Final Mental Model Diagram

```mermaid
flowchart TD
    subgraph OFFLINE["🔧 Offline (Once)"]
        M1["Movie 1: 'Interstellar'\nDescription text"] --> E1["Embedding Model"]
        M2["Movie 2: 'The Martian'\nDescription text"] --> E1
        M3["Movie N: ...\nDescription text"] --> E1
        E1 --> VS["Vector Store\n{movie_id: vector}"]
    end

    subgraph ONLINE["⚡ Online (Per Request)"]
        Q["User Query OR\nMovie to Match"] --> E2["Embedding Model\n(or skip if movie)"]
        E2 --> QV["Query/Source Vector"]
        QV --> CMP["Compare Against\nAll Stored Vectors\n(Cosine Similarity)"]
        VS --> CMP
        CMP --> RANK["Sort by Score"]
        RANK --> RES["Top N Results"]
    end

    style OFFLINE fill:#2d3436,color:#dfe6e9
    style ONLINE fill:#2d3436,color:#dfe6e9
    style E1 fill:#6c5ce7,color:#fff
    style E2 fill:#6c5ce7,color:#fff
    style VS fill:#00b894,color:#fff
    style RES fill:#fdcb6e,color:#2d3436
```

---

## 6.10 Summary

| Step        | What Happens                               | When It Runs          |
|-------------|--------------------------------------------|-----------------------|
| REPRESENT   | Text → Embedding Model → Vector            | Offline (once per movie), Online (per query) |
| STORE       | Save vectors for reuse                     | Offline (build catalog)|
| COMPARE     | Cosine similarity between vectors          | Online (per request)  |
| RANK        | Sort by score, return top N                | Online (per request)  |

> **The fundamental idea:** Do not think of the embedding model as a chatbot. Think of it as a machine that converts meaning into coordinates. Once you have coordinates, mathematics does the rest.

Chapter 07 shows how all these concepts come together in the complete project design — including the architecture, data model, and design patterns you'd use to build this system.
