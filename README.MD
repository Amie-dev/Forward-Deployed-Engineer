# Forward Deployed Engineer (FDE) & Generative AI Systems

> **Master Curriculum & Engineering Reference for Building Production-Grade Enterprise AI Systems.**

This repository contains structured lecture notes, system architectures, mathematical foundations, paper deep-dives, and production blueprints for **Forward Deployed Engineers (FDEs)** and **Generative AI Systems Architects**.

---

## 🎯 Repository Overview

* **Role & Mindset:** Moving from client-requested *"chatbots"* (proposed solutions) to true enterprise business problem discovery and resolution.
* **Mathematical & Theoretical Depth:** Step-by-step proofs (e.g., Attention variance scaling factor $\frac{1}{\sqrt{d_k}}$, sinusoidal positional relative offsets, $O(1)$ path length complexity).
* **Paper Deep-Dives:** Comprehensive breakdown of seminal research papers including *"Attention Is All You Need"* (Vaswani et al., 2017).
* **Production Architecture:** Design criteria for Grounded, Observable, Secure, and Actionable enterprise AI systems.
* **Hands-on Implementation:** Production microservices built with Node.js, Express, TypeScript, and modern AI SDKs.

---

## 📚 Curriculum Navigation

- 📖 **[Main Repository Index & Curriculum Roadmap](./index.md)**
- 📂 **[Lecture 01 Index & Notes](./Lecture%2001/notes/README.md)** | 📄 **[Complete Document](./Lecture%2001/notes/Lecture_01_Complete_Notes.md)**
- 📂 **[Lecture 02 Index & Notes](./Lecture%2002/notes/README.md)** | 📄 **[Complete Document](./Lecture%2002/notes/Lecture_02_Complete_Notes.md)**
- 📂 **[Lecture 03 Index & Notes](./Lecture%2003/notes/README.md)** | 📄 **[Complete Document](./Lecture%2003/notes/Lecture_03_Complete_Notes.md)** | 💻 **[Codebase](./Lecture%2003/code/README.md)** | 🛠️ **[Implementation Guide](./Lecture%2003/code/implementations%20guide/README.md)**
- 📂 **[Lecture 04 Index & Notes](./Lecture%2004/notes/README.md)** | 📄 **[Complete Document](./Lecture%2004/notes/Lecture_04_Complete_Notes.md)** | 💻 **[Codebase](./Lecture%2004/code/README.md)** | 🛠️ **[Implementation Guide](./Lecture%2004/code/implementations%20guide/README.md)**
- 📂 **[Lecture 05 Index & Notes](./Lecture%2005/notes/README.md)** | 📄 **[Complete Document](./Lecture%2005/notes/Lecture_05_Complete_Notes.md)** | 💻 **[Codebase](./Lecture%2005/code/README.md)** | 🛠️ **[Implementation Guide](./Lecture%2005/code/implementations%20guide/README.md)**
- 📂 **[Lecture 06 Index & Notes](./Lecture%2006/notes/README.md)** | 📄 **[Complete Document](./Lecture%2006/notes/Lecture_06_Complete_Notes.md)** | 💻 **[Codebase](./Lecture%2006/code/README.md)** | 🛠️ **[Implementation Guide](./Lecture%2006/code/implementations%20guide/README.md)**
- 📂 **[Lecture 07 Index & Notes](./Lecture%2007/notes/README.md)**
- 📂 **[Lecture 08 Index & Notes](./Lecture%2008/notes/README.md)** | 💻 **[Codebase](./Lecture%2008/code/README.md)** | 🛠️ **[Implementation Guide](./Lecture%2008/code/implementations%20guide/README.md)**
- 📂 **[Lecture 09 Index & Notes](./Lecture%2009/notes/README.md)**

---

## 📖 Lecture Highlights

### [Lecture 01: Introduction to FDE & Generative AI Foundations](./Lecture%2001/notes/README.md)
E-commerce case study (50k daily queries), Problem vs Solution discovery, Symbolic AI & Expert Systems, Machine Learning paradigm shifts, Statistical N-grams, RNN hidden state decay, Transformer Attention mechanism, and Enterprise Production AI Stack topology.

### [Lecture 02: How LLMs Work (From Tokens to Transformers)](./Lecture%2002/notes/README.md)
Autoregressive next-token prediction, Subword tokenization (BPE/WordPiece), Dense Vector Embeddings $\mathbb{R}^{d_{\text{model}}}$, Positional Encodings, Scaled Dot-Product Self-Attention ($Q, K, V$), Transformer multi-block state propagation, Logits projection head, Softmax, Temperature scaling, and autoregressive streaming.

### [Lecture 03: Talking to an LLM from Your Application](./Lecture%2003/notes/README.md)
ChatGPT vs Raw LLM (Car vs Engine analogy), Deterministic tools (Calculator, DB, Weather), Knowledge cutoff limits, The 4 Invariant Request Components (Where, Who, Which Model, What), Token economics (Prefill vs Decode, cost & latency), Node.js + Express + TypeScript microservice setup, Zod validation, OpenAI client singletons, response telemetry audit, and prompt injection defense via multi-role architecture.

### [Lecture 04: Building a Chatbot: Context, Memory, Streaming & Hallucinations](./Lecture%2004/notes/README.md)
Statelessness of HTTP LLM endpoints, the illusion of conversational continuity, coreference and pronoun binding failure, message roles (`system`, `user`, `assistant`), prompt contamination anti-patterns, the 4 Pillars of system prompts, context window budget constraints, quadratic token accumulation problem ($O(N^2)$ bloat), lost-in-the-middle phenomenon, sliding window and rolling summarization in TypeScript, Parametric Knowledge ($\Theta$) vs In-Context Working Memory ($X_{\text{prompt}}$), autoregressive token streaming via Server-Sent Events (SSE), fluency vs truth orthogonality, coherent fabrication vs benign nonsense, model sycophancy (Aditya Tandon sorting law experiment), and the 7-layer defense-in-depth architecture.

