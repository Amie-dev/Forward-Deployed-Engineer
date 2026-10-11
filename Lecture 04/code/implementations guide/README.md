# Lecture 04 Codebase: Step-by-Step Implementation Guide

Welcome to the **Step-by-Step Implementation Guide** for the [Enterprise Conversational AI Microservice](../README.md).

This guide walks you through building the complete production **Node.js, Express, and TypeScript** chatbot microservice from scratch. Each chapter provides the exact file paths, setup terminal commands, full source code, and an exhaustive **block-by-block explanation** detailing how the code functions under the hood.

---

## 📚 Chapter Navigation Index

| Chapter | Module & Focus | File / Component Covered | Key Concepts & Engineering Patterns |
| :--- | :--- | :--- | :--- |
| **[Chapter 00](./00_Overview_and_File_Structure.md)** | **Architecture & File Blueprint** | Master System Topology | Layered architecture, file tree, design patterns (fail-fast, state decoupling, token budgeting, SSE streaming, 7-layer defense). |
| **[Chapter 01](./01_Project_Initialization_and_TypeScript_Setup.md)** | **Toolchain & Setup** | `package.json`<br>`tsconfig.json`<br>`.gitignore`<br>`.env.example` | NodeNext ESM modules, TypeScript compiler options, dependency roles (`express`, `zod`, `openai`, `tsx`, `cors`), npm scripts. |
| **[Chapter 02](./02_Environment_Configuration_and_Validation.md)** | **Config & Runtime Validation** | `src/config/env.ts` | Zod schema validation, fail-fast boot guarantees, strongly-typed config export, `.env` management. |
| **[Chapter 03](./03_Data_Contracts_and_Type_Definitions.md)** | **Type System & Schemas** | `src/types/chat.types.ts` | Message contracts (`ChatMessage`), role schemas (`system`, `user`, `assistant`), `GroundedResponseSchema`, token budgeting metrics. |
| **[Chapter 04](./04_AI_Transport_and_Token_Budgeting_Utilities.md)** | **AI Client & Token Estimator** | `src/lib/openai.ts`<br>`src/lib/tokenizer.ts` | OpenAI client singleton, HTTP keep-alive pooling, BPE token counter heuristics, ChatML formatting overhead. |
| **[Chapter 05](./05_Session_Store_and_Application_Memory_Engine.md)** | **Session & Application Memory** | `src/services/session.store.ts` | Decoupled state tier, Application Memory pattern (persistent user dietary/VIP profiles), GDPR session eviction. |
| **[Chapter 06](./06_Context_Manager_and_Rolling_Compaction_Service.md)** | **Context Window & Compaction** | `src/services/context-manager.service.ts` | The 4 Pillars system prompt (`ROLE`, `TASK`, `BEHAVIOUR`, `CONSTRAINTS`), sliding window FIFO, rolling conversational summarization ($O(1)$ stability). |
| **[Chapter 07](./07_Real_Time_SSE_Streaming_Service.md)** | **Real-Time Streaming** | `src/services/streaming.service.ts` | Server-Sent Events (SSE) headers, HTTP chunked transfer encoding, `AbortController` client disconnection handling, simulated fallback. |
| **[Chapter 08](./08_Grounding_and_Anti_Hallucination_Guardrails.md)** | **Grounding & Guardrails** | `src/services/grounding.service.ts` | Hybrid RAG knowledge base, calibrated refusal engineering ("I don't know"), Zod structured outputs, citation verification guardrail. |
| **[Chapter 09](./09_API_Routing_Express_App_and_Server_Bootstrap.md)** | **API Routing & App Assembly** | `src/routes/health.routes.ts`<br>`src/routes/chat.routes.ts`<br>`src/app.ts`<br>`src/server.ts` | Express REST/SSE routing, Zod input validation middleware, global error handling, liveness probe, graceful process termination. |
| **[Chapter 10](./10_CLI_Chatbot_and_Adversarial_Testing_Scripts.md)** | **CLI Tooling & Test Suites** | `src/scripts/cli-chat.ts`<br>`src/scripts/test-hallucination.ts`<br>`src/scripts/test-context-bloat.ts` | Interactive terminal chatbot CLI, automated hallucination/sycophancy test suite (Aditya Tandon sorting law), 20-turn context bloat benchmark. |
| **[Chapter 11](./11_End_to_End_Verification_and_HTTP_Testing.md)** | **Verification & HTTP Suite** | `test-requests.http` | Live HTTP integration tests, curl commands, verifying multi-turn pronoun resolution, SSE streaming, and adversarial refusals. |

---

## 📄 Complete Master Document

For a single consolidated document containing all implementation chapters in one file:
👉 **[Complete Master Implementation Guide](./Complete_Implementation_Guide.md)**

---

## 🛠 Recommended Build Order

1. **Chapter 01:** Initialize the project toolchain (`package.json`, `tsconfig.json`, `.env.example`).
2. **Chapter 02:** Implement boot-time environment validation (`src/config/env.ts`).
3. **Chapter 03:** Define strongly-typed schemas and message contracts (`src/types/chat.types.ts`).
4. **Chapter 04:** Build the OpenAI client singleton and token estimator (`src/lib/openai.ts`, `src/lib/tokenizer.ts`).
5. **Chapter 05:** Implement the session store and application memory tier (`src/services/session.store.ts`).
6. **Chapter 06:** Construct the context manager with sliding window and rolling compaction (`src/services/context-manager.service.ts`).
7. **Chapter 07:** Build the Server-Sent Events (SSE) streaming engine (`src/services/streaming.service.ts`).
8. **Chapter 08:** Implement the hybrid RAG grounding and anti-hallucination guardrail (`src/services/grounding.service.ts`).
9. **Chapter 09:** Assemble API routers, Express middleware, and server listener (`src/routes/`, `src/app.ts`, `src/server.ts`).
10. **Chapter 10:** Create developer CLI tools and adversarial test scripts (`src/scripts/`).
11. **Chapter 11:** Verify the end-to-end microservice with HTTP test suites and curl commands (`test-requests.http`).
