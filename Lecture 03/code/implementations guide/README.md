# Lecture 03 Codebase: Step-by-Step Implementation Guide

Welcome to the **Step-by-Step Implementation Guide** for the [Support Ticket Summarizer Microservice](../README.md).

This guide walks you through building the entire enterprise **Node.js, Express, and TypeScript** microservice from zero to a production-ready system. Each chapter presents the exact files, terminal commands, complete code, and an exhaustive **block-by-block explanation** of how the code works under the hood.

---

## 📚 Chapter Navigation Index

| Chapter | Module & Focus | File / Component Covered | Key Concepts |
| :--- | :--- | :--- | :--- |
| **[Chapter 00](./00_Overview_and_File_Structure.md)** | **Architecture & File Structure** | Overall system topology | Layered architecture, file tree, design patterns (fail-fast, singleton, role separation). |
| **[Chapter 01](./01_Project_Initialization_and_TypeScript_Setup.md)** | **Toolchain & Setup** | `package.json`<br>`tsconfig.json`<br>`.gitignore`<br>`.env.example` | NodeNext ESM modules, TypeScript compiler options, dependency roles (`express`, `zod`, `openai`, `tsx`). |
| **[Chapter 02](./02_Environment_Configuration_and_Validation.md)** | **Config & Runtime Validation** | `src/config/env.ts` | Zod schema validation, fail-fast boot guarantees, strongly-typed config export, `.env` management. |
| **[Chapter 03](./03_OpenAI_Client_Singleton_and_Connection_Pooling.md)** | **AI Client & Transport** | `src/lib/openai.ts` | Client singleton pattern, HTTP Keep-Alive connection pooling, exponential backoff retries, timeouts. |
| **[Chapter 04](./04_Summarization_Services_and_Multi_Role_Security.md)** | **Domain Services Layer** | `src/services/summarizer.service.ts`<br>`src/services/audited.service.ts`<br>`src/services/secure.service.ts` | Dynamic prompt parameterization, token economics tracking, prompt injection vulnerability vs. multi-role defense. |
| **[Chapter 05](./05_API_Routing_and_Zod_Validation_Middleware.md)** | **Routing & Payload Guards** | `src/routes/health.routes.ts`<br>`src/routes/summarizer.routes.ts` | Zod request validation middleware, zero-cost input guards, container liveness probes, asynchronous error dispatch. |
| **[Chapter 06](./06_Express_Application_and_Server_Bootstrap.md)** | **Express Assembly & Server** | `src/app.ts`<br>`src/server.ts` | Decoupling application from listener, body parsing limits (2MB), request logging, global error handlers, startup banner. |
| **[Chapter 07](./07_CLI_Prototypes_and_Adversarial_Injection_Testing.md)** | **CLI Tooling & Security Tests** | `src/scripts/direct-prototype.ts`<br>`src/scripts/test-injection.ts` | Standalone CLI prototypes, latency benchmarking, automated adversarial prompt injection testing. |
| **[Chapter 08](./08_End_to_End_Verification_and_HTTP_Testing.md)** | **System Verification & HTTP Suite** | `test-requests.http` | Live HTTP integration tests, curl commands, token usage accounting verification, HTTP 400 error validation. |

---

## 📄 Complete Master Document

For a single consolidated document containing all implementation chapters in one file:
👉 **[Complete Master Implementation Guide](./Complete_Implementation_Guide.md)**

---

## 🛠 Recommended Build Order

1. Follow **Chapter 01** to initialize the repository and install dependencies.
2. Follow **Chapter 02** to construct `src/config/env.ts` and set up your `.env`.
3. Follow **Chapter 03** to establish the OpenAI client singleton in `src/lib/openai.ts`.
4. Follow **Chapter 04** to build the domain services in `src/services/`.
5. Follow **Chapter 05** to build the routes and validation in `src/routes/`.
6. Follow **Chapter 06** to assemble `src/app.ts` and boot the server with `src/server.ts`.
7. Follow **Chapter 07** to run CLI prototypes and adversarial security tests.
8. Follow **Chapter 08** to test all endpoints using curl or REST Client.
