# Chapter 12 — Evaluation and Ablation

> **Goal of this chapter:** prove the pipeline works, and prove *which control* did
> the work. The closing principle of the lecture is that retrieval and generation must
> be evaluated **separately** — a generation metric without a retrieval metric beside
> it cannot tell you which stage failed.
>
> **Lecture chapter:** [09 — Evaluation and Production Playbook](../../../notes/09_Evaluation_and_Production_Playbook.md)
> (the two metric families, the diagnostic tree, the ablation order, the seven pinned
> versions).

---

## 12.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/eval.ts` |
| **Layer** | evaluation |
| **Purpose** | the golden set, per-case + aggregate metrics, and the ablation presets |
| **Imports** | `config`/`type Config`, `runPipeline` |
| **Exports** | `type GoldenCase`, `GOLDEN`, `type CaseResult`, `type Metrics`, `evaluate`, `type Preset`, `PRESETS`, `ablation` |
| **Imported by** | `src/index.ts` |
| **Lecture sections** | 09 §"the two metric families", §"the ablation order", §"pin seven versions" |

### The metrics, and which family each belongs to

| Metric | Family | Question it answers |
|---|---|---|
| `recall` | retrieval | were all the expected documents in the candidate set? |
| `mrr` | retrieval | how high was the first expected document ranked? |
| `precision` | context | of the chunks that reached the prompt, how many were on-topic? |
| `refusal` | generation | did it answer when it should, and refuse when it should not? |
| `contextTokens` | cost | what did the prompt cost? |

---

## 12.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run eval        # per case: recall, precision, MRR, refused/answered
npm run ablation    # one control at a time, same golden set
```

---

## 12.3 Full file

**Path:** `src/services/eval.ts`

```ts
import { config, type Config } from "../config/config.js";
import type { CaseResult, GoldenCase, Metrics } from "../models/types.js";
import { runPipeline } from "./index.js";

/**
 * Chapter 09 — evaluation.
 *
 * The closing principle of the lecture: **evaluate retrieval and generation
 * separately**. A generation metric without a retrieval metric beside it cannot
 * tell you which stage failed.
 *
 * Metrics here are deliberately small: `recall@N` and `MRR` for retrieval,
 * `context precision` for the assembled prompt, `refusal correctness` for
 * generation, plus `contextTokens` for cost.
 *
 * `GoldenCase`, `CaseResult` and `Metrics` are contracts (Chapter 14). `Preset`
 * stays here because it is a `Partial<Config>` — evaluation is the only layer
 * that rewrites the configuration.
 */

export const GOLDEN: GoldenCase[] = [
  {
    question: "Can I return my damaged headphones after 10 days?",
    expectedDocs: ["return-policy-electronics", "damaged-product-policy"],
    answerable: true,
  },
  {
    question: "How long is the return window for electronic products?",
    expectedDocs: ["return-policy-electronics"],
    answerable: true,
  },
  {
    question: "How long do I have to report a damaged product?",
    expectedDocs: ["damaged-product-policy"],
    answerable: true,
  },
  {
    question: "Does the AX-204 wireless headphone support fast charging?",
    expectedDocs: ["product-ax204"],
    answerable: true,
  },
  {
    question: "What is the general return window?",
    expectedDocs: ["return-policy-general"],
    answerable: true,
  },
  {
    question: "Who won the Indian Premier League in 2026?",
    expectedDocs: [],
    answerable: false,
  },
];


```

```ts
/** The doc ids behind a list of chunk ids: `return-policy-electronics#2#ab12` → doc id. */
function docIds(chunkIds: string[]): string[] {
  return [...new Set(chunkIds.map((id) => id.split("#")[0]))];
}

