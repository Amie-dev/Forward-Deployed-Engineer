# Chapter 01 — Project Structure and File Map

> **Before a single line of logic:** what is in the project, what each file is *for*,
> and why the folders are named the way they are. Getting this right first is what
> makes the remaining nine chapters readable — every later chapter is "here is one
> file, and here is why it is shaped like that".

---

## Project details

| | |
| :--- | :--- |
| **Project** | `Lecture 18/code/Basic Code` |
| **Shape** | 18 TypeScript files, ~1,760 lines, one folder per concern |
| **Runtime** | Node ≥ 20, ESM, `tsx` executes TypeScript directly (no build step) |
| **Framework** | Express 5 for the HTTP surface |
| **Runs offline** | yes — the model is a deterministic stand-in, so every number is reproducible |
| **Implements** | the eight chapters of [`../../../notes`](../../../notes/README.md) |

---

## Commands

```bash
cd "Lecture 18/code/Basic Code"
npm install
npm run typecheck     # tsc --noEmit — exit 0 before you start
npm run eval          # the four-layer pipeline, then the release gate
npm start             # the HTTP surface on :8080
```

---

## The tree

```text
Basic Code/
├── .env                            # local config (gitignored; see .env.example)
├── .env.example                    # the same keys, documented by chapter
├── package.json                    # scripts + dependencies
├── package-lock.json               # resolved versions
├── tsconfig.json                   # the compiler rules that make the rest safe
├── README.md                       # what the project is, and the two commands that show it
├── implementations guide/          # ← you are here
└── src/
    ├── index.ts                    # Ch10 — the HTTP entry point
    ├── cli.ts                      # Ch09 — `npm run eval`, and the exit code CI reads
    ├── config/
    │   └── config.ts               # Ch02 — env, thresholds, and the app version
    ├── domain/
    │   ├── types.ts                # Ch02 — the shapes an eval is made of
    │   └── dataset.ts              # Ch03 + Ch05 — the policy corpus and the 9 golden cases
    ├── middleware/
    │   └── requestContext.ts       # Ch04 — a trace id on every request
    ├── controllers/
    │   ├── chatController.ts       # Ch10 — POST /chat
    │   └── evalController.ts       # Ch10 — GET /dataset, GET /eval
    ├── routes/
    │   └── index.ts                # Ch10 — the route table, and the 404
    └── services/
        ├── text.ts                 # Ch06 — the one definition of "content terms"
        ├── model.ts                # Ch07 — the model: offline stand-in, or a real one
        ├── knowledgeBase.ts        # Ch03 — retrieval, ranked, with a score and a rank
        ├── tools.ts                # Ch03 — the three tools and their fixtures
        ├── supportAgent.ts         # Ch04 — the application under test
        ├── deterministic.ts        # Ch06 — Layer 1: the eight checks
        ├── judge.ts                # Ch07 — Layer 2: the rubric and the five metrics
        ├── pipeline.ts             # Ch08 — Layers 1–4, per case
        └── report.ts               # Ch09 — the report, the aggregation, and the gate
```

---

## What each file is for

| File | Layer | Its one job |
| :--- | :--- | :--- |
| `src/index.ts` | entry | bind a port and say so |
| `src/cli.ts` | entry | run the offline pipeline and exit non-zero when the gate blocks |
| `src/config/config.ts` | config | read the environment; own the thresholds; produce the `appVersion` string |
| `src/domain/types.ts` | domain | the *shapes*: `Trace`, `AgentResponse`, `GoldenCase`, `CaseResult`, `EvalReport` |
| `src/domain/dataset.ts` | domain | the policy corpus **and** the nine golden cases |
| `src/middleware/requestContext.ts` | HTTP | give every request a trace id, and log the outcome |
| `src/controllers/chatController.ts` | HTTP | read `{ message }`, call the agent, return the answer *and* the trace |
| `src/controllers/evalController.ts` | HTTP | expose the dataset and run the pipeline on demand |
| `src/routes/index.ts` | HTTP | the route table, and the 404 |
| `src/services/text.ts` | services | the one definition of "content terms" and "overlap" |
| `src/services/model.ts` | services | the model: an offline stand-in, or a real one, behind one interface |
| `src/services/knowledgeBase.ts` | services | question in, ranked documents out |
| `src/services/tools.ts` | services | the three tools, and the fixtures behind them |
| `src/services/supportAgent.ts` | services | the application under test: route → retrieve → tool → answer, traced |
| `src/services/deterministic.ts` | services | Layer 1: the eight checks that need no model |
| `src/services/judge.ts` | services | Layer 2: the rubric and the five metrics |
| `src/services/pipeline.ts` | services | Layers 1–4, per case, over the whole dataset |
| `src/services/report.ts` | services | aggregate, name the failures, decide the gate |

