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

## 🏗 Repository Structure

```text
Forward-Deployed-Engineer/
├── index.md                  # Main Repository Index & Navigation (This File)
├── REDME.MD                  # Project Readme
├── Lecture 01/
│   ├── code/                 # Lecture 01 Hands-on Code & Implementations
│   └── notes/                # Lecture 01 Notes & Visual Artifacts
│       ├── README.md         # Lecture 01 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Excalidraw-Notes.svg # Architectural & Conceptual Diagrams
│       └── Lecture_01_Complete_Notes.md # Consolidated Master Document
└── Lecture 02/
    └── notes/                # Lecture 02 Notes & Visual Artifacts
        ├── README.md         # Lecture 02 Index & Navigation
        ├── Notes.pdf         # Original Slide Presentation
        ├── Excalidraw-Notes.svg # Architectural & Conceptual Diagrams
        └── Lecture_02_Complete_Notes.md # Consolidated Master Document
```

---

## 🎯 Key Engineering Takeaways Overview

1. **Proposed Solution vs. True Requirement:** A client request like *"Build a chatbot"* is a proposed solution. FDEs discover the underlying business requirement (*"Reduce resolution time safely"*).
2. **LLMs Are Reasoning Engines, Not Applications:** An LLM alone cannot run business transactions or verify facts; production systems require RAG knowledge retrieval, business APIs, RBAC authorization, guardrails, and human oversight.
3. **The Attention Paradigm Shift:** Attention connects any two tokens across a sequence in $O(1)$ matrix operations, enabling massive GPU training parallelization and eliminating the sequential context bottleneck of RNNs.
