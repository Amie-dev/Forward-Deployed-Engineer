# Lecture 17 — GenAI Evals & Testing (Basic Code)

> **The code behind the notes.** One small AI application — a support chatbot with a
> retriever — plus the evaluation system that tells you whether it still works: a
> **fixed dataset**, **deterministic checks**, an **LLM-as-a-judge** with rubrics,
> **pointwise and pairwise** scoring, **retrieval and response evaluation with failure
> attribution**, and the **offline/online loop** that turns production failures into
> regression tests.

**Runs offline, with no API key.** The model call is replaced by a deterministic
stand-in, which is a *feature* rather than a shortcut: Chapter 09 §9.1 wants offline
evaluation to be controlled and reproducible, and a stand-in is perfectly reproducible.
Set `OPENAI_API_KEY` and the same rubric goes to a real model through the same
interface — the pipeline does not change.

```bash
cd "Lecture 17/code/Basic Code"
npm install

npm run eval        # the offline evaluation + the release gate  ← start here
npm start           # the HTTP surface: the app under test and the eval API
npm run typecheck   # tsc --noEmit
```

## The two commands that make the lecture's point

**1 · The baseline is green.**

```bash
npm run eval
```

```text
Lecture 17 — offline evaluation
  dataset       revision 1 · 9 cases
  app           app-v1.0.0 | topK=3 | model=offline
  judge         standin-v1

  --- the two halves, kept apart (Chapter 02 §2.8) ---
  deterministic  pass rate 1
  retrieval      hit 1 · recall 1 · precision 0.72 · mrr 0.92
  quality        faithfulness 5 · relevance 5
  attribution    pass 9

  --- where the failures cluster (never one blended number) ---
  normal         3 case(s) · pass rate 1
  reworded       1 case(s) · pass rate 1
  edge           2 case(s) · pass rate 1
  out_of_scope   1 case(s) · pass rate 1
  missing_info   1 case(s) · pass rate 1
  adversarial    1 case(s) · pass rate 1

GATE PASSED — ship with evidence.
```

**2 · One retrieval setting changes, and the gate blocks it.**

```bash
npm run eval -- --topk=1 --baseline=3 --pairwise
```

```text
  deterministic  pass rate 0.89
  retrieval      hit 0.83 · recall 0.83 · precision 0.83 · mrr 1
  quality        faithfulness 5 · relevance 5
  attribution    retrieval 1 · pass 8

  --- regressions vs baseline (topK=3) ---
  warranty-and-return  ->  attributed to retrieval
      must-mention: missing required fact(s): 12 month
      expected-docs: missing expected doc(s): warranty

  pairwise      topK=1 vs topK=3 · win rate 0 (0W / 1L / 8T) · no position bias

GATE BLOCKED
  - 1 case(s) regressed: warranty-and-return
  - deterministic pass rate 0.89 < 0.95
```

Read the attribution line, because it is the whole lecture in one word: the answer was
**faithful** (faithfulness is still 5 — the system answered correctly from the context
it had), and it still failed. The failure is `retrieval`, so the model is innocent and
a prompt change would have been wasted work. Exit code 1, so CI can act on it.

---

## The HTTP surface

`npm start` exposes the same services over HTTP, so each chapter is reachable with `curl`.

```bash
# Chapter 02 — run the system once and read its trace
curl -s 'http://127.0.0.1:8080/ask?q=What+is+the+return+period%3F'
#   -> answer, retrieved docs with ranks, context chars, tool calls, usage

# Chapter 03 — the dataset and the coverage report it promises
curl -s http://127.0.0.1:8080/dataset
#   -> coverage.missingCategories: []   (delete a category and watch it fill)

# Chapter 04-06, 08 — the offline evaluation, with a baseline to diff against
curl -s 'http://127.0.0.1:8080/eval?topk=1&baseline=3'
#   -> report.regressions, report.attribution, per-case failed checks with details

# Chapter 07 — pairwise, in both orders
curl -s 'http://127.0.0.1:8080/pairwise?a=3&b=1'
#   -> winRate, wins/losses/ties, positionBiasCases

# Chapter 09 — the loop: record feedback, read the queue, promote a failure
curl -s -X POST http://127.0.0.1:8080/feedback -H 'Content-Type: application/json' \
  -d '{"id":"<interactionId>","verdict":"down"}'
curl -s http://127.0.0.1:8080/online
curl -s -X POST http://127.0.0.1:8080/promote  -H 'Content-Type: application/json' \
  -d '{"id":"<interactionId>"}'
```

---

## Structure

