# Chapter 01 — Project Structure and File Map

> **Before a single line of logic:** what is in the project, what each file is
> *for*, and why the folders are named the way they are. Getting this right first
> is what makes the remaining ten chapters readable — every later chapter is
> "here is one file, and here is why it is shaped like that".
>
> The structure of a security project is itself a security decision, so this
> chapter is not admin. Read the "why these folders" table at the end before you
> move on.

---

## Project details

| | |
| :--- | :--- |
| **Project** | `Lecture 19/code/Basic Code` |
| **Shape** | 19 TypeScript files, ~2,515 lines, one folder per concern |
| **Runtime** | Node ≥ 20, ESM, `tsx` executes TypeScript directly (no build step) |
| **Framework** | Express 5 for the HTTP surface |
| **Runs offline** | yes — the model is a deterministic stand-in that is *persuadable*, so every attack is reproducible |
| **Implements** | the nine chapters of [`../../../notes`](../../../notes/README.md) |

---

## Commands

```bash
cd "Lecture 19/code/Basic Code"
npm install
npm run typecheck     # tsc --noEmit — exit 0 before you start
npm run demo          # the eight attacks, then the safety gate
npm start             # the HTTP surface on :8080
```

---

## The tree

```text
Basic Code/
├── .env                              # local config (gitignored; see .env.example)
├── .env.example                      # the same keys, documented by chapter
├── package.json                      # scripts + dependencies
├── package-lock.json                 # resolved versions
├── tsconfig.json                     # the compiler rules that make the rest safe
├── README.md                         # what the project is, and the two commands that show it
├── implementations guide/            # ← you are here
└── src/
    ├── index.ts                      # Ch11 — the HTTP entry point
    ├── cli.ts                        # Ch10 — `npm run demo`, and the exit code CI reads
    ├── config/
    │   └── config.ts                 # Ch02 — guardrail switches, limits, canary token
    ├── domain/
    │   ├── types.ts                  # Ch02 — the vocabulary: assets, tiers, trace, session
    │   └── data.ts                   # Ch02 — orders, customers, policies, the poisoned note
    ├── middleware/
    │   └── requestContext.ts         # Ch02 — a request id on every request
    ├── controllers/
    │   ├── chatController.ts         # Ch11 — POST /chat
    │   └── securityController.ts     # Ch11 — /security, /audit, /scenarios, /attack/:id
    ├── routes/
    │   └── index.ts                  # Ch11 — the route table, and the 404
    ├── utils/
    │   └── text.ts                   # Ch04 — the one definition of "content terms"
    └── services/
        ├── audit.ts                  # Ch02 — the security trace
        ├── model.ts                  # Ch03 — the model: persuadable stand-in, or a real one
        ├── knowledgeBase.ts          # Ch04 — retrieval: the indirect-injection channel
        ├── tools.ts                  # Ch05 — four tools, with tiers and schemas
        ├── router.ts                 # Ch06 — the capability map
        ├── policy.ts                 # Ch07 — validation, authorization, confirmation
        ├── guardrails.ts             # Ch08 — the four layers
        ├── agent.ts                  # Ch09 — the safe loop
        └── scenarios.ts              # Ch10 — the eight attacks, as data
```

---

## What each file is for

| File | Layer | Its one job |
| :--- | :--- | :--- |
| `src/index.ts` | entry | bind a port and say so |
| `src/cli.ts` | entry | run the eight attacks and exit non-zero if a forbidden effect executed |
| `src/config/config.ts` | config | read the environment; own the guardrail switches and the limits |
| `src/domain/types.ts` | domain | the *shapes*: `Trace`, `ToolCall`, `SecurityEvent`, `Session`, `Confirmation` |
| `src/domain/data.ts` | domain | the orders, the customers, the policy corpus, and the one untrusted document |
| `src/middleware/requestContext.ts` | HTTP | give every request an id and log the outcome |
| `src/controllers/chatController.ts` | HTTP | read `{ user, message }`, build the session, return the answer *and* the trace |
| `src/controllers/securityController.ts` | HTTP | serve the security model, the audit log, and the attack endpoints |
| `src/routes/index.ts` | HTTP | the route table, and the 404 |
| `src/utils/text.ts` | utils | the one definition of "content terms" and "overlap" |
| `src/services/audit.ts` | services | the security trace: create, record, summarise, remember |
| `src/services/model.ts` | services | the model, behind an interface that cannot execute anything |
| `src/services/knowledgeBase.ts` | services | question in, ranked documents out — the delivery channel |
| `src/services/tools.ts` | services | the four tools, with a tier, an asset class and a schema each |
| `src/services/router.ts` | services | one intent, one capability set, decided before the model runs |
| `src/services/policy.ts` | services | validation, authorization, and confirmation with a fingerprint |
| `src/services/guardrails.ts` | services | the four layers, as four small functions |
| `src/services/agent.ts` | services | the safe loop: the whole lecture in one method |
| `src/services/scenarios.ts` | services | the eight attacks, and what each one must not execute |

