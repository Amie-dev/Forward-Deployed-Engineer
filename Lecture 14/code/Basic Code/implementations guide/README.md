# Lecture 14 — Basic Code · Implementation Guide

> **A chapter-wise, order-wise walkthrough of the `Basic Code` project.**
> Every chapter covers **one source file**: what it is for, the commands you need,
> the **complete file** verbatim, and then a **block-by-block** explanation of what
> each block does and *how* it works. Read the chapters in order — each one builds
> on the previous file.

This guide explains the runnable code behind the lecture notes
([`../../../notes`](../../../notes/README.md)). The notes explain *why* MCP exists;
this guide explains *how the code is built*, one file at a time.

---

## What this project is

A single, offline, **no-API-key** Model Context Protocol (MCP) project with two halves:

```text
                 ┌──────────────────────────── HOST (src/client/client.ts) ───────────────────────────┐
                 │  owns the conversation, spawns ONE client, drives the lifecycle                      │
                 │                                                                                      │
                 │   Client ──stdio(JSON-RPC)──▶ SERVER (src/index.ts → src/server/server.ts)          │
                 │                                    ├── Tools     (do)     src/tools/tools.ts         │
                 │                                    ├── Resources (know)   src/resources/resources.ts │
                 │                                    └── Prompts   (reuse)  src/prompts/prompts.ts      │
                 └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **The server** exposes all three MCP primitives: **Tools** (*do*), **Resources** (*know*),
  **Prompts** (*reuse*).
- **The host/client** discovers and invokes them. There is no LLM in this project —
  the client stands in for the model *deterministically*, so the entire lifecycle
  (`tools/list → tools/call → resources/read → prompts/get`) is reproducible on any machine.

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | `>= 20.0.0` | `package.json` sets `engines.node`; the code uses modern ESM + `node:` APIs |
| **npm** | any recent | installs dependencies and runs the scripts |

No API key, no network, no database. Everything runs locally.

---

## Quickstart

```bash
cd "Lecture 14/code/Basic Code"

npm install        # install dependencies (tsx, typescript, @modelcontextprotocol/*, zod, dotenv)

npm run client     # HOST + CLIENT: the full lifecycle, printed step by step  ← start here
npm run server     # the SERVER alone, listening on stdio (waits for a client)
npm run dev        # server with auto-reload while you edit
npm run typecheck  # tsc --noEmit — type-checks the whole project
```

`npm run client` prints (this is the whole protocol lifecycle in one screen):

```text
[task-mcp-server] v1.0.0 listening on stdio

1. tools/list -> create_task, list_tasks, complete_task
2. tools/call create_task -> Task #1 created: Record MCP Video (PENDING)
3. tools/call complete_task (unknown title) -> isError=true No pending task titled "No such task". Call list_tasks to read the exact titles, then retry.
   tools/call complete_task (exact title)   -> Task completed: Record MCP Video (COMPLETED)

4. resources/list -> company://policies/return-policy, company://policies/refund-policy
   resources/read company://policies/return-policy -> 1 content block(s)

5. prompts/list -> review_pull_request
   prompts/get review_pull_request -> {"type":"text","text":"You are reviewing pull request #42. ..."}
```

---

## Chapter map

Read top to bottom. Each chapter is one file; the **build order** below is the order
the code actually depends on itself (config → server → service → primitives → entry → client).

| # | Guide chapter | File covered | Lecture chapter |
|---|---|---|---|
| 01 | [Project Structure & File Map](./01_Project_Structure_and_File_Map.md) | whole project, `package.json`, `tsconfig.json`, `.env` | 01 / 02 |
| 02 | [Config: Server Identity & Transport](./02_Config_Server_Identity_and_Transport.md) | `src/config/config.ts` | 02 / 04 / 06 |
| 03 | [Server: The Standard Door](./03_Server_The_Standard_Door.md) | `src/server/server.ts` | 02 / 04 |
| 04 | [Task Service: The Execution Layer](./04_Task_Service_Execution_Layer.md) | `src/services/taskService.ts` | 05 / 07 |
| 05 | [Tools: The Tools Primitive](./05_Tools_The_Tools_Primitive.md) | `src/tools/tools.ts` | 05 |
| 06 | [Resources: Addressable Context](./06_Resources_Addressable_Context.md) | `src/resources/resources.ts` | 06 |
| 07 | [Prompts: Reusable Instructions](./07_Prompts_Reusable_Instructions.md) | `src/prompts/prompts.ts` | 06 |
| 08 | [Entry Point: STDIO Transport](./08_Entry_Point_STDIO_Transport.md) | `src/index.ts` | 04 |
| 09 | [Client & Host: The Lifecycle](./09_Client_Host_and_Lifecycle.md) | `src/client/client.ts` | 03 / 04 / 07 |

---

## How each chapter is structured

Every chapter follows the same six-part shape so you can follow along mechanically:

1. **File details** — path, purpose, imports/exports, and the lecture section it implements.
2. **Commands** — the exact command(s) to run this piece in isolation (when it makes sense).
3. **Full file** — the complete, verbatim source (never a snippet).
4. **Block-by-block explanation** — the file is split into numbered blocks; for each block you
   get *what it does* and *how it works*.
5. **Run / verify** — the command and the output you should see.
6. **Checkpoint** — the two or three things you must understand before moving on.

---

## The order, and why

```text
01 structure      → know the map before walking the streets
02 config.ts      → the server's identity + transport + URI scheme (the constants everything else uses)
03 server.ts      → createServer(): assembles the three primitives behind one door
04 taskService.ts → the deterministic business logic (what the tools actually do)
05 tools.ts       → the Tools contract the MODEL reads (do)
06 resources.ts   → the Resources the APPLICATION reads (know)
07 prompts.ts     → the Prompts the USER selects (reuse)
08 index.ts       → binds the assembled server to STDIO (the process entry point)
09 client.ts      → the HOST + CLIENT that spawns the server and drives the whole lifecycle
```

> **Note on chapter numbering.** This guide numbers chapters by *file/build order* (Chapter 01 is
> the file-structure overview you asked to start with). The "Lecture chapter" column maps each
> guide chapter back to the corresponding chapter in [`../../../notes`](../../../notes/README.md).

**Back to:** [Lecture 14 notes](../../../notes/README.md) · [Basic Code README](../README.md)