```text
Basic Code/
├── .env                            # local config (gitignored; see .env.example)
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
└── src/
    ├── index.ts                    # Ch09 §9.1 — the HTTP entry point
    ├── cli.ts                      # Ch09 §9.1 — `npm run eval`, and the exit code CI reads
    ├── config/config.ts            # Ch02 — the configuration, which *is* the app version
    ├── domain/
    │   ├── types.ts                # Ch02 §2.8 — the shapes an eval is made of
    │   └── dataset.ts              # Ch03 — the fixed dataset, the corpus, the coverage report
    ├── controllers/evalController.ts  # Ch02 §2.4 — the HTTP surface
    ├── routes/index.ts             # Ch02 §2.4 — the route table
    └── services/
        ├── app.ts                  # Ch02 §2.6 — the system under test (retrieve → answer)
        ├── deterministic.ts        # Ch04 — code as the judge: the check catalogue
        ├── judge.ts                # Ch05–07 — the judge, the rubrics, pairwise preference
        ├── retrieval.ts            # Ch08 — retrieval metrics + the attribution classifier
        ├── report.ts               # Ch02/04/07 — the loop, the report, the gate, pairwise
        └── online.ts               # Ch09 — the online half and the promotion loop
```

### Chapter map

| Notes chapter | Where it lives |
|---|---|
| [01 — Why AI needs evals](../../notes/01_Why_AI_Needs_Evals.md) | The reason `expected === actual` appears nowhere in this project: `domain/types.ts` asserts *behaviour*, never text |
| [02 — Anatomy of an eval](../../notes/02_Anatomy_Of_An_Eval.md) | `domain/types.ts` (the three ingredients), `services/app.ts` (the system under test), `services/report.ts` (the loop) |
| [03 — Datasets and golden data](../../notes/03_Evaluation_Datasets_And_Golden_Data.md) | `domain/dataset.ts` — the versioned file, the six categories, the coverage report |
| [04 — Deterministic evaluation](../../notes/04_Deterministic_Evaluation.md) | `services/deterministic.ts` — the twelve checks, and the gate they feed |
| [05 — AI quality metrics](../../notes/05_AI_Quality_Metrics.md) | `services/judge.ts` — the five metrics and their rubrics |
| [06 — LLM-as-a-judge](../../notes/06_LLM_As_A_Judge.md) | `services/judge.ts` — inputs, rubric, structured `{score, reason}`; bounded concurrency in `report.ts` |
| [07 — Rubrics, pointwise, pairwise, human](../../notes/07_Rubrics_Pointwise_Pairwise_And_Human_Evaluation.md) | `services/judge.ts` (rubrics + `prefer`), `services/report.ts` (`pointwiseGate`, `compareConfigurations`) |
| [08 — RAG and system-level evaluation](../../notes/08_RAG_And_System_Level_Evaluation.md) | `services/retrieval.ts` — hit/recall/precision/MRR and the attribution classifier |
| [09 — Offline and online evaluation](../../notes/09_Offline_And_Online_Evaluation.md) | `cli.ts` (the offline gate), `services/online.ts` (feedback + the promotion loop) |

---

## Four design decisions worth reading the code for

**1 · The dataset is a file, not a generator.** Nine hand-written cases in
`domain/dataset.ts`, never synthesised at run time. Chapter 03 §3.1 is blunt about why:
*a dataset you regenerate is not a baseline.* One case (`warranty-and-return`)
deliberately needs **two** documents, because that is what makes `recall@k` and the
`topK` lever observable at all.

**2 · Deterministic and quality results are stored separately.** `EvalResult` has two
fields, not one, and the report prints them on separate lines. When a score moves you
want to know *which half* moved — and the `--topk=1` run is exactly that: the quality
scores never moved (faithfulness stayed 5) while the deterministic half broke.

**3 · Retrieval is evaluated with set arithmetic, not a judge.** `scoreRetrieval` is
four lines of array work. Chapter 08 §8.2 calls this "the cheapest and most reliable eval
you will ever write", and it is what makes the attribution classifier possible: without a
retrieval verdict there is nothing to attribute against.

**4 · The judge is a measuring instrument, and it says which one it is.** Every score
carries a `judgeVersion` — `standin-v1` or `model:gpt-4o-mini` — so a report can never be
misread as having been judged by a model when it was not. A model failure falls back to
the stand-in rather than aborting the run, because an evaluation that dies on the first
flaky call is an evaluation nobody runs.

---

**Back to:** [Lecture 17 notes](../../notes/README.md) · [Implementation guide](./implementations%20guide/README.md)