---

## Why these folders, and not others

| Folder | Why it is separate |
| :--- | :--- |
| `domain/` | The data model and the dataset are *the specification*. Nothing in `domain/` imports a service, so the vocabulary of the whole lecture can be read without reading the machinery. |
| `services/` | Everything that does work. **No file here imports Express** — which is what lets `npm run eval` gate a commit with no server running (Chapter 08 §8.5). |
| `config/` | Thresholds are product decisions (Chapter 08 §8.4). Putting them in one readable file, fed by the environment, is what makes them reviewable. |
| `controllers/` | The HTTP boundary: read a request, call a service, shape a response. No evaluation logic. |
| `routes/` | The route table, and the 404. A path plus a method. |
| `middleware/` | Cross-cutting concerns. Here, the trace id — Chapter 03 §3.6's correlation requirement, in its smallest useful form. |

**The dependency direction is one-way:** `routes → controllers → services → domain`,
with `config` readable from anywhere. Nothing in `services/` knows that HTTP exists,
and nothing in `domain/` knows that anything else exists at all.

---

## `package.json`

```json
{
  "name": "lecture-18-ai-application-testing",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 18 — AI Application Testing: Deterministic Evals & LLM-as-a-Judge. The minimal, runnable code behind the notes: an observable support agent (AgentResponse + trace), a golden dataset, deterministic checks, an LLM-as-a-judge with five metrics, the four-layer pipeline, and per-metric thresholds feeding a release gate.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "eval": "tsx src/cli.ts",
    "typecheck": "tsc --noEmit"
  },
  "keywords": [
    "fde",
    "ai-application-testing",
    "evals",
    "deterministic-evaluation",
    "llm-as-a-judge",
    "observability",
    "traces",
    "golden-dataset",
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

### Block-by-block

**`"type": "module"`** — the whole project is ESM. Every relative import therefore
ends in `.js` even though the file on disk is `.ts`. That looks wrong the first time
and is not: TypeScript's `NodeNext` resolution requires the *emitted* specifier, and
`tsx` maps it back to the `.ts` source. Get this wrong and `tsc` will be happy while
`node` cannot find the module.

**The four scripts are the whole interface to the project.**

| Script | What it is for | Which chapter it demonstrates |
| :--- | :--- | :--- |
| `npm run eval` | the offline pipeline and the gate — the one that matters | 07, 08 |
| `npm start` | the HTTP surface, so the agent can be run by hand | 02 §2.4, 03 |
| `npm run dev` | the same, with a watcher | — |
| `npm run typecheck` | `tsc --noEmit` — no build, just proof the types hold | 02 |

**`npm run eval` and `npm start` are separate commands on purpose.** That separation
is Chapter 08 §8.5's point: the offline evaluation is the one that gates a release, so
it must be runnable with no HTTP at all. If the loop lived in a controller, CI would
have to boot a server to test anything.

**Why `openai` is a dependency in a project that runs offline.** It is imported at the
top of `services/model.ts`, but `createModel()` only constructs `OpenAIModel` when
`OPENAI_API_KEY` is non-empty. The dependency is there so the *real* code path is a
first-class path rather than a comment — and it costs nothing when unused.

**There is no eval framework here** — no `promptfoo`, no `ragas`, no `deepeval`. The
lecture's subject is the mechanism: the check catalogue, the rubric, the attribution
classifier, the gate. A framework would hide precisely the parts the notes ask you to
understand.

---

## `tsconfig.json`

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

### Block-by-block

**`"module": "NodeNext"` + `"moduleResolution": "NodeNext"`** — the pair that makes
ESM work correctly under Node. This is the setting responsible for the `.js` import
suffixes described above.

**`"strict": true`** — this is doing more work in this project than usual. The judge
returns `Partial<Record<string, number>>` parsed from JSON, and `strict` is what forces
the `?? 1` fallbacks in `model.ts` to exist. Without it, a model that returned a
missing metric would produce `undefined` and poison every average in the report.

**`"outDir"` / `"declaration"` / `"sourceMap"` are set, but the project never builds.**
`tsx` runs the TypeScript directly. They are there so `tsc --noEmit` and a
hypothetical `tsc` build agree on one configuration rather than two.

---

## `.env.example`

```text
# Lecture 18 — AI Application Testing: Deterministic Evals & LLM-as-a-Judge
# Copy to `.env` and adjust if needed.

