<div align="center">

# 🚀 Forward Deployed Engineer (FDE) &amp; Generative AI Systems

### 🧠 Master Curriculum &amp; Engineering Reference for Building Production-Grade Enterprise AI

*Lecture notes · System architectures · Mathematical foundations · Paper deep-dives · Production blueprints*

[![Lectures](https://img.shields.io/badge/Lectures-15-blueviolet?style=for-the-badge)](#-curriculum-navigation)
[![Chapter Notes](https://img.shields.io/badge/Chapter_Notes-118-2ea44f?style=for-the-badge)](#-curriculum-navigation)
[![Notes Volume](https://img.shields.io/badge/Notes-177k%2B_lines-informational?style=for-the-badge)](#-repository-at-a-glance)
[![Code](https://img.shields.io/badge/Code-TypeScript_%7C_Node.js-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](#-technology-stack)

[![Paper Deep-Dives](https://img.shields.io/badge/Paper_Deep--Dives-Transformers_%7C_RAG_%7C_Vector_DB-orange?style=for-the-badge)](#-lecture-highlights)
[![Runnable Code](https://img.shields.io/badge/Hands--on-Runnable_Codebases-ff69b4?style=for-the-badge)](#-quick-start)
[![Status](https://img.shields.io/badge/Status-Active-success?style=for-the-badge)](#-roadmap)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen?style=for-the-badge)](#-contributing)

**[📖 Start the Curriculum](#-curriculum-navigation)** · **[🗺️ Learning Path](#-learning-path)** · **[🚀 Quick Start](#-quick-start)** · **[📑 Master Index](./index.md)**

</div>

---

## 🧭 Table of Contents

| | Section | What's inside |
| :---: | :--- | :--- |
| 🎯 | **[Repository Overview](#-repository-overview)** | What this repository is and who it is for |
| 📊 | **[Repository at a Glance](#-repository-at-a-glance)** | Hard numbers: lectures, chapters, lines of notes, lines of code |
| 🗺️ | **[Learning Path](#-learning-path)** | The five-phase route through the curriculum |
| 📚 | **[Curriculum Navigation](#-curriculum-navigation)** | Every lecture, note set, codebase and implementation guide |
| 📖 | **[Lecture Highlights](#-lecture-highlights)** | Deep-dive summaries of all 15 lectures |
| 🧰 | **[Technology Stack](#-technology-stack)** | Languages, frameworks, services and SDKs used |
| 🚀 | **[Quick Start](#-quick-start)** | How to read the notes and run the code |
| 🗂️ | **[Repository Structure](#-repository-structure)** | Directory map |
| 📐 | **[Conventions](#-conventions)** | How every note set, codebase and guide is organised |
| 🛣️ | **[Roadmap](#-roadmap)** | Where the curriculum is heading |
| 🤝 | **[Contributing](#-contributing)** | How to add or improve a lecture |
| 📄 | **[License &amp; Attribution](#-license--attribution)** | Usage terms |

---

## 🎯 Repository Overview

> **The thesis of this repository:** a Forward Deployed Engineer is not the person who ships the *requested* chatbot — it is the person who discovers the *real* business problem and then proves the fix with a measurable system.

This repository contains structured lecture notes, system architectures, mathematical foundations, paper deep-dives, and production blueprints for **Forward Deployed Engineers (FDEs)** and **Generative AI Systems Architects**.

| Theme | What it covers |
| :--- | :--- |
| 🧭 **Role & Mindset** | Moving from client-requested *"chatbots"* (proposed solutions) to true enterprise business problem discovery and resolution. |
| 📐 **Mathematical &amp; Theoretical Depth** | Step-by-step proofs — e.g. the Attention variance scaling factor $\frac{1}{\sqrt{d_k}}$, sinusoidal positional relative offsets, $O(1)$ path length complexity. |
| 📑 **Paper Deep-Dives** | Comprehensive breakdowns of seminal research, including *"Attention Is All You Need"* (Vaswani et al., 2017). |
| 🏭 **Production Architecture** | Design criteria for **Grounded**, **Observable**, **Secure** and **Actionable** enterprise AI systems. |
| 💻 **Hands-on Implementation** | Production microservices built with Node.js, Express, TypeScript and modern AI SDKs. |

---

## 📊 Repository at a Glance

| Metric | Value |
| :--- | ---: |
| 🎓 Lectures | **15** |
| 📓 Chapter note files | **118** |
| 📄 Consolidated note documents | **15** |
| 🗂️ Markdown files | **383** |
| ✍️ Lines of notes &amp; guides | **177,000+** |
| 💻 TypeScript / JavaScript files | **310** |
| 🧾 Lines of code | **38,400+** |
| 🏭 Lectures shipping runnable code | **11** (03 · 04 · 05 · 06 · 08 · 10 · 11 · 12 · 13 · 14 · 15) |
| 🧩 Runnable codebases | **14** |
| 🎞️ Source slide decks &amp; Excalidraw diagrams | **15 PDF · 14 SVG** |

> 💡 Every number above is derived from the repository contents — notes are Markdown, code is strict TypeScript or plain JavaScript, and each codebase ships with a chapter-by-chapter implementation guide.

---

## 🗺️ Learning Path

Follow the phases in order — each one assumes only the phase before it.

| Phase | Lectures | Colour | You leave able to… |
| :---: | :--- | :---: | :--- |
| **1 · Foundations** | 01 · 02 | 🟦 | Explain how an LLM actually produces a token, and why rules → ML → Transformers happened |
| **2 · Application Layer** | 03 · 04 | 🟩 | Call a model from a real service, budget tokens, and fix statelessness, memory and streaming |
| **3 · Agency &amp; Streaming** | 05 · 06 | 🟨 | Give a model tools, sandbox it, add human-in-the-loop, and stream tokens to a browser correctly |
| **4 · Embeddings &amp; Retrieval** | 07 · 08 · 09 · 10 | 🟧 | Represent meaning as vectors, then store and search billions of them with ANN indexes |
| **5 · RAG &amp; Advanced RAG** | 11 · 12 | 🟥 | Build a grounded answering system end to end — then prove which control fixes a wrong answer |
| **6 · Output Contracts &amp; Integration** | 13 · 14 · 15 | 🟪 | Make a model's output something a program can trust — then give that program standard access to the outside world, with all three primitives under the right owner |

---

## 📚 Curriculum Navigation

> **Legend** — 📂 **Notes index** (chapter-by-chapter) · 📄 **Complete document** (single consolidated file) · 💻 **Codebase** · 🛠️ **Implementation guide** (full source, block-by-block)

| # | Lecture | 📂 Notes | 📄 Complete | 💻 Codebase | 🛠️ Guide |
| :---: | :--- | :---: | :---: | :--- | :--- |
| **01** | 🟦 Introduction to FDE & Generative AI Foundations | [📂](./Lecture%2001/notes/README.md) | [📄](./Lecture%2001/notes/Lecture_01_Complete_Notes.md) | ➖ | ➖ |
| **02** | 🟦 How LLMs Work (From Tokens to Transformers) | [📂](./Lecture%2002/notes/README.md) | [📄](./Lecture%2002/notes/Lecture_02_Complete_Notes.md) | ➖ | ➖ |
| **03** | 🟩 Talking to an LLM from Your Application | [📂](./Lecture%2003/notes/README.md) | [📄](./Lecture%2003/notes/Lecture_03_Complete_Notes.md) | [💻](./Lecture%2003/code/README.md) | [🛠️](./Lecture%2003/code/implementations%20guide/README.md) |
| **04** | 🟩 Building a Chatbot: Context, Memory, Streaming & Hallucinations | [📂](./Lecture%2004/notes/README.md) | [📄](./Lecture%2004/notes/Lecture_04_Complete_Notes.md) | [💻](./Lecture%2004/code/README.md) | [🛠️](./Lecture%2004/code/implementations%20guide/README.md) |
| **05** | 🟨 Autonomous AI Agents, Tool Calling & Human-in-the-Loop | [📂](./Lecture%2005/notes/README.md) | [📄](./Lecture%2005/notes/Lecture_05_Complete_Notes.md) | [💻](./Lecture%2005/code/README.md) | [🛠️](./Lecture%2005/code/implementations%20guide/README.md) |
| **06** | 🟨 AI Streaming — From LLM Tokens to a Live Chat Experience | [📂](./Lecture%2006/notes/README.md) | [📄](./Lecture%2006/notes/Lecture_06_Complete_Notes.md) | [💻](./Lecture%2006/code/README.md) | [🛠️](./Lecture%2006/code/implementations%20guide/README.md) |
| **07** | 🟧 Vector Embeddings — From First Principles | [📂](./Lecture%2007/notes/README.md) | [📄](./Lecture%2007/notes/Lecture_07_Complete_Notes.md) | ➖ | ➖ |
| **08** | 🟧 Vector Embeddings Project — Movie Recommendation System | [📂](./Lecture%2008/notes/README.md) | [📄](./Lecture%2008/notes/Lecture_08_Complete_Notes.md) | [💻](./Lecture%2008/code/README.md) | [🛠️](./Lecture%2008/code/implementations%20guide/README.md) |
| **09** | 🟧 Vector Embedding Search & Storage | [📂](./Lecture%2009/notes/README.md) | [📄](./Lecture%2009/notes/Lecture_09_Complete_Notes.md) | ➖ | ➖ |
| **10** | 🟧 Deep Dive into Vector Databases & ANN Algorithms | [📂](./Lecture%2010/notes/README.md) | [📄](./Lecture%2010/notes/Lecture_10_Complete_Notes.md) | [💻](./Lecture%2010/code/README.md) | [🛠️](./Lecture%2010/code/implementations%20guide/README.md) |
| **11** | 🟥 Retrieval-Augmented Generation (RAG) | [📂](./Lecture%2011/notes/README.md) | [📄](./Lecture%2011/notes/Lecture_11_Complete_Notes.md) | [💻 Productions RAG](./Lecture%2011/code/Productions%20RAG/README.md)<br/>[🧪 Eassy RAG](./Lecture%2011/code/Eassy%20RAG/src/queryPdf.js) | [🛠️ Productions RAG (00 → 14)](./Lecture%2011/code/Productions%20RAG/implementations%20guide/README.md)<br/>[🛠️ Eassy RAG (01 → 08)](./Lecture%2011/code/Eassy%20RAG/implementations%20guide/README.md) |
| **12** | 🟥 Advanced RAG — Chunking, Hybrid Retrieval, Reranking & Context Engineering | [📂](./Lecture%2012/notes/README.md) | [📄](./Lecture%2012/notes/Lecture_12_Complete_Notes.md) | [💻 Advanced RAG](./Lecture%2012/code/advanced-rag/README.md) | [🛠️ (00 → 10)](./Lecture%2012/code/advanced-rag/implementations%20guide/README.md) |
| **13** | 🟪 Structured Outputs in GenAI — Schema, Enforcement, Validation & Action | [📂](./Lecture%2013/notes/README.md) | [📄](./Lecture%2013/notes/Lecture_13_Complete_Notes.md) | [🏭 Structured Outputs](./Lecture%2013/code/Production%20Code/README.md) | ➖ |
| **14** | 🟪 MCP Server from First Principles — Host, Client, Server, Tools, Resources & Prompts | [📂](./Lecture%2014/notes/README.md) | [📄](./Lecture%2014/notes/Lecture_14_Complete_Notes.md) | [🧱 Basic Code](./Lecture%2014/code/Basic%20Code/README.md)<br/>[🏭 Production Code](./Lecture%2014/code/Production%20Code/README.md) | [🛠️ Basic Code (01 → 09)](./Lecture%2014/code/Basic%20Code/implementations%20guide/README.md)<br/>[🛠️ Production Code (01 → 17)](./Lecture%2014/code/Production%20Code/implementations%20guide/README.md) |
| **15** | 🟪 MCP Server — Resources & Prompts | [📂](./Lecture%2015/notes/README.md) | [📄](./Lecture%2015/notes/Lecture_15_Complete_Notes.md) | [🧱 Basic Code](./Lecture%2015/code/Basic%20Code/README.md)<br/>[🏭 Production Code](./Lecture%2015/code/Production%20Code/README.md) | [🛠️ Basic Code (01 → 09)](./Lecture%2015/code/Basic%20Code/implementations%20guide/README.md)<br/>[🛠️ Production Code (01 → 26)](./Lecture%2015/code/Production%20Code/implementations%20guide/README.md) |

> 🧭 **Want the full chapter-level roadmap with per-chapter topic tables?** Open the **[Main Repository Index & Curriculum Roadmap](./index.md)**.

---


## 📖 Lecture Highlights

Each lecture below is summarised twice: a one-line thesis and a topic chip list for scanning, plus a collapsible **full breakdown** with the complete subject coverage. Colour squares match the **[Learning Path](#-learning-path)** phases.

---

### 🟦 [Lecture 01: Introduction to FDE & Generative AI Foundations](./Lecture%2001/notes/README.md)

> **Thesis** — The job is not to build the chatbot the client asked for; it is to find the business problem underneath it, and the history of AI explains why the current tools look the way they do.

`E-commerce case study (50k daily queries)` · `Problem vs Solution discovery` · `Symbolic AI` · `Expert Systems` · `ML paradigm shift` · `Statistical N-grams` · `RNN hidden-state decay` · `Transformer attention` · `Production AI stack`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

E-commerce case study (50k daily queries), Problem vs Solution discovery, Symbolic AI & Expert Systems, Machine Learning paradigm shifts, Statistical N-grams, RNN hidden state decay, Transformer Attention mechanism, and Enterprise Production AI Stack topology.

</details>

**[📂 Notes index](./Lecture%2001/notes/README.md)** · **[📄 Complete document](./Lecture%2001/notes/Lecture_01_Complete_Notes.md)**

---

### 🟦 [Lecture 02: How LLMs Work (From Tokens to Transformers)](./Lecture%2002/notes/README.md)

> **Thesis** — An LLM is a next-token probability machine: text → tokens → vectors → attention → logits → softmax → one token, appended and repeated.

`Autoregressive next-token prediction` · `Subword tokenization (BPE/WordPiece)` · `Dense embeddings ℝ^d_model` · `Positional encodings` · `Scaled dot-product attention (Q, K, V)` · `Multi-block state propagation` · `Logits head` · `Softmax` · `Temperature` · `Streaming`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

Autoregressive next-token prediction, Subword tokenization (BPE/WordPiece), Dense Vector Embeddings $\mathbb{R}^{d_{\text{model}}}$, Positional Encodings, Scaled Dot-Product Self-Attention ($Q, K, V$), Transformer multi-block state propagation, Logits projection head, Softmax, Temperature scaling, and autoregressive streaming.

</details>

**[📂 Notes index](./Lecture%2002/notes/README.md)** · **[📄 Complete document](./Lecture%2002/notes/Lecture_02_Complete_Notes.md)**

---

### 🟩 [Lecture 03: Talking to an LLM from Your Application](./Lecture%2003/notes/README.md)

> **Thesis** — A raw model is an engine, not a car: your application supplies the keys, the dashboard, the fuel budget and the guardrails.

`ChatGPT vs raw LLM` · `Deterministic tools` · `Knowledge cutoff` · `4 invariant request components` · `Prefill vs decode economics` · `Node.js + Express + TypeScript` · `Zod validation` · `Client singletons` · `Telemetry audit` · `Prompt-injection defense`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

ChatGPT vs Raw LLM (Car vs Engine analogy), Deterministic tools (Calculator, DB, Weather), Knowledge cutoff limits, The 4 Invariant Request Components (Where, Who, Which Model, What), Token economics (Prefill vs Decode, cost & latency), Node.js + Express + TypeScript microservice setup, Zod validation, OpenAI client singletons, response telemetry audit, and prompt injection defense via multi-role architecture.

</details>

**[📂 Notes index](./Lecture%2003/notes/README.md)** · **[📄 Complete document](./Lecture%2003/notes/Lecture_03_Complete_Notes.md)** · **[💻 Codebase](./Lecture%2003/code/README.md)** · **[🛠️ Implementation guide](./Lecture%2003/code/implementations%20guide/README.md)**

---

### 🟩 [Lecture 04: Building a Chatbot: Context, Memory, Streaming & Hallucinations](./Lecture%2004/notes/README.md)

> **Thesis** — There is no conversation in the model — only the array your server sends. Memory, streaming and hallucination are therefore application design problems, not model properties.

`HTTP statelessness` · `Coreference binding` · `system / user / assistant roles` · `4 pillars of system prompts` · `Context-window budget` · `O(N²) token bloat` · `Lost-in-the-middle` · `Sliding window & rolling summaries` · `Parametric vs in-context knowledge` · `SSE streaming` · `Fluency ≠ truth` · `Sycophancy` · `7-layer defense in depth`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

Statelessness of HTTP LLM endpoints, the illusion of conversational continuity, coreference and pronoun binding failure, message roles (`system`, `user`, `assistant`), prompt contamination anti-patterns, the 4 Pillars of system prompts, context window budget constraints, quadratic token accumulation problem ($O(N^2)$ bloat), lost-in-the-middle phenomenon, sliding window and rolling summarization in TypeScript, Parametric Knowledge ($\Theta$) vs In-Context Working Memory ($X_{\text{prompt}}$), autoregressive token streaming via Server-Sent Events (SSE), fluency vs truth orthogonality, coherent fabrication vs benign nonsense, model sycophancy (Aditya Tandon sorting law experiment), and the 7-layer defense-in-depth architecture.

</details>

**[📂 Notes index](./Lecture%2004/notes/README.md)** · **[📄 Complete document](./Lecture%2004/notes/Lecture_04_Complete_Notes.md)** · **[💻 Codebase](./Lecture%2004/code/README.md)** · **[🛠️ Implementation guide](./Lecture%2004/code/implementations%20guide/README.md)**

---


### 🟨 [Lecture 05: Autonomous AI Agents, Tool Calling & Human-in-the-Loop Architecture](./Lecture%2005/notes/README.md)

> **Thesis** — Agency is a spectrum, and every step up it costs context budget, latency and blast radius — so sandbox the workspace and keep a human on the irreversible actions.

`Tool delegation` · `5-step tool-calling wire protocol` · `JSON Schema + Zod validation` · `ReAct loop (Thought ➔ Action ➔ Observation)` · `O(N²) context economics` · `Agency spectrum` · `safePath sandboxing` · `BrewLab case study` · `3-tier HITL` · `Durable pause/resume webhooks`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

From token prediction to deterministic tool delegation (Safe Calculator, Weather, Currency Exchange), the 5-step tool calling wire protocol, JSON Schema parameter validation via Zod, multi-step ReAct closed loop (Thought ➔ Action ➔ Observation), $O(N^2)$ quadratic context economics, agency spectrum (Fixed Code ➔ Dynamic Router ➔ Plan & Execute ➔ Autonomous ReAct), workspace filesystem sandboxing (`safePath` jail, symlink containment), autonomous website builder case study (BrewLab coffee landing page), and 3-tier Human-in-the-Loop (HITL) authorization with durable pause/resume webhooks.

</details>

**[📂 Notes index](./Lecture%2005/notes/README.md)** · **[📄 Complete document](./Lecture%2005/notes/Lecture_05_Complete_Notes.md)** · **[💻 Codebase](./Lecture%2005/code/README.md)** · **[🛠️ Implementation guide](./Lecture%2005/code/implementations%20guide/README.md)**

---

### 🟨 [Lecture 06: AI Streaming — From LLM Tokens to a Live Chat Experience](./Lecture%2006/notes/README.md)

> **Thesis** — Generation and delivery are two independent processes. Streaming is what you build in the gap between them, and TTFT — not total latency — is the number users feel.

`Prefill vs decode` · `TTFT vs total latency` · `4-layer granularity model` · `UTF-8 multi-byte splits` · `Chunked transfer encoding` · `SSE wire grammar` · `7 pipeline invariants` · `.call() → .stream()` · `Dual-write pattern` · `status: "interrupted"` · `ReadableStream + TextDecoder` · `AbortController` · `Three watchdogs` · `Backpressure` · `p95(clientTTFT − serverTTFT) alert`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

Autoregressive token generation and the prefill-vs-decode latency duality, generation vs. delivery as two independent processes, **TTFT vs. total latency** and human reading speed as the throughput threshold, the four-layer granularity model (LLM token ≠ provider chunk ≠ network chunk ≠ decoded piece) with UTF-8 multi-byte split discipline, chunked transfer encoding and the exact SSE wire grammar (`data`/`event`/`id`/`retry`, `\n\n` framing, heartbeats), the **7 pipeline invariants**, the `.call()` → `.stream()` return-type change (`String` → `Flux<String>`/`AsyncIterable`), the **dual-write pattern** (stream out, buffer in) with one reconstructed assistant message per turn and `status: "interrupted"` for partial answers, the browser half (`fetch` resolves on headers, `ReadableStream.getReader()`, one `TextDecoder({stream:true})`, one growing bubble, sticky auto-scroll, `AbortController`), and production hardening: three watchdogs, backpressure that stalls instead of overflowing, cancellation propagation to the provider, in-band error protocols after `200 OK`, and the `p95(clientTTFT − serverTTFT)` alert that detects buffering regressions. Companion codebase ships a three-transport streaming microservice (raw `text/plain`, NDJSON, SSE) plus a browser client with a telemetry HUD, chaos injection and an executable `await response.text()` anti-pattern demo.

</details>

**[📂 Notes index](./Lecture%2006/notes/README.md)** · **[📄 Complete document](./Lecture%2006/notes/Lecture_06_Complete_Notes.md)** · **[💻 Codebase](./Lecture%2006/code/README.md)** · **[🛠️ Implementation guide](./Lecture%2006/code/implementations%20guide/README.md)**

---


### 🟧 [Lecture 07: Vector Embeddings — From First Principles](./Lecture%2007/notes/README.md)

> **Thesis** — Computers cannot do mathematics on symbols, so meaning has to become geometry — and learned embeddings beat hand-crafted features because context, not a human, chose the axes.

`Symbol vs meaning` · `Feature vectors` · `Euclidean vs dot vs cosine` · `Feature-engineering failure` · `Learned representations` · `Embedding lookup table` · `Gradient descent` · `king − man + woman ≈ queen` · `Feature vector ≠ embedding` · `CLIP multi-modal spaces` · `Embedding application taxonomy`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

The symbol-vs-meaning gap, why computers need numbers to perform mathematics, one-number representations and their failure, multi-dimensional feature vectors and vector spaces, Euclidean distance vs. dot product vs. cosine similarity, the failure of hand-crafted feature engineering (dimensionality explosion, task specificity, language ambiguity), learned representations through context prediction, the embedding lookup table and gradient-descent training loop, vector arithmetic (`king − man + woman ≈ queen`), the critical distinction between a feature vector and a learned embedding, multi-modal shared spaces (CLIP), and the application taxonomy unlocked by embeddings: semantic search, nearest-neighbour retrieval, clustering, classification, ranking, recommendation, and RAG.

</details>

**[📂 Notes index](./Lecture%2007/notes/README.md)** · **[📄 Complete document](./Lecture%2007/notes/Lecture_07_Complete_Notes.md)**

---

### 🟧 [Lecture 08: Vector Embeddings Project — Building a Movie Recommendation System](./Lecture%2008/notes/README.md)

> **Thesis** — `REPRESENT → STORE → COMPARE → RANK`: embed stable content once, embed the changing query per request, and rank with cosine similarity.

`REPRESENT → STORE → COMPARE → RANK` · `Why not prompt the whole catalog` · `Precomputation insight` · `Offline/online architecture` · `Semantic search vs similar-item` · `Content-based vs collaborative` · `Cosine from first principles` · `Zero-vector guards` · `O(N × D) scoring` · `Optional LLM explanation layer`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

A complete, working movie recommendation engine built on **REPRESENT → STORE → COMPARE → RANK**. Covers why not to prompt an LLM with the entire catalog (context limits, repeated work, unnecessary generation, cost/latency), the precomputation insight (stable movie descriptions embedded once; changing user queries embedded per request), the two-phase offline/online architecture, semantic search vs. similar-movie recommendation sharing one ranking engine, content-based vs. collaborative filtering, cosine similarity from first principles (`(A · B) / (‖A‖ × ‖B‖)`), zero-vector and dimension guards, `O(N × D)` scoring, and the full system design with an optional LLM explanation layer that leads into RAG. Companion codebase ships an Express + TypeScript API with Zod validation, batch startup embeddings, OpenAI live mode plus deterministic mock mode, an 18-movie catalog, and a chapter-wise implementation guide (00 → 08) with block-by-block explanations.

</details>

**[📂 Notes index](./Lecture%2008/notes/README.md)** · **[📄 Complete document](./Lecture%2008/notes/Lecture_08_Complete_Notes.md)** · **[💻 Codebase](./Lecture%2008/code/README.md)** · **[🛠️ Implementation guide](./Lecture%2008/code/implementations%20guide/README.md)**

---


### 🟧 [Lecture 09: Vector Embedding Search & Storage](./Lecture%2009/notes/README.md)

> **Thesis** — At scale, "store the vectors" and "search the vectors" are two different engineering problems — and brute-force KNN is the baseline you must beat on purpose, not by accident.

`Store vs search` · `Vector DB anatomy` · `Pre- vs post-filtering` · `Hybrid search + RRF` · `Brute-force KNN baseline` · `15.36B dimension ops @ 10M×1536` · `6 KB/vector · 600 GB/100M` · `k-d tree branch-and-bound` · `Curse of dimensionality` · `IVF · HNSW · PQ · LSH · DiskANN` · `Two-stage rescoring` · `Capacity planning & CDC` · `Zero-downtime re-embedding` · `recall@K / MRR / nDCG` · `ACL security`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

Why the 30-movie recommender from Lecture 08 cannot survive scale, and what replaces it. Covers the two separate engineering problems — **storing** hundreds of millions of vectors and **searching** them efficiently — the myth that relational databases cannot store vectors (they can; they simply cannot index similarity with a B-tree), the anatomy of a vector database (ID + vector + payload, fixed dimensions and metrics, write/read pipelines, pre- vs post-filtering, hybrid search with RRF), and brute-force KNN as the correct baseline: `O(N × D)` per query, 10M × 1536 = **15.36 billion dimension operations**, 1536 `float32` ≈ **6 KB** per vector, **6 GB per million**, **600 GB per 100 million**. Then the indexing story: why sorted scalar indexes work, why a k-d tree partitions space one axis at a time, the exact branch-and-bound pruning rule (`planeDist < bestDist`), and why pruning collapses as dimensions grow — boundary proliferation, volume concentration, and distance concentration. Finally, **ANN indexes** in practice: IVF (`nlist`/`nprobe`), HNSW (`M`/`efConstruction`/`efSearch`), product quantization (32× compression, ADC), scalar/binary quantization, LSH bands and rows, DiskANN, two-stage retrieval with exact rescoring, and production design: capacity planning, CDC ingestion, deletes and orphan chunks, zero-downtime model re-embedding with alias swaps, sharding and tail latency, multi-tenancy, recall@K / MRR / nDCG evaluation, caching, ACL security, vendor selection, runbooks, and a production checklist.

</details>

**[📂 Notes index](./Lecture%2009/notes/README.md)** · **[📄 Complete document](./Lecture%2009/notes/Lecture_09_Complete_Notes.md)**

---


### 🟧 [Lecture 10: Deep Dive into Vector Databases & ANN Algorithms](./Lecture%2010/notes/README.md)

> **Thesis** — The lecture that turns the retrieval half of RAG into working code: implement IVF, HNSW and PQ yourself, then put Qdrant or pgvector behind the same interface.

`Irreversible model/dimension choices` · `Cosine vs dot vs L2/L1` · `Exact KNN as ground truth` · `Speed–recall contract` · `IVF (nlist/nprobe)` · `HNSW (M/efConstruction/efSearch)` · `Product quantization + ADC` · `5-layer vector DB anatomy` · `Qdrant vs pgvector` · `Chunking · hybrid + RRF · reranking` · `Latency budgets` · `Failure runbook`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

The lecture that turns the retrieval half of RAG into working code. Notes cover embeddings and irreversible model/dimension choices, cosine vs dot vs L2/L1 and metric consistency, exact KNN as the ground truth (`O(N × D)`, 15.36 billion dimension operations at 10M × 1536), the speed–recall contract, IVF (`nlist`/`nprobe`, k-means, boundary vectors), HNSW (level sampling, greedy descent, `efConstruction`/`efSearch`, neighbour diversity, tombstones, filter weakness), product quantization (codebooks, ADC, rescoring, 64× compression), the five-layer anatomy of a vector database, the Qdrant vs pgvector decision, and production retrieval: chunking, hybrid search + RRF, reranking, evaluation, latency budgets, security and a failure runbook. The companion codebase implements every algorithm from scratch in strict TypeScript — IVF, HNSW and PQ included — plus a CRUD vector store with payload filters, BM25/RRF hybrid search, official Qdrant and pgvector adapters tested against Docker, and a chapter-wise implementation guide (00 → 10) with the full source and block-by-block explanations. **No RAG generation:** the LLM answer layer belongs to Lecture 11.

</details>

**[📂 Notes index](./Lecture%2010/notes/README.md)** · **[📄 Complete document](./Lecture%2010/notes/Lecture_10_Complete_Notes.md)** · **[💻 Codebase](./Lecture%2010/code/README.md)** · **[🛠️ Implementation guide](./Lecture%2010/code/implementations%20guide/README.md)**

---


### 🟥 [Lecture 11: Retrieval-Augmented Generation (RAG)](./Lecture%2011/notes/README.md)

> **Thesis** — Hallucination is a mechanism, not a bug: the model is a stateless next-token predictor, so grounding means putting verified evidence in the prompt and refusing when it is missing.

`Parametric vs non-parametric memory` · `Two pipelines / seven serving steps` · `Extraction & chunking hazards` · `Orphan chunks` · `Embedding-space contract` · `Namespaces & score calibration` · `Hybrid search + RRF · MMR · reranking` · `Four-clause prompt contract` · `Exact refusal sentence` · `Verified [n] citations` · `Prompt injection as authority` · `Query condensation` · `Sessions & IDOR` · `recall@K · MRR · nDCG` · `SLOs · degradation · blue/green re-index`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

The generation half of RAG, built end to end. Notes start from the stateless model — parametric vs non-parametric memory, why hallucination is a mechanism rather than a bug, and why a larger context window is capacity rather than attention — then build the open-book architecture: two pipelines, seven serving steps, and the failure modes that survive a correct design. Ingestion covers extraction hazards, cleaning, chunking strategies and overlap arithmetic, metadata and deterministic ids, and the orphan-chunk problem. Retrieval covers the embedding-space contract, dimensions and prefixes, namespaces, score calibration, top-K, metadata filters, hybrid search with RRF, MMR and reranking. Grounding covers the four-clause prompt contract, the exact refusal sentence the script uses, citation markers, fabrication guards, and prompt injection as an authority and capability problem. Conversation state covers query condensation ("And for shoes?"), memory strategies and their quadratic cost, session ownership and IDOR, and history poisoning. Evaluation separates retrieval from generation with recall@K, MRR and nDCG, citation validity, refusal correctness, a debug tree and a per-request trace; production design adds SLOs, degradation paths, caching keyed by `corpusVersion`, blue/green re-indexing, a failure runbook and build-vs-buy. The companion codebase is a working, framework-free system in strict TypeScript — structure-aware token chunking, OpenAI plus deterministic offline embeddings, an in-memory store and a Pinecone adapter behind one interface, hybrid retrieval with a calibrated score floor, a grounded prompt with verified `[n]` citations, TTL-bounded sessions with query rewriting, a 12-case golden set (**recall@4 1.00**, citations 12/12, refusals 12/12, expected facts 12/12 offline), and an Express API that returns the full trace with every answer — plus a chapter-wise implementation guide (00 → 14) with the full source and block-by-block explanations.

</details>

**🧩 Two codebases ship with this lecture — they answer different questions:**

| Codebase | Language &amp; size | The question it answers | What's inside |
| :--- | :--- | :--- | :--- |
| 🏭 **[Productions RAG](./Lecture%2011/code/Productions%20RAG/README.md)** | TypeScript · 30 files · guide **00 → 14** | *How do you build the real thing?* | Every stage behind an interface, hybrid retrieval, citation verification, sessions, evaluation and an HTTP API. |
| 🧪 **[Eassy RAG](./Lecture%2011/code/Eassy%20RAG/src/queryPdf.js)** | Plain JavaScript · 6 modules · 477 lines · guide **01 → 08** | *What is the smallest honest pipeline?* | `pdf-parse` → 1,000-character chunks with a 150-character overlap → `text-embedding-3-small` truncated to 1,024 dimensions → one Qdrant point per chunk with a deterministic UUID id → top-5 cosine retrieval → a six-clause grounded prompt returning `[Source n]` citations and the exact chunks used, or a refusal when retrieval returns nothing. |

> ⚠️ **Real failure modes documented in the Eassy RAG guide, not hidden:** the `pdf-parse@1.1.1` ESM crash (and the `createRequire` fix), the chunker's `850`-character whitespace-free limit (`Chunking failed to advance`), and the collection dimension guard that stops silent space mismatches.

**[📂 Notes index](./Lecture%2011/notes/README.md)** · **[📄 Complete document](./Lecture%2011/notes/Lecture_11_Complete_Notes.md)** · **[🛠️ Productions RAG guide (00 → 14)](./Lecture%2011/code/Productions%20RAG/implementations%20guide/README.md)** · **[🛠️ Eassy RAG guide (01 → 08)](./Lecture%2011/code/Eassy%20RAG/implementations%20guide/README.md)**

---


### 🟥 [Lecture 12: Advanced RAG — Chunking, Hybrid Retrieval, Reranking and Context Engineering](./Lecture%2012/notes/README.md)

> **Thesis** — Basic RAG makes one heroic assumption: *the retrieved chunks contain everything needed*. This lecture makes that true, then proves the model used the result honestly.

`Coverage vs selection failures` · `Retrieval-or-generation decision tree` · `stride = size − overlap` · `Structural chunking + breadcrumbs` · `Semantic breakpoints` · `Parent-child (small-to-big)` · `Contextual retrieval + late chunking` · `K_retrieve vs K_context` · `Calibrated score floors + MMR` · `Fail-closed ACL + temporal filters` · `BM25 from first principles` · `RRF` · `Two-stage reranking + two-sided gate` · `Precedence + bookending + token budget` · `Ablation matrix` · `Blue/green re-indexing`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

The engineering discipline of making basic RAG's one heroic assumption true — *the retrieved chunks contain everything needed to answer correctly* — and then proving that the model used the result honestly. Notes start by separating the two failure classes (coverage and selection) and give a four-step tree for deciding whether a wrong answer is a retrieval problem or a generation problem. Chunking covers fixed-size arithmetic (`stride = size − overlap`, storage `≈ S/(S−O)`, the `overlap ≥ size` bug, orphan chunks), then structural chunking with breadcrumbs and the two-pass rule for tables, semantic breakpoints and why they are not the default, parent-child (small-to-big) retrieval, contextual retrieval and late chunking. Retrieval covers `K_retrieve` as a recall ceiling versus `K_context` as a token bill, calibrated score floors, MMR, metadata filtering with fail-closed tenant/ACL rules and temporal validity, BM25 from first principles, reciprocal rank fusion and why scores cannot be added across two rankings, and two-stage reranking with a two-sided gate that decides when *nothing* was relevant. Context engineering covers precedence when documents disagree, lost-in-the-middle bookending, evidence labels, token budgets and prompt injection as an authority problem. Evaluation and production cover recall@K, MRR, nDCG, faithfulness, citation validity, refusal correctness, the ablation matrix, the seven pinned versions, blue/green re-indexing and a failure runbook. The companion codebase is a framework-free system in strict TypeScript — fixed/structural/semantic chunkers, an offline hash embedder plus OpenAI behind one interface, an in-memory store with pre- and post-filtering, a filter DSL with ACL and `asOf` rules, BM25 + RRF, a joint reranker with a calibrated gate, context assembly with parents, dedupe, precedence, budget and bookending, a 14-case golden set and a six-row ablation matrix (**recall 0.571 → 0.821, refusal 0.000 → 1.000, context tokens 725 → 566**) — plus a chapter-wise implementation guide (00 → 10) with the full source and block-by-block explanations. **Runs with no API key:** every number in the guide is reproducible offline.

</details>


**🧩 Two codebases ship with this lecture — they answer different questions:**

| Codebase | Language &amp; size | The question it answers | What's inside |
| :--- | :--- | :--- | :--- |
| 🧱 **[Basic Code](./Lecture%2012/code/Basic%20Code/README.md)** | TypeScript · 20 files · ~950 lines · guide **01 → 19** | *What is the smallest code that shows all eight controls — in a real layered structure?* | A conventional layout (`config` · `models` · `utils` · `services` · `controllers` · `routes` · `middleware`), one file per control, a 6-case golden set, a 5-preset ablation, an HTTP API and a chapter CLI sharing one domain layer — offline, no API key. |
| 🏭 **[Advanced RAG](./Lecture%2012/code/advanced-rag/README.md)** | TypeScript · 26 files · ~4,200 lines · guide **00 → 10** | *Which control actually fixes a wrong answer?* | Every stage behind an interface, an ablation matrix that changes one control at a time, calibrated score floors, pre-filtering with fail-closed access rules, and a trace returned with every answer. |
| 🔗 **The Lecture 11 codebases** ([Productions RAG](./Lecture%2011/code/Productions%20RAG/README.md) · [Eassy RAG](./Lecture%2011/code/Eassy%20RAG/src/queryPdf.js)) | TypeScript &amp; JavaScript | *How do you build a grounded answering system at all?* | Lecture 12 assumes that system exists and asks what to change when it is wrong. |

> ⚖️ **Honest limits — documented rather than hidden:** the offline embedder is lexical (hashes, stems and character 4-grams) so it handles morphology but not paraphrase; the reranker is a joint lexical scorer rather than a neural cross-encoder; and the extractive generator quotes sentences without reasoning, which is why `facts` sits at **0.583** while `refusal` is **1.000** — a retrieval-vs-generation distinction the guide's failure tree names explicitly.

**[📂 Notes index](./Lecture%2012/notes/README.md)** · **[📄 Complete document](./Lecture%2012/notes/Lecture_12_Complete_Notes.md)** · **[🧱 Basic code](./Lecture%2012/code/Basic%20Code/README.md)** (guide **01 → 13**) · **[💻 Advanced codebase](./Lecture%2012/code/advanced-rag/README.md)** · **[🛠️ Advanced guide (00 → 10)](./Lecture%2012/code/advanced-rag/implementations%20guide/README.md)**

---


### 🟪 [Lecture 13: Structured Outputs in GenAI — Schema, Enforcement, Validation and Action](./Lecture%2013/notes/README.md)

> **Thesis** — Every GenAI application starts as *prompt → LLM → text*. That is complete for a human and unusable for a program. This lecture builds the bridge: **define the contract, enforce it at the decoder, verify it at the boundary — and never let unverified model output touch the outside world.**

`The integration gap` · `Schema as contract` · `One declaration → type + validator + wire schema` · `Enum the closed sets` · `Required-or-nullify` · `The strict-mode subset` · `Instruction vs guarantee` · `Constrained decoding + logit masking` · `The four-rung enforcement ladder` · `Structural vs semantic validation` · `block vs review severity` · `The strong repair prompt` · `Bounded repair + fallback ladder` · `Degraded objects` · `Typed outcomes` · `Structured output vs tool calling` · `Approval tiers` · `Idempotency keys from semantics` · `Typed domain errors` · `MCP: tools · resources · prompts` · `Discovery is not permission` · `First-pass validity + issue distribution` · `The release gate`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

The engineering discipline of turning a probabilistic model into a deterministic system's collaborator. Notes start with the **integration gap** — humans read meaning, software reads fields — and the board's `MeetingDetails` form, then define structured output properly: *a schema is a form the application writes and the model fills*, and the target is a typed object, never "JSON". A single declaration produces three artefacts (the TypeScript type, the runtime validator and the wire contract), which is what makes a rename break the build instead of production.

Chapter 03 is the pivot: an instruction is a **preference over a token distribution**, not a guarantee, so "return JSON" fails in documented ways — chatty preamble, markdown fence, trailing comma, unbalanced braces, truncation — and every regex added to rescue them is a latent bug. Chapter 04 is schema craft: enum the closed sets, require-or-nullify every field, flatten by default, put units in the name, order the reasoning field first, and treat `description` as the highest-value keyword in the vocabulary — then respect the **strict-mode subset**, because a grammar enforces structure and silently ignores value predicates like `pattern` and `minimum`. Chapter 05 goes inside the decoder: logit masking, grammar compilation and caching, the capability ladder from prompt-only → JSON mode → strict schema, the tool-use workaround where schemas are unsupported, and the honest boundary — *a decoder can make malformed output impossible and says nothing about whether the output is right*.

Chapter 06 is the deliverable: **structural** validation (types, enums, bounds) plus **semantic** validation (is it *true*?), separated into `block` and `review` severities so the system neither over-rejects good data nor under-rejects bad data; a **strong repair prompt** carrying the machine-readable issues, the previous output, a scoping instruction and a format instruction; a bounded loop; and a fallback ladder that ends in a **degraded object** rather than a silent default. Chapter 07 separates the *result* from the *request* — structured output versus tool calling — and places approval tiers on the boundary. Chapter 08 turns data into action: adapters that absorb vendor payload differences, vendor errors mapped to **typed domain errors**, **idempotency keys derived from semantics** so a retry cannot duplicate an action, and MCP as host/client/server with the **tools** (*do*) · **resources** (*know*) · **prompts** (*reuse*) primitives, under the rule that *discovery is not permission*. Chapter 09 is the production playbook: first-pass validity, repair rate, per-field accuracy and the **issue distribution** that turns "the model is unreliable" into "`durationMinutes` is a string 4% of the time" — plus versioning, observability, a release gate and a go-live checklist.

The companion codebase makes the whole ladder measurable in one table. On the same ten golden cases: **first-pass validity is 100% at `schema` and `validate`, and 0% at `instruction` and `json_mode`** — where the bounded repair loop rescues every clean case, at double the call cost. Field accuracy is 100% everywhere, because the *content* was never the problem; the envelope was. The golden set deliberately includes six cases that must **not** return `ok` (a missing time, an injected instruction, an out-of-scope request, an unknown colleague, an out-of-range duration, a policy violation), and the harness asserts each one — including the distinction that separates the fallback rung from a bug: a *missing* duration may be defaulted and flagged, while a *stated* duration that breaches policy must be escalated, never silently changed.

</details>

**🧩 One codebase ships with this lecture — plus the lecture's own three-file demo:**

| Codebase | Language &amp; size | The question it answers | What's inside |
| :--- | :--- | :--- | :--- |
| 🏭 **[Structured Outputs](./Lecture%2013/code/Production%20Code/README.md)** | TypeScript · 18 files · ~4,500 lines | *How does a probabilistic model feed a deterministic system — safely?* | One Zod contract generating the TS type, the JSON Schema and the runtime validator; the strict-mode subset with the unenforceable predicates stripped; a four-rung enforcement ladder with a per-rung prompt; structural + semantic validation with `block`/`review` severities; a bounded repair loop with a `(path, code)`-keyed fallback; an idempotent action pipeline behind a calendar adapter; an **MCP-shaped** capability server with session-scoped identity and tier gating; a 10-case golden set, a metric card and a release gate; a 10-subcommand CLI and an Express API. |
| 🧱 **[The lecture's original demo](./Lecture%2013/code/Production%20Code/DemoApplication.js)** (`npm run demo`) | JavaScript · 3 files | *What does the happy path look like?* | `MeetingDetails.js` (the Zod schema), `MeetingService.js` (one `openai.responses.parse` call with `zodTextFormat`) and `DemoApplication.js` — kept verbatim as the starting point the rest of the codebase argues with. |

> ⚖️ **Honest limits — documented rather than hidden:** the offline model is a **deterministic simulator, not a language model** — it reproduces each rung's *documented* failure modes (chatty preamble, numeric-as-string drift, enum casing drift, extra keys, missing nullable key, truncation) so every chapter reproduces with no API key, and it honours repair instructions by making only the mechanical edits a model legitimately could; the calendar adapter is in-process; and the MCP layer reproduces the **shape** (primitives, tier gating, session-scoped identity) rather than a JSON-RPC transport.

**[📂 Notes index](./Lecture%2013/notes/README.md)** · **[📄 Complete document](./Lecture%2013/notes/Lecture_13_Complete_Notes.md)** · **[🏭 Codebase](./Lecture%2013/code/Production%20Code/README.md)**

---


### 🟪 [Lecture 14: MCP Server from First Principles — Host, Client, Server, Tools, Resources and Prompts](./Lecture%2014/notes/README.md)

> **Thesis** — Tool calling solved *how a model asks for an action*; it never solved *how an application gets access to that action at all*. MCP turns an N × M integration problem into an N + M one — without adding a single new capability to the model. It standardises the doorway, not the intelligence behind it.

`Tool calling recap` · `N × M → N + M` · `A standard provides access, not capability` · `What MCP is` · `An MCP Server needs no LLM` · `Host / Client / Server` · `The 1:1 rule` · `STDIO vs Streamable HTTP` · `Tools (do) · Resources (know) · Prompts (reuse)` · `Tool anatomy + schema craft` · `tools/list → tools/call` · `Protocol error vs tool execution error (isError)` · `Tool annotations` · `Resources vs RAG` · `The control model` · `The eight-step lifecycle` · `Dynamic discovery + caching` · `Discovery is not permission` · `OAuth for remote servers` · `The threat model` · `The build order`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

The lecture starts from something that already works perfectly — a single `getWeather()` tool wired into one application — and shows where it breaks: at the **second consumer**, and arithmetically by the sixth. The same five capabilities wanted by six AI applications become repeated, drifting, independently-secured integrations: N × M (5 apps × 10 systems = 50) instead of N + M (15) with a standard. Chapter 01 sets the two rules that follow — depend on the protocol rather than the vendor, and adopt the standard that already has a precedent (HTTP, USB, ODBC).

Chapter 02 defines MCP as a standard protocol through which AI applications connect to external tools and data, and pins down what an **MCP Server** is: a capability provider that needs **no LLM** — ordinary business logic behind a standard interface. It also answers *"why not just use REST?"* and separates an MCP server from a microservice. Chapter 03 places MCP beside tool calling as **complementary layers**: tool calling answers *which capability, with what arguments?*, MCP answers *where do those tools come from, and how are they accessed?* — with the handoff point, the structured-output connection from Lecture 13, the four possible combinations and a responsibility matrix. Chapter 04 introduces the three roles and the **1:1 rule** (one client speaks to exactly one server), then isolation, transports and the lifecycle.

Chapters 05–06 are the primitives. **Tools** (*do*): anatomy, `tools/list` discovery, `tools/call` invocation, what a tool returns, the **two error mechanisms** (a protocol error versus a tool-execution error carrying `isError: true`), annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`), the tool-definition rules, and security duties. **Resources** (*know*) and **Prompts** (*reuse*): addressable context by URI, Tool vs Resource, Resources vs RAG, prompt templates with arguments, and the control model — the model drives tools, the application drives resources, the user drives prompts.

Chapter 07 is the machine: the eight-step lifecycle, discovery as a curated act, selection as the fragile step, the host doing the routing, the result becoming context, dynamic discovery, whether `tools/list` runs on every message, the context-budget problem, and a five-step diagnostic order. Chapter 08 is the boundary: the governing sentence (*MCP standardizes communication; it does not remove your responsibility for security*), the threat model, **discovery is not permission**, OAuth for remote servers, the two-application demo architecture, production concerns and the build order.

</details>


**🧩 Two codebases ship with this lecture — they answer different questions:**

| Codebase | Language &amp; size | The question it answers | What's inside |
| :--- | :--- | :--- | :--- |
| 🧱 **[Basic Code](./Lecture%2014/code/Basic%20Code/README.md)** | TypeScript · 8 files · ~376 lines · guide **01 → 09** | *How do you build an MCP server at all?* | One server exposing all three primitives plus the Host/Client over **STDIO**; `tools/list` → `tools/call` → `resources/read` → `prompts/get`; `isError` messages written as recovery instructions; an honest custom `company://` scheme; an inspector command and a raw JSON-RPC probe. |
| 🏭 **[Production Code](./Lecture%2014/code/Production%20Code/README.md)** | TypeScript · 16 files · ~1,849 lines · guide **01 → 17** | *What does Chapter 08 make non-optional?* | The same three primitives with validated config, structured stderr logging + redaction, metrics, a four-code error taxonomy, rate limits, timeouts, idempotency keys, **resource templates**, and a host that enforces **trust tiers, consent and tool filtering** with a hashed-argument **audit trail** — plus a raw-JSON-RPC probe and a Streamable-HTTP swap. |

> ⚖️ **Honest limits — documented rather than hidden:** the host stands in for the LLM deterministically so the whole lifecycle is reproducible with **no API key**; the high-level SDK advertises `resources.subscribe` **without a handler** (`Method not found`), which the guide records rather than fakes; dynamic discovery and subscriptions need the low-level `Server`; and the task store and audit trail are in-process, sitting behind interfaces a real deployment would replace.

**[📂 Notes index](./Lecture%2014/notes/README.md)** · **[📄 Complete document](./Lecture%2014/notes/Lecture_14_Complete_Notes.md)** · **[🧱 Basic Code](./Lecture%2014/code/Basic%20Code/README.md)** · **[🏭 Production Code](./Lecture%2014/code/Production%20Code/README.md)** · **[🛠️ Basic guide (01 → 09)](./Lecture%2014/code/Basic%20Code/implementations%20guide/README.md)** · **[🛠️ Production guide (01 → 17)](./Lecture%2014/code/Production%20Code/implementations%20guide/README.md)**

---
### 🟦 [Lecture 15: MCP Server — Resources and Prompts](./Lecture%2015/notes/README.md)

> **Thesis** — Lecture 14 built an MCP server from first principles and used exactly one primitive: the **Tool**. This lecture opens the other two thirds. **Tools do, Resources know, Prompts reuse** — and the sentence that tells them apart is not about the bytes but about **who holds the trigger**: *the model drives tools, the application drives resources, the user drives prompts.* The proof is one request — `GET /plan?hours=4` — in which all three primitives fire, owned by three different parties, and a Tool and a Resource return **byte-identical payloads** because they share one renderer.

`Tools do · Resources know · Prompts reuse` · `The control model` · `Why Resources exist at all` · `Agency + addressability` · `Resources vs RAG` · `Discovery is not consumption` · `resources/list → resources/read` · `Resource anatomy` · `Static · dynamic · templated` · `Segment-exact template matching` · `The renderer↔descriptor invariant` · `How the application chooses (5 strategies)` · `Filter before ranking` · `Every choice carries its reason` · `The three-stage context budget` · `MCP Prompt ≠ LLM Response` · `prompts/list → prompts/get` · `Advertised arguments` · `Prompt hygiene` · `The same bytes, two owners` · `Authorise before the read` · `Hashed arguments, no content` · `A capability flag is a promise`

<details>
<summary><b>🔎 Full breakdown</b></summary>

<br>

The lecture begins where Lecture 14 stopped. That server exposed one primitive — the **Tool** — and the Tool was enough to prove the protocol. But a Tool is the *narrowest* of the three: it answers only questions the **model** thought to ask. Chapter 01 sets out the control model that separates the primitives, and the separation is not cosmetic. A Tool runs because a model decided to call it; a Resource is read because the **application** decided it was relevant; a Prompt is chosen because the **user** picked a workflow. Three primitives, three owners, and *"the prompt is a nudge, not a command"* — a prompt may name a capability, but the model still decides whether to use it.

Chapter 02 asks the question the whole lecture rests on: if a Tool can already return data, why is there a second primitive for information? The answer is **agency plus addressability**. A Tool result arrives because a model asked, so the application cannot put it in context *before* the conversation; a Resource has a **URI**, so it can be referenced, scoped, cached and authorised ahead of time. The chapter then separates Resources from **RAG** — curated, addressable context versus similarity-retrieved chunks — and states the security rule that follows: *do not let Resources become a prompt-injection channel*, because content that lands in a system message acquires system-level authority.

Chapter 03 covers the two verbs, and its organising idea is **discovery is not consumption**. `resources/list` returns metadata; `resources/read` returns content; a client that pays for content to answer *"what exists?"* has already lost. The chapter gives the anatomy of a well-formed Resource — `uri`, `name`, `title`, `description`, `mimeType` — explains why `description` is a **user-facing** field (a checkbox labelled `task://guidelines` is unusable; one labelled *"Task management guidelines"* is not), and names the asymmetry that runs through the whole lecture: **a failed read is a JSON-RPC protocol error, while a failed tool call is an `isError` result.**


Chapter 04 is the build. Three shapes through one verb: **static** (a constant document), **dynamic** (rendered from live state) and **templated** (a URI pattern with variables, so thousands of addresses need one definition). It shows how a template is declared, bound and matched — including why matching must be **segment-exact**, so `task://tasks/{id}` cannot swallow `task://tasks/1/notes` — and lands on the invariant that makes a catalogue trustworthy: **every advertised URI has a renderer.**

Chapter 05 is the chapter MCP deliberately does not answer for you. *"MCP does not prescribe how a host selects a Resource"* — so the selection code is the application's own, and the chapter gives five strategies: **attached** (the user said so), **state** (the session's scope), **rule** (a pattern in the message), **retrieval** (similarity against metadata) and **LLM** (a router call). Two rules govern them: selection must **filter before ranking**, so a router is never shown a Resource it may not surface; and every choice must carry its **reason**, so the decision is auditable. The chapter closes with the three-stage context budget — cap the count, cap each body, cap the total — and the requirement that a truncation be *stated*.

Chapters 06–07 cover Prompts, and Chapter 06 delivers the lecture's sharpest distinction: **`MCP Prompt ≠ LLM Response`**. `prompts/get` returns **messages** — a template with arguments substituted — and the model call happens afterwards, elsewhere. That is not a technicality: a caller who confuses the two builds a UI that thinks it has an answer when it only has a question. Chapter 07 makes a prompt's **advertised arguments** the source of truth for both the client's form and the server's validator, covers required versus optional arguments, and explains why the server validating its own contract beats the host duplicating it — *two validators for one contract is two things to keep in sync.*

Chapter 08 is the whole machine in one request. `GET /plan?hours=4` runs three primitives with three owners: the **user** controls the Prompt (`prompts/get plan_day { availableHours: 4 }`), the **application** controls the Resource (select → authorise → read → budget) and the **model** controls the Tool. The demonstration is a strict string comparison — `list_tasks` (a Tool) and `task://backlog` (a Resource) return **the same bytes**, because they share one renderer, and *the difference is who decided to fetch them, not what came back.* The chapter closes on the production checklist: authorise before ranking, budget with a stated marker, hash arguments and never record content, and treat a capability flag as a promise — if the server does not implement it, do not advertise it.

</details>


**🧩 Two codebases ship with this lecture — they answer different questions:**

| Codebase | Language | Guide | The question it answers | What it contains |
| :--- | :--- | :--- | :--- | :--- |
| 🧱 **[Basic Code](./Lecture%2015/code/Basic%20Code/README.md)** | TypeScript · 10 files · ~937 lines | **01 → 09** | *How do you add the two primitives Lecture 14 left out?* | The same task-management server, now exposing **Resources** (*know*) and **Prompts** (*reuse*) alongside the **Tool** (*do*): `resources/list` → `resources/read` → `prompts/list` → `prompts/get`, static + dynamic + templated resources with an honest `task://` / `user://` scheme, an application-side **selection** step, and `GET /plan?hours=4` as one route in which three primitives fire with three owners. |
| 🏭 **[Production Code](./Lecture%2015/code/Production%20Code/README.md)** | TypeScript · 33 files · ~6,454 lines | **01 → 26** | *What does production make non-optional once Resources and Prompts exist?* | A **layered host** (`controllers/` · `middleware/` · `routes/`) over an MCP server: a resource **catalogue** with segment-exact template compilation, a **renderer↔descriptor invariant** asserted at boot, a **TTL cache** with `static`/`live`/`cache` provenance, **five selection strategies** ranked with reasons, a **three-stage context budget** that marks what it cut, a **resource ACL and prompt allowlist** enforced before the read, tool **trust tiers** with a consent seam, and an audit trail that hashes arguments and never records content. |

> ⚖️ **Honest limits — documented rather than hidden:** the host runs **offline** (`askModel` echoes the assembled prompt when no key is set, so the whole pipeline is reproducible and inspectable without one); state is **in-process** behind interfaces a real deployment would replace; the session is read from **headers** (`x-actor`, `x-projects`, `x-admin`) as a stated substitution for a real authentication scheme; the **scheme allowlist is defence in depth** the SDK's URI router pre-empts, so it never runs in practice; the **consent gate is wired but never triggered** by the walkthrough (no step calls a `confirm`-tier tool); and the route-level 404 returns a **different body shape** from the error handler. The guide records all six rather than implying otherwise — and four of them were found by *running* the code.

**[📂 Notes index](./Lecture%2015/notes/README.md)** · **[📄 Complete document](./Lecture%2015/notes/Lecture_15_Complete_Notes.md)** · **[🧱 Basic Code](./Lecture%2015/code/Basic%20Code/README.md)** · **[🏭 Production Code](./Lecture%2015/code/Production%20Code/README.md)** · **[🛠️ Basic guide (01 → 09)](./Lecture%2015/code/Basic%20Code/implementations%20guide/README.md)** · **[🛠️ Production guide (01 → 26)](./Lecture%2015/code/Production%20Code/implementations%20guide/README.md)**

---



## 🧰 Technology Stack

| Layer | What the curriculum uses |
| :--- | :--- |
| **Languages** | ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black) ![SQL](https://img.shields.io/badge/SQL-4479A1?style=flat-square&logo=postgresql&logoColor=white) |
| **Runtime &amp; server** | ![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white) ![Express](https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white) ![SSE](https://img.shields.io/badge/SSE%20%2F%20NDJSON%20%2F%20chunked-FF6F00?style=flat-square) |
| **Validation &amp; typing** | ![Zod](https://img.shields.io/badge/Zod-3E67B1?style=flat-square&logo=zod&logoColor=white) ![tsx](https://img.shields.io/badge/tsx-2D3748?style=flat-square) |
| **Model providers** | ![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=flat-square&logo=openai&logoColor=white) ![Spring AI](https://img.shields.io/badge/Spring%20AI-6DB33F?style=flat-square&logo=spring&logoColor=white) |
| **Vector stores** | ![Qdrant](https://img.shields.io/badge/Qdrant-DC244C?style=flat-square&logo=qdrant&logoColor=white) ![Pinecone](https://img.shields.io/badge/Pinecone-000000?style=flat-square) ![pgvector](https://img.shields.io/badge/pgvector-4169E1?style=flat-square&logo=postgresql&logoColor=white) |
| **Infrastructure** | ![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white) ![Mermaid](https://img.shields.io/badge/Mermaid-FF3670?style=flat-square&logo=mermaid&logoColor=white) ![Markdown](https://img.shields.io/badge/Markdown-000000?style=flat-square&logo=markdown&logoColor=white) |

---


## 🚀 Quick Start

### 1 · Reading the notes (no setup required)

```text
1. Open  index.md                      → full chapter-level roadmap
2. Open  Lecture NN/notes/README.md    → chapter index for that lecture
3. Open  Lecture NN/notes/NN_*.md      → one chapter at a time
   ...or Lecture NN/notes/Lecture_NN_Complete_Notes.md for the single-document version
```

Every note set also ships the original **`Notes.pdf`** slides and an **`Excalidraw-Notes.svg`** diagram file in the same folder.

### 2 · Running the code

Each codebase is self-contained with its own `package.json`. Pick a lecture folder and install:

```bash
# Lecture 12 — Advanced RAG · Basic Code (smallest runnable version, NO API key)
cd "Lecture 12/code/Basic Code"
npm install
npm run dev          # HTTP API on :3100 — /health /search /ask /eval /ablation /filters
npm run chunks       # Chapters 06–07: fixed vs structural chunking + the overlap maths
npm run ask          # Chapters 09–12: the full pipeline, ending in an answer + citations
npm run filters      # Chapter 08: eligibility, ACL and `asOf`
npm run ablation     # Chapter 14: one control at a time (12 → 19 chunks, ctx 327 → 214 tokens)
```

```bash
# Lecture 12 — Advanced RAG (runs with NO API key)
cd "Lecture 12/code/advanced-rag"
npm install
npm run baseline     # naive pipeline: 8 of 14 golden cases fail, each with a named stage
npm run ablation     # one control at a time: recall 0.571 → 0.821
npm run ask -- "Is the AX-204 still covered after 18 months?"
npm run dev          # HTTP API on :3100
```

```bash
# Lecture 13 — Structured Outputs (runs with NO API key)
cd "Lecture 13/code/Production Code"
npm install
npm run naive        # "Sure! Here's the JSON you requested:" — and JSON.parse throws
npm run layers       # the same sentence through all four enforcement rungs
npm run extract      # the full reliability loop, with a per-attempt trace
npm run eval         # 1st-pass validity: 100% at schema/validate, 0% at instruction/json_mode
npm run dev          # HTTP API on :3200
```

```bash
# Lecture 11 — Productions RAG (set OPENAI_API_KEY for live embeddings)
cd "Lecture 11/code/Productions RAG"
npm install
npm run ingest && npm run ask && npm run eval
```

```bash
# Lecture 11 — Eassy RAG (smallest honest pipeline, needs Qdrant + OpenAI key)
cd "Lecture 11/code/Eassy RAG"
npm install
npm run index        # PDF → chunks → embeddings → Qdrant
npm run query        # question → retrieval → grounded answer with [Source n]
```

> 🔑 **Keys are optional where it matters.** The Lecture 12 codebase and the Eassy RAG guide are built so their numbers reproduce offline; set `OPENAI_API_KEY` (and optionally `COHERE_API_KEY`) to swap in real embeddings and a real cross-encoder without changing a line of logic.

### 3 · Following an implementation guide

Each codebase ships an `implementations guide/` folder that walks the same source **chapter by chapter**: file details → complete source → block-by-block explanation → commands and verification output.

---

## 🗂️ Repository Structure

```text
Forward-Deployed-Engineer/
├── README.MD                       # ← you are here
├── index.md                        # Master roadmap: every lecture + per-chapter topic tables
├── prompt.md                       # Note-generation brief used across lectures
│
├── Lecture 01/ … Lecture 15/       # 15 lectures
│   ├── notes/
│   │   ├── README.md               # Chapter index for the lecture
│   │   ├── Notes.pdf               # Original source slides
│   │   ├── Excalidraw-Notes.svg    # Hand-drawn diagram source
│   │   ├── 01_*.md … NN_*.md       # Chapter-by-chapter notes
│   │   └── Lecture_NN_Complete_Notes.md   # Single consolidated document
│   └── code/                       # Present for lectures 03 · 04 · 05 · 06 · 08 · 10 · 11 · 12 · 13 · 14 · 15
│       ├── README.md               # What the codebase does + how to run it
│       ├── src/ · package.json · tsconfig.json
│       └── implementations guide/  # Chapter-wise build guide (full source, block by block)
│
└── (Lecture 11 ships two codebases — Productions RAG and Eassy RAG; Lecture 13 ships
    the structured-outputs implementation; Lecture 14 ships Basic Code and Production Code;
    Lecture 15 ships Basic Code and Production Code)
```

---

## 📐 Conventions

Every artefact in this repository follows the same four-part contract, so you can jump between lectures without relearning the layout:

| # | Convention | What it means |
| :---: | :--- | :--- |
| 1 | **Notes are chapter-wise** | 6–10 chapter files per lecture, each answering one question, numbered in reading order. |
| 2 | **A consolidated document always exists** | `Lecture_NN_Complete_Notes.md` condenses the chapters and links back to them — it is not a blind concatenation. |
| 3 | **Guides are block-by-block** | Each implementation guide states the file's details, prints the **complete** source (never an excerpt), then explains every block and the command that proves it. |
| 4 | **Claims are measured** | Retrieval, refusal, citation and latency numbers in the notes come from a runnable golden set, and honest limits are written down rather than hidden. |

---


## 🗺️ Roadmap

| Status | Item |
| :---: | :--- |
| ✅ | Lectures **01 → 15** published with chapter-wise notes and consolidated documents |
| ✅ | Codebases for lectures **03 · 04 · 05 · 06 · 08 · 10 · 11 · 12 · 13 · 14 · 15**, with implementation guides for **03 · 04 · 05 · 06 · 08 · 10 · 11 · 12 · 14 · 15** |
| ✅ | Master roadmap maintained in [`index.md`](./index.md) |
| 🔜 | Additional chapters where the source slides are thinner than the engineering reality |
| 🔜 | More evaluation golden sets so every quantitative claim stays reproducible |

> 🟢 The repository is under **active development** — new lecture material lands as the curriculum progresses.

---

## 🤝 Contributing

1. **Read the conventions** in [`prompt.md`](./prompt.md) and the [Conventions](#-conventions) table above.
2. **Keep the four-part contract:** chapter-wise notes → consolidated document → runnable code → block-by-block implementation guide.
3. **Update the indexes:** if you add a lecture or a codebase, update [`index.md`](./index.md) **and** this README's [Curriculum Navigation](#-curriculum-navigation) table.
4. **Prove your numbers:** any metric you quote (recall, refusal, latency, token counts) should be reproducible from a command in the codebase.
5. **Encode links correctly:** paths contain spaces, so use `%20` (e.g. `./Lecture%2012/code/implementations%20guide/README.md`).

Pull requests that improve depth, fix a wrong claim, or add a missing failure mode are especially welcome. 🎉

---

## 📄 License &amp; Attribution

This repository is an **educational curriculum**. Lecture content, notes and diagrams are derived from the referenced source materials and papers — notably *"Attention Is All You Need"* (Vaswani et al., 2017) — which remain the property of their respective authors. Code samples are provided for learning and reference; verify against your own security, licensing and compliance requirements before production use.

---

<div align="center">

### ⭐ If this curriculum helps you, star the repository — it makes the next lecture easier to find.

**[📑 Master Index](./index.md)** · **[📖 Curriculum Navigation](#-curriculum-navigation)** · **[🚀 Quick Start](#-quick-start)**

*Built for Forward Deployed Engineers who measure what they ship.*

</div>

