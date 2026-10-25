# Lecture 18 — AI Application Testing (Basic Code)

> **The code behind the notes.** One small AI application — an e-commerce support
> agent with retrieval and three tools — plus the testing system that tells you
> whether it still works: an **observable response** (`AgentResponse` + a trace), a
> **golden dataset**, **deterministic checks**, an **LLM-as-a-judge** with five
> metrics, the **four-layer pipeline**, and **per-metric thresholds** feeding a
> **release gate**.

**Runs offline, with no API key.** The model is replaced by a deterministic
stand-in, and that is a *feature* rather than a shortcut: Chapter 05 §5.2 asks you
to freeze what you can before running a dataset, and a stand-in is perfectly
frozen. Set `OPENAI_API_KEY` and the same rubric goes to a real model through the
same interface — the pipeline does not change, and every score starts carrying a
different `judgeVersion` so the change is visible.

```bash
cd "Lecture 18/code/Basic Code"
npm install

npm run eval        # the four-layer pipeline + the release gate   ← start here
npm start           # the HTTP surface: the agent under test, and the eval API
npm run typecheck   # tsc --noEmit
```

## The two commands that make the lecture's point

**1 · The baseline is green.**

```bash
npm run eval
```

```text
Lecture 18 — offline evaluation: the four-layer pipeline

  app            agent-v1.0.0 | topK=1 | prompt=v1 | model=offline
  judge          offline-v1
  dataset        revision 1 · 9 cases

  --- Layer 1 · deterministic (code as the judge) ---
  deterministic  pass rate 1

  --- Layers 2 + 3 · quality scores against per-metric thresholds ---
  relevance         4.89   threshold 4
  correctness       5.00   threshold 4
  faithfulness      5.00   threshold 4
  helpfulness       5.00   threshold 4
  hallucinationFree 5.00   threshold 4

  --- per category (never one blended number) ---
  A   4 case(s) · pass 4
  B   3 case(s) · pass 3
  C   2 case(s) · pass 2

GATE PASSED — 9/9 cases, pass rate 1.
```

**2 · One retrieval setting changes, and the gate blocks it.**

```bash
RETRIEVAL_TOPK=2 npm run eval
```

```text
  deterministic  pass rate 0.96
  ...
  A   4 case(s) · pass 1

  --- failures, with the layer that owns them ---
  policy-return-window   [deterministic]
      No unexpected source: expected=return-policy actual=return-policy, refund-policy
  policy-shipping-speed   [deterministic]
      No unexpected source: expected=shipping-policy actual=shipping-policy, refund-policy
  policy-reworded-window   [deterministic]
      No unexpected source: expected=return-policy actual=return-policy, refund-policy

GATE BLOCKED
  - 3 of 9 case(s) failed
  - pass rate 0.67 < 1
```

Read the attribution line, because it is the whole lecture in one word. The agent's
answers were **still perfectly faithful and correct** — the quality scores did not
move at all — and the run still failed. The failure is in *retrieval*, so the prompt
is innocent and rewriting it would have been wasted work. Exit code 1, so CI can act
on it.

That is the difference between this project and a test that just says "the test
failed".

---

## The HTTP surface

`npm start` exposes the same services over HTTP, so each chapter is reachable with
`curl`.

```bash
# Chapter 02–03 — run the agent once and read its trace
curl -s -X POST http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"message":"Where is ORD-101?"}'
```

```json
{
  "answer": "Order ORD-101 has been shipped and is on the way.",
  "retrievedDocuments": [],
  "toolsUsed": ["getOrderStatus"],
  "toolArguments": ["ORD-101"],
  "toolResults": ["Order ORD-101 has been shipped and is on the way."],
  "context": "TOOL RESULT 1: Order ORD-101 has been shipped and is on the way.",
  "trace": { "traceId": "…", "latencyMs": 0, "model": "offline-v1", "promptVersion": "v1" }
}
```

Note what came back: an answer **and** an eval trace. `retrievedDocuments: []` is not
missing data — it is the assertion that the retrieval path was *not* taken, and the
dataset checks it.

```bash
# Chapter 04 — the dataset, and the coverage it promises
curl -s http://127.0.0.1:8080/dataset
#   -> 9 cases, coverage A:4 B:3 C:2

# Chapter 05–08 — the whole pipeline, plus the gate
curl -s http://127.0.0.1:8080/eval
#   -> passRate, deterministicPassRate, averages per metric, byCategory, gate, and per-case detail

# Chapter 03 — every response carries a trace id
curl -s -D - -o /dev/null -X POST http://127.0.0.1:8080/chat \
  -H 'content-type: application/json' -d '{"message":"What is the weather in Paris?"}' | grep -i x-trace-id
```

---

## The file map

