# Forward Deployed Engineer (FDE)

Welcome to the **Forward Deployed Engineer (FDE) & Generative AI Systems** repository. This repository contains lecture notes, system architectures, mathematical foundations, and code implementations for building production-grade enterprise AI applications.

---

## 📚 Curriculum & Lecture Navigation

## [Lecture 01: Introduction to Forward Deployed Engineering & Generative AI Foundations](./Lecture%2001/notes/README.md)

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

## [Lecture 02: How Large Language Models Work (From Tokens to Transformers)](./Lecture%2002/notes/README.md)

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

## [Lecture 03: Talking to an LLM from Your Application](./Lecture%2003/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 03/notes/Notes.pdf`](./Lecture%2003/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 03/notes/Excalidraw-Notes.svg`](./Lecture%2003/notes/Excalidraw-Notes.svg)
- **Master Notes Document:**
  - 👉 **[Lecture 03 Complete Consolidated Notes](./Lecture%2003/notes/Lecture_03_Complete_Notes.md)**
- **Hands-on Production Codebase:**
  - 💻 **[Lecture 03 Code Repository (Node.js + Express + TypeScript)](./Lecture%2003/code/README.md)**
  - 🛠️ **[Step-by-Step Implementation Guide](./Lecture%2003/code/implementations%20guide/README.md)** (Block-by-Block Code Tutorial)

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

## [Lecture 04: Building a Chatbot: Context, Memory, Streaming & Hallucinations](./Lecture%2004/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 04/notes/Notes.pdf`](./Lecture%2004/notes/Notes.pdf)
- **Master Notes Document:**
  - 👉 **[Lecture 04 Complete Consolidated Notes](./Lecture%2004/notes/Lecture_04_Complete_Notes.md)**
- **Hands-on Production Codebase:**
  - 💻 **[Lecture 04 Code Repository (Node.js + Express + TypeScript)](./Lecture%2004/code/README.md)**
  - 🛠️ **[Step-by-Step Implementation Guide](./Lecture%2004/code/implementations%20guide/README.md)** (Block-by-Block Code Tutorial)

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2004/notes/01_Stateless_LLMs_Conversation_History_and_Role_Architecture.md)** | **Stateless LLMs, Conversation History & Role Architecture** | Statelessness of HTTP LLM endpoints, the illusion of conversational continuity, coreference and pronoun binding failure, message roles (`system`, `user`, `assistant`), prompt contamination anti-patterns, the 4 Pillars of system prompts (`ROLE`, `TASK`, `BEHAVIOUR`, `CONSTRAINTS`), why prompts are not security barriers, TypeScript session state engine. |
| **[Chapter 02](./Lecture%2004/notes/02_Context_Windows_Token_Accumulation_and_Context_Management.md)** | **Context Windows, Token Accumulation & Context Management** | Context window capacity constraint ($L_{\text{total}} = L_{\text{input}} + L_{\text{output}} \le C_{\text{max}}$), composite prompt structure, quadratic token accumulation problem ($O(N^2)$ bloat), numerical token ledger and cost analysis, the fallacy of "send everything", U-shaped "Lost-in-the-Middle" phenomenon, context strategies in TypeScript (Sliding Window, Pinned Anchor, Rolling Summarization, Semantic History RAG). |
| **[Chapter 03](./Lecture%2004/notes/03_Context_vs_Model_Weights_and_The_Illusion_of_Learning.md)** | **Context vs. Model Weights & The Illusion of Learning** | Illusion of memory, Parametric Knowledge ($\Theta$) vs In-Context Working Memory ($X_{\text{prompt}}$), mathematical formulation ($P(w_t \mid w_{<t}, \text{Context})$), "Same Question, Different Context" (Docker beginner vs principal engineer), training loop (backprop, loss, weight updates) vs inference pass (static frozen weights, zero gradients), in-context activation vs parameter learning, Application Memory vs Fine-Tuning trade-off matrix. |
| **[Chapter 04](./Lecture%2004/notes/04_Real_Time_Streaming_Architecture_and_SSE_Protocols.md)** | **Real-Time Streaming Architecture & SSE Protocols** | Autoregressive token generation mechanics, latency decomposition (TTFT vs ITL vs Total), blocking request-response bottlenecks, Server-Sent Events (SSE) and chunked transfer encoding (`Transfer-Encoding: chunked`), production Express streaming endpoint in TypeScript, OpenAI SDK `stream: true` async iterables, client-side `fetch` stream consumption, `AbortSignal` disconnect handling. |
| **[Chapter 05](./Lecture%2004/notes/05_Hallucination_Mechanisms_Fluency_vs_Truth_and_Vulnerabilities.md)** | **Hallucination Mechanisms, Fluency vs. Truth & Vulnerabilities** | Cross-entropy loss and statistical plausibility vs empirical truth, the Fluency Heuristic cognitive trap, why hallucinations sound confident (lack of metacognition), Coherent Fabrication vs Obvious Nonsense (Gosling IBM Project Oak case study, 2038 Cricket World Cup), 5 catalysts of hallucination, the Aditya Tandon sorting law experiment, model sycophancy. |
| **[Chapter 06](./Lecture%2004/notes/06_Engineering_Defenses_RAG_Guardrails_and_Verification.md)** | **Engineering Defenses: RAG, Guardrails & Verification** | Why system prompts alone cannot guarantee truth or security, 7-layer defense-in-depth architecture, hybrid RAG grounding, deterministic tools and APIs, calibrated refusal engineering ("I don't know"), type-safe structured outputs via Zod and OpenAI JSON Schema mode, programmatic post-generation citation verification guardrail. |
| **[Chapter 07](./Lecture%2004/notes/07_Complete_Enterprise_Chatbot_Architecture_and_Takeaways.md)** | **Complete Enterprise Chatbot Architecture & Key Takeaways** | Master End-to-End Enterprise Chatbot Topology diagram, FDE mental model: LLM as an unprivileged stateless kernel, Naïve Prototype vs Enterprise Production Chatbot comparison matrix, comprehensive conceptual mindmap, 25 Cardinal Engineering Principles for production conversational AI. |

---

## [Lecture 05: Autonomous AI Agents, Tool Calling & Human-in-the-Loop Architecture](./Lecture%2005/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 05/notes/Notes.pdf`](./Lecture%2005/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 05/notes/Excalidraw-Notes.svg`](./Lecture%2005/notes/Excalidraw-Notes.svg)
- **Master Notes Document:**
  - 👉 **[Lecture 05 Complete Consolidated Notes](./Lecture%2005/notes/Lecture_05_Complete_Notes.md)**
- **Hands-on Production Codebase:**
  - 💻 **[Lecture 05 Code Repository (Node.js + Express + TypeScript)](./Lecture%2005/code/README.md)**
  - 🛠️ **[Step-by-Step Implementation Guide](./Lecture%2005/code/implementations%20guide/README.md)** (Block-by-Block Code Tutorial)

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2005/notes/01_From_Token_Prediction_to_Tool_Augmentation.md)** | **From Token Prediction to Tool Augmentation** | Fundamental limits of autoregressive token prediction ($P(w_t \mid w_{<t})$), generating action strings vs. performing actions, the "Hands vs. Brain" mental model (the genius trapped in a room), linguistic impedance mismatch, LLMs as universal semantic decoders, why naïve "Return JSON" prompting fails in production (markdown fences, schema drift, hallucinated keys). |
| **[Chapter 02](./Lecture%2005/notes/02_The_Tool_Calling_Protocol_and_Wire_Architecture.md)** | **The Tool Calling Protocol & Wire Architecture** | Deconstructing tools: ordinary functions + JSON Schema contracts, OpenAPI/JSON Schema wire format (`name`, `description`, `parameters`, `required`), the 5-step wire protocol lifecycle (`user` ➔ `assistant` with `tool_calls` ➔ runtime execution ➔ `tool` message ➔ final response), TypeScript schemas with Zod, building deterministic tools (Safe Calculator) and live telemetry tools (Weather, Currency Exchange), multi-tool routing and `tool_choice` policies. |
| **[Chapter 03](./Lecture%2005/notes/03_Multi_Step_Tool_Chaining_and_Execution_Loops.md)** | **Multi-Step Tool Chaining & Execution Loops** | Multi-tool sequential dependencies (Currency ➔ Calculator) and parallel dispatches (Weather + Currency), the ReAct framework (Reasoning + Acting: Thought ➔ Action ➔ Observation), two functional families: Informative Tools vs. Action Tools, building the autonomous TypeScript execution engine, recursion guards, maximum turn limits, and runaway loop prevention, self-correction of runtime tool exceptions, token ledger accumulation across iterations. |
| **[Chapter 04](./Lecture%2005/notes/04_First_Principles_of_AI_Agents_and_Agency_Spectrum.md)** | **First Principles of AI Agents & The Agency Spectrum** | The 4 Levels of Agency, the First-Principles 6-Component Agent Model (Goal, Decision Maker, Actions, Environment, Observations, Decision Loop), Agent vs. Workflow architectural comparison (Deterministic Graph/DAG vs. Dynamic Emergence; What+How vs. What+Self-Directed How), hybrid workflows (Agent inside DAG), general-purpose emergence: BrewLab Coffee Shop vs. NeuralForge AI Robotics with zero code changes. |
| **[Chapter 05](./Lecture%2005/notes/05_Workspace_Sandboxing_and_Agent_Security.md)** | **Workspace Sandboxing & Agent Security** | Principle of Least Privilege: Tool = Capability + Permission, why unrestricted shell tools (`exec`, `bash`) are fatal in production, threat modeling: path traversal (`../../etc/passwd`), privilege escalation, data wiping, and indirect prompt injection, building `WorkspaceTools` in TypeScript, rigorous path normalization and boundary containment (`safePath`), containerization vs. chroot vs. in-process sandbox layers. |
| **[Chapter 06](./Lecture%2005/notes/06_Building_an_Autonomous_Website_Builder_Agent.md)** | **Building an Autonomous Website Builder Agent** | Complete end-to-end case study: The Website Builder Agent, job description and system prompt engineering ("Don't describe the action. Perform it!"), four core workspace tools (`createDirectory`, `writeFile`, `readFile`, `listFiles`), end-to-end TypeScript orchestrator, trace execution of BrewLab coffee landing page, the environmental feedback loop: reading back generated files, verifying DOM structure, and iterative self-repair. |
| **[Chapter 07](./Lecture%2005/notes/07_Human_In_The_Loop_Safety_and_Enterprise_Patterns.md)** | **Human-in-the-Loop Safety & Enterprise Patterns** | High-impact actions and catastrophic risk (financial transfers, data deletion, customer emails), Human-in-the-Loop (HITL) approval gates, tool authorization classifications (Tier 1 Read-only Auto, Tier 2 Scoped Mutate, Tier 3 Critical Approval Required), synchronous vs. asynchronous durable pause/resume state machines, Naïve Chatbot vs. Enterprise Autonomous Agent comparison matrix, 25 Cardinal Engineering Principles for Production AI Agents. |

---

## [Lecture 06: AI Streaming — From LLM Tokens to a Live Chat Experience](./Lecture%2006/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 06/notes/Notes.pdf`](./Lecture%2006/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 06/notes/Excalidraw-Notes.svg`](./Lecture%2006/notes/Excalidraw-Notes.svg)
- **Master Notes Document:**
  - 👉 **[Lecture 06 Complete Consolidated Notes](./Lecture%2006/notes/Lecture_06_Complete_Notes.md)**