export function evaluate(cfg: Config = config): { metrics: Metrics; cases: CaseResult[] } {
  const cases = GOLDEN.map((golden) => {
    const trace = runPipeline(golden.question, cfg);
    const retrieved = docIds(trace.reranked.map((hit) => hit.chunk.id));

    const ranks = golden.expectedDocs
      .map((docId) => retrieved.indexOf(docId))
      .filter((rank) => rank >= 0);
    const recall = golden.expectedDocs.length === 0 || ranks.length === golden.expectedDocs.length ? 1 : 0;

    // Context precision (Chapter 09): of the chunks that actually reached the
    // prompt, how many belong to a document the case expects?
    const contextDocs = trace.context.blocks.map((block) => block.docId);
    const relevant = contextDocs.filter((docId) => golden.expectedDocs.includes(docId)).length;
    const precision = contextDocs.length === 0 ? 0 : relevant / contextDocs.length;

    const reciprocal = ranks.length > 0 ? 1 / (Math.min(...ranks) + 1) : 0;
    const correct = golden.answerable === !trace.answer.refused ? 1 : 0;

    return {
      question: golden.question,
      expected: golden.expectedDocs,
      retrieved,
      recall,
      precision,
      reciprocal,
      correct,
      tokens: trace.context.tokens,
      refused: trace.answer.refused,
    };
  });

  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(3));

  const first = runPipeline(GOLDEN[0].question, cfg);
  const answerable = cases.filter((c) => c.expected.length > 0);
  return {
    metrics: {
      chunks: first.chunks,
      recall: mean(cases.map((c) => c.recall)),
      precision: mean(answerable.map((c) => c.precision)),
      mrr: mean(cases.map((c) => c.reciprocal)),
      refusal: mean(cases.map((c) => c.correct)),
      contextTokens: Math.round(cases.reduce((sum, c) => sum + c.tokens, 0) / cases.length),
    },
    cases,
  };
}
```

```ts
/**
 * Chapter 09 — the ablation: one control at a time, same golden set.
 *
 *   0 baseline (fixed chunks, dense, K=4)
 *   1 + structural chunking
 *   2 + hybrid search (dense + BM25 + RRF)
 *   3 + calibrated threshold and a wider candidate set
 *   4 + rerank 20 → present 4
 */
export type Preset = { name: string; overrides: Partial<Config> };

export const PRESETS: Preset[] = [
  {
    name: "naive",
    overrides: { chunkStrategy: "fixed", chunkOverlap: 0, hybrid: "off", rerank: "off", minScore: 0, kRetrieve: 4, kContext: 4 },
  },
  {
    name: "structural",
    overrides: { chunkStrategy: "structural", hybrid: "off", rerank: "off", minScore: 0, kRetrieve: 4, kContext: 4 },
  },
  {
    name: "hybrid",
    overrides: { chunkStrategy: "structural", hybrid: "rrf", rerank: "off", minScore: 0.15, kRetrieve: 10, kContext: 4 },
  },
  {
    name: "rerank",
    overrides: { chunkStrategy: "structural", hybrid: "rrf", rerank: "on", minScore: 0.15, kRetrieve: 10, kContext: 4 },
  },
  {
    name: "full",
    overrides: { chunkStrategy: "structural", hybrid: "rrf", rerank: "on", minScore: 0.15, kRetrieve: 20, kContext: 4 },
  },
];

export function ablation(base: Config = config): { preset: string; metrics: Metrics }[] {
  return PRESETS.map((preset) => ({
    preset: preset.name,
    metrics: evaluate({ ...base, ...preset.overrides }).metrics,
  }));
}
```

---

## 12.4 Block-by-block explanation

**Block 1 — `GoldenCase`: the smallest useful golden set**

```ts
export type GoldenCase = {
  question: string;
  expectedDocs: string[];
  answerable: boolean;
};
```

- Three fields, and each maps to a metric:
  - `expectedDocs` drives `recall`, `precision` and `MRR` — it is the retrieval
    ground truth, expressed as **document ids**, not chunk ids, so re-chunking does not
    invalidate the golden set.
  - `answerable` drives `refusal correctness` — the only generation metric here, and
    the one that catches the "always answers" failure.
- There is deliberately no `mustInclude` field. The notes use one as a deterministic
  stand-in for answer correctness; here the generator is extractive, so a
  sentence-level assertion would measure the generator rather than the retrieval
  pipeline. `refused` plus `precision` carries the same information for this project.

**Block 2 — the six cases, and the two kinds of question**

```ts
export const GOLDEN: GoldenCase[] = [ … ];
```

- Five **answerable** cases and one that must be refused. That ratio is the point: a
  golden set with no unanswerable case can never detect a system that answers
  everything, which is exactly what `minScore = 0` produces.
- Case 1 needs **two** documents (`return-policy-electronics` *and*
  `damaged-product-policy`). It is the only case where `recall` can be 0 while the
  system looks fine, which makes it the case that catches a K that is too small.
- Case 4 is the SKU question, so it is the case that measures Chapter 06's hybrid
  search. Case 5 is the general policy, so it is the case that would fail if the
  filter were `category == 'electronics'` — the restrictiveness trap, as a test.
- Case 6 is deliberately *answerable: false* with no expected documents: a system that
  returns nothing for it is correct, and a system that returns a policy is not.

**Block 3 — the result and metric shapes**

```ts
export type CaseResult = { question: string; expected: string[]; retrieved: string[]; recall: number; precision: number; reciprocal: number; correct: number; tokens: number; refused: boolean };
export type Metrics = { chunks: number; recall: number; precision: number; mrr: number; refusal: number; contextTokens: number };
```

- `CaseResult` is per question and `Metrics` is the aggregate — the notes' requirement
  that a metric be readable **per class** as well as in aggregate. `npm run eval` prints
  both.
- `reciprocal` rather than `mrr` on the case: MRR is by definition a mean, so a single
  case contributes its reciprocal rank. Naming it `reciprocal` keeps that honest.
- `correct` is `0 | 1` rather than a boolean so the aggregate is a plain `mean(...)`.
  The `answerable === !refused` comparison is the whole refusal metric.
- `chunks` sits in `Metrics` because the ablation table needs it per preset — it is the
  one metric that describes the *corpus* rather than a question.

**Block 4 — `docIds`: chunk id → document id**

```ts
function docIds(chunkIds: string[]): string[] {
  return [...new Set(chunkIds.map((id) => id.split("#")[0]))];
}
```

- This is where Chapter 04's id format pays off. `return-policy-electronics#2#7cfa05be`
  splits on `#` to give the document id, so the evaluation never has to know how the
  corpus was chunked.
