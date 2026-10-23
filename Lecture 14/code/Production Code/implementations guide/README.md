# Lecture 14 — Production Code · Implementation Guide

> **Read this guide top to bottom and you will have built, file by file, a
> production-shaped MCP server and the host that governs it.** Every chapter
> covers exactly one source file: what it is, why it exists, the **complete
> source**, then a block-by-block explanation of how each block works, and how to
> verify it.

This is the companion to the
**[Basic Code guide](../../Basic%20Code/implementations%20guide/README.md)**.
Basic Code teaches the protocol; this guide teaches the protocol *plus* the
responsibilities Chapter 08 says the protocol does not remove.

---

## Prerequisites

```bash
cd "Lecture 14/code/Production Code"
npm install
npm run typecheck     # tsc --noEmit — must exit 0 before you start
```

Runtime used for every output quoted in this guide:

```text
Node v24.22.0 · tsx 4.23.15 · tsc 5.9.3
@modelcontextprotocol/server 2.3.1 · @modelcontextprotocol/client 2.3.1
```

---

## The two commands you will use throughout

```bash
npm run host     # HOST + CLIENT: the full lifecycle, printed step by step  ← start here
npm run server   # the SERVER alone, listening on stdio (waits for a client)
```

`npm run host` ends with an audit table. Two rows carry the **same `argsHash`**
because one was an idempotent replay; two more carry the same hash with different
outcomes because the *user's answer* changed, not the request (excerpt — the full
run prints eight rows):

```text
10. audit      -> every decision, with hashed arguments
   time         tool           decision  outcome  argsHash          ms
   11:02:50.737 create_task    auto      ok       57036086e66b5396  33
   11:02:50.741 create_task    auto      ok       57036086e66b5396  2
   11:02:50.746 complete_task  auto      error    aa0c17ac393b495d  3
   11:02:50.752 delete_task    confirm   denied   9e7e65453739bbc6  0
   11:02:50.758 delete_task    confirm   ok       9e7e65453739bbc6  5
```

---

## How each chapter is structured

Every chapter follows the same six-part shape, so you can follow along
mechanically:

1. **File details** — path, layer, purpose, imports/exports, and the lecture
   section it implements.
2. **Commands** — the exact command(s) to exercise this piece in isolation.
3. **Full file** — the complete, verbatim source. Never a snippet.
4. **Block-by-block explanation** — the file split into numbered blocks; for each
   block, *what it does* and *how it works*.
5. **Run / verify** — the command and the output you should see.
6. **Checkpoint** — the two or three things to understand before moving on.

---

## Chapter map

Read top to bottom. The order is the order the code depends on itself: config →
core → domain → service → MCP primitives → assembly → entry → host.

| # | Guide chapter | File covered | Lecture chapter |
| :---: | :--- | :--- | :--- |
| 01 | [Project Structure & File Map](./01_Project_Structure_and_File_Map.md) | whole project, `package.json`, `tsconfig.json`, `.env` | 01 / 02 |
| 02 | [Config: The Validated Environment](./02_Config_Validated_Environment.md) | `src/config/env.ts` | 02 / 08 |
| 03 | [Core: Structured Logging & Redaction](./03_Core_Structured_Logging.md) | `src/core/logger.ts` | 08 |
| 04 | [Core: Metrics Without a Vendor](./04_Core_Metrics.md) | `src/core/metrics.ts` | 08 |
| 05 | [Core: The Error Taxonomy](./05_Core_Error_Taxonomy.md) | `src/core/errors.ts` | 05 |
| 06 | [Core: Execution Guards](./06_Core_Execution_Guards.md) | `src/core/guards.ts` | 08 |
| 07 | [Domain: The Task Store & Idempotency](./07_Domain_Task_Store.md) | `src/domain/taskStore.ts` | 07 / 08 |
| 08 | [Service: Validated Business Logic](./08_Services_Task_Service.md) | `src/services/taskService.ts` | 05 / 08 |
| 09 | [MCP: The Wiring Contract](./09_Mcp_Wiring_Contract.md) | `src/mcp/deps.ts` | 08 |
| 10 | [MCP: The Tools Primitive](./10_Mcp_Tools.md) | `src/mcp/tools.ts` | 05 |
| 11 | [MCP: Resources & Templates](./11_Mcp_Resources.md) | `src/mcp/resources.ts` | 06 |
| 12 | [MCP: Prompts](./12_Mcp_Prompts.md) | `src/mcp/prompts.ts` | 06 |
| 13 | [MCP: Server Assembly](./13_Mcp_Server_Assembly.md) | `src/mcp/server.ts` | 02 / 04 |
| 14 | [Entry Point: STDIO & Shutdown](./14_Entry_Point_Stdio.md) | `src/index.ts` | 04 |
| 15 | [Host: Policy, Consent & Filtering](./15_Host_Policy.md) | `src/host/policy.ts` | 08 |
| 16 | [Host: The Audit Trail](./16_Host_Audit.md) | `src/host/audit.ts` | 08 |
| 17 | [Host: The Lifecycle](./17_Host_Client_Lifecycle.md) | `src/host/client.ts` | 03 / 04 / 07 |

---

## The build order, and why

```text
01 structure        → know the map before walking the streets
02 config/env.ts    → every knob validated once, at boot; a bad value stops the process
03 core/logger.ts   → stdout is the protocol channel, so every log line goes to stderr
04 core/metrics.ts  → counters and latency, so an incident can be answered with numbers
05 core/errors.ts   → the two error mechanisms, and why a failure must name the recovery
06 core/guards.ts   → the two budget guards: rate limit and timeout
07 domain/taskStore → state plus idempotency keys (a retry must not duplicate)
08 services/…       → business rules, re-validated, throwing recovery-carrying errors
09 mcp/deps.ts      → the wiring contract, so primitives are testable without a transport
10 mcp/tools.ts     → the Tools contract the MODEL reads, behind one guard()
11 mcp/resources.ts → the Resources the APPLICATION reads, static and templated
12 mcp/prompts.ts   → the Prompts the USER selects
13 mcp/server.ts    → createServer(): capabilities, instructions, and the composition root
14 index.ts         → binds the assembled server to STDIO, plus graceful shutdown
15 host/policy.ts   → discovery is an inventory, not a grant: auto / confirm / never shown
16 host/audit.ts    → the record, with hashed arguments instead of PII
17 host/client.ts   → the HOST: handshake → discovery → policy → consent → invoke → audit
```

> **Note on chapter numbering.** This guide numbers chapters by *file/build order*
> (Chapter 01 is the file-structure overview). The "Lecture chapter" column maps
> each guide chapter back to the corresponding chapter in
> [`../../../notes`](../../../notes/README.md).

---

## What was verified, and how

Every claim in this guide was produced by running the code:

| Check | Command | Result |
| :--- | :--- | :--- |
| Types | `npm run typecheck` | `tsc --noEmit` exits **0** |
| Full lifecycle | `npm run host` | 10 numbered steps, exit **0** |
| Policy branch: hidden tool | `MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host` | `3 of 4 tools shown`, `delete_task` **denied** |
| Config fail-fast | `MCP_TOOL_TIMEOUT_MS=abc npm run server` | `refusing to start — invalid environment`, exit **1** |
| Raw protocol | `printf … \| npm run server --silent` | `initialize` returns capabilities + `instructions` |

**Back to:** [Production Code README](../README.md) · [Basic Code guide](../../Basic%20Code/implementations%20guide/README.md) · [Lecture 14 notes](../../../notes/README.md)

**Next:** [Chapter 01 — Project Structure & File Map](./01_Project_Structure_and_File_Map.md)
