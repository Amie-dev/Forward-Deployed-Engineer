# Lecture 15 — Basic Code · Implementation Guide

> **A chapter-wise, order-wise walkthrough of the `Basic Code` project.**
> Every chapter covers **one source file**: what it is for, the commands you need,
> the **complete file** verbatim, and then a **block-by-block** explanation of what
> each block does and *how* it works. Read the chapters in order — each one builds
> on the previous file.

This guide explains the runnable code behind the lecture notes
([`../../../notes`](../../../notes/README.md)). The notes explain *why* Resources
and Prompts exist; this guide explains *how the code is built*, one file at a time.

---

## What this project is

**One MCP server** that exposes all three primitives, plus **one host** that uses
them. It runs **offline with no API key**.

```text
                    ┌──────────────── HOST ────────────────┐
                    │  src/routes/index.ts  (HTTP, :8080)   │
                    │  src/client/client.ts (the MCP client)│
                    └───────────────┬──────────────────────┘
                                    │ Streamable HTTP (JSON-RPC)
                    ┌───────────────▼──────────────────────┐
                    │  SERVER  src/index.ts (:8081/mcp)     │
                    │  src/server/server.ts  createServer() │
                    ├──────────────────────────────────────┤
                    │  Tools     (model)        src/tools/      │
                    │  Resources (application)  src/resources/  │
                    │  Prompts   (user)         src/prompts/    │
                    └──────────────────────────────────────┘
```

**The one sentence that explains every design decision here:** the three
primitives are told apart by **who holds the trigger** — the **model** calls
Tools, the **application** reads Resources, the **user** selects Prompts.

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | `>= 20.0.0` | `package.json` sets `engines.node`; the code uses modern ESM, `node:` APIs and top-level `await` |
| **npm** | any recent | installs dependencies and runs the scripts |

No API key, no network, no database. Leave `OPENAI_API_KEY` empty and the client
prints the prompt it assembled instead of calling a model, so the whole Resource
and Prompt half of the protocol is still visible.

---

## Quickstart

```bash
cd "Lecture 15/code/Basic Code"

npm install        # @modelcontextprotocol/*, zod, dotenv, openai, express, tsx, typescript

npm run lifecycle  # ONE command: starts the server, walks the whole lifecycle  ← start here
npm run typecheck  # tsc --noEmit — type-checks the whole project
```

`npm run lifecycle` prints:

```text
[task-mcp-server] v1.0.0 MCP endpoint on http://127.0.0.1:8081/mcp

1. resources/list — discovery, not consumption
   task://guidelines
   task://backlog
   task://summary
   task://projects/{projectId}   (template)
   user://{userId}/profile   (template)

2. resources/read task://guidelines — a STATIC Resource
   Task Management Guidelines:
   1. Deep work tasks should preferably be done before 12 PM.
   ...

3. resources/read task://projects/fde — a TEMPLATED Resource, one definition
   Project: fde
   Tasks: 2
   - [open] Write MCP notes
   - [open] Review pull request

4. resources/read user://123/profile — a second template, same shape
   User: 123
   Open tasks: 2 of 2
   ...

5. prompts/list — which workflows exist?
   plan_day(availableHours)
   review_workload()

6. prompts/get plan_day { availableHours: "4" } — a template, not an answer
   Help me plan my pending tasks for today.
   First read my current pending tasks, then apply the task guidelines.
   I have 4 hours available today.
   ...

7. the model step, after prompts/get — GET /plan?hours=4 in miniature
   (offline — no OPENAI_API_KEY, so no model was called)
   USER:
   Help me plan my pending tasks for today.
   ...
```

