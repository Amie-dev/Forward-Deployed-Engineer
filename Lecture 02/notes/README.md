# Lecture 02 Notes: How Large Language Models Work (From Tokens to Transformers)

Welcome to the structured notes for **Lecture 02: How Large Language Models Work (From Tokens to Transformers)**. These notes synthesize the material from [`Notes.pdf`](./Notes.pdf) and handwritten architectural diagrams from [`Excalidraw-Notes.svg`](./Excalidraw-Notes.svg).

---

## 📚 Chapter Navigation Index

| Chapter | Title & Description | Key Concepts & Diagrams |
| :--- | :--- | :--- |
| **[Chapter 01](./01_Foundations_of_LLMs_and_Next_Token_Prediction.md)** | **Foundations of LLMs & Next-Token Prediction** | Core operational paradigm, prompt context expansion (Coffee prompt evolution), next-token probability distribution (Capital of India prompt), iterative autoregressive append-and-predict loop, words vs tokens distinction. |
| **[Chapter 02](./02_Tokenization_Subwords_and_Numerical_Representations.md)** | **Tokenization, Subwords & Numerical Representations** | Why text must become numbers (matrix operations), Token ID $\neq$ Semantic Meaning (Roll numbers analogy), debunking token myths, trade-offs of tokenization granularities (word-level vs char-level vs subword BPE/SentencePiece), full text-to-ID pipeline. |
| **[Chapter 03](./03_Positional_Encodings_and_Vector_Embeddings.md)** | **Positional Encodings & Vector Embeddings** | Word order & permutation invariance problem ("Dog bites man" vs "Man bites dog"), context & polysemy ("bank"), dense vector embeddings $\mathbb{R}^{d_{\text{model}}}$, conceptual feature dimension table (King, Queen, Banana, Laptop), learned vs hand-crafted dimensions, combining embeddings & positional encodings. |
| **[Chapter 04](./04_Self_Attention_Mechanism_and_QKV_Architecture.md)** | **Self-Attention Mechanism & QKV Architecture** | Why embeddings alone are not enough, dynamic reference resolution ("tired" vs "wide"), Query, Key, and Value (QKV) search engine analogy, scaled dot-product attention mathematical derivation $\text{softmax}(\frac{QK^T}{\sqrt{d_k}})V$, grounded e-commerce query urgency calculation ($Z = w_1 x_1 + w_2 x_2 + w_3 x_3$). |
| **[Chapter 05](./05_Transformer_Blocks_Deep_Layers_and_Logits.md)** | **Transformer Blocks, Deep Layers & Logits** | Clarifying Transformer $\neq$ Attention alone, sequential multi-block architecture, hierarchical layer abstraction (photo editing analogy), state vector propagation across layers, LM Projection Head, raw Logits vector definition. |
| **[Chapter 06](./06_Softmax_Decoding_Strategies_and_Temperature.md)** | **Softmax, Decoding Strategies & Temperature** | Softmax probability transformation formula, separation of Model Inference vs Decoding Strategy, Greedy Decoding vs Random/Weighted Sampling (lottery ticket analogy), Temperature scaling mechanics ($z/T$), numerical traces for $T=0.5, 1.0, 2.0$, autoregressive UI token streaming. |
| **[Chapter 07](./07_Complete_LLM_Pipeline_and_Key_Takeaways.md)** | **Complete LLM Pipeline & Key Takeaways** | End-to-end master LLM generation architecture diagram, stage-by-stage component summary matrix, conceptual mindmap of Lecture 02, 20 fundamental engineering takeaways. |

---

## 📄 Complete Master Document

For a single consolidated document containing all chapters, read:
👉 **[Lecture 02 Complete Consolidated Notes](./Lecture_02_Complete_Notes.md)**

---

## 🛠 Features of these Notes
- **Mermaid Diagrams:** Fully formatted Mermaid diagrams visualizing workflows, architectures, state progressions, QKV self-attention matrices, and temperature scaling distributions.
- **Enterprise Perspective:** Focuses on practical Forward Deployed Engineering (FDE) principles, LLM system trade-offs, and production system considerations.
- **Mathematical Foundations:** Includes KaTeX mathematical formulations for scaled dot-product attention, positional vector addition, softmax activation, and temperature logit adjustment.
- **Integrated Source Material:** Integrates both formal PDF lecture slides (`Notes.pdf`) and Excalidraw handwritten diagrams (`Excalidraw-Notes.svg`).
