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
- 📂 **[Lecture 03 Index & Notes](./Lecture%2003/notes/README.md)** | 📄 **[Complete Document](./Lecture%2003/notes/Lecture_03_Complete_Notes.md)** | 💻 **[Codebase](./Lecture%2003/code/README.md)**

---

## 📖 Lecture Highlights

### [Lecture 01: Introduction to FDE & Generative AI Foundations](./Lecture%2001/notes/README.md)
E-commerce case study (50k daily queries), Problem vs Solution discovery, Symbolic AI & Expert Systems, Machine Learning paradigm shifts, Statistical N-grams, RNN hidden state decay, Transformer Attention mechanism, and Enterprise Production AI Stack topology.

### [Lecture 02: How LLMs Work (From Tokens to Transformers)](./Lecture%2002/notes/README.md)
Autoregressive next-token prediction, Subword tokenization (BPE/WordPiece), Dense Vector Embeddings $\mathbb{R}^{d_{\text{model}}}$, Positional Encodings, Scaled Dot-Product Self-Attention ($Q, K, V$), Transformer multi-block state propagation, Logits projection head, Softmax, Temperature scaling, and autoregressive streaming.

### [Lecture 03: Talking to an LLM from Your Application](./Lecture%2003/notes/README.md)
ChatGPT vs Raw LLM (Car vs Engine analogy), Deterministic tools (Calculator, DB, Weather), Knowledge cutoff limits, The 4 Invariant Request Components (Where, Who, Which Model, What), Token economics (Prefill vs Decode, cost & latency), Node.js + Express + TypeScript microservice setup, Zod validation, OpenAI client singletons, response telemetry audit, and prompt injection defense via multi-role architecture.
