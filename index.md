# Forward Deployed Engineer (FDE)

Welcome to the **Forward Deployed Engineer (FDE) & Generative AI Systems** repository. This repository contains lecture notes, system architectures, mathematical foundations, and code implementations for building production-grade enterprise AI applications.

---

## 📚 Curriculum & Lecture Navigation

### [Lecture 01: Introduction to Forward Deployed Engineering & Generative AI Foundations](./Lecture%2001/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 01/notes/Notes.pdf`](./Lecture%2001/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 01/notes/Excalidraw-Notes.svg`](./Lecture%2001/notes/Excalidraw-Notes.svg)
- **Master Notes Document:**
  - 👉 **[Lecture 01 Complete Consolidated Notes](./Lecture%2001/notes/Lecture_01_Complete_Notes.md)**

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2001/notes/01_Introduction_to_Forward_Deployed_Engineering.md)** | **Introduction to Forward Deployed Engineering (FDE)** | E-commerce Case Study (50k daily support queries), Customer Solution vs True Requirement, Iterative Attempts (Rules $\rightarrow$ ML Classifier $\rightarrow$ Naïve LLM), Grounded Enterprise AI System Architecture, FDE Operational Role & Discovery Workflow. |
| **[Chapter 02](./Lecture%2001/notes/02_Foundations_of_Artificial_Intelligence_and_Rule_Based_Systems.md)** | **Foundations of AI & Rule-Based Systems** | Turing Test (1950), Coining of AI (McCarthy, 1956), Deterministic Computing vs Cognitive Tasks, AI Hierarchy, Symbolic AI & Expert Systems (Fact Base + Rule Base + Inference Engine), ELIZA chatbot (1966) & the Illusion of Understanding, Combinatorial Explosion of Handwritten Rules. |
| **[Chapter 03](./Lecture%2001/notes/03_Machine_Learning_and_Deep_Learning_Foundations.md)** | **Machine Learning & Deep Learning Foundations** | ML Paradigm Shift ($Y = f(X; \Theta)$), Supervised vs Unsupervised Learning, Training vs Inference, Prompting vs Training, Feature Engineering Bottleneck ($z = \sum w_i x_i$), Deep Learning Representation Learning, CNNs vs RNNs vs Transformers. |
| **[Chapter 04](./Lecture%2001/notes/04_Language_Modeling_Statistical_N_Grams_and_RNNs.md)** | **Language Modeling, Statistical N-Grams & RNNs** | Linguistic Challenges (Polysemy, Word Order, Negations, Coreference, Sarcasm), Frequency Counting Language Models ($P(\text{machine} \mid \text{like}) = 2/3$), N-Gram Context Windows, Sparsity Problem, Recurrent Neural Networks (RNNs) & Hidden State Propagation, Information Bottleneck & Long-Range Dependency Decay. |
| **[Chapter 05](./Lecture%2001/notes/05_Attention_Mechanism_Transformers_and_LLMs.md)** | **Attention Mechanism, Transformers & Modern LLMs** | Paper Deep-Dive: *"Attention Is All You Need"* (Vaswani et al., 2017), Scaled Dot-Product Attention ($\text{softmax}(\frac{QK^T}{\sqrt{d_k}})V$), Multi-Head Attention ($h$ heads), Sinusoidal Positional Encodings, Original Encoder-Decoder Architecture, $O(1)$ Path Length vs RNNs, Decoder-Only GPT. |
| **[Chapter 06](./Lecture%2001/notes/06_Production_Systems_and_Key_Takeaways.md)** | **Production Systems Architecture & Key Takeaways** | Complete Historical Evolution Timeline, Evolutionary Matrix, Enterprise Production AI Stack Topology, Mandatory Criteria for Production Systems (Grounded, Observable, Secure, Actionable), Mindmap of Takeaways, 20 Fundamental Key Takeaways. |

---