### [Lecture 05: Autonomous AI Agents, Tool Calling & Human-in-the-Loop Architecture](./Lecture%2005/notes/README.md)
From token prediction to deterministic tool delegation (Safe Calculator, Weather, Currency Exchange), the 5-step tool calling wire protocol, JSON Schema parameter validation via Zod, multi-step ReAct closed loop (Thought ➔ Action ➔ Observation), $O(N^2)$ quadratic context economics, agency spectrum (Fixed Code ➔ Dynamic Router ➔ Plan & Execute ➔ Autonomous ReAct), workspace filesystem sandboxing (`safePath` jail, symlink containment), autonomous website builder case study (BrewLab coffee landing page), and 3-tier Human-in-the-Loop (HITL) authorization with durable pause/resume webhooks.

### [Lecture 06: AI Streaming — From LLM Tokens to a Live Chat Experience](./Lecture%2006/notes/README.md)
Autoregressive token generation and the prefill-vs-decode latency duality, generation vs. delivery as two independent processes, **TTFT vs. total latency** and human reading speed as the throughput threshold, the four-layer granularity model (LLM token ≠ provider chunk ≠ network chunk ≠ decoded piece) with UTF-8 multi-byte split discipline, chunked transfer encoding and the exact SSE wire grammar (`data`/`event`/`id`/`retry`, `\n\n` framing, heartbeats), the **7 pipeline invariants**, the `.call()` → `.stream()` return-type change (`String` → `Flux<String>`/`AsyncIterable`), the **dual-write pattern** (stream out, buffer in) with one reconstructed assistant message per turn and `status: "interrupted"` for partial answers, the browser half (`fetch` resolves on headers, `ReadableStream.getReader()`, one `TextDecoder({stream:true})`, one growing bubble, sticky auto-scroll, `AbortController`), and production hardening: three watchdogs, backpressure that stalls instead of overflowing, cancellation propagation to the provider, in-band error protocols after `200 OK`, and the `p95(clientTTFT − serverTTFT)` alert that detects buffering regressions. Companion codebase ships a three-transport streaming microservice (raw `text/plain`, NDJSON, SSE) plus a browser client with a telemetry HUD, chaos injection and an executable `await response.text()` anti-pattern demo.

### [Lecture 07: Vector Embeddings — From First Principles](./Lecture%2007/notes/README.md)
The symbol-vs-meaning gap, why computers need numbers to perform mathematics, one-number representations and their failure, multi-dimensional feature vectors and vector spaces, Euclidean distance vs. dot product vs. cosine similarity, the failure of hand-crafted feature engineering (dimensionality explosion, task specificity, language ambiguity), learned representations through context prediction, the embedding lookup table and gradient-descent training loop, vector arithmetic (`king − man + woman ≈ queen`), the critical distinction between a feature vector and a learned embedding, multi-modal shared spaces (CLIP), and the application taxonomy unlocked by embeddings: semantic search, nearest-neighbour retrieval, clustering, classification, ranking, recommendation, and RAG.

### [Lecture 08: Vector Embeddings Project — Building a Movie Recommendation System](./Lecture%2008/notes/README.md)
A complete, working movie recommendation engine built on **REPRESENT → STORE → COMPARE → RANK**. Covers why not to prompt an LLM with the entire catalog (context limits, repeated work, unnecessary generation, cost/latency), the precomputation insight (stable movie descriptions embedded once; changing user queries embedded per request), the two-phase offline/online architecture, semantic search vs. similar-movie recommendation sharing one ranking engine, content-based vs. collaborative filtering, cosine similarity from first principles (`(A · B) / (‖A‖ × ‖B‖)`), zero-vector and dimension guards, `O(N × D)` scoring, and the full system design with an optional LLM explanation layer that leads into RAG. Companion codebase ships an Express + TypeScript API with Zod validation, batch startup embeddings, OpenAI live mode plus deterministic mock mode, an 18-movie catalog, and a chapter-wise implementation guide (00 → 08) with block-by-block explanations.

### [Lecture 09: Vector Embedding Search & Storage](./Lecture%2009/notes/README.md)
Why the 30-movie recommender from Lecture 08 cannot survive scale, and what replaces it. Covers the two separate engineering problems — **storing** hundreds of millions of vectors and **searching** them efficiently — the myth that relational databases cannot store vectors (they can; they simply cannot index similarity with a B-tree), the anatomy of a vector database (ID + vector + payload, fixed dimensions and metrics, write/read pipelines, pre- vs post-filtering, hybrid search with RRF), and brute-force KNN as the correct baseline: `O(N × D)` per query, 10M × 1536 = **15.36 billion dimension operations**, 1536 `float32` ≈ **6 KB** per vector, **6 GB per million**, **600 GB per 100 million**. Then the indexing story: why sorted scalar indexes work, why a k-d tree partitions space one axis at a time, the exact branch-and-bound pruning rule (`planeDist < bestDist`), and why pruning collapses as dimensions grow — boundary proliferation, volume concentration, and distance concentration. Finally, **ANN indexes** in practice: IVF (`nlist`/`nprobe`), HNSW (`M`/`efConstruction`/`efSearch`), product quantization (32× compression, ADC), scalar/binary quantization, LSH bands and rows, DiskANN, two-stage retrieval with exact rescoring, and production design: capacity planning, CDC ingestion, deletes and orphan chunks, zero-downtime model re-embedding with alias swaps, sharding and tail latency, multi-tenancy, recall@K / MRR / nDCG evaluation, caching, ACL security, vendor selection, runbooks, and a production checklist.