- `new Set(...)` de-duplicates: two chunks from the same document are **one** retrieved
  document. Without it, a document with three chunks in the candidate set would look
  three times more "retrieved" than one with a single chunk.
- This one function is what makes `expectedDocs` a stable ground truth: re-chunk the
  corpus, and the golden set still means the same thing.

**Block 5 — the per-case loop**

```ts
  const cases = GOLDEN.map((golden) => {
    const trace = runPipeline(golden.question, cfg);
    const retrieved = docIds(trace.reranked.map((hit) => hit.chunk.id));
```

- One `runPipeline` call per case, with the same `cfg`. Every metric below therefore
  describes the *same* configuration — which is what makes the ablation meaningful:
  change `cfg`, and every number moves together.
- `trace.reranked` is the **candidate set** (what retrieval + reranking produced, before
  the cut at `kContext`). Using it — rather than `context.blocks` — is what makes `recall`
  a *retrieval* metric: it answers "was the document findable at all?", the first
  question in the notes' diagnostic tree.

```ts
    const ranks = golden.expectedDocs
      .map((docId) => retrieved.indexOf(docId))
      .filter((rank) => rank >= 0);
    const recall = golden.expectedDocs.length === 0 || ranks.length === golden.expectedDocs.length ? 1 : 0;
```

- `recall` is computed as a **binary per case** and averaged, which is the notes'
  definition: *"all gold chunks present"*. It is strict on purpose — a case that finds
  1 of 2 required documents scores 0, because the missing one may be the exception.
- `ranks` keeps only the positions that were actually found (`>= 0`), so a missing
  document does not poison the MRR calculation with a `-1`.
- The `expectedDocs.length === 0` branch is the unanswerable case: there is nothing to
  recall, so it counts as satisfied. That keeps case 6 from dragging recall down for a
  reason unrelated to retrieval.

```ts
    const contextDocs = trace.context.blocks.map((block) => block.docId);
    const relevant = contextDocs.filter((docId) => golden.expectedDocs.includes(docId)).length;
    const precision = contextDocs.length === 0 ? 0 : relevant / contextDocs.length;
```

- **Context precision**, not `precision@N` over the candidate list. This is a deliberate
  measurement choice: a candidate-list precision is confounded by N (a preset that
  retrieves 20 candidates has more chances to be wrong), so comparing precision across
  presets with different `kRetrieve` would be invalid. Measuring the *prompt* removes N
  from the equation — every preset presents at most `kContext` chunks.
- It counts **chunks**, not unique documents, so a prompt that spends three of its four
  slots on one document is scored honestly as repetitive.
- `contextDocs.length === 0 ? 0 : ...` handles the refusal case. Those cases are excluded
  from the average anyway (Block 6), but the guard keeps the number well-defined.

```ts
    const reciprocal = ranks.length > 0 ? 1 / (Math.min(...ranks) + 1) : 0;
    const correct = golden.answerable === !trace.answer.refused ? 1 : 0;
```