- **Hands-on Production Codebase:**
  - 💻 **[Lecture 06 Streaming Microservice + Browser Client (Node.js + Express + TypeScript)](./Lecture%2006/code/README.md)**
  - 🛠️ **[Step-by-Step Implementation Guide](./Lecture%2006/code/implementations%20guide/README.md)** (00 → 16 chapters, block-by-block code tutorial)

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2006/notes/01_How_LLMs_Generate_Text.md)** | **How an LLM Generates Text — Autoregressive Decoding** | Tokenization and BPE boundaries, logits and softmax, temperature / top-k / top-p sampling, the per-token decoding loop, **prefill vs. decode** phases, compute-bound vs. memory-bandwidth-bound inference, **KV cache** growth and its latency/cost tax, and why streaming is the same loop with `yield` instead of `append`. |
| **[Chapter 02](./Lecture%2006/notes/02_Generation_vs_Delivery_Non_Streaming_and_Streaming_Responses.md)** | **Generation vs. Delivery — Non-Streaming and Streaming Responses** | The two independent processes (generation vs. delivery), the buffered response lifecycle and its hidden costs, the streaming lifecycle and progressive assembly, wire-level comparison (`message` vs. `delta` frames, `[DONE]`), the endpoint decision framework, and the delivery-path taxonomy (buffered JSON, raw chunked text, SSE, WebSockets, polling, webhooks). |
| **[Chapter 03](./Lecture%2006/notes/03_Latency_Anatomy_TTFT_ITL_and_Perceived_Performance.md)** | **Latency Anatomy — TTFT, ITL & Perceived Performance** | **Time-to-first-token vs. total generation time**, the full latency decomposition (`network + queue + prefill + N×ITL + tail`), TPS and TPOT, human reading speed as the throughput threshold, **input processing precedes output** (prompt engineering becomes latency engineering), formal latency budgets and TTFT SLAs, per-hop instrumentation. |
| **[Chapter 04](./Lecture%2006/notes/04_Token_Chunk_Network_and_Byte_Granularity.md)** | **Token, Provider Chunk, Network Chunk & Byte — Four Layers of Granularity** | The four-layer granularity model, token coalescing into deltas, transport re-framing by TCP, proxies, compression and HTTP/2, **UTF-8 multi-byte splits** and the `TextDecoder({stream:true})` discipline, the boundary-agnostic client contract, the **fragmentation torture test**, and `charsPerChunk` as a diagnostic metric. |
| **[Chapter 05](./Lecture%2006/notes/05_HTTP_Streaming_Mechanics_Chunked_Encoding_SSE_and_WebSockets.md)** | **HTTP Streaming Mechanics — Chunked Encoding, SSE & WebSockets** | Conventional vs. progressive HTTP, `Transfer-Encoding: chunked` and the absence of `Content-Length`, the exact **SSE grammar** (`data`/`event`/`id`/`retry`, `\n\n` framing, heartbeats) and mandatory headers, the SSE vs. WebSockets decision matrix, raw `text/plain` vs. `text/event-stream`, infrastructure kill-switches (proxy buffering, compression, idle timeouts) and the `curl -N` debugging heuristic. |
| **[Chapter 06](./Lecture%2006/notes/06_End_to_End_Streaming_Architecture_and_Pipeline_Invariants.md)** | **The Complete End-to-End Streaming Architecture** | **Two streams that must both stay streamed**, the full pipeline from click to rendered DOM, the **7 pipeline invariants**, backpressure and flow-control reality (stalls, not overflows), cancellation propagation and orphaned-generation economics, and the final end-to-end mental model. |
| **[Chapter 07](./Lecture%2006/notes/07_Backend_Streaming_Call_vs_Stream_and_Flux.md)** | **Backend Streaming — `.call()` vs. `.stream()` and the `Flux` Abstraction** | Why the *return type* (`String` → `Flux<String>`) is the architecture rather than the method name, box vs. conveyor belt, the cross-language translation table (`Flux`/`Flow`/`AsyncIterable`/`ReadableStream`/`IAsyncEnumerable`), the four operators that matter (`doOnNext`/`doOnComplete`/`doOnError`/`doFinally`), **in-band error protocols**, and multi-user isolation with per-conversation locks. |
| **[Chapter 08](./Lecture%2006/notes/08_Conversation_History_Buffering_and_Persistence.md)** | **Conversation History, Buffering & Persistence in Streaming Systems** | Why transport chunks must never become messages, the **dual-write pattern** (stream out, buffer in), prompt bloat from one-message-per-chunk, interrupted turns (`status: "interrupted"`), idempotent persistence with a stable `messageId`, token accounting, context budgets, and the three storage layers (hot buffer, conversation store, analytics ledger). |
| **[Chapter 09](./Lecture%2006/notes/09_Frontend_Streaming_Fetch_ReadableStream_TextDecoder.md)** | **Frontend Streaming — `fetch`, `ReadableStream` & `TextDecoder`** | What `await fetch()` actually waits for (headers, not the body), `response.body.getReader()` and `{value, done}`, one `TextDecoder` with `{stream:true}` plus the final flush, the one-growing-bubble contract, lazy bubble creation, `AbortController` cancellation, sticky auto-scroll, sanitised incremental markdown, `requestAnimationFrame` rendering, accessibility (`aria-live`), and 12 client-side pitfalls. |
| **[Chapter 10](./Lecture%2006/notes/10_Production_Hardening_Observability_and_Takeaways.md)** | **Production Hardening, Observability & Key Takeaways** | The consolidated granularity model, the production hardening checklist (proxies, compression, timeouts, heartbeats, headers, cancellation, rate limits, payload limits, failover), the streaming-specific metrics (server/client TTFT, **TTFT gap**, ITL, chunk sizes, in-band error rate, abort rate), the testing strategy (fragmentation, chaos, canaries), the 15-row anti-pattern catalogue, and 28 consolidated takeaways. |

---

## [Lecture 07: Vector Embeddings — From First Principles](./Lecture%2007/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 07/notes/Notes.pdf`](./Lecture%2007/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 07/notes/Excalidraw-Notes.svg`](./Lecture%2007/notes/Excalidraw-Notes.svg)
- **Complete Consolidated Notes:** [`Lecture_07_Complete_Notes.md`](./Lecture%2007/notes/Lecture_07_Complete_Notes.md) — all 7 chapters merged, with formula sheet, glossary, misconceptions, self-check questions, and the Lecture 08/09 bridge

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2007/notes/01_The_Problem_of_Meaning_in_Computers.md)** | **The Problem of Meaning in Computers** | Symbol vs. meaning gap (Batman example), identity matching vs. semantic similarity (`"I forgot my password"` ≡ `"How can I recover my login credentials?"`), why mathematical operations require numbers, why randomly assigned numbers carry no relational information. |
| **[Chapter 02](./Lecture%2007/notes/02_From_Numbers_to_Vectors.md)** | **From Numbers to Vectors** | One-number representations and their limitations (Titanic vs. Hera Pheri both score `2`), adding comedy as a second dimension, 2D vector space visualization, why order within a vector matters (`[9,2]` ≠ `[2,9]`), dimensions defined, vector spaces and continuous similarity (`0.92` vs. `true/false`). |
| **[Chapter 03](./Lecture%2007/notes/03_Measuring_Similarity_Between_Vectors.md)** | **Measuring Similarity Between Vectors** | Euclidean distance (straight-line gap, formula, User A vs. User B scale problem), Dot Product (direction + magnitude, `A·B = |A||B|cos θ`), Cosine Similarity (angle only, scale-invariant, range `−1 → +1`), comparison table, pseudo-code for all three, when to prefer each metric. |
| **[Chapter 04](./Lecture%2007/notes/04_The_Failure_of_Hand_Crafted_Features.md)** | **The Failure of Hand-Crafted Features** | Feature engineering definition & ML history timeline, Problem 1 — dimensionality explosion (Interstellar has 1000s of valid features), Problem 2 — features are task-specific (recommendation vs. box-office vs. parental-controls need different dimensions), Problem 3 — natural language ambiguity (`bank`, `apple`, `java`, `king/queen`), context changes meaning, the scaling impossibility. |
| **[Chapter 05](./Lecture%2007/notes/05_What_Are_Embeddings_Learning_Representations.md)** | **What Are Embeddings? Learning Representations** | Formal definition `f: input → ℝᵈ`, meaning-through-context (Firth's *"You shall know a word by the company it keeps"*), toy training objective (predict nearby words), the embedding lookup table (king/queen/dog/cat/banana/apple), the gradient-descent training cycle (random → useful vectors), king−man+woman≈queen vector arithmetic, latent features vs. human-readable dimensions. |
| **[Chapter 06](./Lecture%2007/notes/06_Vector_vs_Embedding_And_Applications.md)** | **Vector vs. Embedding & Applications** | Critical distinction (every embedding is a vector; not every vector is an embedding), feature vector vs. learned embedding, embedding model as a function `f(input) → ℝᵈ`, multi-modal shared spaces (CLIP text+image), full application taxonomy (semantic search, nearest-neighbor, clustering, classification, ranking, recommendation, RAG), embedding model reference table (ada-002, BERT, CLIP, Word2Vec). |
| **[Chapter 07](./Lecture%2007/notes/07_The_Complete_Journey_Synthesis.md)** | **The Complete Journey — Synthesis** | End-to-end progression (real-world object → manual vector → does not scale → training objective → learned embedding), the definitive final definition, complete semantic-search worked example (support ticket system with pseudo-code + sequence diagram), feature engineering vs. embeddings comparison matrix, why geometry encodes semantics. |

---

## [Lecture 08: Vector Embeddings Project — Building a Movie Recommendation System](./Lecture%2008/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 08/notes/Notes.pdf`](./Lecture%2008/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 08/notes/Excalidraw-Notes.svg`](./Lecture%2008/notes/Excalidraw-Notes.svg)
- **Hands-on Production Codebase:**
  - 💻 **[Lecture 08 Movie Recommendation Engine (Node.js + Express + TypeScript)](./Lecture%2008/code/README.md)**
  - 🛠️ **[Step-by-Step Implementation Guide](./Lecture%2008/code/implementations%20guide/README.md)** (00 → 08 chapters, block-by-block code tutorial)
- **Complete Consolidated Notes:** [`Lecture_08_Complete_Notes.md`](./Lecture%2008/notes/Lecture_08_Complete_Notes.md) — all 7 chapters synthesised, with cheat sheet, glossary, misconceptions, self-check, failure modes, and the Lecture 09 bridge

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2008/notes/01_Embeddings_and_The_Problem_of_Meaning.md)** | **Embeddings and the Problem of Meaning** | The symbol-vs-meaning gap, why mathematics requires numbers, text → fixed-size vector representation, why individual dimensions have no human-readable labels, how semantic closeness becomes geometric closeness, and the distinction between an embedding model and a generative LLM. |
| **[Chapter 02](./Lecture%2008/notes/02_Why_Not_Just_Use_an_LLM.md)** | **Why Not Just Use an LLM?** | The naive “send the whole catalog to the LLM” approach, context-window ceilings, repeated and wasted inference work, why ranking does not require text generation, cost and latency comparison, matching the tool to the problem, and the hybrid pattern: embeddings for retrieval + LLM for explanation (RAG). |
| **[Chapter 03](./Lecture%2008/notes/03_Precomputation_The_Key_Engineering_Insight.md)** | **Precomputation — The Key Engineering Insight** | Stable data vs. changing data, the two-phase offline/online architecture, “compute once, query many times,” batch-embedding the catalog at startup vs. embedding each query on demand, estimated API-call savings at scale, storage choices (in-memory, `pgvector`, Pinecone, Qdrant), and when vectors must be recomputed. |
| **[Chapter 04](./Lecture%2008/notes/04_Semantic_Search_and_Movie_Recommendation.md)** | **Semantic Search and Movie Recommendation** | Why keyword search misses semantically equivalent queries, the complete semantic-search flow (query → embed → compare → sort), the similar-movie flow using a precomputed vector, the shared engine with two different starting vectors, content-based vs. collaborative filtering, and what production recommenders add on top. |
| **[Chapter 05](./Lecture%2008/notes/05_Cosine_Similarity_Measuring_Closeness.md)** | **Cosine Similarity — Measuring Closeness** | Euclidean distance and its magnitude sensitivity for text, dot product and vector direction, the cosine formula `(A · B) / (‖A‖ × ‖B‖)`, score range `−1 → +1`, zero-vector and dimension-mismatch guards, single-pass implementation, `O(N × D)` scoring complexity, and why direction beats distance for embeddings. |
| **[Chapter 06](./Lecture%2008/notes/06_Core_Mental_Model_REPRESENT_STORE_COMPARE_RANK.md)** | **Core Mental Model: REPRESENT → STORE → COMPARE → RANK** | The four universal operations behind every embedding system: convert meaning to numbers, persist the vectors, measure closeness, and sort by score. What to represent (movie descriptions vs. user queries), precomputed storage, cosine comparison, top-N ranking, and how the same pattern powers semantic search, recommendation, and RAG. |
| **[Chapter 07](./Lecture%2008/notes/07_Complete_System_Design_and_Applications.md)** | **Complete System Design and Applications** | The full movie-platform data model, Phase 1 catalog construction, Phase 2 request serving, end-to-end architecture, the optional LLM explanation layer (the bridge to RAG), applications beyond movies (support, e-commerce, recruiting, code, healthcare), and production next steps: vector databases, ANN indexes (HNSW/IVF), and hybrid search. |