---

## Why these folders, and not others

| Folder | Why it is separate |
| :--- | :--- |
| `domain/` | The data model is *the threat model's vocabulary*. Nothing in `domain/` imports a service, so the five asset classes, the three tool tiers and the shape of a trace can be read without reading any machinery. |
| `services/` | Everything that does work. **No file here imports Express** — which is what lets `npm run demo` run the whole attack suite with no server (Chapter 09 §9.13). |
| `config/` | The guardrail switches are the *subject* of the lecture, not infrastructure. Putting them in one readable file fed by the environment is what makes "turn a layer off and watch" a one-word command. |
| `controllers/` | The HTTP boundary: read a request, build the session, call a service, shape a response. No security logic. |
| `routes/` | The route table, and the 404. A path plus a method. |
| `middleware/` | Cross-cutting concerns. Here, the request id — the precondition for the audit log being joinable. |
| `utils/` | One pure function with two callers. It lives in `utils/` rather than `services/` because it does no work of its own. |

**The dependency direction is one-way:** `routes → controllers → services → domain`,
with `config` readable from anywhere. Nothing in `services/` knows that HTTP
exists, and nothing in `domain/` knows that anything else exists at all.

That one-way rule is what makes Chapter 09 readable: `agent.ts` is the only file
that knows about all of the layers, because it is the only file whose job is to
put them in order.

---

## `package.json` (the full file)

**Path:** `Basic Code/package.json`

```json
{
  "name": "lecture-19-genai-security",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 19 — GenAI Security & Guardrails: Prompt Injection, Jailbreaks & Safe Tool Use. The minimum runnable code behind the notes: a ShopX support agent whose retrieval channel is untrusted, a capability router, argument validation, authorization, confirmation, four guardrail layers and a security trace — so you can watch a prompt injection get proposed by the model and refused by the code.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "demo": "tsx src/cli.ts",
    "typecheck": "tsc --noEmit"
  },
  "keywords": [
    "fde",
    "genai-security",
    "prompt-injection",
    "jailbreak",
    "guardrails",
    "least-privilege",
    "tool-calling",
    "defense-in-depth",
    "typescript"
  ],
  "author": "Forward Deployed Engineering Team",
  "license": "MIT",
  "dependencies": {
    "dotenv": "^16.4.7",
    "express": "^5.3.0",
    "openai": "^6.0.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.13.8",
    "tsx": "^4.23.15",
    "typescript": "^5.9.3"
  }
}
```

**How it works, block by block**

| Block | What it does and why |
| :--- | :--- |
| `"type": "module"` | ESM. This is why every import in this project ends in `.js` even though the files are `.ts` — under `NodeNext`, the import specifier is the *runtime* path, and `tsx` maps it back to the source. |
| `"engines": { "node": ">=20" }` | `structuredClone` (used to reset the fixtures) is Node 17+, and `Array.prototype.at` (used by the stand-in model) is Node 16+. Saying 20 makes both safe. |
| `"demo": "tsx src/cli.ts"` | The important script. It runs the whole attack suite **with no server**, which is Chapter 09 §9.13's point: a security test that needs infrastructure is a security test that runs less often. |
| `"typecheck": "tsc --noEmit"` | No build step, so this is the only compile-time gate. Run it before you run anything else. |
| `dependencies` | Three, and each one is load-bearing: `dotenv` reads the guardrail switches, `express` is the surface, `openai` is the second `ModelClient`. |
| `devDependencies` | `tsx` to run TypeScript directly, `typescript` for the gate, and the two `@types` packages. |

---

## `tsconfig.json` (the full file)

**Path:** `Basic Code/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**How it works, block by block**

| Block | What it does and why |
| :--- | :--- |
| `"strict": true` | The one setting that matters here. In a security project, `strict` is not style: it is what makes `tool === undefined` a case you are *forced* to handle in `Agent.handle`, and that check is the difference between "the model proposed a tool that does not exist" being a refusal and being a crash. |
| `"module"`/`"moduleResolution": "NodeNext"` | The ESM pair. Together they require the `.js` extension on relative imports, which is what keeps the source runnable by `node` directly if you ever compile it. |
| `"target": "ES2022"` | Gives you `structuredClone`, `Array.at`, and top-level `await` (used in `cli.ts`). |
| `"noEmit"` is *not* here | `npm run typecheck` passes `--noEmit` on the command line, and `outDir`/`declaration`/`sourceMap` stay in the config so `npx tsc` still produces a usable `dist/` if you want one. |
| `"include": ["src/**/*"]` | Only `src`. The implementation guide is Markdown and must never be type-checked. |

---

## `.env` and `.env.example` (the full files)

**Path:** `Basic Code/.env.example` (committed template)

```dotenv
# Lecture 19 — GenAI Security & Guardrails: Prompt Injection, Jailbreaks & Safe Tool Use
# Copy to `.env` and adjust if needed.
#
# Every value below has a default, so the code runs with this file absent.