# Chapter 02 — the HTTP surface: the application under test, and the eval API.
PORT=8080
HOST=127.0.0.1

# Chapter 02 §2.2 — how many policy documents retrieval returns.
# This is the lever the regression demo pulls: RETRIEVAL_TOPK=2 makes the agent
# retrieve a document the dataset did not expect, and the gate blocks the build.
RETRIEVAL_TOPK=1

# Chapter 05 §5.2 — the operational budget. A *check*, not a metric: latency is
# deterministic, so no judge is involved.
EVAL_MAX_LATENCY_MS=5000

# Chapter 08 §8.4 — the quality thresholds. One number, applied to every metric,
# overridable per metric (EVAL_MIN_FAITHFULNESS, EVAL_MIN_HALLUCINATION_FREE, …).
# There is nothing universal about 4: it is a product decision for this app.
EVAL_MIN_SCORE=4

# Chapter 08 §8.6 — the release gate. 1 means "no case may fail".
EVAL_MIN_PASS_RATE=1

# Chapter 06 — the judge's model. Leave OPENAI_API_KEY empty and everything still
# runs: the model and the judge fall back to deterministic stand-ins, so every
# number in this project is reproducible with no API key.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

### Block-by-block

Every value here is a **lever on what is being measured**, which is why they are
environment variables rather than constants. Chapter 02 §2.8 records the configuration
in `appVersion`, so changing one changes the identity of the run — and two runs with
different identities are not comparable.

| Key | Notes section | What it controls |
| :--- | :--- | :--- |
| `PORT` / `HOST` | Ch02 | the HTTP surface |
| `RETRIEVAL_TOPK` | Ch02 §2.2 | **the lever the regression demo pulls.** `RETRIEVAL_TOPK=2 npm run eval` retrieves one document more than the dataset expects, and the gate blocks |
| `EVAL_MAX_LATENCY_MS` | Ch05 §5.2 | the operational budget — a deterministic check, not a metric |
| `EVAL_MIN_SCORE` | Ch08 §8.4 | the default quality threshold, applied to all five metrics |
| `EVAL_MIN_<METRIC>` | Ch08 §8.4 | a per-metric override, e.g. `EVAL_MIN_FAITHFULNESS=5` |
| `EVAL_MIN_PASS_RATE` | Ch08 §8.6 | how many cases must pass for the gate to open |
| `OPENAI_API_KEY` | Ch06 | empty means both the agent and the judge use the offline stand-in |
| `OPENAI_MODEL` | Ch06 | which model answers and judges, when a key is present |

**Leaving `OPENAI_API_KEY` empty is the default, and that is deliberate.** Every number
quoted in this guide was produced with no key, so you can reproduce all of them — which
is Chapter 05 §5.2's "freeze what you can before running the dataset" satisfied by
construction rather than by discipline.

**`EVAL_MIN_PASS_RATE=1` looks stricter than the lecture's `0.95`.** With nine cases,
`0.95` and `1` select the same runs: one failure out of nine is a pass rate of `0.89`,
which is below both. The smaller the dataset, the less room a percentage has to mean
anything — which is its own lesson about dataset size.

---

## Checkpoint

1. **Why does `services/` not import Express?**
   Because the offline evaluation must run with no HTTP at all — `npm run eval` gates a
   commit in CI without starting a server. If the loop lived in a controller, CI would
   have to boot the app to test it.

2. **Why is `domain/` import-free?**
   Because it holds the *vocabulary* of the lecture. `types.ts` describing a `Trace`
   should be readable without a service dragged in behind it — and a data model that
   can be read alone is a data model that can be agreed on alone.

3. **Why is there no eval framework in `package.json`?**
   The lecture's subject is the mechanism. A framework would hide the check catalogue,
   the rubric and the attribution classifier — exactly the parts the notes ask you to
   understand.

4. **Why does `openai` appear as a dependency in a project that runs offline?**
   So the real code path is a first-class implementation of `ModelClient` rather than a
   comment. It is only constructed when a key exists, so the offline path never
   instantiates it.

5. **What makes two runs comparable?**
   `appVersion` — a description of the configuration (`topK`, prompt version, model).
   Change a threshold or a `topK` and you have changed what is being measured.

---

**[Chapter 02: Config and the Trace Contract →](./02_Config_And_The_Trace_Contract.md)**