---

## [Lecture 09: Vector Embedding Search & Storage](./Lecture%2009/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 09/notes/Notes.pdf`](./Lecture%2009/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 09/notes/Excalidraw-Notes.svg`](./Lecture%2009/notes/Excalidraw-Notes.svg)
- **Complete Consolidated Notes:** [`Lecture_09_Complete_Notes.md`](./Lecture%2009/notes/Lecture_09_Complete_Notes.md) — all 8 chapters synthesised, with capacity maths, index-selection and failure tables, cheat sheet, glossary, and self-check

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2009/notes/01_The_Scale_Wall_Why_Toy_Vector_Search_Breaks.md)** | **The Scale Wall — Why Toy Vector Search Breaks** | The 30-movie Lecture 08 loop, what changes when `N` reaches 10K → 100M → 1B, storage vs search as two separate problems, the three hidden costs (comparison count, per-comparison work, bytes read), the `O(N × D)` preview, 10M × 1536 = 15.36 billion dimension operations, and the transition from exact search to approximate retrieval. |
| **[Chapter 02](./Lecture%2009/notes/02_Why_Relational_Databases_Are_Not_Enough.md)** | **Why a Relational Database Is Not Enough** | The myth that relational databases cannot store vectors (JSON/JSONB, `bytea`, native `vector(D)`), exact/ordered SQL predicates vs graded similarity, the Netflix/Interstellar example, why a B-tree needs a total order, hybrid metadata filters, the cost of `SELECT`-then-score in application code, and when PostgreSQL + `pgvector` is genuinely sufficient. |
| **[Chapter 03](./Lecture%2009/notes/03_Anatomy_of_a_Vector_Database.md)** | **Anatomy of a Vector Database** | The minimum record (ID + vector + metadata), production fields (document, tenant, model id/version, timestamps), embedding model vs vector database, collections with fixed dimensions/metric/index, the write path (chunk → embed → upsert → index), the read path (embed → candidates → filter → rescore → rerank), pre/post/filtered-ANN strategies, hybrid search and RRF, and the essential `VectorStore` interface in TypeScript-style pseudo-code. |
| **[Chapter 04](./Lecture%2009/notes/04_Brute_Force_KNN_The_Correct_Baseline.md)** | **Brute Force and KNN — The Correct Baseline** | KNN definition and how to choose `K`, cosine vs dot vs L2 vs L1, normalization as a constant-factor optimization, the real cost of one comparison at 1536 dimensions, top-K with a bounded heap (`O(N log K)`), memory/disk bandwidth as the true bottleneck, storage math (6 KB per vector, 6 GB per million, 60 GB per 10M, 600 GB per 100M), exact nearest-neighbor guarantees, and when brute force is the right production choice. |
| **[Chapter 05](./Lecture%2009/notes/05_Indexes_and_Why_Scalar_Indexes_Fail_for_Vectors.md)** | **Indexes and Why Scalar Indexes Fail for Vectors** | Why B-trees work (total order, selectivity, provable pruning), scanning vs indexed lookup, one-dimensional number-line search, the loss of order in 2D (`A = [2,8]`, `B = [5,3]`), k-d tree construction on `A–F`, the full `Q = [7,6]` search trace, the five-step branch-and-bound pruning rule (`planeDist < bestDist`), when pruning works, when it fails near a boundary, and complexity (`O(log N)` average, `O(N)` worst). |
| **[Chapter 06](./Lecture%2009/notes/06_The_Curse_of_Dimensionality.md)** | **The Curse of Dimensionality** | The precise meaning (gradual degradation, not a cliff), boundary proliferation with `(1 − p)^D`, high-dimensional volume concentration (ball vs cube), distance concentration and why pruning margins vanish, trees inspecting 70–100% of the dataset, why real embeddings are clustered but still fatal to k-d trees, Matryoshka/dimension reduction, quantization, and the pivot from "prove irrelevance" to "measure recall". |
| **[Chapter 07](./Lecture%2009/notes/07_Approximate_Nearest_Neighbor_Indexes.md)** | **Approximate Nearest Neighbor Indexes** | The recall/latency/memory/build/freshness bargain, IVF (`nlist`, `nprobe`, inverted lists, k-means training), HNSW (multi-layer graph, `M`, `efConstruction`, `efSearch`, greedy descent, best-first layer-0 search), product quantization (subvectors, codebooks, ADC, 32× compression), float16/int8/binary quantization, LSH bands and rows with collision probability, DiskANN/ScaNN/FAISS, full comparison table, two-stage retrieval with exact rescoring, tuning playbook, and common mistakes. |
| **[Chapter 08](./Lecture%2009/notes/08_Production_Vector_Search_Design.md)** | **Production Vector Search Design** | The reference architecture (source of truth → CDC/queue → embed → index → retrieve → rerank), capacity planning with 20M vectors, ingestion patterns and freshness, deletes and orphaned chunks, zero-downtime model re-embedding with alias swaps, sharding/replication/multi-tenancy, offline metrics (recall@K, MRR, nDCG) and online metrics, golden sets, caching and semantic-cache risks, ACL/tenant security and prompt injection via retrieved text, vendor landscape, failure runbooks, production checklist, 20 consolidated takeaways, and 10 exercises. |

---

## [Lecture 10: Deep Dive into Vector Databases and ANN Algorithms](./Lecture%2010/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 10/notes/Notes.pdf`](./Lecture%2010/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 10/notes/Excalidraw-Notes.svg`](./Lecture%2010/notes/Excalidraw-Notes.svg)
- **Hands-on Production Codebase:**
  - 💻 **[Lecture 10 Vector Database & ANN Codebase (Node.js + Express + TypeScript)](./Lecture%2010/code/README.md)** — IVF, HNSW, PQ, CRUD store, filters, BM25/RRF, Qdrant and pgvector adapters
  - 🛠️ **[Step-by-Step Implementation Guide](./Lecture%2010/code/implementations%20guide/README.md)** (00 → 10 chapters, full source + block-by-block explanations)
- **Complete Consolidated Notes:** [`Lecture_10_Complete_Notes.md`](./Lecture%2010/notes/Lecture_10_Complete_Notes.md) — 9 chapters synthesised with capacity maths, index-selection tables, cheat sheet, glossary, misconceptions and self-check

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2010/notes/01_Embeddings_and_the_Geometry_of_Meaning.md)** | **Embeddings and the Geometry of Meaning** | Meaning → coordinates, dimensions, what gets embedded (documents, chunks, queries), keyword vs semantic vs hybrid search, embedding model vs generative LLM, the model-compatibility rule, choosing a model, and the embedding contract in TypeScript-style pseudo-code. |
| **[Chapter 02](./Lecture%2010/notes/02_Similarity_Distance_and_Metric_Consistency.md)** | **Similarity, Distance and Metric Consistency** | Dot product, cosine similarity, Euclidean and Manhattan distance, a full worked comparison where the metrics disagree, normalisation and the cosine/dot collision, metric consistency across embedding model → index → query, what a score means, and numeric precision guards. |
| **[Chapter 03](./Lecture%2010/notes/03_Exact_KNN_and_the_ANN_Bargain.md)** | **Exact KNN and the ANN Bargain** | The baseline loop, the true cost of one query (`O(N × D)`), the Delhi coffee-shop analogy, what ANN actually approximates, why it misses, Recall@K, the speed–recall–memory spectrum, two-stage retrieval and the recall ceiling, and when exact search is still correct. |
| **[Chapter 04](./Lecture%2010/notes/04_IVF_Inverted_File_Index.md)** | **IVF — Inverted File Index** | Divide the space, centroids, k-means training, inverted lists, query → probe → candidates, the 1M-vector arithmetic, the boundary problem, `nlist`/`nprobe`, IVF variants (IVF-Flat, IVF-PQ, IVF-SQ), updates, drift, filtering and tuning. |
| **[Chapter 05](./Lecture%2010/notes/05_HNSW_Hierarchical_Navigable_Small_World.md)** | **HNSW — Hierarchical Navigable Small World** | From partitioning to connectivity, search by navigation, the flat-graph problem, the highway analogy, exponential layer sampling, insertion and query algorithms, `M`/`M0`/`efConstruction`/`efSearch`, memory accounting, build cost, tombstones, the filtered-search weakness, IVF vs HNSW and a tuning playbook. |
| **[Chapter 06](./Lecture%2010/notes/06_Vector_Compression_and_Product_Quantization.md)** | **Vector Compression and Product Quantization** | Why float32 is expensive, scalar/binary quantization, PQ split → codebooks → codes, 1536-dimension worked example, ADC, lossy compression, exact rescoring, IVF-PQ/HNSW-PQ combinations, capacity planning, and a compression decision table. |
| **[Chapter 07](./Lecture%2010/notes/07_Anatomy_of_a_Vector_Database.md)** | **Anatomy of a Vector Database** | The five layers, the record model (id + vector + payload), collections/points/segments, write and read paths, pre- vs post- vs filter-aware search, hybrid search and RRF, lifecycle and source-of-truth rules, what a vector DB does not do, and a design checklist. |
| **[Chapter 08](./Lecture%2010/notes/08_Qdrant_pgvector_and_the_Storage_Decision.md)** | **Qdrant, pgvector and the Storage Decision** | Qdrant object model, Docker, the JavaScript client, collections, upsert/query/filter, payload indexes, multi-tenancy, operations and snapshots; pgvector schema, operators, HNSW/IVFFlat, dimension limits and iterative scans; the wider vendor landscape, decision framework, cost and failure modes. |
| **[Chapter 09](./Lecture%2010/notes/09_Production_RAG_Retrieval_Systems.md)** | **Production RAG Retrieval Systems** | Retrieval architecture, chunking as the ceiling, query understanding, candidate generation, reranking, context assembly, retrieval vs generation evaluation, latency/cost budgets, freshness, multi-tenant security, a failure runbook, and a capstone retrieval project — generation deferred to Lecture 11. |

---

## [Lecture 11: Retrieval-Augmented Generation (RAG)](./Lecture%2011/notes/README.md)

- **Source Materials:**
  - Excalidraw Diagrams: [`Lecture 11/notes/Excalidraw-Notes.svg`](./Lecture%2011/notes/Excalidraw-Notes.svg)
- **Hands-on Codebases:**
  - 🏭 **[Productions RAG (Node.js + Express + TypeScript)](./Lecture%2011/code/Productions%20RAG/README.md)** — structure-aware chunking, embeddings (OpenAI + deterministic offline), memory and Pinecone stores, hybrid retrieval with a score floor, grounded prompt with `[n]` citations, citation verification, conversation state with query rewriting, golden-set evaluation, and an HTTP API with a full request trace
  - 🛠️ **[Productions RAG — Step-by-Step Implementation Guide](./Lecture%2011/code/Productions%20RAG/implementations%20guide/README.md)** (00 → 14 chapters, full source + block-by-block explanations)
  - 🧪 **[Eassy RAG (plain JavaScript + PDF + OpenAI + Qdrant)](./Lecture%2011/code/Eassy%20RAG/src/queryPdf.js)** — the lecture's minimal end-to-end pipeline: `pdf-parse` → 1,000-character chunks with 150 overlap → `text-embedding-3-small` at 1,024 dimensions → one Qdrant point per chunk with deterministic UUID ids → top-5 cosine retrieval → `[Source n]` grounded answer. Six ES modules, four dependencies, no framework
  - 🛠️ **[Eassy RAG — Step-by-Step Implementation Guide](./Lecture%2011/code/Eassy%20RAG/implementations%20guide/README.md)** (01 → 08 chapters: overview & provider map, config, chunking, embeddings, Qdrant, indexing, querying, verification — full source + block-by-block explanations + verified failure modes)