### [Lecture 02: How Large Language Models Work (From Tokens to Transformers)](./Lecture%2002/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 02/notes/Notes.pdf`](./Lecture%2002/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 02/notes/Excalidraw-Notes.svg`](./Lecture%2002/notes/Excalidraw-Notes.svg)
- **Master Notes Document:**
  - 👉 **[Lecture 02 Complete Consolidated Notes](./Lecture%2002/notes/Lecture_02_Complete_Notes.md)**

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2002/notes/01_Foundations_of_LLMs_and_Next_Token_Prediction.md)** | **Foundations of LLMs & Next-Token Prediction** | Core operational paradigm, prompt context expansion (Coffee prompt evolution), next-token probability distribution (Capital of India prompt), iterative autoregressive append-and-predict loop, words vs tokens distinction. |
| **[Chapter 02](./Lecture%2002/notes/02_Tokenization_Subwords_and_Numerical_Representations.md)** | **Tokenization, Subwords & Numerical Representations** | Why text must become numbers (matrix operations), Token ID $\neq$ Semantic Meaning (Roll numbers analogy), debunking token myths, trade-offs of tokenization granularities (word-level vs char-level vs subword BPE/SentencePiece), full text-to-ID pipeline. |
| **[Chapter 03](./Lecture%2002/notes/03_Positional_Encodings_and_Vector_Embeddings.md)** | **Positional Encodings & Vector Embeddings** | Word order & permutation invariance problem ("Dog bites man" vs "Man bites dog"), context & polysemy ("bank"), dense vector embeddings $\mathbb{R}^{d_{\text{model}}}$, conceptual feature dimension table (King, Queen, Banana, Laptop), learned vs hand-crafted dimensions, combining embeddings & positional encodings. |
| **[Chapter 04](./Lecture%2002/notes/04_Self_Attention_Mechanism_and_QKV_Architecture.md)** | **Self-Attention Mechanism & QKV Architecture** | Why embeddings alone are not enough, dynamic reference resolution ("tired" vs "wide"), Query, Key, and Value (QKV) search engine analogy, scaled dot-product attention mathematical derivation $\text{softmax}(\frac{QK^T}{\sqrt{d_k}})V$, grounded e-commerce query urgency calculation ($Z = w_1 x_1 + w_2 x_2 + w_3 x_3$). |
| **[Chapter 05](./Lecture%2002/notes/05_Transformer_Blocks_Deep_Layers_and_Logits.md)** | **Transformer Blocks, Deep Layers & Logits** | Clarifying Transformer $\neq$ Attention alone, sequential multi-block architecture, hierarchical layer abstraction (photo editing analogy), state vector propagation across layers, LM Projection Head, raw Logits vector definition. |
| **[Chapter 06](./Lecture%2002/notes/06_Softmax_Decoding_Strategies_and_Temperature.md)** | **Softmax, Decoding Strategies & Temperature** | Softmax probability transformation formula, separation of Model Inference vs Decoding Strategy, Greedy Decoding vs Random/Weighted Sampling (lottery ticket analogy), Temperature scaling mechanics ($z/T$), numerical traces for $T=0.5, 1.0, 2.0$, autoregressive UI token streaming. |
| **[Chapter 07](./Lecture%2002/notes/07_Complete_LLM_Pipeline_and_Key_Takeaways.md)** | **Complete LLM Pipeline & Key Takeaways** | End-to-end master LLM generation architecture diagram, stage-by-stage component summary matrix, conceptual mindmap of Lecture 02, 20 fundamental engineering takeaways. |

---

### [Lecture 03: Talking to an LLM from Your Application](./Lecture%2003/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 03/notes/Notes.pdf`](./Lecture%2003/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 03/notes/Excalidraw-Notes.svg`](./Lecture%2003/notes/Excalidraw-Notes.svg)
- **Master Notes Document:**
  - 👉 **[Lecture 03 Complete Consolidated Notes](./Lecture%2003/notes/Lecture_03_Complete_Notes.md)**
- **Hands-on Production Codebase:**
  - 💻 **[Lecture 03 Code Repository (Node.js + Express + TypeScript)](./Lecture%2003/code/README.md)**

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2003/notes/01_GenAI_Applications_vs_Raw_LLMs_and_The_Engine_Analogy.md)** | **GenAI Applications vs. Raw LLMs & The Engine Analogy** | ChatGPT vs. Raw LLM, Car vs. Engine architectural analogy, tool-augmented systems (Weather in Delhi), probabilistic tokens vs. deterministic computation ($8{,}745{,}873 \times 5{,}608{,}241$ math hallucination failure), LLM as translation bridge, knowledge cut-off limits (2024 vs. 2026), Cardinal Rule: *"The LLM only knows what reaches the LLM."* |
| **[Chapter 02](./Lecture%2003/notes/02_LLM_API_Architecture_and_The_Postman_Protocol.md)** | **LLM API Architecture & The Postman Protocol** | Demystifying AI networking as standard HTTP POST client-server interactions, the 4 Invariant Request Components (Where, Who, Which Model, What to Process), enterprise FDE case study (Payment-service 502 container restart loops), Postman validation workflow (Endpoint, Bearer Auth, JSON payload), end-to-end request-response network lifecycle. |
| **[Chapter 03](./Lecture%2003/notes/03_Token_Economics_Metadata_and_Production_Engineering.md)** | **Token Economics, Metadata & Production Engineering** | Anatomy of the LLM API JSON response (Generated Content vs. Operational Metadata), Input (Prefill/Parallel) vs. Output (Decode/Sequential) token streams, the 4 Production Engineering Pillars of Tokens (Financial Cost modeling, Latency TTFT vs. ITL, Context Window limits & KV Cache, Rate limits RPM/TPM), 10-page Incident Report token ledger. |
| **[Chapter 04](./Lecture%2003/notes/04_Node_Express_JS_TS_Environment_and_Architecture.md)** | **Node.js & Express Architecture and JS/TS Environment Setup** | Moving from Postman to automated Node.js microservices, the JS/TS AI ecosystem (OpenAI Node SDK `openai`, Vercel AI SDK, LangChain.js), initializing TypeScript Express projects (`package.json`, `tsconfig.json`, `tsx`), enterprise secret management via `.env` and `process.env.OPENAI_API_KEY`, declarative configuration module with Zod schema validation (`src/config/env.ts`), Postman-to-Node.js transition state matrix. |
| **[Chapter 05](./Lecture%2003/notes/05_Building_the_Production_Support_Ticket_Summarizer.md)** | **Building the Production Support Ticket Summarizer** | Modular 3-tier Express microservice architecture, OpenAI client singleton with connection pooling (`src/lib/openai.ts`), deconstructing SDK parameters (`model`, `messages`, `temperature`), strongly-typed `SummarizerService`, Express REST routing (`POST /api/summarize`) with Zod schema validation, global error handling middleware, complete step-by-step end-to-end call stack execution trace. |
| **[Chapter 06](./Lecture%2003/notes/06_Framework_Abstractions_Response_Metadata_and_Prompt_Hygiene.md)** | **Framework Abstractions, Response Metadata & Prompt Hygiene** | Why AI SDKs over raw `fetch`/`axios` (zero vendor lock-in, native async streaming, Zod structured outputs, conversation memory, tool calling, OpenTelemetry), extracting rich response metadata in TypeScript (`usage.prompt_tokens`, `finish_reason`), the architectural vulnerability of string concatenation (`prompt = "Summarize: " + ticket`), prompt injection and goal hijacking attack vectors, multi-role prompt architecture (`system` vs. `user` vs. `assistant`). |
| **[Chapter 07](./Lecture%2003/notes/07_Complete_Application_Pipeline_and_Key_Takeaways.md)** | **Complete Application Pipeline & Key Takeaways** | Master End-to-End Enterprise GenAI Application Topology diagram (Node.js + Express + TypeScript), 3-tier comparative synthesis matrix (Postman vs. Raw `fetch` vs. Node.js & Express AI SDKs), comprehensive conceptual mindmap of Lecture 03, 20 essential Forward Deployed Engineering principles. |

