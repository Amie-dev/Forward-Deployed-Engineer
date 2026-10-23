# Chapter 11 — The Pipeline

> **Goal of this chapter:** wire Chapters 02–10 into one function and make it
> **observable**. The notes' closing habit is *"inspect retrieval before inspecting
> the answer"* — so this function returns a **trace**, not just an answer.
>
> **Lecture chapters:** [01](../../../notes/01_Why_Basic_RAG_Breaks.md) (the baseline
> habit) through [08](../../../notes/08_Context_Engineering.md), assembled in the
> order the lecture draws the pipeline.

---

## 11.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/index.ts` |
| **Layer** | orchestration |
| **Purpose** | run every stage in order and return the full trace + timings |
| **Imports** | `config`/`type Config`, `assembleContext`, `DOCUMENTS`, `generateAnswer`, `rerank`, `hybridSearch`, `buildIndex`/`filterFrom`/`isEligible` |
| **Exports** | `type Trace`, `runPipeline`, `ask` |
| **Imported by** | `services/eval.ts`, `src/index.ts` |
| **Lecture sections** | 01 §"the habit that governs everything"; 09 §"the diagnostic tree" |

### The stage order, and where each stage comes from

```text
ingest  →  filter  →  dense + lexical  →  RRF  →  cut at K  →  rerank  →  assemble  →  answer
  06        06            07              07       04           08          09          10
```

---

## 11.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run search     # the trace, stage by stage, plus per-stage timings
npm run ask        # the same trace, then the assembled prompt and the answer
```

---

## 11.3 Full file

**Path:** `src/services/index.ts`

```ts
import { config, type Config } from "../config/config.js";
import type { Trace } from "../models/types.js";
import { assembleContext } from "./context.js";
import { DOCUMENTS } from "./documents.js";
import { generateAnswer } from "./generate.js";
import { rerank } from "./rerank.js";
import { hybridSearch } from "./search.js";
import { buildIndex, filterFrom, isEligible } from "./store.js";

/**
 * Chapters 01–08 in one function — the orchestrator that produces the **trace**.
 *
 * Chapter 09's habit lives here: the trace carries every stage's output, so
 * "which stage owns this failure?" is answered by reading it, not by guessing.
 *
 *   filter → dense + lexical → RRF → threshold → cut at K → rerank → assemble → answer
 *
 * `Trace` is a contract (Chapter 14). This file is the composition root: it is
 * the only module that imports every service.
 */

const round = (value: number): number => Number(value.toFixed(2));

export function runPipeline(question: string, cfg: Config = config): Trace {
  const t0 = performance.now();

  // Ingest + the eligibility filter (Chapters 03–05).
  const index = buildIndex(DOCUMENTS, cfg);
  const filter = filterFrom(cfg);
  const eligible = index.filter((chunk) => isEligible(chunk, filter));
  const t1 = performance.now();

  // Chapter 04 + 06 — the same eligible set goes to both retrievers.
  const { dense, lexical, fused } = hybridSearch(eligible, question, cfg);
  const t2 = performance.now();

  // Chapter 04 — cut the fused ranking at K to get the candidate set.
  const candidates = fused.slice(0, cfg.kRetrieve);

  // Chapter 07 — rerank the candidates, and respect the gate.
  const { results: reranked, passed } =
    cfg.rerank === "on"
      ? rerank(question, candidates, cfg)
      : { results: candidates, passed: candidates.length > 0 };
  const t3 = performance.now();

  // Chapter 08 — assemble the context, then answer from it (or refuse).
  const context = assembleContext(passed ? reranked.slice(0, cfg.kContext) : [], question, cfg);
  const answer = generateAnswer(question, context);
  const t4 = performance.now();

  return {
    question,
    chunks: index.length,
    eligible: eligible.length,
    filter,
    dense,
    lexical,
    fused,
    candidates,
    reranked,
    passed,
    context,
    answer,
    timings: {
      ingest: round(t1 - t0),
      retrieve: round(t2 - t1),
      rerank: round(t3 - t2),
      assemble: round(t4 - t3),
    },
  };
}