- **Complete Consolidated Notes:** [`Lecture_11_Complete_Notes.md`](./Lecture%2011/notes/Lecture_11_Complete_Notes.md) — 9 chapters synthesised with cheat sheet, decision tables, misconceptions, glossary and 25 self-check questions

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2011/notes/01_The_Stateless_Model.md)** | **The Stateless Model** | Parametric vs non-parametric memory, the inference loop, why hallucination is a mechanism rather than a bug, knowledge cutoffs, the "capital of India" and "What is my name?" demos, statelessness and history, context-window capacity vs attention, and why bigger windows do not replace retrieval. |
| **[Chapter 02](./Lecture%2011/notes/02_RAG_The_Open_Book_Architecture.md)** | **RAG — The Open Book Architecture** | The open-book analogy, the two pipelines (offline ingestion, online serving), the seven serving steps, what RAG fixes and what it cannot, the system-prompt-only anti-pattern, retrieve-then-read variants, and the failure modes that survive a correct architecture. |
| **[Chapter 03](./Lecture%2011/notes/03_Ingestion_Documents_to_Chunks.md)** | **Ingestion — Documents to Chunks** | PDF extraction hazards, cleaning and normalisation, chunking strategies (fixed, recursive, semantic, parent-child), the `1–1000 / 801–1800` overlap trace from the board, chunk-size arithmetic, metadata and context headers, deterministic ids, the orphan-chunk problem, and batching. |
| **[Chapter 04](./Lecture%2011/notes/04_Embeddings_at_Query_Time.md)** | **Embeddings at Query Time** | The embedding space contract, model selection, Matryoshka dimensions, symmetric vs asymmetric encoding and prefixes, normalisation, truncation, the cost of changing a model, and why the model and dimension belong in the schema. |
| **[Chapter 05](./Lecture%2011/notes/05_The_Vector_Index.md)** | **The Vector Index** | The record model, namespaces (`policies`), query anatomy, score calibration, top-K, metadata filters, hybrid search with RRF, MMR, reranking, consistency and freshness, and the Pinecone query from the board traced line by line. |
| **[Chapter 06](./Lecture%2011/notes/06_Grounded_Generation.md)** | **Grounded Generation** | The four-clause prompt contract, the exact refusal sentence, context ordering and the U-shaped attention curve, citation markers, fabrication guards, and prompt injection as an authority and capability problem. |
| **[Chapter 07](./Lecture%2011/notes/07_Conversation_State_and_Memory.md)** | **Conversation State and Memory** | Statelessness as an application problem, history as a retrieval problem, query condensation ("And for shoes?"), memory strategies and their costs, quadratic history cost, session ownership and IDOR, TTL, deletion, and history poisoning. |
| **[Chapter 08](./Lecture%2011/notes/08_Evaluation_and_Debugging.md)** | **Evaluation and Debugging** | Golden sets, recall@K / MRR / nDCG with a worked example, faithfulness and citation validity, refusal correctness, the retrieval-vs-generation 2×2, LLM-as-judge biases, the debug tree, and the trace every request must emit. |
| **[Chapter 09](./Lecture%2011/notes/09_Production_System_Design.md)** | **Production System Design** | SLOs, the `/api/query` contract, security model, degradation paths, caching keyed by `corpusVersion`, the cost model, blue/green re-indexing, the failure runbook, build-vs-buy, and the capstone acceptance test. |

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
├── Lecture 03/
│   ├── code/                 # Lecture 03 Production Microservice Codebase
│   │   ├── package.json      # Dependencies (Express, OpenAI SDK, Zod, tsx)
│   │   ├── tsconfig.json     # TypeScript Configuration (ES2022/NodeNext)
│   │   ├── .env.example      # Environment Configuration Template
│   │   ├── test-requests.http# REST Client / Postman Request Collection
│   │   ├── README.md         # Codebase Architecture & Running Instructions
│   │   ├── implementations guide/ # Step-by-Step Implementation Guide (00 - 08 Chapters)
│   │   └── src/
│   │       ├── app.ts        # Express Application & Middleware
│   │       ├── server.ts     # Server Bootstrap & Port Listener
│   │       ├── config/       # Boot-time Zod Environment Validation
│   │       ├── lib/          # OpenAI Client Singleton & Connection Pooling
│   │       ├── services/     # Summarizer, Audited, and Secure Services
│   │       ├── routes/       # Health & Summarizer REST Endpoints
│   │       └── scripts/      # Standalone Prototype & Security Injection Tests
│   └── notes/                # Lecture 03 Notes & Visual Artifacts
│       ├── README.md         # Lecture 03 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Excalidraw-Notes.svg # Handwritten & Architectural Diagrams
│       ├── Lecture_03_Complete_Notes.md # Consolidated Master Document
│       └── [01 - 07 Chapters].md # Individual Modular Chapters
├── Lecture 04/
│   ├── code/                 # Lecture 04 Conversational AI Microservice Codebase
│   │   ├── package.json      # Dependencies (Express, OpenAI SDK, Zod, tsx, cors)
│   │   ├── tsconfig.json     # TypeScript Configuration (ES2022/NodeNext)
│   │   ├── .env.example      # Environment Configuration Template
│   │   ├── test-requests.http# REST Client / Postman Request Collection
│   │   ├── README.md         # Codebase Architecture & Running Instructions
│   │   ├── implementations guide/ # Step-by-Step Implementation Guide (00 - 11 Chapters)
│   │   └── src/
│   │       ├── app.ts        # Express Application & Middleware
│   │       ├── server.ts     # Server Bootstrap & Graceful Shutdown
│   │       ├── config/       # Boot-time Zod Environment Validation
│   │       ├── lib/          # OpenAI Client Singleton & BPE Tokenizer Utils
│   │       ├── types/        # Strongly Typed Chat Schemas & Contracts
│   │       ├── services/     # SessionStore, ContextManager, Streaming & Grounding
│   │       ├── routes/       # Health & Chat REST/SSE Endpoints
│   │       └── scripts/      # CLI Chat Prototype, Hallucination & Context Bloat Tests
│   └── notes/                # Lecture 04 Notes & Visual Artifacts
│       ├── README.md         # Lecture 04 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Lecture_04_Complete_Notes.md # Consolidated Master Document
│       └── [01 - 07 Chapters].md # Individual Modular Chapters
├── Lecture 06/
│   ├── code/                 # Lecture 06 AI Streaming Microservice + Browser Client
│   │   ├── package.json      # Dependencies (Express, OpenAI SDK, Zod, eventsource-parser, tsx)
│   │   ├── tsconfig.json     # TypeScript Configuration (ES2022/NodeNext)
│   │   ├── .env.example      # Streaming Knobs (granularity, flush, heartbeat, 3 timeouts, limits)
│   │   ├── test-requests.http# REST Client Collection (18 Cases + curl Diagnostics)
│   │   ├── README.md         # Architecture, Wire Protocol, Results & Running Instructions
│   │   ├── implementations guide/ # Step-by-Step Implementation Guide (00 - 16 Chapters)
│   │   ├── public/           # The BROWSER half: fetch · ReadableStream · TextDecoder · HUD
│   │   │   ├── index.html    # Chat UI, telemetry HUD, wire inspector, chaos toggles
│   │   │   ├── app.js        # Frame parsing, rAF rendering, cancellation, recovery
│   │   │   └── styles.css
│   │   └── src/
│   │       ├── app.ts        # Express Factory, Static Mount & Error Boundary
│   │       ├── server.ts     # Bootstrap, Node Timeout Tuning & Stream-Aware Shutdown
│   │       ├── config/       # Zod-Validated Streaming Configuration
│   │       ├── types/        # Provider Contract, Wire Frames & Store Records
│   │       ├── lib/          # Logger, Metrics Registry, Byte/Frame Codec, Timing
│   │       ├── providers/    # Live OpenAI Provider, Deterministic Simulator, Error Taxonomy
│   │       ├── stream/       # StreamPump, DeltaCoalescer, BackpressureWriter
│   │       ├── services/     # ConversationStore, HistoryService, StreamRegistry, ChatService
│   │       ├── routes/       # Chat (3 transports), Conversation & Observability Routers
│   │       └── scripts/      # CLI Consumer, UTF-8 Torture Test, Invariants, Cancel, Benchmark
│   └── notes/                # Lecture 06 Notes & Visual Artifacts
│       ├── README.md         # Lecture 06 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Excalidraw-Notes.svg # Architectural & Conceptual Diagrams
│       ├── Lecture_06_Complete_Notes.md # Consolidated Master Document
│       └── [01 - 10 Chapters].md # Individual Modular Chapters
├── Lecture 07/
│   └── notes/                # Lecture 07 Notes & Visual Artifacts
│       ├── README.md         # Lecture 07 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Excalidraw-Notes.svg # Handwritten Conceptual Diagrams
│       ├── Lecture_07_Complete_Notes.md # Consolidated Master Document
│       └── [01 - 07 Chapters].md # Individual Modular Chapters
├── Lecture 08/
    ├── code/                 # Lecture 08 Movie Recommendation Engine Codebase
    │   ├── package.json      # Dependencies (Express, OpenAI SDK, Zod, cors, tsx)
    │   ├── tsconfig.json     # TypeScript Configuration (ES2022/NodeNext)
    │   ├── .env.example      # Environment Configuration Template
    │   ├── test-requests.http# REST Client / Postman Request Collection
    │   ├── README.md         # Codebase Architecture & Running Instructions
    │   ├── implementations guide/ # Step-by-Step Implementation Guide (00 - 08 Chapters)
    │   ├── movies.json       # 30-movie dataset used by the standalone jsDemo
    │   └── src/
    │       ├── app.ts        # Express Application & Middleware
    │       ├── server.ts     # Bootstrap: Build Catalog, Then Listen
    │       ├── config/       # Boot-time Zod Environment Validation
    │       ├── data/         # 18-Movie Typed Catalog
    │       ├── types/        # Domain & API Contracts
    │       ├── services/     # EmbeddingService, VectorStore, RecommendationService
    │       └── routes/       # Catalog, Search, Similar-Movie & Status Endpoints
    └── notes/                # Lecture 08 Notes & Visual Artifacts
        ├── README.md         # Lecture 08 Index & Navigation
        ├── Notes.pdf         # Original Slide Presentation
        ├── Excalidraw-Notes.svg # Handwritten Conceptual Diagrams
        ├── Lecture_08_Complete_Notes.md # Consolidated Master Document
        └── [01 - 07 Chapters].md # Individual Modular Chapters