```text
Basic Code/
├── .env                              # local config (see .env.example)
├── .env.example                      # the same keys, documented by chapter
├── package.json                      # scripts + dependencies
├── package-lock.json                 # resolved versions
├── tsconfig.json                     # the compiler rules that make the rest safe
├── README.md                         # ← you are here
├── implementations guide/            # the ten-chapter walkthrough
└── src/
    ├── index.ts                      # Ch10 — the HTTP entry point
    ├── cli.ts                        # Ch09 — `npm run eval`, and the exit code CI reads
    ├── config/
    │   └── config.ts                 # Ch02 — env, thresholds, and the app version
    ├── domain/
    │   ├── types.ts                  # Ch02 — the shapes an eval is made of
    │   └── dataset.ts                # Ch03 + Ch05 — the policy corpus and the 9 golden cases
    ├── middleware/
    │   └── requestContext.ts         # Ch04 — a trace id on every request
    ├── controllers/
    │   ├── chatController.ts         # Ch10 — POST /chat
    │   └── evalController.ts         # Ch10 — GET /dataset, GET /eval
    ├── routes/
    │   └── index.ts                  # Ch10 — the route table, and the 404
    └── services/
        ├── text.ts                   # Ch06 — the one definition of "content terms"
        ├── model.ts                  # Ch07 — the model: offline stand-in, or a real one
        ├── knowledgeBase.ts          # Ch03 — retrieval, ranked, with a score and a rank
        ├── tools.ts                  # Ch03 — the three tools and their fixtures
        ├── supportAgent.ts           # Ch04 — the application under test
        ├── deterministic.ts          # Ch06 — Layer 1: the eight checks
        ├── judge.ts                  # Ch07 — Layer 2: the rubric and the five metrics
        ├── pipeline.ts               # Ch08 — Layers 1–4, per case
        └── report.ts                 # Ch09 — the report, the aggregation, and the gate
```

### Chapter map

| Notes chapter | Where it lives |
|---|---|
| [01 — Why AI testing is different](../../notes/01_Why_AI_Testing_Is_Different.md) | The reason `expected === actual` appears nowhere in this project: `domain/types.ts` asserts *behaviour*, never text |
| [02 — The application under test](../../notes/02_The_Application_Under_Test.md) | `domain/dataset.ts` (the corpus), `services/knowledgeBase.ts`, `services/tools.ts`, `services/supportAgent.ts` |
| [03 — Observability: `AgentResponse` and traces](../../notes/03_Observability_AgentResponse_And_Traces.md) | `domain/types.ts` (`Trace`, `AgentResponse`), `services/supportAgent.ts` (`buildContext`), `middleware/requestContext.ts` |
| [04 — The golden dataset](../../notes/04_The_Golden_Dataset.md) | `domain/dataset.ts` — the nine cases, and the `null` expectations that are assertions |
| [05 — Deterministic evaluation](../../notes/05_Deterministic_Evaluation.md) | `services/deterministic.ts` — the eight checks, and `services/text.ts` behind them |
| [06 — LLM-as-a-judge](../../notes/06_LLM_As_A_Judge.md) | `services/judge.ts` (the rubric, the five metrics), `services/model.ts` (the instrument) |
| [07 — The four-layer pipeline](../../notes/07_The_Four_Layer_Evaluation_Pipeline.md) | `services/pipeline.ts` |
| [08 — Choosing evaluators, thresholds, reality](../../notes/08_Choosing_Evaluators_And_Thresholds.md) | `config/config.ts` (the thresholds), `services/report.ts` (the gate), `cli.ts` (the exit code) |

---

## Five design decisions worth reading the code for

**1 · The response carries its own evidence.** `chat()` returns an answer *and* a
trace. Chapter 03 §3.3 calls the trace "the second output of every request", and
everything in Chapters 05–08 is a function over it. Without it, the only testable
thing is the final string — the least informative artefact the system produces.

**2 · Deterministic and quality results are stored separately.** `CaseResult` has
`checks` and `quality`, not one score, and the report prints them on separate lines.
The `RETRIEVAL_TOPK=2` run is exactly why: the quality scores never moved while the
deterministic half broke. One blended number would have hidden the layer, and the
layer is what has an owner.

**3 · `null` in the dataset is an assertion, not a gap.** `expectedSource: null` means
"must not retrieve a document"; `expectedTool: null` means "must not call a tool".
That is what makes over-retrieval and needless tool calls *failures* instead of
silence — and it is the check that catches the `topK` regression above.

**4 · Thresholds live in the environment, not in a function body.** Chapter 08 §8.4:
there is nothing universal about the number 4. `EVAL_MIN_SCORE=4` is the default and
`EVAL_MIN_FAITHFULNESS=5` tightens one metric without touching the rest, because
faithfulness is a hard correctness signal and helpfulness is a soft one.

**5 · The judge is a measuring instrument, and it says which one it is.** Every score
carries a `judgeVersion` — `offline-v1` or `model:gpt-4o-mini` — so a report can
never be misread as having been judged by a model when it was not. The same interface
serves both, which is why swapping the instrument changes nothing downstream.

---

## What this project deliberately does **not** do

| Not included | Why |
|---|---|
| An eval framework (`promptfoo`, `ragas`, …) | The lecture's subject is the mechanism: the check catalogue, the rubric, the attribution. A framework would hide exactly the parts the notes ask you to understand. |
| A vector database | Retrieval is scored by content-term overlap, so the whole project runs with no key, no network and no nondeterminism. The *contract* — ranked documents with ids — is the same. |
| Bounded-concurrency judge calls | Chapter 06 §6.5's concurrency is about cost and rate limits. Offline, the nine cases run sequentially so the output order is stable and diffable. |
| A production trace sink | The trace is in the response body because it is the lesson. Chapter 03 §3.8 says to keep it off the user channel; that is a one-line change in `chatController.ts`. |

---

**Back to:** [Lecture 18 notes](../../notes/README.md) · [Implementation guide](./implementations%20guide/README.md)