/** A convenience wrapper for callers that only want the answer. */
export function ask(question: string, cfg: Config = config): Answer {
  return runPipeline(question, cfg).answer;
}
```

---

## 11.4 Block-by-block explanation

**Block 1 — the imports read as the pipeline**

```ts
import { config, type Config } from "../config/config.js";
import { assembleContext, type AssembledContext } from "./context.js";
import { DOCUMENTS } from "./documents.js";
import { generateAnswer, type Answer } from "./generate.js";
import { rerank } from "./rerank.js";
import { hybridSearch, type Hit } from "./search.js";
import { buildIndex, filterFrom, isEligible, type Filter } from "./store.js";
```

- This is the only file that imports from every service, and that is the point: it is
  the **composition root**. Every other file knows at most two neighbours, so a stage
  can be replaced without touching the rest.
- Note that `chunking.ts` and `embeddings.ts` are **not** imported here. They are used
  by `store.ts`, which is the correct layering: the pipeline talks about an *index*, not
  about how one is built.

**Block 2 — `Trace`: the contract that makes debugging possible**

```ts
export type Trace = {
  question: string;
  chunks: number;
  eligible: number;
  filter: Filter;
  dense: Hit[];
  lexical: Hit[];
  fused: Hit[];
  candidates: Hit[];
  reranked: Hit[];
  passed: boolean;
  context: AssembledContext;
  answer: Answer;
  timings: Record<string, number>;
};
```

- Every stage's output is present, in pipeline order, so the notes' diagnostic tree can
  be walked *from the data* rather than from memory:
  - *Was the deciding chunk retrieved at all?* → look at `dense` / `lexical` / `fused`.
  - *Was it in the context sent?* → look at `context.blocks`.
  - *Did the model use it?* → look at `answer` and `context` together.
- `candidates` is kept **as well as** `fused`, because they differ: `fused` is the whole
  fused ranking and `candidates` is what survived the cut at `kRetrieve`. That
  distinction is exactly the "K too small" row of the runbook.
- `chunks` and `eligible` are two counts rather than one, so the filter's effect is
  measurable without re-running ingest — the first number is Chapter 02/03, the second
  is Chapter 05.
- `filter` is recorded, not just applied. A trace that does not say *which tenant and
  which `asOf`* produced it cannot explain a surprising result — and the notes' security
  requirement is that the filter is server-derived, which is only checkable if it is
  visible.
- `timings` is a `Record<string, number>`, i.e. a string-keyed map — deliberately loose
  so a stage can be added without changing the type.

**Block 3 — `round`, and why timings are rounded**

```ts
const round = (value: number): number => Number(value.toFixed(2));
```

- `performance.now()` returns sub-millisecond floats with long decimals. Rounding to two
  decimals makes the printed JSON stable and readable, and stops a nondeterministic
  number from making two identical runs look different.

**Block 4 — stage 1: ingest and filter**

```ts
  const index = buildIndex(DOCUMENTS, cfg);
  const filter = filterFrom(cfg);
  const eligible = index.filter((chunk) => isEligible(chunk, filter));
```

- Three lines, three jobs, and the order matters: **build the index, derive the filter,
  then narrow the index**. Narrowing first is what makes this a *pre*-filter — the
  unauthorised chunks never reach a retriever (Chapter 06).
- `filterFrom(cfg)` takes the whole config, not a request. That is the security
  property, not a style choice.
- `index.filter(...)` produces a plain array, so both retrievers can be handed the same
  `eligible` value. There is exactly one filter application in the project.

**Block 5 — stage 2: the two retrievers and their fusion**

```ts
  const { dense, lexical, fused } = hybridSearch(eligible, question, cfg);
```

- One call, three outputs. `hybridSearch` internally honours `cfg.hybrid`, so this line
  is the same whether hybrid search is on or off — the ablation changes behaviour
  without changing the pipeline.
- Passing `eligible` (not `index`) is how Chapter 07's "same filter on both retrievers"
  is guaranteed: there is only one array to pass.

**Block 6 — stage 3: cut, then rerank**

```ts
  const candidates = fused.slice(0, cfg.kRetrieve);

  const { results: reranked, passed } =
    cfg.rerank === "on"
      ? rerank(question, candidates, cfg)
      : { results: candidates, passed: candidates.length > 0 };
```

- `fused.slice(0, cfg.kRetrieve)` is Chapter 04's *K is a budget*, applied to the fused
  ranking. `denseSearch` and `bm25Search` each cut at `kRetrieve` too, but the union of
  two top-K lists can be up to `2K` entries — so this line is what actually enforces the
  budget before reranking.
- The ternary is the whole "reranking is an optional stage" idea from the notes:
  - `rerank === "on"` → the joint scorer decides the order, and `passed` is its gate.
  - `rerank === "off"` → the fused order is kept, and `passed` becomes
    `candidates.length > 0` — i.e. *"there is something to answer from"*.
- The `off` branch is why the naive preset answers questions the gate would refuse:
  without a reranker there is no gate, and BM25 guarantees at least one candidate for
  almost any query. That is the failure the notes describe, reproduced by a `? :`.
- Destructuring with a rename (`results: reranked`) is what lets both branches return the
  same shape while the local name stays meaningful.

**Block 7 — stage 4: assemble, then answer**

```ts
  const context = assembleContext(passed ? reranked.slice(0, cfg.kContext) : [], question, cfg);
  const answer = generateAnswer(question, context);