├── Lecture 09/
│   └── notes/                # Lecture 09 Notes & Visual Artifacts
│       ├── README.md         # Lecture 09 Index & Navigation
│       ├── Notes.pdf         # Original Slide Presentation
│       ├── Excalidraw-Notes.svg # Handwritten Conceptual Diagrams
│       ├── Lecture_09_Complete_Notes.md # Consolidated Master Document
│       └── [01 - 08 Chapters].md # Individual Modular Chapters
├── Lecture 10/
    ├── code/                 # Lecture 10 Vector Database & ANN Codebase
    │   ├── package.json      # Express, Zod, OpenAI SDK, Qdrant client, pg, tsx
    │   ├── tsconfig.json     # Strict TypeScript (ES2022 / NodeNext)
    │   ├── .env.example      # Provider, metric, index, Qdrant, pgvector config
    │   ├── README.md         # Architecture, quick start, API and measured results
    │   ├── test-requests.http # Every endpoint with example bodies
    │   ├── implementations guide/ # 00 - 10 chapters (full source + explanations)
    │   └── src/
    │       ├── app.ts        # Express app, health, error mapping
    │       ├── server.ts     # Boot, seed, eager index, graceful shutdown
    │       ├── config/       # Zod environment validation
    │       ├── types/        # Vector, record, filter and index contracts
    │       ├── lib/          # Heap, top-K, RNG, async, errors, HTTP wrapper
    │       ├── core/         # Metrics, exact KNN, k-means, IVF, HNSW, PQ, evaluation
    │       ├── embeddings/   # Provider factory, mock, OpenAI, Gemini, cache
    │       ├── store/        # CRUD vector store, filters, BM25 + RRF
    │       ├── adapters/     # Official Qdrant client and pg/pgvector
    │       ├── routes/       # Documents, query and admin APIs
    │       ├── services/     # Corpus seeding
    │       ├── data/         # 24-document corpus, synthetic generator
    │       └── scripts/      # verify, demo, benchmark, seed, adapter CRUD
    └── notes/                # Lecture 10 Notes & Visual Artifacts
        ├── README.md         # Lecture 10 Index & Navigation
        ├── Notes.pdf         # Original Slide Presentation
        ├── Excalidraw-Notes.svg # Handwritten Conceptual Diagrams
        ├── Lecture_10_Complete_Notes.md # Consolidated Master Document
        └── [01 - 09 Chapters].md # Individual Modular Chapters
└── Lecture 11/
    ├── code/
    │   ├── Productions RAG/  # Full production-shaped RAG service (TypeScript)
    │   │   ├── package.json  # Express, Zod, OpenAI SDK, Pinecone, tiktoken, unpdf
    │   │   ├── tsconfig.json # Strict TypeScript (ES2022 / NodeNext)
    │   │   ├── .env.example  # Providers, chunking, retrieval, sessions, store
    │   │   ├── README.md     # Architecture, quick start, API and measured results
    │   │   ├── test-requests.http # Every endpoint with example bodies
    │   │   ├── index.js      # The lecture's original single-file sample
    │   │   ├── implementations guide/ # 00 - 14 chapters (full source + explanations)
    │   │   ├── eval/         # golden.json — 12 questions, 10 answerable
    │   │   ├── knowledge/    # refund, shipping and warranty policy corpus
    │   │   └── src/
    │   │       ├── app.ts    # Express app, routes, validation, error mapping
    │   │       ├── server.ts # Boot, auto-ingest, graceful shutdown
    │   │       ├── container.ts # Composition root (the only wiring file)
    │   │       ├── rag.service.ts # ingest() + ask() + trace
    │   │       ├── config/   # Zod environment validation
    │   │       ├── types/    # Chunk, record, match, citation, trace contracts
    │   │       ├── lib/      # Text, vectors, retry, errors
    │   │       ├── ingest/   # Document loader and token chunker
    │   │       ├── embeddings/ # Provider factory, mock, OpenAI
    │   │       ├── store/    # Vector-store interface, memory, Pinecone
    │   │       ├── retrieval/ # Retriever and hybrid lexical scoring
    │   │       ├── grounding/ # Context assembly and citation verification
    │   │       ├── generation/ # Prompt builder, OpenAI, extractive
    │   │       ├── session/  # Conversation store and query rewriter
    │   │       └── scripts/  # ingest, ask, demo, eval
    │   └── Eassy RAG/        # Minimal PDF → Qdrant → answer pipeline (JavaScript)
    │       ├── package.json  # openai, @qdrant/js-client-rest, pdf-parse@1.1.1, dotenv
    │       ├── .env          # 11 settings: models, dimensions, chunking, Qdrant, top-K
    │       ├── .gitignore    # ignores .env and node_modules/
    │       ├── guide.md      # 778-line article the code was written for
    │       ├── documents/    # Input folder — drop your PDF here
    │       ├── implementations guide/ # 01 - 08 chapters (full source + explanations)
    │       └── src/
    │           ├── config.js     # Validated env → one config object
    │           ├── chunking.js   # 1,000-char windows, 150 overlap, word snap
    │           ├── embeddings.js # Batched embeddings, index-aligned, validated
    │           ├── qdrant.js     # Client, collection lifecycle, dimension guard
    │           ├── indexPdf.js   # PDF → chunks → points → upsert (offline)
    │           └── queryPdf.js   # Question → top-5 → [Source n] → answer (online)
    └── notes/                # Lecture 11 Notes & Visual Artifacts
        ├── README.md         # Lecture 11 Index & Navigation
        ├── Excalidraw-Notes.svg # Handwritten Conceptual Diagrams
        ├── Lecture_11_Complete_Notes.md # Consolidated Master Document
        └── [01 - 09 Chapters].md # Individual Modular Chapters