---

## 🏗 Repository Structure

```text
Forward-Deployed-Engineer/
├── index.md                  # Main Repository Index & Navigation (This File)
├── README.MD                 # Project Readme & Overview
├── .gitignore                # Workspace Git Ignore Rules
├── Lecture 01/
│   ├── code/                 # Lecture 01 Hands-on Code
│   └── notes/                # Lecture 01 Notes & Visual Artifacts
│       ├── README.md         # Lecture 01 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Excalidraw-Notes.svg # Architectural & Conceptual Diagrams
│       └── Lecture_01_Complete_Notes.md # Consolidated Master Document
├── Lecture 02/
│   ├── code/                 # Lecture 02 Hands-on Code
│   └── notes/                # Lecture 02 Notes & Visual Artifacts
│       ├── README.md         # Lecture 02 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Excalidraw-Notes.svg # Architectural & Conceptual Diagrams
│       └── Lecture_02_Complete_Notes.md # Consolidated Master Document
└── Lecture 03/
    ├── code/                 # Lecture 03 Production Microservice Codebase
    │   ├── package.json      # Dependencies (Express, OpenAI SDK, Zod, tsx)
    │   ├── tsconfig.json     # TypeScript Configuration (ES2022/NodeNext)
    │   ├── .env.example      # Environment Configuration Template
    │   ├── test-requests.http# REST Client / Postman Request Collection
    │   ├── README.md         # Codebase Architecture & Running Instructions
    │   └── src/
    │       ├── app.ts        # Express Application & Middleware
    │       ├── server.ts     # Server Bootstrap & Port Listener
    │       ├── config/       # Boot-time Zod Environment Validation
    │       ├── lib/          # OpenAI Client Singleton & Connection Pooling
    │       ├── services/     # Summarizer, Audited, and Secure Services
    │       ├── routes/       # Health & Summarizer REST Endpoints
    │       └── scripts/      # Standalone Prototype & Security Injection Tests
    └── notes/                # Lecture 03 Notes & Visual Artifacts
        ├── README.md         # Lecture 03 Index & Navigation
        ├── Notes.pdf         # Original Slide Presentation
        ├── Excalidraw-Notes.svg # Handwritten & Architectural Diagrams
        ├── Lecture_03_Complete_Notes.md # Consolidated Master Document
        └── [01 - 07 Chapters].md # Individual Modular Chapters
```

---

## 🎯 Key Engineering Takeaways Overview

1. **Proposed Solution vs. True Requirement:** A client request like *"Build a chatbot"* is a proposed solution. FDEs discover the underlying business requirement (*"Reduce resolution time safely"*).
2. **LLMs Are Reasoning Engines, Not Applications:** An LLM alone cannot run business transactions or verify facts; production systems require RAG knowledge retrieval, business APIs, RBAC authorization, guardrails, and human oversight.
3. **The Attention Paradigm Shift:** Attention connects any two tokens across a sequence in $O(1)$ matrix operations, eliminating the sequential context bottleneck of RNNs.
4. **The Cardinal Law of GenAI Engineering:** *The LLM only knows what reaches the LLM.* If session history, database rows, live weather, or current timestamps are not serialized into the prompt context window, the model cannot access them.
5. **Decouple Authority via Role Separation:** Never concatenate application instructions with untrusted user strings. Enforce strict multi-role architectures (`system` vs. `user`) to neutralize prompt injection and goal hijacking attacks.