- `1 / (rank + 1)` with `Math.min(...ranks)`: the **first** expected document decides the
  reciprocal rank. `+1` converts the zero-based index into a one-based rank, so a document
  found first scores `1.0` and one found second scores `0.5`.
- `golden.answerable === !trace.answer.refused` is the entire refusal metric in one line:
  answered-and-answerable, or refused-and-unanswerable. Anything else is wrong. Note it
  uses the `refused` boolean from Chapter 10, never the answer text.

**Block 6 — the aggregate**

```ts
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(3));

  const first = runPipeline(GOLDEN[0].question, cfg);
  const answerable = cases.filter((c) => c.expected.length > 0);
```

- `mean` guards the empty array (which would be `NaN`) and rounds to three decimals so the
  printed table is stable — the same rounding habit as `round` in the pipeline.
- `const first = runPipeline(GOLDEN[0].question, cfg)` looks wasteful, since the first case
  was already run inside the loop. It is there for **one** field: `chunks`, the size of the
  index under this `cfg`. Rather than restructure the loop to hoist a value out of it, the
  code pays one extra pipeline run (about 0.4 ms here) for a much clearer loop. On a real
  corpus you would hoist it.
- `answerable` filters the cases that have expected documents, so `precision` is averaged
  only over questions where "relevant" is defined.

```ts
    metrics: {
      chunks: first.chunks,
      recall: mean(cases.map((c) => c.recall)),
      precision: mean(answerable.map((c) => c.precision)),
      mrr: mean(cases.map((c) => c.reciprocal)),
      refusal: mean(cases.map((c) => c.correct)),
      contextTokens: Math.round(cases.reduce((sum, c) => sum + c.tokens, 0) / cases.length),
    },
```

- Five `mean(...)` calls, each over the right population — that is the notes' *"never report
  a generation metric without a retrieval metric beside it"*: `refusal` and `recall` are
  computed in the same function, at the same time, from the same traces, so they cannot
  drift apart.
- `contextTokens` is a plain `Math.round` of the mean rather than a `mean(...)`, because the
  value is a token count, not a rate in `[0, 1]`.

**Block 7 — the presets: one control at a time**

```ts
export type Preset = { name: string; overrides: Partial<Config> };
```

- `Partial<Config>` is the type that makes the ablation cheap: a preset states **only what
  it changes**, and everything else falls back to the base config. Adding a control to
  `config.ts` does not require touching a single preset.
- `name` is a string, not a union, so the table can be extended by adding an object.

```ts
export const PRESETS: Preset[] = [
  { name: "naive",      overrides: { chunkStrategy: "fixed", chunkOverlap: 0, hybrid: "off", rerank: "off", minScore: 0,    kRetrieve: 4,  kContext: 4 } },
  { name: "structural", overrides: { chunkStrategy: "structural",             hybrid: "off", rerank: "off", minScore: 0,    kRetrieve: 4,  kContext: 4 } },
  { name: "hybrid",     overrides: { chunkStrategy: "structural",             hybrid: "rrf", rerank: "off", minScore: 0.15, kRetrieve: 10, kContext: 4 } },
  { name: "rerank",     overrides: { chunkStrategy: "structural",             hybrid: "rrf", rerank: "on",  minScore: 0.15, kRetrieve: 10, kContext: 4 } },
  { name: "full",       overrides: { chunkStrategy: "structural",             hybrid: "rrf", rerank: "on",  minScore: 0.15, kRetrieve: 20, kContext: 4 } },
];
```

- Read the rows as a staircase, exactly the notes' ablation order: **baseline → structural
  chunking → hybrid → threshold + wider candidate set → rerank**. Each row changes one
  thing (or one small group) relative to the row above it, which is what makes the deltas
  attributable.
- `naive` sets `minScore: 0` and `chunkOverlap: 0` — no floor and no overlap. Those two
  zeros are the *absence* of two controls, and they are what the later rows add.
- `rerank` and `full` differ only in `kRetrieve` (10 vs 20). That single difference is how
  the table demonstrates the notes' "retrieve 20 → rerank → present 4" advice: recall and
  MRR should not move (the same documents were already found), while the cost of reranking
  more candidates would.
- `kContext: 4` is constant across every row, so the prompt-size comparison between presets
  is fair.

**Block 8 — `ablation`: the one-liner the whole design was for**

