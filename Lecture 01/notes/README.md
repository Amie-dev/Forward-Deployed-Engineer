# Lecture 01 Notes: Introduction to Forward Deployed Engineering & Generative AI Foundations

Welcome to the structured notes for **Lecture 01: Introduction to Forward Deployed Engineering & Generative AI Foundations**. These notes synthesize the material from [`Notes.pdf`](./Notes.pdf) and handwritten architectural diagrams from [`Excalidraw-Notes.svg`](./Excalidraw-Notes.svg).

---

## 📚 Chapter Navigation Index

| Chapter | Title & Description | Key Concepts & Diagrams |
| :--- | :--- | :--- |
| **[Chapter 01](./01_Introduction_to_Forward_Deployed_Engineering.md)** | **Introduction to Forward Deployed Engineering (FDE)** | E-commerce Case Study (50k daily support queries), Business Problem vs Proposed Solution, Iterative Attempts (Rules $\rightarrow$ ML Classifier $\rightarrow$ Naïve LLM), Grounded AI System Architecture, FDE Operational Role & Discovery Workflow. |
| **[Chapter 02](./02_Foundations_of_Artificial_Intelligence_and_Rule_Based_Systems.md)** | **Foundations of AI & Rule-Based Systems** | Turing Test (1950), Coining of AI (McCarthy, 1956), Deterministic Computing vs Cognitive Tasks, AI Taxonomy Hierarchy, Symbolic AI & Expert Systems (Fact Base + Rule Base + Inference Engine), ELIZA chatbot (1966) & the Illusion of Understanding, Combinatorial Explosion of Handwritten Rules. |
| **[Chapter 03](./03_Machine_Learning_and_Deep_Learning_Foundations.md)** | **Machine Learning & Deep Learning Foundations** | ML Paradigm Shift ($Y = f(X; \Theta)$), Supervised vs Unsupervised Learning, Training vs Inference, Prompting vs Training, Feature Engineering Bottleneck ($z = \sum w_i x_i$), Deep Learning Representation Learning, CNNs vs RNNs vs Transformers. |
| **[Chapter 04](./04_Language_Modeling_Statistical_N_Grams_and_RNNs.md)** | **Language Modeling, Statistical N-Grams & RNNs** | Linguistic Challenges (Polysemy, Word Order, Negations, Coreference, Sarcasm), Frequency Counting Language Models ($P(\text{machine} \mid \text{like}) = 2/3$), N-Gram Context Windows, Sparsity Problem, Recurrent Neural Networks (RNNs) & Hidden State Propagation, Information Bottleneck & Long-Range Dependency Decay. |
| **[Chapter 05](./05_Attention_Mechanism_Transformers_and_LLMs.md)** | **Attention Mechanism, Transformers & Modern LLMs** | "Attention Is All You Need" (Vaswani et al., 2017), Scaled Dot-Product Attention ($\text{softmax}(\frac{QK^T}{\sqrt{d_k}})V$), Multi-Head Attention ($h$ heads), Sinusoidal Positional Encodings, Encoder-Decoder Architecture, $O(1)$ Path Length vs RNNs, Decoder-Only GPT. |
| **[Chapter 06](./06_Production_Systems_and_Key_Takeaways.md)** | **Production Systems Architecture & Key Takeaways** | Full Historical Evolution Timeline, Evolutionary Matrix, Enterprise Production AI Stack Topology, Mandatory Criteria for Production Systems, Mindmap of Takeaways, 20 Fundamental Key Takeaways. |

---

## 📄 Complete Master Document

For a single consolidated document containing all chapters, read:
👉 **[Lecture 01 Complete Consolidated Notes](./Lecture_01_Complete_Notes.md)**

---

## 🛠 Features of these Notes
- **Mermaid Diagrams:** Fully formatted Mermaid diagrams visualizing workflows, architectures, and state progressions.
- **Enterprise Perspective:** Focuses on practical Forward Deployed Engineering (FDE) principles and production system design.
- **Mathematical Foundations:** Includes KaTeX mathematical formulations for models, synthetic neurons, language model probability distributions, and N-gram calculations.
- **Integrated Source Material:** Integrates both formal PDF lecture slides and Excalidraw handwritten diagrams.