```

---

## 🎯 Key Engineering Takeaways Overview

1. **Proposed Solution vs. True Requirement:** A client request like *"Build a chatbot"* is a proposed solution. FDEs discover the underlying business requirement (*"Reduce resolution time safely"*).
2. **LLMs Are Reasoning Engines, Not Applications:** An LLM alone cannot run business transactions or verify facts; production systems require RAG knowledge retrieval, business APIs, RBAC authorization, guardrails, and human oversight.
3. **The Attention Paradigm Shift:** Attention connects any two tokens across a sequence in $O(1)$ matrix operations, eliminating the sequential context bottleneck of RNNs.
4. **The Cardinal Law of GenAI Engineering:** *The LLM only knows what reaches the LLM.* If session history, database rows, live weather, or current timestamps are not serialized into the prompt context window, the model cannot access them.
5. **Decouple Authority via Role Separation:** Never concatenate application instructions with untrusted user strings. Enforce strict multi-role architectures (`system` vs. `user`) to neutralize prompt injection and goal hijacking attacks.
6. **The LLM Has Zero Native Memory:** Every conversation is an isolated forward pass. The application layer alone constructs conversational continuity.
7. **Autoregressive Generation Demands Streaming:** Streaming does not make generation faster, but it drops perceived latency (TTFT) from $20\text{s}$ to $< 500\text{ms}$ using Server-Sent Events (SSE).
8. **Fluency is Decoupled from Truth:** Flawless grammar and confident language do not guarantee factuality. Treat hallucinations as an inherent engineering problem solvable only through defense-in-depth: RAG grounding, deterministic tools, structured outputs, and output verification.
9. **The Hands vs. Brain Paradigm:** The LLM is a reasoning kernel without arms or senses. Tools grant actuation and perception through deterministic function execution.
10. **The ReAct Closed-Loop Invariant:** Autonomous agency requires a dynamic feedback loop (Thought $\rightarrow$ Action $\rightarrow$ Observation). The agent evaluates real-world output and self-corrects until the goal is fulfilled.
11. **Principle of Least Privilege & Sandboxing:** Never grant unconstrained execution rights to autonomous agents. Enforce path traversal jails (`safePath`), symlink verification, and managerial Human-in-the-Loop (HITL) authorization gates on high-impact actions.
12. **The Return Type Is the Architecture:** Streaming is not enabled by calling `.stream()` instead of `.call()`; it is enabled by changing the contract from `String` (a box: one value, after completion) to `Flux`/`AsyncIterable` (a conveyor belt: zero, one or many values over time). With a stream type, no layer above it *can* buffer without visibly choosing to.
13. **Streaming Is a Pipeline, Not a Feature:** Six links — generation → provider → backend → HTTP → browser → UI. A single buffering hop anywhere collapses the experience, and the failure is invisible to every backend dashboard.
14. **TTFT Is the Number the User Feels:** Perceived latency is time-to-first-token, not total generation time. Streaming rarely makes the model finish faster; it drops perceived latency from tens of seconds to a few hundred milliseconds.
15. **Token ≠ Provider Chunk ≠ Network Chunk ≠ Decoded Piece:** Four layers of granularity. The client must be boundary-agnostic: buffer bytes, decode incrementally with one `TextDecoder({stream:true})`, and append whatever arrives.
16. **Once the First Byte Is Written, the Status Is Frozen:** After `200 OK`, failures, timeouts and cancellations can only be expressed **in-band** (`event: error` + `done{status:"interrupted"}`). Design that protocol before you need it.
17. **Streaming ≠ SSE:** SSE is one delivery format, not a synonym for streaming. Raw chunked `text/plain` is enough for a simple chatbot; SSE adds framing, `id`-based resumption and heartbeats; WebSockets add bidirectionality.
18. **The Dual-Write Pattern:** Every chunk must be forwarded to the client *and* appended to a per-request buffer. Persist exactly ONE reconstructed assistant message per turn — chunks are transport artefacts, never messages, or prompt size grows quadratically.
19. **Interrupted Answers Belong in History:** Whatever the user already read must be persisted, flagged `status: "interrupted"` with a finish reason, and annotated in the next prompt so the model does not read a truncated turn as complete.
20. **Cancellation Is a Financial Control:** `AbortController` on the client → socket close → provider cancellation. Without propagation, closed tabs keep generating tokens that nobody reads and somebody pays for.
21. **Backpressure Stalls; It Does Not Overflow:** `res.write()` returning `false` is an instruction to wait for `drain`, not a warning to ignore. The alternative is unbounded server memory growth under a slow client.
22. **Measure the Gap, Not the Average:** `p95(clientTTFT − serverTTFT)` is the single most valuable streaming alert — it catches proxy buffering, compression re-enabled on SSE, a buffering middleware, a CDN misconfiguration and a frontend that collapsed to `await response.text()`, in one rule.
23. **Symbols Are Not Meaning:** A computer can store `"Batman"` but cannot understand it without a numerical representation. Representing symbols is not the same as representing meaning — the entire field of vector embeddings exists to bridge this gap.
24. **Geometry Encodes Semantics:** An embedding is not the meaning itself — it is a *position* in a learned mathematical space where useful relationships in meaning or behavior become relationships in geometry. Objects with similar meanings end up geometrically close.
25. **Let the Model Decide the Dimensions:** Feature engineering (manually choosing which characteristics to measure) fails at scale due to dimensionality explosion, task specificity, and language ambiguity. The scalable solution is to train a model on a useful objective and let useful representations emerge as a by-product.
26. **Every Embedding Is a Vector; Not Every Vector Is an Embedding:** A feature vector `[height, weight, age]` is human-designed. An embedding `[0.21, -0.71, 0.45, ...]` is a *learned* position in a continuous space. The distinction matters for understanding what mathematical operations are meaningful.
27. **Context Determines Meaning:** Words in similar contexts develop similar embeddings (Firth's principle: *"You shall know a word by the company it keeps"*). `king` and `queen` cluster together; `banana` drifts to a separate region — with no human labeling, purely from training data patterns.
28. **Embeddings Unlock an Entire Suite of Operations:** Once objects are vectors, similarity search, nearest-neighbor retrieval, clustering, classification, ranking, recommendation, and RAG all become possible using nothing but distance and angle calculations over that learned space.
29. **Precompute What Is Stable; Process What Changes:** Movie descriptions are stable — embed them once at startup and reuse the vectors forever. User queries are changing — embed them per request. This single distinction is the difference between a scalable embedding system and one that re-embeds its entire catalog on every search.
30. **Search and Recommendation Are the Same Operation:** Semantic search and similar-movie recommendation share one ranking engine and one cosine-similarity implementation. The only difference is where the starting vector comes from: embed the query, or reuse a movie's precomputed vector. Design the shared core once.
31. **Match the Tool to the Problem:** Recommendation is a ranking problem, not a generation problem. Embeddings plus cosine similarity produce the ranking cheaply and deterministically; an LLM is optional and belongs *after* retrieval, explaining the results rather than deciding them.
32. **Scale Changes the Algorithm, Not the Math:** The 30-movie cosine loop is still the specification. At 100M vectors, `O(N × D)` per query becomes 100M comparisons and tens of gigabytes of memory reads — the operation is right, the cost model is fatal.
33. **Storage and Search Are Separate Problems:** A relational database can hold vectors as JSON, blobs, or a native `vector` type. The unsolved part is similarity search, because a B-tree needs a total order and embeddings do not have one.
34. **A Vector Database Does Not Understand Meaning:** The embedding model turns meaning into coordinates; the vector database stores and retrieves those coordinates. Mixing model versions silently mixes coordinate systems.
35. **Brute Force Is the Ground Truth:** Exact KNN checks every vector, returns 100% of the true top-K, and is the only way to measure whether an approximate index is any good. Never tune ANN without an exact baseline.
36. **Every Index Is a Pruning Proof:** A B-tree proves a sorted subtree irrelevant; a k-d tree proves a region irrelevant when `planeDist >= bestDist`. The curse of dimensionality is the collapse of that proof, not of the arithmetic.
37. **High Dimensions Kill Geometric Pruning:** With 1536 dimensions, a query is almost always near some splitting plane; distance concentration removes the margin between nearest and farthest. A k-d tree inspects 70–100% of the data and can be slower than a flat scan.
38. **Approximation Must Be Measured, Not Assumed:** IVF, HNSW, PQ, and LSH all trade recall for speed. The correct production contract is an explicit recall@K target validated on a versioned golden set, plus p95 latency and freshness budgets.
39. **Retrieve Cheaply, Rescore Exactly:** Use the ANN index for candidate generation, then recompute full-precision similarity on a few hundred candidates and apply business ranking. Final recall can never exceed candidate-stage recall.
40. **The Index Is a Derived Artifact:** Design it to be rebuilt from the source of truth, versioned by embedding model, migrated through a new collection plus alias swap, and filtered by tenant/ACL inside the query. Operability is part of correctness.
41. **Statelessness Is the Architecture, Not a Limitation:** The model holds no conversation. Every turn is a fresh forward pass over whatever the application serialises — which is why memory, history and citations are application data structures, not model features.
42. **Retrieval Sets the Ceiling:** Chunking decides what can ever be found, the index decides what is reachable, and the prompt can only use what arrived. No amount of prompt engineering recovers a chunk that was never retrieved.
43. **A Vector Is Meaningless Without Its Model:** Model name, dimension and normalisation are part of the schema. Mixing them produces numbers that look plausible and are quietly wrong — so they belong in the index snapshot and in every trace.
44. **Similarity Is Not Relevance, and Relevance Is Not Confidence:** A cosine score is geometry, not probability. Score floors must be calibrated per model and per corpus against a golden set, and a chunk that is *about* the question may still not answer it.
45. **Refusal Is a Feature With a Test:** One exact sentence, emitted when the evidence is missing, before the model is called. A refusal you can measure is a safety property; "I'm sorry, I can't help with that" is a mood.
46. **Citations Must Be Verified, Not Trusted:** Assign `[n]` before generation, resolve them against the prompt afterwards, count the invented ones and strip them. Fabricated sources are detectable with a `Map`, not with a judge.
47. **Evidence Is Data; Rules Are Authority:** Retrieved text belongs in a delimited user turn, never in the system instructions. Prompt injection cannot be fully solved inside the prompt — the durable control is capability, and a read-only assistant has a small blast radius.
48. **Follow-ups Are a Retrieval Bug:** "And for shoes?" embeds to noise. Condense the question into a standalone query *before* retrieval, or the failure will look like the model ignoring the conversation.
49. **Measure Retrieval and Generation Separately:** Recall@K tells you whether the evidence arrived; faithfulness and citation validity tell you whether it was used. A single quality score cannot distinguish the two, so debugging degenerates into opinion.

---

## [Lecture 12: Advanced RAG — Chunking, Hybrid Retrieval, Reranking and Context Engineering](./Lecture%2012/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 12/notes/Notes.pdf`](./Lecture%2012/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 12/notes/Excalidraw-Notes.svg`](./Lecture%2012/notes/Excalidraw-Notes.svg)
- **Hands-on Codebase:**
  - 🧱 **[Advanced RAG — Basic Code (TypeScript)](./Lecture%2012/code/Basic%20Code/README.md)** — the *minimum* runnable code behind the notes, in a conventional layered structure (`config` · `models` · `utils` · `services` · `controllers` · `routes` · `middleware`): the eight controls (chunking + overlap, top-K, similarity floor, metadata/ACL/`asOf` filters, BM25 + RRF, reranking with a gate, context assembly, evaluation) in 20 files and ~950 lines, with a 6-case golden set, a 5-preset ablation, an HTTP API and a chapter CLI — offline, no API key
  - 🛠️ **[Basic Code — Step-by-Step Implementation Guide](./Lecture%2012/code/Basic%20Code/implementations%20guide/README.md)** (01 → 19 chapters, full source + block-by-block explanations)
  - 🏭 **[Advanced RAG (Node.js + Express + TypeScript)](./Lecture%2012/code/advanced-rag/README.md)** — fixed/structural/semantic chunking with overlap arithmetic, parent-child (small-to-big) retrieval, contextual prefixes, top-K and **calibrated** score floors, MMR, metadata + ACL + temporal filters, BM25 + RRF hybrid search, two-stage reranking with a two-sided gate, context assembly (dedupe, precedence, budget, bookending), an ablation matrix and an HTTP API — all offline with no API key
  - 🛠️ **[Advanced RAG — Step-by-Step Implementation Guide](./Lecture%2012/code/advanced-rag/implementations%20guide/README.md)** (00 → 10 chapters, full source + block-by-block explanations)
- **Complete Consolidated Notes:** [`Lecture_12_Complete_Notes.md`](./Lecture%2012/notes/Lecture_12_Complete_Notes.md) — 9 chapters synthesised with an executive summary, the eight-control cheat sheet, a formula card, decision tables, misconceptions, glossary and 12 self-check questions

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2012/notes/01_Why_Basic_RAG_Breaks.md)** | **Why Basic RAG Breaks — The Two Failure Classes** | The working pipeline that returns the wrong policy, the two halves of the retrieval assumption (coverage and selection), retrieval failures versus generation failures, a seven-symptom taxonomy, the four-step failure tree, and why a baseline trace is the first artefact to build. |
| **[Chapter 02](./Lecture%2012/notes/02_Fixed_Size_Chunking_and_Overlap.md)** | **Fixed-Size Chunking and Overlap Arithmetic** | Why chunking is the ceiling rather than a tuning knob, sliding-window arithmetic (`stride = size − overlap`, storage `≈ S/(S−O)`), characters versus tokens, the `overlap ≥ size` bug that never advances, orphan chunks, and what overlap actually buys. |
| **[Chapter 03](./Lecture%2012/notes/03_Structural_Semantic_and_Contextual_Chunking.md)** | **Structural, Semantic and Contextual Chunking** | Heading-aware chunking and breadcrumbs, the two-pass rule for long sections and tables, minimum chunk size and sibling merging, semantic breakpoints and why they are not the default, parent-child (small-to-big) retrieval, contextual retrieval (template vs LLM), and late chunking. |
| **[Chapter 04](./Lecture%2012/notes/04_Top_K_and_Similarity_Thresholds.md)** | **Top-K and Similarity Thresholds** | The anatomy of a retrieval request, `K_retrieve` as the recall ceiling versus `K_context` as the token bill, why a similarity score is not a confidence, threshold calibration against a golden set, MMR for redundancy, and empty-result handling. |
| **[Chapter 05](./Lecture%2012/notes/05_Metadata_Filtering.md)** | **Metadata Filtering** | The third control: eligibility before scoring. Schema design, pre- versus post-filtering and the restrictiveness trap, tenant isolation and group ACLs that fail closed, temporal validity (`effectiveFrom`/`effectiveTo`/`asOf`), and metadata written at ingest. |
| **[Chapter 06](./Lecture%2012/notes/06_Hybrid_Search_and_RRF.md)** | **Hybrid Search — Dense, Lexical and RRF** | Why dense retrieval loses exact strings (SKUs, error codes, dates), BM25 from first principles (`idf`, `k1`, `b`), reciprocal rank fusion and the `1/(k+rank)` damping, why fusion must use ranks and not scores, per-class routing, and evaluating each arm separately. |
| **[Chapter 07](./Lecture%2012/notes/07_Reranking_Two_Stage_Retrieval.md)** | **Reranking — Two-Stage Retrieval** | Why a bi-encoder cannot see the query-document pair, what a cross-encoder computes, N→K budgeting and the recall ceiling, the 512-token truncation trap, the two-sided gate (`minBest` and `maxDrop`), the score-reuse bug, and graceful degradation. |
| **[Chapter 08](./Lecture%2012/notes/08_Context_Engineering.md)** | **Context Engineering** | Context as a budget rather than a bucket: explicit precedence when documents disagree, lost-in-the-middle ordering and bookending, evidence labels and citations, token budgeting, prompt-injection framing as an authority problem, and ablation tests for each assembly decision. |
| **[Chapter 09](./Lecture%2012/notes/09_Evaluation_and_Production_Playbook.md)** | **Evaluation and the Production Playbook** | Recall@K, MRR and nDCG as retrieval metrics; faithfulness, citation validity and refusal correctness as generation metrics; building a golden set; the ablation matrix; pinning the seven versions that change an index; blue/green re-indexing; the failure runbook and the go-live checklist. |

---

## [Lecture 13: Structured Outputs in GenAI — Schema, Enforcement, Validation and Action](./Lecture%2013/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 13/notes/Notes.pdf`](./Lecture%2013/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 13/notes/Excalidraw-Notes.svg`](./Lecture%2013/notes/Excalidraw-Notes.svg)
- **Hands-on Codebase:**
  - 🏭 **[Structured Outputs (Node.js + Express + TypeScript)](./Lecture%2013/code/Production%20Code/README.md)** — the enforcement ladder measured end to end: one Zod contract that generates the TypeScript type, the JSON Schema and the runtime validator; the strict-mode subset; a bounded repair loop with typed outcomes; `block`/`review` severity separation; a fallback rung keyed on `(path, code)`; an idempotent action pipeline with a calendar adapter; an **MCP-shaped** capability server with tier gating; a 10-case golden set and a release gate — all offline with no API key
- **Complete Consolidated Notes:** [`Lecture_13_Complete_Notes.md`](./Lecture%2013/notes/Lecture_13_Complete_Notes.md) — nine chapters synthesised with the enforcement cheat sheet, schema-design decision tables, the failure taxonomy, a glossary, self-check questions and a go-live checklist

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2013/notes/01_Why_Plain_Text_Is_Not_Enough.md)** | **Why Plain Text Is Not Enough — The Integration Gap** | The chatbot that works as a demo and fails the moment it becomes a feature; humans read *meaning* while software reads *fields*; the bridge between prose and typed data; the board's `MeetingDetails` form; stringly-typed parsing and the regex treadmill; why *"it looks right"* is not a contract, and why a downstream `switch` needs a closed set rather than free text. |
| **[Chapter 02](./Lecture%2013/notes/02_What_Structured_Output_Is_Schema_Contract_And_Types.md)** | **What Structured Output Is — Schema, Contract and Types** | A schema is a form the **application writes** and the model fills; the target is a typed object, never *"JSON"*; one declaration producing three artefacts (TypeScript type, runtime validator, wire contract); field *kinds* (`string` vs `number` vs `enum` vs `const`) and why units belong in the name; presence rules — **required with `null`** rather than optional-and-absent; the four decisions every field forces. |
| **[Chapter 03](./Lecture%2013/notes/03_Why_Just_Ask_For_JSON_Fails.md)** | **Why "Just Ask for JSON" Fails — Instruction vs Contract** | An instruction is a *preference over a token distribution*, not a guarantee; the canonical failure (chatty preamble, markdown fence, trailing comma, unbalanced braces, truncation); **syntax vs shape vs meaning** as three separate questions; the tolerant-reader regex treadmill and why every heuristic is a latent bug that only fires on rare inputs; the four-rung enforcement ladder introduced. |
| **[Chapter 04](./Lecture%2013/notes/04_JSON_Schema_And_Schema_Design_For_LLMs.md)** | **JSON Schema and Schema Design for LLMs** | The keyword vocabulary that actually matters (`type`, `enum`, `const`, `description`, `required`, `additionalProperties`); why `description` is the highest-value keyword in the whole vocabulary; *a schema is a compression of the task* — enum the closed sets, require-or-nullify every field, flatten by default, order the reasoning field first; and the **strict-mode subset**: which predicates a grammar can enforce and which it silently ignores. |
| **[Chapter 05](./Lecture%2013/notes/05_Enforcement_Mechanisms_And_Provider_Landscape.md)** | **Enforcement Mechanisms and the Provider Landscape** | Constrained decoding from the inside — logit masking, grammar compilation and the caching that makes it affordable; the capability ladder from prompt-only → JSON mode → strict schema; what each rung *removes* and what it leaves untouched; the tool-use workaround where schemas are unsupported; and the honest boundary — **a decoder can make malformed output impossible, and says nothing about whether the output is right**. |
| **[Chapter 06](./Lecture%2013/notes/06_Validation_Repair_And_Failure_Handling.md)** | **Validation, Repair and Failure Handling** | The boundary rule — nothing unvalidated touches the outside world; **structural** validation (types, enums, bounds) versus **semantic** validation (is it *true*?); `block` versus `review` severity and why collapsing them over-rejects or under-rejects; the strong repair prompt (issues + previous output + scoping + format); a bounded loop; the fallback ladder including **degraded objects**; a typed outcome taxonomy and the trace that explains each call. |
| **[Chapter 07](./Lecture%2013/notes/07_Structured_Output_vs_Tool_Calling.md)** | **Structured Output vs Tool Calling** | Structured output is the **result**, tool calling is the **request** — the model proposes, the application disposes; the four combinations and when each is right; schemas for tool arguments versus schemas for results; the boundary object; approval tiers and human-in-the-loop; and why *"only schedule for the requesting user"* written in a prompt is a preference rather than an access control. |
| **[Chapter 08](./Lecture%2013/notes/08_From_Data_To_Action_Tools_Integrations_And_MCP.md)** | **From Data to Action — Tools, Integrations and MCP** | The model's output ends at the validator; everything after is ordinary software. Adapters that absorb vendor payload differences (`startIso`/`durationMinutes` → RFC-3339 `start`/`end`); vendor errors mapped to **typed domain errors**; **idempotency keys derived from semantics** so a retry cannot duplicate an action; injection and confused-deputy surfaces; and MCP as host/client/server with the **tools** (*do*) · **resources** (*know*) · **prompts** (*reuse*) primitives, where *discovery is not permission*. |
| **[Chapter 09](./Lecture%2013/notes/09_Production_Playbook_Evaluation_And_Checklist.md)** | **Production Playbook — Evaluation, Observability and Go-Live** | Ship a chain of narrow guarantees and measure each link: **first-pass validity**, repair rate, final failure rate, outcome-kind accuracy and per-field accuracy; the **issue distribution** as the chart that turns *"the model is unreliable"* into *"`durationMinutes` is a string 4% of the time"*; latency and cost budgets; versioning the contract and migrating models; observability and redaction; the release gate and the go-live checklist. |

---

## [Lecture 14: MCP Server from First Principles — Host, Client, Server, Tools, Resources and Prompts](./Lecture%2014/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 14/notes/Notes.pdf`](./Lecture%2014/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 14/notes/Excalidraw-Notes.svg`](./Lecture%2014/notes/Excalidraw-Notes.svg)
- **Hands-on Codebases — two, and they answer different questions:**
  - 🧱 **[Basic Code (Node.js + TypeScript)](./Lecture%2014/code/Basic%20Code/README.md)** — *how do you build an MCP server at all?* One MCP **server** exposing all three primitives — **Tools** (*do*), **Resources** (*know*), **Prompts** (*reuse*) — plus the **Host/Client** that discovers and invokes them over **STDIO**: `tools/list` → `tools/call` → `resources/read` → `prompts/get`, `isError` results written as recovery instructions rather than bare errors, and an honest custom `company://` URI scheme. 8 files · ~376 lines · **runs offline with no API key**
  - 🏭 **[Production Code (Node.js + TypeScript)](./Lecture%2014/code/Production%20Code/README.md)** — *what does Chapter 08 make non-optional?* The same three primitives with every production concern bolted on: Zod-validated config at boot, structured stderr logging with redaction, counters and latency metrics, a four-code error taxonomy, rate limiting, timeouts, idempotency keys, **resource templates**, and a host that enforces **trust tiers, consent and tool filtering** with a hashed-argument **audit trail**. 16 files · ~1,849 lines · **runs offline with no API key**
  - 🛠️ **[Basic Code — Step-by-Step Implementation Guide](./Lecture%2014/code/Basic%20Code/implementations%20guide/README.md)** (01 → 09 chapters — one source file per chapter: full source + block-by-block explanations)
  - 🛠️ **[Production Code — Step-by-Step Implementation Guide](./Lecture%2014/code/Production%20Code/implementations%20guide/README.md)** (01 → 17 chapters — file details → full source → block-by-block explanation → run/verify → checkpoint, plus recorded branch-verification runs)
- **Complete Consolidated Notes:** [`Lecture_14_Complete_Notes.md`](./Lecture%2014/notes/Lecture_14_Complete_Notes.md) — all eight chapters condensed into one reference: the thesis, "Where Each Idea Lives", the ten-sentence summary, cheat sheets (three roles · three primitives · method vocabulary · eight-step lifecycle · tool-definition rules · which primitive?), decision tables (MCP vs tool calling · MCP vs REST · server vs microservice · stdio vs Streamable HTTP · protocol vs tool-execution error · cache or refresh · which policy), a glossary, common misconceptions, self-check questions and a go-live checklist

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2014/notes/01_The_Integration_Problem_and_Why_Standards_Win.md)** | **The Integration Problem and Why Standards Win** | A single `getWeather()` tool that works perfectly — and the arithmetic that breaks it: the same five capabilities wanted by six consumers, N × M integrations (5 apps × 10 systems = 50) versus N + M with a standard (15), the precedent of HTTP/USB/ODBC, the dependency rule (depend on the protocol, not the vendor) and the adoption rule. |
| **[Chapter 02](./Lecture%2014/notes/02_What_MCP_Is_Protocol_Server_and_Standard_Interface.md)** | **What MCP Is: Protocol, Server and the Standard Interface** | MCP as a standard protocol through which AI applications connect to external tools and data; what an MCP Server *is* (a capability provider that needs **no LLM** — ordinary business logic behind a standard interface); the three boundaries the lecture insists on; why *"just use REST"* misses the point; one host with many servers; and the JSON-RPC and transports layer underneath. |
| **[Chapter 03](./Lecture%2014/notes/03_MCP_vs_Tool_Calling_Complementary_Layers.md)** | **MCP vs Tool Calling: Two Complementary Layers** | The two questions — tool calling answers *"which capability, with what arguments?"*, MCP answers *"where do those tools come from and how are they accessed?"* — the handoff point between them, the connection to Lecture 13's structured output, the four possible combinations and the responsibility matrix. |
| **[Chapter 04](./Lecture%2014/notes/04_Host_Client_Server_Architecture.md)** | **Host, Client and Server: The Three Roles** | Who owns the conversation (Host), the connection (Client) and the capability (Server); the **1:1 rule** — one client speaks to exactly one server; isolation principles; who owns what; **STDIO** versus **Streamable HTTP**; and the lifecycle from `initialize` to shutdown. |
| **[Chapter 05](./Lecture%2014/notes/05_The_Tools_Primitive.md)** | **The Tools Primitive: Executable Capability** | Tool anatomy (`name`, `description`, `inputSchema`, `outputSchema`, `annotations`); `tools/list` discovery and `tools/call` invocation; what a tool returns; the **two error mechanisms** (a protocol error versus a tool-execution error carrying `isError: true`); annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`); the tool-definition rules; the board's calculator fixed; and the security duties the server still owns. |
| **[Chapter 06](./Lecture%2014/notes/06_Resources_and_Prompts.md)** | **Resources and Prompts: Context and Reusable Instructions** | **Tools do, Resources know, Prompts reuse**: addressable context by URI, Tool vs Resource, Resources vs RAG, prompt templates with arguments, and the control model — the model drives tools, the application drives resources, the user drives prompts. |
| **[Chapter 07](./Lecture%2014/notes/07_Discovery_Invocation_and_Lifecycle.md)** | **The Tool Lifecycle: Discovery, Selection, Invocation** | The eight-step lifecycle; discovery as a curated act; selection as the fragile step; the host doing the routing; the result becoming context; dynamic tool discovery; whether `tools/list` runs on every message; the context-budget problem; and the five-step diagnostic order. |
| **[Chapter 08](./Lecture%2014/notes/08_Security_Production_and_Practical_Architecture.md)** | **Security, Production and a Practical Architecture** | The governing sentence — *MCP standardizes communication; it does not remove your responsibility for security*; the threat model; **discovery is not permission**; OAuth for remote servers; the practical two-application demo architecture; production concerns; and the build order. |


---

## [Lecture 15: MCP Server — Resources and Prompts](./Lecture%2015/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 15/notes/Notes.pdf`](./Lecture%2015/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 15/notes/Excalidraw-Notes.svg`](./Lecture%2015/notes/Excalidraw-Notes.svg)
- **Hands-on Codebases — two, and they answer different questions:**
  - 🧱 **[Basic Code (Node.js + TypeScript)](./Lecture%2015/code/Basic%20Code/README.md)** — *how do you add the two primitives Lecture 14 left out?* The same task-management server, now exposing **Resources** (*know* — static, dynamic and templated, addressed by URI) and **Prompts** (*reuse* — templates with advertised arguments) alongside the **Tool** (*do*): `resources/list` → `resources/read` → `prompts/list` → `prompts/get`, an application-side **selection** step that chooses context from a message, and `GET /plan?hours=4` — one request in which the **user** picks the Prompt, the **application** picks the Resource and the **model** picks the Tool. 10 files · ~897 lines · **runs offline with no API key**
  - 🏭 **[Production Code (Node.js + TypeScript)](./Lecture%2015/code/Production%20Code/README.md)** — *what does production make non-optional once Resources and Prompts exist?* Every concern from Lecture 14's Production Code, rebuilt around three primitives and a **layered host** (`controllers/` · `middleware/` · `routes/`): a resource **catalogue** with segment-exact template compilation, a **renderer↔descriptor invariant** asserted at boot, a **TTL cache** with `static`/`live`/`cache` provenance, **five selection strategies** (attached · state · rule · retrieval · LLM) ranked with reasons, a **three-stage context budget** that marks what it truncated, a **resource ACL and prompt allowlist** enforced before the read, and an audit trail that hashes arguments and never records content. 33 files · ~6,354 lines · **runs offline with no API key**
  - 🛠️ **[Basic Code — Step-by-Step Implementation Guide](./Lecture%2015/code/Basic%20Code/implementations%20guide/README.md)** (01 → 09 chapters — one source file per chapter: full source + block-by-block explanations)
  - 🛠️ **[Production Code — Step-by-Step Implementation Guide](./Lecture%2015/code/Production%20Code/implementations%20guide/README.md)** (01 → 26 chapters — file details → full source → block-by-block explanation → run/verify → checkpoint, plus the four real bugs the guide found by running the code)
- **Complete Consolidated Notes:** [`Lecture_15_Complete_Notes.md`](./Lecture%2015/notes/Lecture_15_Complete_Notes.md) — all eight chapters condensed into one reference: the three primitives and the **control model**, cheat sheets (which primitive? · method vocabulary · resource anatomy · prompt anatomy · the five selection strategies), decision tables (Resource vs RAG · Tool vs Resource vs Prompt · static vs dynamic vs templated · cache or refresh · protocol error vs `isError`), a glossary, common misconceptions, self-check questions and a go-live checklist

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2015/notes/01_The_Three_Primitives_and_the_Control_Model.md)** | **The Three Primitives and the Control Model** | Lecture 14 used one primitive; this lecture opens the other two. **Tools do, Resources know, Prompts reuse** — and the sentence that tells them apart: *the model drives tools, the application drives resources, the user drives prompts*. Why the distinction is about **who holds the trigger** rather than what the bytes look like, the same capability exposed three ways, and why a prompt is a *nudge* rather than a command. |
| **[Chapter 02](./Lecture%2015/notes/02_Why_Resources_Context_as_a_First_Class_Primitive.md)** | **Why Resources: Context as a First-Class Primitive** | If a Tool can return data, why is there a second primitive for information? The answer is **agency and addressability**: a Tool result arrives because a *model decided to ask*, while a Resource is fetched because the *application decided it was relevant* — and it has a **URI**, so it can be referenced, cached, scoped and authorised. Resource versus **RAG** (curated addressable context versus similarity-retrieved chunks), the context budget, and *do not let Resources become a prompt-injection channel*. |
| **[Chapter 03](./Lecture%2015/notes/03_Resource_Discovery_Reading_and_Anatomy.md)** | **Resource Discovery, Reading and Anatomy** | **Discovery is not consumption**: `resources/list` returns metadata, `resources/read` returns content, and a client that pays for content to answer *"what exists?"* has already lost. The anatomy of a well-formed Resource (`uri`, `name`, `title`, `description`, `mimeType`), why `description` is a **user-facing** field, the separate `resources/templates/list` verb, and the **protocol-error vs tool-execution-error** asymmetry — a failed read is a JSON-RPC error, a failed tool call is an `isError` result. |
| **[Chapter 04](./Lecture%2015/notes/04_Building_Resources_Static_Dynamic_and_Templated.md)** | **Building Resources: Static, Dynamic and Templated** | Three shapes through one verb: **static** (a constant document), **dynamic** (rendered from live state), and **templated** (a URI pattern with variables, so thousands of addresses need one definition). How a template is declared and bound, **segment-exact** matching (why `task://tasks/{id}` must not swallow `task://tasks/1/notes`), the renderer as the interesting part rather than the transport, and the invariant that every advertised URI has a renderer. |
| **[Chapter 05](./Lecture%2015/notes/05_How_the_Application_Chooses_a_Resource.md)** | **How the Application Chooses a Resource** | *MCP does not prescribe how a host selects a Resource* — so this is the application's own code, and the chapter's five strategies: **attached** (the user said so), **state** (the session's scope), **rule** (a pattern in the message), **retrieval** (similarity against metadata) and **LLM** (a router call). Why selection must **filter before ranking** so a router never sees what it may not show, why every choice must carry its **reason**, and the three-stage context budget that caps count, each body and the total. |
| **[Chapter 06](./Lecture%2015/notes/06_MCP_Prompts_Reusable_Interaction_Templates.md)** | **MCP Prompts: Reusable Interaction Templates** | The sharpest distinction in the lecture: **`MCP Prompt ≠ LLM Response`**. `prompts/get` returns **messages** — a template with arguments substituted — and the model call happens afterwards, elsewhere. Prompt anatomy (`name`, `title`, `description`, `arguments`), what a prompt may and may not contain (instructions, never facts), prompt hygiene (no secrets in a prompt), and why a deterministic template is the *testable* half of an agentic pipeline. |
| **[Chapter 07](./Lecture%2015/notes/07_Prompt_Arguments_Discovery_and_Client_Wiring.md)** | **Prompt Arguments, Discovery and Client Wiring** | A prompt **advertises** its arguments, so a client can render a form instead of making the user guess — `prompts/list` as the source of truth for both the UI and the validator. Required versus optional arguments, the client-side wiring that fetches a prompt and turns its messages into model input, *keep the count small* as a design constraint, and why the server validating its own contract beats the host duplicating it. |
| **[Chapter 08](./Lecture%2015/notes/08_Bringing_Tools_Resources_and_Prompts_Together.md)** | **Bringing Tools, Resources and Prompts Together** | The whole machine in one request — `GET /plan?hours=4`: the **user** controls the Prompt, the **application** controls the Resource and the **model** controls the Tool, with three owners and three primitives in a single flow. The demonstration that a Tool and a Resource can return **byte-identical payloads** because they share one renderer — *the difference is who decided to fetch them, not what came back* — plus the production checklist: authorisation before ranking, a budget that says what it cut, an audit trail that hashes arguments and records no content, and a capability flag as a promise. |



---

## [Lecture 16: Multimodal AI — How LLMs Understand Images](./Lecture%2016/notes/README.md)

- **Source Materials:**
  - PDF Slides: [`Lecture 16/notes/Notes.pdf`](./Lecture%2016/notes/Notes.pdf)
  - Excalidraw Diagrams: [`Lecture 16/notes/Excalidraw-Notes.svg`](./Lecture%2016/notes/Excalidraw-Notes.svg)
- **Hands-on Codebase:**
  - 🧱 **[Basic Code (Node.js + JavaScript)](./Lecture%2016/code/Basic%20Code)** — *how does a chat application accept a picture and still return text?* An Express server with `multer` upload handling and a `ChatService` that builds a **multipart content payload** — `[{ type: 'text' }, { type: 'image_url', url: 'data:<mime>;base64,…' }]` — keeps a **shared in-memory conversation history** so follow-up questions can reason about the same screenshot, serialises turns through a promise queue to preserve order, and commits a turn only after the API call succeeds. Express 5 · multer · OpenAI SDK · `gpt-4o-mini`
- **Complete Consolidated Notes:** [`Lecture_16_Complete_Notes.md`](./Lecture%2016/notes/Lecture_16_Complete_Notes.md) — all eight chapters condensed into one reference: the **two pipelines that converge**, the seven-step mental model, cheat sheets (pipeline · OCR vs MLLM · modalities · cost · security rules), decision tables (OCR vs multimodal LLM · early/late/cross-attention fusion · provider selection · build vs buy), a glossary, common misconceptions, 28 self-check questions with an answer key, and a go-live checklist

#### 📖 Chapter Notes Breakdown

| Chapter | Module Title | Core Topics & Key Concepts |
| :--- | :--- | :--- |
| **[Chapter 01](./Lecture%2016/notes/01_Why_Text_Only_AI_Is_Not_Enough.md)** | **Why Text-Only AI Is Not Enough** | The baseline contract `String → LLM → String` and exactly where it breaks: the user attaches `payment-error.png` and the evidence lives *inside the image*. The three silent failure modes (**silent drop**, **filename-only**, **confident guess**) and the load-bearing conclusion — *a missing modality is a missing input, not a missing instruction*. Definitions of **modality** and **multimodality**, the **multimodal vs multi-model** distinction (orthogonal axes), the modality-combination map, and the cost of the old OCR + regex workaround. |
| **[Chapter 02](./Lecture%2016/notes/02_What_Multimodal_Models_Understand_And_OCR_vs_MLLM.md)** | **What Multimodal Models Understand, and OCR vs MLLM** | The invoice example: image + instruction → **typed JSON** (structured output from a picture). The comprehension ladder — **objects · text · layout · position · relationships · context · meaning** — and the difference between *extraction* (`Payment Failed ₹7,999 Reason: Insufficient Balance`) and *understanding* (`…because the account had insufficient balance`). The full **OCR vs multimodal LLM** comparison (determinism, cost, layout, reasoning), when OCR is still correct, and the production **hybrid** pattern (OCR for truth, MLLM for meaning). |
| **[Chapter 03](./Lecture%2016/notes/03_From_Text_To_Numbers_The_Text_Pipeline.md)** | **From Text to Numbers: The Text Pipeline** | The bridge that makes images tractable: the model never sees English — only **vectors**. The board's worked example (`"HI, my name is Aditya"` → tokens → token IDs `23 41 56` → vectors `v1 v2 v3`), why token IDs carry no meaning, why embeddings are *learned lookups*, and the five-row table mapping each text stage to its image analogue (tokenization→patches, embedding→visual embedding, positional encoding→patch position, self-attention→patch attention). |
| **[Chapter 04](./Lecture%2016/notes/04_Images_Are_Numbers_Pixels_Patches_And_Visual_Embeddings.md)** | **Images Are Numbers: Pixels, Patches and Visual Embeddings** | An RGB image is already a grid of numbers (`1920 × 1080 ≈ 2.07M pixels ≈ 6.2M numbers`); why raw pixels fail (volume, no units, no abstraction, no locality, redundancy). **Step 1 — patches** (e.g. `16 × 16`) turn a 2-D grid into a 1-D sequence; the **text-token vs image-patch** analogy and its honest limits. **Step 2 — the vision encoder** turns patches into visual embeddings (`[0.12, -0.55, 1.04, 0.31, …]`), and text/visual embeddings converge on the same object: **vectors**. Plus the patch/token arithmetic (`1920×1080 @16px ≈ 8,160 visual tokens`) and ViT vs CNN. |

| **[Chapter 05](./Lecture%2016/notes/05_Connecting_Vision_To_Language_Projection_Position_And_Attention.md)** | **Connecting Vision to Language: Projection, Position and Attention** | Why visual vectors are *not* automatically compatible with the LLM (dimensionality, objective, geometry) and **Step 3 — the projection layer / adapter** (linear · MLP · resampler/Q-Former, which also compresses token count). Why **position** matters (`button below text box` ≠ `button above`; the board's `top-left … bottom-right`), object recognition as relational (`ear + eye + fur + whiskers → cat`, background suppressed), the `bank` analogy, **attention over patches**, the four cross-modal attention flows, OCR-free screenshot reading, and the precision limits (counting, coordinates, "just left of"). |
| **[Chapter 06](./Lecture%2016/notes/06_How_Models_Learn_Vision_Language_Alignment.md)** | **How Models Learn Vision-Language Alignment** | The lecture's direct question — *how does the model learn that a cat is a cat?* — answered by training on **large amounts of visual + language information**: image–caption pairs, VQA, interleaved documents. The board's `Text → Language concepts` / `Image → Visual patterns` split, the two-way association (`ears, fur, whiskers` ↕ `cat, kitten, animal, pet`), why it is a **learned geometry rather than rules**, **vision-language alignment** named, contrastive (CLIP-style) pre-training, the three training stages, frozen encoders / LoRA, and the honesty section: *a confident caption can still be wrong*. |
| **[Chapter 07](./Lecture%2016/notes/07_The_End_To_End_Multimodal_Pipeline.md)** | **The End-to-End Multimodal Pipeline** | The assembled flow — two pipelines converging at the model, output still **text tokens**. Why large images are **preprocessed** (`8000 × 6000 ≈ 187,500 patches`; resize/crop/tile/normalize; the board's `Raw Image → compress → compressed image → LLM`), why **image quality still matters**, the application boundary (*your app packages; the provider interprets* — the board's `Client —/chat→ LLM`, "Text / Image → Text"), and **conversation history with images** (the image is re-sent every turn; compaction levers). Ends with the **seven-step mental model** and the wiring details: base64 vs URL (SSRF) vs asset id, streaming silence, latency budget, multi-image/multi-page, multimodal RAG. |
| **[Chapter 08](./Lecture%2016/notes/08_Production_Multimodal_Systems_Cost_Security_And_Evaluation.md)** | **Production Multimodal Systems: Cost, Security and Evaluation** | The final takeaway — *a multimodal application does not fundamentally change how an AI application works*. **Cost**: image tokens scale with area and are re-sent per turn (`tokens × turns × users × days`), with levers ordered by impact. **Latency**: encoding happens before the first token. **Security**: **visual prompt injection** (why images are worse than text), the eight-layer defence stack, plus PII, SSRF, spoofing, poisoning and resource exhaustion. **Privacy**: redact, bound retention, log **id + hash + dimensions** — never raw pixels. **Evaluation**: a golden set from *your* images, task-specific metrics, provider comparison on your own data. **The six-step failure runbook**, a provider decision framework, and the go-live checklist. |