To run the HTTP host (the lecture's `GET /plan?hours=4`), use **two terminals**:

```bash
# terminal 1
npm run server     # the MCP server, http://127.0.0.1:8081/mcp

# terminal 2
npm run host       # the application, http://127.0.0.1:8080
```

```bash
curl 'http://127.0.0.1:8080/plan?hours=4'
curl 'http://127.0.0.1:8080/resources'
curl 'http://127.0.0.1:8080/prompts'
curl 'http://127.0.0.1:8080/read?uri=task://summary'
curl 'http://127.0.0.1:8080/ask?message=how%20busy%20am%20I'
```

---

## The complete file structure

```text
Basic Code/
├── .env                        # local runtime values; gitignored
├── .env.example                # committed template that `.env` is copied from
├── package.json                # dependencies + the npm scripts
├── package-lock.json           # the exact dependency tree `npm install` resolved
├── tsconfig.json               # TypeScript compiler configuration
├── README.md                   # the project's own overview (short)
├── implementations guide/      # ← you are here: this chapter-wise walkthrough
└── src/
    ├── index.ts                # Chapter 09 — the MCP server process (Streamable HTTP)
    ├── config/
    │   └── config.ts           # Chapter 02 — identity, URI schemes, ports, model
    ├── server/
    │   └── server.ts           # Chapter 07 — createServer(): the "standard door"
    ├── services/
    │   ├── taskService.ts      # Chapter 03 — the data layer (tasks + text views)
    │   └── resourceSelector.ts # Chapter 05 — how the APPLICATION picks a Resource
    ├── tools/
    │   └── tools.ts            # Chapter 07 — Tools: the MODEL holds the trigger
    ├── resources/
    │   └── resources.ts        # Chapter 04 — Resources: the APPLICATION holds it
    ├── prompts/
    │   └── prompts.ts          # Chapter 06 — Prompts: the USER holds the trigger
    ├── client/
    │   └── client.ts           # Chapter 08 — the MCP client + the lifecycle walkthrough
    └── routes/
        └── index.ts            # Chapter 09 — the HTTP host: GET /plan?hours=4
```

One file per folder, and the folder name says what the file is. `services/` is the
only folder with two files, because it holds two different jobs: the data
(`taskService`) and a decision (`resourceSelector`).

---

## Chapter map

Read top to bottom. The **build order** below is the order the code actually
depends on itself: config → data → resources → selection → prompts → tools →
assembly → client → processes.

| # | Guide chapter | File(s) covered | Lecture chapters |
|---|---|---|---|
| 01 | [Project Structure & File Map](./01_Project_Structure_and_File_Map.md) | whole project, `package.json`, `tsconfig.json`, `.env` | 01 / 02 |
| 02 | [Config: Server Identity & Schemes](./02_Config_Server_Identity_and_Schemes.md) | `src/config/config.ts` | 02 / 03 |
| 03 | [Task Service: The Data Layer](./03_Task_Service_The_Data_Layer.md) | `src/services/taskService.ts` | 03 / 04 |
| 04 | [Resources: Static, Dynamic, Templated](./04_Resources_Static_Dynamic_and_Templated.md) | `src/resources/resources.ts` | 03 / 04 |
| 05 | [Resource Selection: How the App Chooses](./05_Resource_Selection_How_the_App_Chooses.md) | `src/services/resourceSelector.ts` | 05 |
| 06 | [Prompts: Reusable Templates with Arguments](./06_Prompts_Reusable_Templates_with_Arguments.md) | `src/prompts/prompts.ts` | 06 / 07 |
| 07 | [Tools & Server Assembly](./07_Tools_and_Server_Assembly.md) | `src/tools/tools.ts`, `src/server/server.ts` | 01 |
| 08 | [Client Wiring: `resources/read` & `prompts/get`](./08_Client_Wiring_resources_read_and_prompts_get.md) | `src/client/client.ts` | 07 / 08 |
| 09 | [Entry Point & Routes: `GET /plan?hours=4`](./09_Entry_Point_and_Routes_GET_plan_hours_4.md) | `src/index.ts`, `src/routes/index.ts` | 01 / 08 |

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
01 structure          → know the map before walking the streets
02 config.ts          → the constants everything else imports
03 taskService.ts     → the data every primitive reads or writes
04 resources.ts       → the APPLICATION-controlled primitive  ← Lecture 15's first half
05 resourceSelector.ts→ the decision Chapter 05 is entirely about
06 prompts.ts         → the USER-controlled primitive         ← Lecture 15's second half
07 tools.ts + server.ts → the MODEL-controlled primitive, and the assembly of all three
08 client.ts          → how a host actually reads Resources and fetches Prompts
09 index.ts + routes/ → the two processes: the server, and GET /plan?hours=4
```

> **Note on chapter numbering.** This guide numbers chapters by *file/build order*
> (Chapter 01 is the file-structure overview). The "Lecture chapters" column maps each
> guide chapter back to the corresponding chapter in
> [`../../../notes`](../../../notes/README.md).

---

## Where the lecture's own example lives in the code

| Lecture idea | Code |
|---|---|
| `task://guidelines` — the board's `company://coding-guidelines` | `src/resources/resources.ts` (static Resource) |
| `user://123/profile` — the board's dynamic user example | `src/resources/resources.ts` (templated Resource) |
| Resource anatomy: name, URI, description, MIME type, content | `src/resources/resources.ts` |
| How the application chooses a Resource | `src/services/resourceSelector.ts` |
| `prompts/list` and `prompts/get` | `src/prompts/prompts.ts` + `src/client/client.ts` |
| "Prompt ≠ LLM response" | `src/client/client.ts` (`getPromptText` vs `askModel`) |
| `GET /plan?hours=4` | `src/routes/index.ts` |
| Tools vs Resources vs Prompts, and who controls each | `src/server/server.ts` |

**Back to:** [Lecture 15 notes](../../../notes/README.md) · [Basic Code README](../README.md)