# Chapter 06 §6.2 — the HTTP surface.
PORT=8080
HOST=127.0.0.1

# Chapter 04 §4.3 — how many documents retrieval returns. The untrusted
# "customer note" is only reachable because retrieval returns more than one
# document: RETRIEVAL_TOPK=1 hides the indirect-injection channel.
RETRIEVAL_TOPK=2

# Chapter 09 §9.4–9.7 — the four guardrail layers. Turning one off is the whole
# demonstration: it shows which layer was actually protecting you, and which
# layers are only filters.
GUARDRAIL_INPUT=true
GUARDRAIL_INSTRUCTIONS=true
GUARDRAIL_ACTIONS=true
GUARDRAIL_OUTPUT=true

# Chapter 08 §8.6 — confirmation. A high-impact write above this amount cannot
# execute on the model's word alone; it becomes a pending confirmation.
AUTO_APPROVE_LIMIT=5000

# Chapter 06 §6.3 — the tool-call budget. A loop with no ceiling is a denial of
# service waiting to happen. 4 is enough for the indirect-injection demo, where a
# blocked injected call is followed by the legitimate one.
MAX_TOOL_CALLS=4

# Chapter 02 §2.3 — the canary token. It lives in the system prompt, so if it
# ever appears in an answer the prompt has leaked. The output guardrail watches
# for it (Chapter 09 §9.7).
CANARY_TOKEN=CANARY-7f3a91

# Chapter 01 §1.2 — the model. Leave OPENAI_API_KEY empty and everything still
# runs: the model falls back to a deterministic stand-in that is *persuadable*
# on purpose, so every attack in the demo is reproducible with no API key.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

**Path:** `Basic Code/.env` (your local copy — gitignored, same keys)

```dotenv
# Lecture 19 — GenAI Security & Guardrails (Basic Code)
# Local runtime values. Same keys as `.env.example`, which documents each one.
PORT=8080
HOST=127.0.0.1

RETRIEVAL_TOPK=2

GUARDRAIL_INPUT=true
GUARDRAIL_INSTRUCTIONS=true
GUARDRAIL_ACTIONS=true
GUARDRAIL_OUTPUT=true

AUTO_APPROVE_LIMIT=5000
MAX_TOOL_CALLS=4
CANARY_TOKEN=CANARY-7f3a91

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

**How it works, block by block**

| Block | What it does and why |
| :--- | :--- |
| `GUARDRAIL_*` | Four booleans, one per layer. **This is the most important part of the file.** A security layer you cannot switch off is a layer you cannot measure, and the demo's whole argument — "the filter was never the control" — needs `GUARDRAIL_INSTRUCTIONS=false` to be a single word. |
| `RETRIEVAL_TOPK=2` | A *retrieval* setting with a security consequence, which is Chapter 04 §4.3's uncomfortable point. At `2`, the untrusted customer note and a policy document both enter the context. |
| `AUTO_APPROVE_LIMIT=5000` | The confirmation threshold. Alice's `ORD-101` totals INR 2,500 (executes); Bob's `ORD-202` totals INR 9,800 (becomes a pending confirmation). One number decides which of the two demos you get. |
| `MAX_TOOL_CALLS=4` | The loop ceiling. Four is chosen so the `indirect-no-filter` scenario can do all of: get an injected call refused, get an injected capability refused, read the order, and refund it. |
| `CANARY_TOKEN` | Chapter 02 §2.3's technique. It is in the system prompt and the output layer looks for it, which turns "did the prompt leak?" into a boolean. |
| `OPENAI_API_KEY=` (empty) | Empty means offline. Everything — including every attack — still runs. |

---

## Checkpoint

Before Chapter 02, you should be able to answer:

1. Which folder would a new *security rule* go in, and which folder would a new
   *data shape* go in?
2. Why does `services/` deliberately not import Express?
3. Which environment variable would you change to make the indirect-injection
   channel disappear, and why is that a security decision rather than a
   performance one?
4. Which script runs the whole attack suite, and what does its exit code mean?

---

**Back to:** [Guide index](./README.md) · [Basic Code README](../README.md)

**Next:** [Chapter 02 — The Threat Model and the Security Trace](./02_Threat_Model_And_The_Security_Trace.md)