```ts
export function ablation(base: Config = config): { preset: string; metrics: Metrics }[] {
  return PRESETS.map((preset) => ({
    preset: preset.name,
    metrics: evaluate({ ...base, ...preset.overrides }).metrics,
  }));
}
```

- `{ ...base, ...preset.overrides }` is the entire mechanism. Because every service takes
  `cfg: Config` instead of reading the global, a preset is a spread — no monkey-patching, no
  environment juggling, no re-importing.
- `evaluate(...)` returns both the cases and the metrics; the ablation keeps only the
  metrics, because the table is about aggregates. `npm run eval` is what prints the cases.
- Returning `{ preset, metrics }` rather than a bare array of metrics keeps the label
  attached to the numbers, so the CLI can print a table without a parallel array.

---

## 12.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run eval
```

Expected (excerpt):

```text
Chapter 09 — golden set (6 cases)

✓ recall 1  prec 0.75  mrr 1.000  answered  Can I return my damaged headphones after 10 days?
    expected : return-policy-electronics, damaged-product-policy
    retrieved: return-policy-electronics, return-policy-general, damaged-product-policy, product-ax204
…
✓ recall 1  prec 0.00  mrr 0.000  refused  Who won the Indian Premier League in 2026?
    expected : (none — must refuse)
    retrieved: return-policy-electronics, return-policy-general, product-bx900, damaged-product-policy, product-ax204

summary  chunks 19  recall 1  precision 0.65  mrr 0.833  refusal 1  ctx tokens 214
```

```bash
npm run ablation
```

```text
preset       chunks  recall  prec   mrr    refusal  ctx tok
naive        12      1.000   0.500  0.750  1.000    327
structural   19      1.000   0.600  0.833  1.000    250
hybrid       19      1.000   0.600  0.833  1.000    250
rerank       19      1.000   0.650  0.833  1.000    214
full         19      1.000   0.650  0.833  1.000    214
```

### How to read that table (honestly)

- **Structural chunking is the biggest single win.** Context precision `0.500 → 0.600`,
  MRR `0.750 → 0.833`, and the prompt drops from **327 to 250 tokens**. That is the
  notes' claim about chunking, measured: better answers *and* a cheaper prompt.
- **Reranking buys precision, not recall.** `0.600 → 0.650`, and another 36 tokens off.
  Recall is unchanged, which is exactly the notes' proof that a reranker only changed
  the ordering — *"report `recall@N` unchanged + `nDCG@5` improved"*.
- **Hybrid search does not move this table.** On a seven-document corpus BM25 adds no
  new *documents*; it only reorders chunks. Its value shows up on the SKU question
  (`npm run search -- "Does the AX-204 … support fast charging?"`), not in an aggregate
  over six cases. A result that shows nothing is still a result — and the honest reading
  is "this corpus is too small to demonstrate hybrid search", not "hybrid search does not
  work".
- **Recall is saturated at 1.000 and refusal at 1.000 for every preset.** A metric that
  cannot move tells you nothing. This is why context precision, MRR and context tokens are
  on the same row — the notes' rule is to choose a metric that can actually discriminate,
  and then to report retrieval and generation side by side.

### What this golden set does *not* measure

| Not measured | Why |
|---|---|
| faithfulness | the generator quotes the context, so faithfulness is 1 by construction |
| answer correctness | extractive quoting cannot conclude "10 days > 7 days" (Chapter 10) |
| latency p95 | the corpus is 7 documents; the timings are microseconds |
| a cross-tenant probe | `npm run filters` demonstrates it directly, as a row in a table |

Those four rows are the honest boundary of a basic implementation. The notes list them
as first-class metrics; here they are either structural (`faithfulness`) or demonstrated
by a different command.

---

## 12.6 Checkpoint

1. **Why is `recall` measured over `trace.reranked` and `precision` over
   `trace.context.blocks`?** Because recall is a *retrieval* question (was it findable?)
   and precision is a *prompt* question (what did the model read?) — and because a
   candidate-list precision would be confounded by N.
2. **What makes the ablation one line?** `Partial<Config>` presets spread over the base
   config: `evaluate({ ...base, ...preset.overrides })`.
3. **Why does the table show no gain from hybrid search, and what does that mean?** The
   corpus is too small for BM25 to add a new document; it reorders chunks instead. The
   measurement is working — the corpus is the limitation.

**Next:** [Chapter 13 — The CLI](./13_The_CLI.md)