```

- `passed ? reranked.slice(0, cfg.kContext) : []` is the **only** place the gate turns
  into behaviour: a failed gate hands `assembleContext` an empty array, and
  `generateAnswer` then refuses. One expression, one decision, easy to find.
- `reranked.slice(0, cfg.kContext)` is the *present* half of the two-K architecture:
  retrieve 10, present 4. If `kContext >= candidates.length` the slice is harmless.
- `generateAnswer(question, context)` takes the question *and* the context, because the
  question is needed to choose which sentences to quote — the context alone does not say
  what was asked.

**Block 8 — the return: one object, no side effects**

```ts
  return {
    question, chunks: index.length, eligible: eligible.length, filter,
    dense, lexical, fused, candidates, reranked, passed, context, answer,
    timings: { ingest: round(t1 - t0), retrieve: round(t2 - t1), rerank: round(t3 - t2), assemble: round(t4 - t3) },
  };
```

- Every field is either an input or a stage output — the function has **no side effects**
  and no logging. That is why the CLI can print whatever it likes, `eval.ts` can measure
  whatever it likes, and both use the same function.
- Four timers, four stages. `ingest` includes chunking, validating and embedding;
  `retrieve` includes both retrievers and the fusion; `rerank` includes the gate;
  `assemble` includes the answer. The boundaries match the notes' latency table, so the
  numbers can be compared with it directly.
- `index.length` is captured *after* the fact, so it is the number of chunks the current
  `cfg` produced — which is how the ablation table reports a different `chunks` value per
  preset.

**Block 9 — the convenience wrapper**

```ts
export function ask(question: string, cfg: Config = config): Answer {
  return runPipeline(question, cfg).answer;
}
```

- A one-line wrapper for callers that only want the answer. It exists so that the *intent*
  is readable at the call site: `ask(...)` says "I want an answer",
  `runPipeline(...)` says "I want the trace".
- Both default `cfg` to the global `config`, which is what makes `runPipeline(question)`
  and `runPipeline(question, { ...config, ...overrides })` work with one signature.

---

## 11.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run search
```

Expected (excerpt — the trace, in order):

```text
Question: Can I return my damaged headphones after 10 days?
Filter  : tenant=northwind acl=[support, customer] asOf=2026-06-01 categories=[electronics, damaged, product, general]
Corpus  : 7 documents → 19 chunks → 15 eligible

  1 · dense (cosine, above the floor) (5)
    0.3356  return-policy-electronics  Electronics Return Policy → Scope
    …

  2 · lexical (BM25) (10)
    …

  3 · fused (RRF, k = 60) (10)
    0.0328  return-policy-electronics  Electronics Return Policy → Return window
    0.0318  return-policy-general  General Return Policy → Return window
    0.0318  damaged-product-policy  Damaged Product Reporting Policy → Exception
    …

  4 · reranked (joint score) (10)
    0.4167  return-policy-electronics  Electronics Return Policy → Return window
    0.4167  damaged-product-policy  Damaged Product Reporting Policy → Exception
    0.3500  return-policy-general  General Return Policy → Return window
    …

  Gate    : best 0.4167 vs 0.2 → pass
  Context : 4 blocks, ~259 tokens
  Timings : {"ingest":0.38,"retrieve":0.21,"rerank":0.06,"assemble":0.14} ms
```

Notice `7 documents → 19 chunks → 15 eligible`. Three numbers, three chapters: the
corpus (03), the chunker (04) and the filter (05) — and only the last one is allowed to
remove a document from consideration.

---

## 11.6 Checkpoint

1. **Why does `runPipeline` return a trace instead of an answer?** So "which stage owns
   this failure?" can be answered by reading data rather than by guessing.
2. **What is the only place the gate changes behaviour?** The ternary that hands
   `assembleContext` either `reranked.slice(0, kContext)` or `[]`.
3. **Why is `eligible` passed to `hybridSearch` instead of `index`?** So both retrievers
   provably see the same filtered set — there is only one array.

**Next:** [Chapter 12 — Evaluation and ablation](./12_Evaluation_and_Ablation.md)


