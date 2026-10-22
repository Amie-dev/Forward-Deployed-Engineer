# Chapter 10: Evaluation, Ablation and the API

> **Chapter Goal:** Close the loop. Measure retrieval separately from generation, change one
> control at a time, read the table, and expose the whole thing over HTTP with the trace
> attached. This is the chapter that makes every earlier claim checkable.

> **Lecture mapping:** Notes Chapter 09 — the measurement discipline, the golden set, the
> ablation matrix, the failure tree, the go-live checklist, and the production concerns that
> outlive any single technique.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/eval/metrics.ts` | 160 | recall@k, MRR, nDCG@k, per-case evaluation, summary |
| `src/eval/run.ts` | 125 | the golden-set runner and the six ablation presets |
| `src/pipeline.ts` | 296 | orchestration and the trace every command prints |
| `src/cli.ts` | 434 | one subcommand per chapter, plus the comparison tables |
| `src/server.ts` | 129 | the HTTP API: `/health`, `/search`, `/ask` |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- eval                  # the configured pipeline, case by case
npm run cli -- eval rerank           # the same view for one preset
npm run cli -- ablation              # one control at a time
npm run dev                          # the API on :3100
```

---

## 2. The Ablation

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts ablation

Ablation over 14 golden cases

preset      chunks  recall  mrr    ndcg   refusal  falseRef  ctx tok  p50
──────────  ──────  ──────  ─────  ─────  ───────  ────────  ───────  ───
naive       31      0.571   0.399  0.442  0.000    0.000     725      2ms
structural  27      0.643   0.488  0.528  1.000    0.167     348      1ms
hybrid      27      0.750   0.548  0.595  0.000    0.000     756      2ms
rerank      27      0.821   0.586  0.640  1.000    0.000     566      3ms
full        27      0.821   0.586  0.640  1.000    0.000     865      4ms
full-wide   27      0.821   0.586  0.640  1.000    0.000     918      6ms

What to read:
  naive       fixed 1,000 chars · top-4 · no floor · no hybrid · no rerank
  structural  + structural chunks + contextual prefix + floor
  hybrid      + BM25 and reciprocal rank fusion
  rerank      + cross-encoder rerank with the two-sided gate
  full        + parent expansion and bookend ordering
  full-wide   same, but 8 candidates to collapse into complete parents

This table measures retrieval, because that is what the presets change.
Answer-level metrics live in `npm run cli -- eval <preset>`, where a weak
generator can be told apart from weak retrieval.
If a row does not move recall but raises ctx tokens, it is costing money for nothing.
```

**How to read it — one row at a time, one control at a time:**

| row | change from the row above | recall | refusal | ctx tokens | verdict |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `naive` | — (the baseline) | 0.571 | 0.000 | 725 | answers everything, including what it cannot answer |
| `structural` | chunking + context prefix + floor | 0.643 | **1.000** | **348** | +7 points of recall at *half* the tokens, and refusals appear |
| `hybrid` | + BM25 and RRF | **0.750** | 0.000 | 756 | +11 points of recall, and it stops refusing anything |
| `rerank` | + joint scorer and the gate | **0.821** | **1.000** | 566 | +7 more points *and* refusal restored, at a lower token cost |
| `full` | + parent expansion and bookending | 0.821 | 1.000 | 865 | +300 tokens for no measurable retrieval gain |
| `full-wide` | + 8 candidates to collapse | 0.821 | 1.000 | 918 | the same, with more headroom |

Four conclusions, all of them defensible from the numbers:

1. **Chunking is the highest-leverage change, and it is free.** Recall up, context halved, and
   refusal appears — because specific chunks score differently from blind windows.
2. **Hybrid search buys recall and loses honesty.** Recall 0.643 → 0.750, refusal 1.000 →
   0.000. Fusion makes more candidates look relevant, and without a gate the system answers.
   *That is the failure mode the notes warn about*, reproduced in one row.
3. **The reranker is what restores the gate.** Recall 0.750 → 0.821 *and* refusal back to
   1.000, with fewer context tokens than the hybrid row. It is the only row that improves both
   axes at once.
4. **Parent expansion is a cost with no measured benefit *on this corpus*.** 566 → 865 tokens
   for identical recall. On a corpus of small documents the parent is often the child; the
   technique earns its keep on long documents, and the honest report says so.

**Note what the table does *not* contain: `facts`.** That is deliberate — the presets change
*retrieval* controls, while `facts` measures the generator, so mixing them would attribute a
generator problem to a retrieval change. Answer-level metrics live in `eval`, next to the
per-case diagnosis that says which stage to blame.


---

## 3. Metrics — `src/eval/metrics.ts`

```ts
import type { Citation, RagTrace } from '../types.js';

/**
 * Retrieval and generation metrics, computed separately.
 *
 * The separation is the whole point of Chapter 10: an end-to-end "was the answer
 * good" score cannot tell you whether to change the chunker or the prompt. These
 * functions each answer one question about one stage:
 *
 *   recall@K   did any of the right documents reach the prompt?
 *   MRR        how high was the first right one?
 *   nDCG@K     was the whole list ordered well, not just the top?
 *   citation   did every claim cite a block that existed?
 *   facts      did the exact numbers survive into the answer?
 */

export interface GoldenCase {
  id: string;
  question: string;
  asOf: string;
  answerable: boolean;
  expectedSources: string[];
  mustInclude: string[];
}

export interface CaseEvaluation {
  id: string;
  question: string;
  answerable: boolean;
  refused: boolean;
  /** Sources in the order they reached the prompt. */
  usedSources: string[];
  recall: number;
  mrr: number;
  ndcg: number;
  citationValidity: number;
  factMatch: boolean;
  contextTokens: number;
  latencyMs: number;
  answer: string;
}

/** Share of the expected documents that made it into the prompt. */
export function recallOf(expected: readonly string[], retrieved: readonly string[]): number {
  if (expected.length === 0) return 0;
  const seen = new Set(retrieved);
  return expected.filter((source) => seen.has(source)).length / expected.length;
}

/**
 * 1 / rank of the first expected document, or 0 when none appeared.
 *
 * Ranks are counted over *documents*, not chunks: five chunks from the third-best
 * document are still one document at one position, and counting them five times
 * would flatter a retriever that simply returned a lot of one thing.
 */
export function reciprocalRank(expected: readonly string[], retrieved: readonly string[]): number {
  const rank = [...new Set(retrieved)].findIndex((source) => expected.includes(source));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

/**
 * nDCG with binary relevance.
 *
 * A list of five chunks where the right document is third is worse than one where
 * it is first, and MRR alone cannot express *how much* worse once several relevant
 * documents exist. DCG divides each hit by log2(rank + 1), so position decays
 * gently instead of collapsing. Duplicates are collapsed first — the same document
 * retrieved twice is not two relevant results.
 */
export function ndcgAtK(expected: readonly string[], retrieved: readonly string[], k: number): number {
  if (expected.length === 0) return 0;

  const unique = [...new Set(retrieved)].slice(0, k);

  let dcg = 0;
  unique.forEach((source, index) => {
    if (expected.includes(source)) dcg += 1 / Math.log2(index + 2);
  });

  let idcg = 0;
  for (let index = 0; index < Math.min(expected.length, k); index++) {
    idcg += 1 / Math.log2(index + 2);
  }

  return idcg === 0 ? 0 : Math.min(1, dcg / idcg);
}

export function evaluateCase(
  testCase: GoldenCase,
  result: { answer: string; refused: boolean; citations: readonly Citation[]; trace: RagTrace },
): CaseEvaluation {
  const usedSources = result.trace.retrieved
    .filter((row) => row.used)
    .sort((left, right) => (left.rank ?? 99) - (right.rank ?? 99))
    .map((row) => row.source);

  const answered = result.answer.toLowerCase();
  const factMatch = testCase.mustInclude.every((phrase) => answered.includes(phrase.toLowerCase()));

  const citationValidity = result.citations.length === 0
    ? (result.refused ? 1 : 0)
    : result.citations.filter((citation) => citation.valid).length / result.citations.length;

  return {
    id: testCase.id,
    question: testCase.question,
    answerable: testCase.answerable,
    refused: result.refused,
    usedSources,
    recall: recallOf(testCase.expectedSources, usedSources),
    mrr: reciprocalRank(testCase.expectedSources, usedSources),
    ndcg: ndcgAtK(testCase.expectedSources, usedSources, 5),
    citationValidity,
    factMatch,
    contextTokens: result.trace.contextTokens,
    latencyMs: result.trace.latencyMs,
    answer: result.answer,
  };
}

export interface SuiteSummary {
  cases: number;
  recall: number;
  mrr: number;
  ndcg: number;
  /** Share of answerable questions whose required facts appear in the answer. */
  factAccuracy: number;
  /** Share of unanswerable questions that were correctly refused. */
  refusalAccuracy: number;
  /** Share of answerable questions that were wrongly refused. */
  falseRefusal: number;
  citationValidity: number;
  averageContextTokens: number;
  p50LatencyMs: number;
}

export function summarise(evaluations: readonly CaseEvaluation[]): SuiteSummary {
  const answerable = evaluations.filter((evaluation) => evaluation.answerable);
  const unanswerable = evaluations.filter((evaluation) => !evaluation.answerable);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));

  const latencies = evaluations.map((evaluation) => evaluation.latencyMs).sort((a, b) => a - b);

  return {
    cases: evaluations.length,
    recall: mean(evaluations.map((evaluation) => evaluation.recall)),
    mrr: mean(evaluations.map((evaluation) => evaluation.mrr)),
    ndcg: mean(evaluations.map((evaluation) => evaluation.ndcg)),
    factAccuracy: mean(answerable.map((evaluation) => (evaluation.factMatch ? 1 : 0))),
    refusalAccuracy: mean(unanswerable.map((evaluation) => (evaluation.refused ? 1 : 0))),
    falseRefusal: mean(answerable.map((evaluation) => (evaluation.refused ? 1 : 0))),
    citationValidity: mean(evaluations.map((evaluation) => evaluation.citationValidity)),
    averageContextTokens: Math.round(
      evaluations.reduce((sum, evaluation) => sum + evaluation.contextTokens, 0) / Math.max(1, evaluations.length),
    ),
    p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
  };
}
```

**Block by block:**

- **`GoldenCase` is the contract between the corpus and the measurement**: `expectedSources`,
  `mustInclude`, `answerable`, `asOf`. Everything else in this file reads that shape.
- **`recallOf` counts documents, not chunks.** Five chunks from the third-best document are
  still one document at one position. This is what makes the golden set survive re-chunking.
- **`reciprocalRank` dedupes before finding the first expected document.** Otherwise a retriever
  that returns five chunks of one document gets credit for five positions.
- **`ndcgAtK` divides each hit by `log2(rank + 2)` and normalises by the ideal ranking.** It
  answers a question recall cannot: *was the whole list ordered well, or just the top?* The
  `Math.min(1, …)` clamp is not defensive noise — it is there because duplicates made the raw
  ratio exceed 1 before deduplication was added, and a metric that can report 1.054 is a metric
  that will eventually be quoted in a slide.
- **`evaluateCase` reads the *rank* the pipeline assigned**, not the order the store returned.
  That distinction is the whole point: recall@K is measured against what actually reached the
  prompt.
- **`citationValidity` treats "refused with no citations" as 1.0**, because a correct refusal
  cites nothing and should not be scored as a citation failure.
- **`summarise` reports the two failure directions separately** — `refusalAccuracy` over
  unanswerable questions and `falseRefusal` over answerable ones. A single "accuracy" number
  hides the trade-off that decides whether the system is useful.
- **`p50LatencyMs`** is the median, not the mean: one cold-start outlier should not define the
  number you put in an SLO.

---

## 4. The Runner and the Presets — `src/eval/run.ts`

```ts
import { readFile } from 'node:fs/promises';

import type { RagConfig } from '../config/env.js';
import { paths } from '../config/env.js';
import { RagPipeline } from '../pipeline.js';
import type { AccessContext } from '../types.js';
import { evaluateCase, summarise, type CaseEvaluation, type GoldenCase, type SuiteSummary } from './metrics.js';

/**
 * The ablation matrix.
 *
 * One preset per row, one control changed per row, so a difference in the numbers
 * can only have one cause. This is the answer to "is reranking worth it?" that
 * survives a review: not an opinion, and not a vendor benchmark — the same fourteen
 * questions, the same corpus, one knob at a time.
 */

export interface Preset {
  name: string;
  description: string;
  overrides: Partial<RagConfig>;
}

const NAIVE: Partial<RagConfig> = {
  chunkStrategy: 'fixed',
  chunkUnit: 'chars',
  chunkSize: 1000,
  chunkOverlap: 150,
  contextualize: 'none',
  lateChunkAlpha: 0,
  kRetrieve: 4,
  kContext: 4,
  minScore: -1,
  mmrLambda: 0,
  hybrid: 'off',
  rerank: 'none',
  expandParents: false,
  bookendOrder: false,
};

export const PRESETS: Preset[] = [
  { name: 'naive', description: 'fixed 1,000 chars · top-4 · no floor · no hybrid · no rerank', overrides: NAIVE },
  {
    name: 'structural',
    description: '+ structural chunks + contextual prefix + floor',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15 },
  },
  {
    name: 'hybrid',
    description: '+ BM25 and reciprocal rank fusion',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15, hybrid: 'rrf' },
  },
  {
    name: 'rerank',
    description: '+ cross-encoder rerank with the two-sided gate',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15, hybrid: 'rrf', rerank: 'heuristic' },
  },
  {
    name: 'full',
    description: '+ parent expansion and bookend ordering',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15, hybrid: 'rrf', rerank: 'heuristic', expandParents: true, bookendOrder: true },
  },
  {
    name: 'full-wide',
    description: 'same, but 8 candidates to collapse into complete parents',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 8, minScore: 0.15, hybrid: 'rrf', rerank: 'heuristic', expandParents: true, bookendOrder: true },
  },
];

export async function loadGoldenCases(): Promise<GoldenCase[]> {
  const raw = JSON.parse(await readFile(paths.golden, 'utf8')) as { cases: GoldenCase[] };
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error('golden.json has no cases.');
  return raw.cases;
}

export interface SuiteResult {
  evaluations: CaseEvaluation[];
  summary: SuiteSummary;
}

export async function runSuite(
  pipeline: RagPipeline,
  cases: readonly GoldenCase[],
  baseAccess: AccessContext,
): Promise<SuiteResult> {
  const evaluations: CaseEvaluation[] = [];

  for (const testCase of cases) {
    const access: AccessContext = { ...baseAccess, asOf: testCase.asOf };
    const result = await pipeline.ask(testCase.question, { access });
    evaluations.push(evaluateCase(testCase, result));
  }

  return { evaluations, summary: summarise(evaluations) };
}

export interface AblationRow {
  name: string;
  description: string;
  summary: SuiteSummary;
  chunks: number;
  indexMs: number;
}

export async function runAblation(
  cases: readonly GoldenCase[],
  baseAccess: AccessContext,
  presets: readonly Preset[] = PRESETS,
): Promise<AblationRow[]> {
  const rows: AblationRow[] = [];

  for (const preset of presets) {
    const pipeline = await RagPipeline.create(preset.overrides);
    const { summary } = await runSuite(pipeline, cases, baseAccess);
    rows.push({
      name: preset.name,
      description: preset.description,
      summary,
      chunks: pipeline.stats.chunks,
      indexMs: pipeline.stats.embedMs,
    });
  }

  return rows;
}
```

**Block by block:**

- **`NAIVE` is defined once and reused by every preset.** Each preset then states *only* what it
  changes, which is what makes the table readable as a sequence of single changes.
- **A preset is a `Partial<RagConfig>`**, and `RagPipeline.create` merges it over the
  environment. That is the entire implementation of the ablation matrix: no new classes, no
  dependency injection framework, just values.
- **`full-wide` exists to show an interaction.** Parent expansion has nothing to collapse when
  only five candidates survive, so the last row gives it eight and the dedupe becomes visible in
  the context-token column.
- **`runSuite` reuses one pipeline for all cases** — the index is built once per preset, not once
  per question. Fourteen cases × six presets would otherwise be 84 index builds.
- **`asOf` comes from the case, not from the config.** The temporal filter is a property of the
  question, which is exactly how it should be modelled.
- **`runAblation` returns the summary *and* the index stats** (`chunks`, `indexMs`), so a reader
  can see the cost side of a change, not only the quality side.

---

## 5. The API — `src/server.ts`

```ts
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { z } from 'zod';

import { serverConfig } from './config/env.js';
import { RagPipeline } from './pipeline.js';
import { parseFilter } from './store/filters.js';
import type { AccessContext } from './types.js';

/**
 * A thin HTTP surface over the same pipeline the CLI uses.
 *
 * Four design rules, all of them production rules rather than demo rules:
 *
 *  1. **Access comes from the request, not the server.** `tenantId` and `acl` are
 *     required on every call: a server that defaults them is a server that answers
 *     with the wrong tenant's data the first time a client forgets a header.
 *  2. **Filters are parsed, never `eval`ed.** An unknown field throws.
 *  3. **The trace is returned with the answer.** Debuggability is a feature, not a
 *     log file.
 *  4. **The index is built once at boot.** Ingestion is not on the request path.
 */

const accessSchema = z.object({
  tenantId: z.string().min(1),
  acl: z.array(z.string().min(1)).min(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const askSchema = z.object({
  question: z.string().min(3).max(1000),
  access: accessSchema,
  filter: z.string().min(1).max(200).optional(),
});

const searchSchema = askSchema.extend({
  topK: z.number().int().min(1).max(50).optional(),
});

async function main(): Promise<void> {
  const pipeline = await RagPipeline.create();
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      ok: true,
      index: {
        strategy: pipeline.stats.strategy,
        documents: pipeline.stats.documents,
        chunks: pipeline.stats.chunks,
        dimensions: pipeline.stats.dimensions,
        model: pipeline.config.embedding.model,
      },
      controls: {
        hybrid: pipeline.config.hybrid,
        rerank: pipeline.config.rerank,
        minScore: pipeline.config.minScore,
        kRetrieve: pipeline.config.kRetrieve,
        kContext: pipeline.config.kContext,
        expandParents: pipeline.config.expandParents,
      },
    });
  });

  app.post('/search', async (request: Request, response: Response) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    const { question, access, filter, topK } = parsed.data;
    const run = await pipeline.retrieve(question, {
      access: access as AccessContext,
      filter: filter ? parseFilter(filter) : undefined,
    });

    response.json({
      question,
      hits: run.hits.slice(0, topK ?? run.hits.length).map((hit, index) => ({
        rank: index + 1,
        id: hit.chunk.id,
        source: hit.chunk.source,
        heading: hit.chunk.heading,
        breadcrumb: hit.chunk.breadcrumb,
        score: Number(hit.score.toFixed(4)),
        tokens: hit.chunk.tokens,
      })),
      stages: run.stages,
      candidates: run.candidates,
    });
  });

  app.post('/ask', async (request: Request, response: Response) => {
    const parsed = askSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    const { question, access, filter } = parsed.data;
    const result = await pipeline.ask(question, {
      access: access as AccessContext,
      filter: filter ? parseFilter(filter) : undefined,
    });

    response.json(result);
  });

  // A thrown filter-parse error is a client error, not a server error.
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    console.error(`[api] ${error.message}`);
    response.status(400).json({ error: 'bad_request', message: error.message });
  });

  app.listen(serverConfig.port, () => {
    console.log(`Advanced RAG API on http://localhost:${serverConfig.port}`);
    console.log(`  index: ${pipeline.stats.chunks} chunks from ${pipeline.stats.documents} documents`);
    console.log(`  try:   curl -s localhost:${serverConfig.port}/health`);
  });
}

main().catch((error: unknown) => {
  console.error(`[api] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
```

**Block by block:**

- **Access comes from the request, never from the server.** `tenantId` and `acl` are required on
  every call. A server that defaults them is a server that answers with the wrong tenant's data
  the first time a client forgets a field — and it will pass every test written by the team that
  forgot it.
- **Filters are parsed, never `eval`ed.** An unknown field throws inside `parseFilter`, and the
  error handler maps that to a 400 rather than a 500, because it is a client error.
- **The index is built once at boot.** Ingestion is not on the request path; a re-index is a
  deployment, not a request.
- **`/health` reports the index and the controls**, so an operator can see which configuration is
  live without reading logs.
- **`/search` returns the stage list**, so a caller can see how many candidates were scanned and
  how many were dropped.
- **`/ask` returns the trace with the answer.** Debuggability is a feature, not a log file.
- **`zod` validates the body** with the same library the configuration uses, so there is one
  validation idiom in the codebase.

### 5.1 The API, verified

```text
{"ok":true,"index":{"strategy":"structural","documents":8,"chunks":27,"dimensions":1024,"model":"hash-1024-v1"},"controls":{"hybrid":"rrf","rerank":"heuristic","minScore":0.15,"kRetrieve":25,"kContext":5,"expandParents":true}}
```

```text
{"answer":"Once the warehouse has inspected a returned item, the refund is issued within 5 to 7 business days. [1] Once the dispute is withdrawn the refund is reissued within the normal 5 to 7 business days. [1] If more than 7 business days have passed since inspection and no refund is visible, the customer's bank may still be settling the transaction: card refunds can take a further 3 to 5 business days to appear on a statement. [1] Product-specific policies for electronics, damaged goods, exchanges and refunds are published separately and take precedence over this document when they apply. [2]","citations":[{"label":1,"source":"refund-timing.md","heading":"Chargebacks and disputes","valid":true},{"label":2,"source":"returns-general.md","heading":"Scope","valid":true}],"refused":false,"trace":{"question":"How long does a refund take?","asOf":"2026-06-01","tenantId":"northwind-eu","stages":[{"name":"dense","ms":1,"detail":"24 candidates · 24 eligible · 24 below 0.15"},{"name":"bm25","ms":14,"detail":"15 hits · 0 also in dense"},{"name":"rrf","ms":0,"detail":"k=60 · 15 fused from 0+15"},{"name":"rerank","ms":7,"detail":"heuristic · 15 scored · best 0.507 · 4 kept"},{"name":"assemble","ms":16,"detail":"2 blocks · 1207 tokens · 2 dropped"},{"name":"generate","ms":2,"detail":"extractive · 2 citations"}],"retrieved":[{"id":"e269ab5eb1609fdec1699b0888ab880751c32ab1856ed4befb42592fe0b9b316","source":"refund-timing.md","heading":"Chargebacks and disputes","dense":0,"used":true,"bm25":3.301,"fused":0.016,"rerank":0.507,"rank":1},{"id":"ac36b00e272f77a60a619347b98d0e280437c9c6a162ba838282732b9e6845f5","source":"returns-general.md","heading":"Seasonal and promotional purchases","dense":0,"used":true,"bm25":3.005,"fused":0.016,"rerank":0.409,"rank":3},{"id":"ed746895c63941a077f828d0c5255c0a91d713c90869493be6072bd9942203fe","source":"returns-general.md","heading":"Scope","dense":0,"used":true,"bm25":2.65,"fused":0.016,"rerank":0.417,"rank":2},{"id":"7fe0bce66a85fcadba4d58d462f7104aafd3f9e49887392d14dfeb897fb7ee06","source":"damaged-goods.md","heading":"Escalation matrix","dense":0,"used":true,"bm25":1.759,"fused":0.016,"rerank":0.312,"rank":4},{"id":"97d0dcfa078d00c5eea180766b78aa0f3cab0f406b0a428fa21821a4df1636b7","source":"refund-timing.md","heading":"Timeline","dense":0,"used":false,"bm25":1.007,"fused":0.015,"rerank":0.204},{"id":"98c0269177c16c72d6e8bb1030b51f306b808a64e2cc7555747498e1c6398ca4","source":"refund-timing.md","heading":"Deductions","dense":0,"used":false,"bm25":0.955,"fused":0.015,"rerank":0.137},{"id":"50fb48032a3ea385f2c328fb8caae938fb59adc472fe865ddd09c5ee2f3a62e9","source":"returns-electronics.md","heading":"Bundle purchases","dense":0,"used":false,"bm25":0.848,"fused":0.015,"rerank":0.07},{"id":"64b64723f24ef8361542e2b461d67d5bef56787252b74164027bb6fa01e10f89","source":"shipping.md","heading":"Shipping costs","dense":0,"used":false,"bm25":0.821,"fused":0.015,"rerank":0.07},{"id":"13b665dcec4e53d19a190043c5b36b550e4b5bfcd9238f27bdb0698bb7a7fdef","source":"returns-general.md","heading":"Related policies","dense":0,"used":false,"bm25":0.818,"fused":0.014,"rerank":0.137},{"id":"fa7f2a6a869d5e157c388068f96adac2fd871d425b6c7273d2a51016c745c30c","source":"damaged-goods.md","heading":"Concealed damage","dense":0,"used":false,"bm25":0.621,"fused":0.014,"rerank":0.137},{"id":"8785ce27c8ecd39527cfae2f965d04e0b80739ffa2d76956877548016e03e952","source":"returns-electronics.md","heading":"Return window","dense":0,"used":false,"bm25":0.605,"fused":0.014,"rerank":0.07},{"id":"1e773dfa36d8a94fc0b8f512c8b24feb4c84cff636a1a8e4995bb415a4ee534b","source":"exchanges.md","heading":"Exchange window","dense":0,"used":false,"bm25":0.6,"fused":0.014,"rerank":0.137},{"id":"b3a7f783797e844a47d1a21f7c681e961f0ee7e7c7636d1aa42d8160cde0ee81","source":"exchanges.md","heading":"Electronics and clearance","dense":0,"used":false,"bm25":0.54,"fused":0.014,"rerank":0.137},{"id":"d1d2905f6d276e73384b055b009df8aaf487c34115b3f47b53f6e8e3ad565554","source":"warranty.md","heading":"Warranty start date","dense":0,"used":false,"bm25":0.54,"fused":0.014,"rerank":0.137},{"id":"1e183aff512658c50c91ead23b8d6e63feee2ffad955447ba21aa9b9f4acc094","source":"damaged-goods.md","heading":"What the customer gets","dense":0,"used":false,"bm25":0.498,"fused":0.013,"rerank":0.07}],"candidates":24,"reranked":15,"contextTokens":1207,"dropped":2,"refused":false,"invalidCitations":0,"latencyMs":43,"providers":{"embeddings":"hash-1024-v1","rerank":"heuristic","generation":"extractive"}},"context":{"text":"<documents>\n[1] refund-timing.md (whole document, match in \"Chargebacks and disputes\") (general)\n# Refund Processing and Timing\n\n## Timeline\n\nOnce the warehouse has inspected a returned item, the refund is issued within 5 to 7\nbusiness days. The money is returned to the original payment method only: the card that\nwas charged, the bank account used for the transfer, or the gift card that was redeemed.\nWe cannot refund to a different card, and we cannot pay a refund in cash.\n\n## When the clock starts\n\nThe 5 to 7 business days start when the inspection is completed, not when the parcel is\ndropped off and not when it is delivered to the warehouse. Inspection usually happens\nwithin two business days of arrival, so the realistic end-to-end time from dropping the\nparcel off is roughly 7 to 9 business days. Support should quote the inspection date from\nthe order timeline rather than guessing.\n\n## Deductions\n\nAny restocking fee is deducted before the refund is issued, so the amount the customer\nsees is the amount they receive. Original shipping charges are refunded only when the\nreturn was caused by a fault, a transit-damage claim or a wrong item. Express shipping\nupgrades are never refunded.\n\n## Partial refunds\n\nA partial refund is issued when accessories, manuals or promotional inserts are missing,\nwhen the packaging is damaged beyond normal handling, or when the serial number does not\nmatch the original shipment. The partial amount is calculated by the inspection team and\nrecorded on the order with a reason code.\n\n## Refund methods\n\nRefunds go back to the original payment method only. A card payment is refunded to the\nsame card, a bank transfer to the same account, and a gift card to the same gift card\ncode. Where a gift card has expired, the balance is reissued as a new gift card rather\nthan paid in cash. Refunds are never issued to a different person, even with the\ncardholder's written consent, because the payment provider rejects the transaction.\n\n## Chargebacks and disputes\n\nIf a customer opens a chargeback before the refund has been issued, the refund process\nis paused and the case is handed to the payments team. Support should not promise a\nrefund date while a dispute is open, because the bank, not Northwind Audio, controls\nthe timeline. Once the dispute is withdrawn the refund is reissued within the normal 5\nto 7 business days.\n\n## If the refund is late\n\nIf more than 7 business days have passed since inspection and no refund is visible, the\ncustomer's bank may still be settling the transaction: card refunds can take a further\n3 to 5 business days to appear on a statement. Support should confirm the refund\nreference from the payment provider before opening a payment investigation.\n\n[2] returns-general.md (whole document, match in \"Scope\") (general)\n# Returns and Refunds — General Policy\n\n## Scope\n\nThis policy applies to every product sold by Northwind Audio through its own storefront,\nunless a product-specific policy says otherwise. It covers the standard return window,\nthe condition an item must be in, the items we never accept back, and the way a return\nis started. Product-specific policies for electronics, damaged goods, exchanges and\nrefunds are published separately and take precedence over this document when they apply.\n\n## Return window\n\nUnopened items may be returned within 30 days of delivery for a full refund. The\n30 days are counted from the delivery date recorded by the carrier, not from the order\ndate and not from the day the parcel is opened. Returns received after the 30-day\nwindow are declined automatically by the returns portal, and the customer is asked to\ncontact support if they believe the delivery date is wrong.\n\n## Condition requirements\n\nAn item must be unused, in its original packaging, and complete with every accessory,\nmanual and promotional insert that shipped with it. Opened items are accepted only when\nthey are faulty, and then only under the damaged-goods or warranty policy. We do not\naccept returns on the basis that the customer changed their mind after opening the box.\n\n## Non-returnable items\n\nGift cards, digital downloads, clearance items marked final sale, and hygiene products\nwhose seal has been broken are not returnable. Headphones and earbuds are returnable\nonly if the hygiene seal on the ear cushions is intact, or if the item is faulty.\n\n## How to start a return\n\nStart every return in the customer account under Orders → Return. The portal issues a\nreturn authorisation number and a prepaid label. Write the authorisation number on the\noutside of the parcel; parcels without one are refused at the warehouse. Refunds are\npaid to the original payment method once the warehouse has inspected the item.\n\n## Seasonal and promotional purchases\n\nItems bought during a seasonal promotion follow the same 30-day window as everything\nelse, and the refund is calculated at the price actually paid rather than the current\nlist price. Where a promotion required a minimum basket value and the return drops the\nbasket below that value, the promotional discount is recovered from the refund; this is\nshown on the return confirmation so the customer sees the arithmetic before the parcel\nis sent. Free gifts attached to a promotion must be returned with the main item, or\ntheir value is deducted.\n\n## Return authorisation validity\n\nA return authorisation number is valid for 14 days from the day it is issued. Parcels\nthat arrive after the authorisation has expired are held for five business days and\nthen returned to the customer at their own cost, because the warehouse cannot process\nstock against a closed authorisation. If the customer needs longer, support can issue a\nreplacement authorisation as long as the original return window has not closed.\n\n## Related policies\n\nElectronics follow a shorter window and a restocking fee. Damaged goods must be reported\nquickly and are handled by a separate team. Exchanges have their own window. Refund\nprocessing times are published separately so that support can quote them accurately.\n</documents>","blocks":[{"label":1,"chunkId":"e269ab5eb1609fdec1699b0888ab880751c32ab1856ed4befb42592fe0b9b316","source":"refund-timing.md","heading":"Chargebacks and disputes","text":"# Refund Processing and Timing\n\n## Timeline\n\nOnce the warehouse has inspected a returned item, the refund is issued within 5 to 7\nbusiness days. The money is returned to the original payment method only: the card that\nwas charged, the bank account used for the transfer, or the gift card that was redeemed.\nWe cannot refund to a different card, and we cannot pay a refund in cash.\n\n## When the clock starts\n\nThe 5 to 7 business days start when the inspection is completed, not when the parcel is\ndropped off and not when it is delivered to the warehouse. Inspection usually happens\nwithin two business days of arrival, so the realistic end-to-end time from dropping the\nparcel off is roughly 7 to 9 business days. Support should quote the inspection date from\nthe order timeline rather than guessing.\n\n## Deductions\n\nAny restocking fee is deducted before the refund is issued, so the amount the customer\nsees is the amount they receive. Original shipping charges are refunded only when the\nreturn was caused by a fault, a transit-damage claim or a wrong item. Express shipping\nupgrades are never refunded.\n\n## Partial refunds\n\nA partial refund is issued when accessories, manuals or promotional inserts are missing,\nwhen the packaging is damaged beyond normal handling, or when the serial number does not\nmatch the original shipment. The partial amount is calculated by the inspection team and\nrecorded on the order with a reason code.\n\n## Refund methods\n\nRefunds go back to the original payment method only. A card payment is refunded to the\nsame card, a bank transfer to the same account, and a gift card to the same gift card\ncode. Where a gift card has expired, the balance is reissued as a new gift card rather\nthan paid in cash. Refunds are never issued to a different person, even with the\ncardholder's written consent, because the payment provider rejects the transaction.\n\n## Chargebacks and disputes\n\nIf a customer opens a chargeback before the refund has been issued, the refund process\nis paused and the case is handed to the payments team. Support should not promise a\nrefund date while a dispute is open, because the bank, not Northwind Audio, controls\nthe timeline. Once the dispute is withdrawn the refund is reissued within the normal 5\nto 7 business days.\n\n## If the refund is late\n\nIf more than 7 business days have passed since inspection and no refund is visible, the\ncustomer's bank may still be settling the transaction: card refunds can take a further\n3 to 5 business days to appear on a statement. Support should confirm the refund\nreference from the payment provider before opening a payment investigation.","tokens":557,"score":0.5067450187876504,"specificity":1,"expanded":true},{"label":2,"chunkId":"ed746895c63941a077f828d0c5255c0a91d713c90869493be6072bd9942203fe","source":"returns-general.md","heading":"Scope","text":"# Returns and Refunds — General Policy\n\n## Scope\n\nThis policy applies to every product sold by Northwind Audio through its own storefront,\nunless a product-specific policy says otherwise. It covers the standard return window,\nthe condition an item must be in, the items we never accept back, and the way a return\nis started. Product-specific policies for electronics, damaged goods, exchanges and\nrefunds are published separately and take precedence over this document when they apply.\n\n## Return window\n\nUnopened items may be returned within 30 days of delivery for a full refund. The\n30 days are counted from the delivery date recorded by the carrier, not from the order\ndate and not from the day the parcel is opened. Returns received after the 30-day\nwindow are declined automatically by the returns portal, and the customer is asked to\ncontact support if they believe the delivery date is wrong.\n\n## Condition requirements\n\nAn item must be unused, in its original packaging, and complete with every accessory,\nmanual and promotional insert that shipped with it. Opened items are accepted only when\nthey are faulty, and then only under the damaged-goods or warranty policy. We do not\naccept returns on the basis that the customer changed their mind after opening the box.\n\n## Non-returnable items\n\nGift cards, digital downloads, clearance items marked final sale, and hygiene products\nwhose seal has been broken are not returnable. Headphones and earbuds are returnable\nonly if the hygiene seal on the ear cushions is intact, or if the item is faulty.\n\n## How to start a return\n\nStart every return in the customer account under Orders → Return. The portal issues a\nreturn authorisation number and a prepaid label. Write the authorisation number on the\noutside of the parcel; parcels without one are refused at the warehouse. Refunds are\npaid to the original payment method once the warehouse has inspected the item.\n\n## Seasonal and promotional purchases\n\nItems bought during a seasonal promotion follow the same 30-day window as everything\nelse, and the refund is calculated at the price actually paid rather than the current\nlist price. Where a promotion required a minimum basket value and the return drops the\nbasket below that value, the promotional discount is recovered from the refund; this is\nshown on the return confirmation so the customer sees the arithmetic before the parcel\nis sent. Free gifts attached to a promotion must be returned with the main item, or\ntheir value is deducted.\n\n## Return authorisation validity\n\nA return authorisation number is valid for 14 days from the day it is issued. Parcels\nthat arrive after the authorisation has expired are held for five business days and\nthen returned to the customer at their own cost, because the warehouse cannot process\nstock against a closed authorisation. If the customer needs longer, support can issue a\nreplacement authorisation as long as the original return window has not closed.\n\n## Related policies\n\nElectronics follow a shorter window and a restocking fee. Damaged goods must be reported\nquickly and are handled by a separate team. Exchanges have their own window. Refund\nprocessing times are published separately so that support can quote them accurately.","tokens":650,"score":0.41738927649073165,"specificity":1,"expanded":true}],"tokens":1207,"dropped":2}}
```

A request from the wrong tenant is the one worth checking, because it is the case that must
return nothing rather than something plausible:

```text
{"question":"return window headphones","hits":[],"stages":[{"name":"dense","ms":0,"detail":"0 candidates · 0 eligible · 0 below 0.15"},{"name":"bm25","ms":0,"detail":"0 hits · 0 also in dense"},{"name":"rrf","ms":0,"detail":"k=60 · 0 fused from 0+0"},{"name":"rerank","ms":0,"detail":"heuristic · 0 scored · best 0.000 · nothing cleared the gate"}],"candidates":0}
```

`candidates: 0`, `eligible: 0` — the tenant filter ran *during* the scan, so there was nothing
to score. A post-filtering implementation would have returned candidates and then emptied the
list, which looks like "no results" instead of "not your data".


---

## 6. The Orchestrator — `src/pipeline.ts`

```ts
import { assemble } from './context/assemble.js';
import { createEmbeddings, type EmbeddingProvider } from './embeddings.js';
import { REFUSAL, createGenerator, verifyCitations, type Generator } from './generate.js';
import { buildIndex, type BuiltIndex } from './ingest/indexer.js';
import { loadDocuments } from './ingest/loader.js';
import { compileFilter, type Filter } from './store/filters.js';
import { Bm25Index } from './search/bm25.js';
import { denseSearch } from './search/dense.js';
import { agreement, rrf } from './search/hybrid.js';
import { createReranker, gateReranked, type Reranker } from './search/rerank.js';
import { config as envConfig, paths, type RagConfig } from './config/env.js';
import type {
  AccessContext,
  AssembledContext,
  RagAnswer,
  RagTrace,
  ScoredChunk,
  SourceDocument,
  TraceStage,
} from './types.js';

/**
 * The pipeline: one object that owns every stage, so a trace can name every stage.
 *
 * `retrieve()` and `ask()` are separate on purpose. Retrieval is what you measure
 * when something is wrong, and the only way to measure it independently is to be
 * able to call it without generating an answer. `ask()` is then a thin composition:
 * retrieve → assemble → generate → verify.
 */

export interface RetrievalRun {
  hits: ScoredChunk[];
  dense: ScoredChunk[];
  lexical: ScoredChunk[];
  fused: ScoredChunk[];
  reranked: ScoredChunk[];
  stages: TraceStage[];
  candidates: number;
  belowFloor: number;
  dropped: number;
}

export interface PipelineDeps {
  docs: readonly SourceDocument[];
  index: BuiltIndex;
  bm25: Bm25Index;
  embeddings: EmbeddingProvider;
  reranker: Reranker | null;
  generator: Generator;
  config: RagConfig;
}

export class RagPipeline {
  readonly config: RagConfig;
  private readonly deps: PipelineDeps;

  private constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.config = deps.config;
  }

  /** Build everything from a config. Each ablation preset calls this once. */
  static async create(overrides: Partial<RagConfig> = {}): Promise<RagPipeline> {
    const config: RagConfig = { ...envConfig, ...overrides };
    const docs = await loadDocuments(paths.policies);
    const embeddings = createEmbeddings({ ...config.embedding, openaiApiKey: config.openaiApiKey });

    const index = await buildIndex(docs, {
      strategy: config.chunkStrategy,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      chunkUnit: config.chunkUnit,
      parentMaxTokens: config.parentMaxTokens,
      minChunkTokens: config.minChunkTokens,
      contextualize: config.contextualize,
      lateChunkAlpha: config.lateChunkAlpha,
      semanticThreshold: 0.35,
      embeddings,
      openaiApiKey: config.openaiApiKey,
      chatModel: config.generation.model,
    });

    return new RagPipeline({
      docs,
      index,
      bm25: new Bm25Index(index.records, { k1: config.bm25K1, b: config.bm25B }),
      embeddings,
      reranker: createReranker(config.rerank, { apiKey: config.cohereApiKey, model: config.rerankModel }),
      generator: createGenerator({
        provider: config.generation.provider,
        model: config.generation.model,
        apiKey: config.openaiApiKey,
      }),
      config,
    });
  }

  get stats() {
    return this.deps.index.stats;
  }

  /** Retrieval only — the half of the system that Chapter 10 measures on its own. */
  async retrieve(question: string, options: { access: AccessContext; filter?: Filter }): Promise<RetrievalRun> {
    const stages: TraceStage[] = [];

    const dense = await denseSearch(
      this.deps.index.store,
      this.deps.embeddings,
      question,
      options.access,
      options.filter,
      {
        kRetrieve: this.config.kRetrieve,
        minScore: this.config.minScore,
        mmrLambda: this.config.mmrLambda,
      },
    );

    stages.push({
      name: 'dense',
      ms: Math.round(dense.embedMs + dense.searchMs),
      detail: `${dense.candidates} candidates · ${dense.eligible} eligible · ${dense.belowFloor} below ${this.config.minScore}`,
    });

    let lexical: ScoredChunk[] = [];
    let fused: ScoredChunk[] = dense.hits;

    if (this.config.hybrid === 'rrf') {
      const lexicalStarted = performance.now();
      lexical = this.deps.bm25.search(question, this.config.kRetrieve, compileFilter(options.filter, options.access));
      const lexicalMs = performance.now() - lexicalStarted;

      const shared = agreement(dense.hits, lexical);
      fused = rrf([dense.hits, lexical], this.config.rrfK, this.config.kRetrieve);

      stages.push({
        name: 'bm25',
        ms: Math.round(lexicalMs),
        detail: `${lexical.length} hits · ${shared} also in dense`,
      });
      stages.push({
        name: 'rrf',
        ms: 0,
        detail: `k=${this.config.rrfK} · ${fused.length} fused from ${dense.hits.length}+${lexical.length}`,
      });
    }

    let reranked: ScoredChunk[] = [];
    let hits = fused.slice(0, this.config.kContext);
    let dropped = Math.max(0, fused.length - hits.length);

    if (this.deps.reranker) {
      const started = performance.now();
      reranked = await this.deps.reranker.rerank(question, fused, fused.length);
      const ms = performance.now() - started;

      const gated = gateReranked(reranked, {
        minBest: this.config.rerankMinBest,
        maxDrop: this.config.rerankMaxDrop,
        maxK: this.config.kContext,
      });

      hits = gated.kept;
      dropped = fused.length - hits.length;

      stages.push({
        name: 'rerank',
        ms: Math.round(ms),
        detail: `${this.deps.reranker.name} · ${reranked.length} scored · best ${(reranked[0]?.score ?? 0).toFixed(3)} · ${gated.refused ? 'nothing cleared the gate' : `${gated.kept.length} kept`}`,
      });
    }

    return {
      hits,
      dense: dense.hits,
      lexical,
      fused,
      reranked,
      stages,
      candidates: dense.candidates,
      belowFloor: dense.belowFloor,
      dropped,
    };
  }

  /** Exposed so the CLI and the API can show what the index actually contains. */
  get store() {
    return this.deps.index.store;
  }

  get records() {
    return this.deps.index.records;
  }

  /** Retrieve, assemble, generate, verify — and record all of it. */
  async ask(
    question: string,
    options: { access: AccessContext; filter?: Filter },
  ): Promise<RagAnswer & { context: AssembledContext }> {
    const startedAt = performance.now();
    const run = await this.retrieve(question, options);

    const assembleStarted = performance.now();
    const context = assemble(run.hits, {
      maxTokens: this.config.maxContextTokens,
      expandParents: this.config.expandParents,
      bookendOrder: this.config.bookendOrder,
    });
    const assembleMs = performance.now() - assembleStarted;

    const generateStarted = performance.now();
    const generated = context.blocks.length === 0
      ? { text: REFUSAL, refused: true }
      : await this.deps.generator.generate({ question, context });
    const generateMs = performance.now() - generateStarted;

    const citations = verifyCitations(generated.text, context.blocks);

    const stages: TraceStage[] = [
      ...run.stages,
      {
        name: 'assemble',
        ms: Math.round(assembleMs),
        detail: `${context.blocks.length} blocks · ${context.tokens} tokens · ${context.dropped} dropped`,
      },
      {
        name: 'generate',
        ms: Math.round(generateMs),
        detail: `${this.deps.generator.name} · ${generated.refused ? 'refused' : `${citations.length} citations`}`,
      },
    ];

    const trace: RagTrace = {
      question,
      asOf: options.access.asOf,
      tenantId: options.access.tenantId,
      stages,
      retrieved: describeRetrieval(run),
      candidates: run.candidates,
      reranked: run.reranked.length,
      contextTokens: context.tokens,
      dropped: context.dropped,
      refused: generated.refused,
      invalidCitations: citations.filter((citation) => !citation.valid).length,
      latencyMs: Math.round(performance.now() - startedAt),
      providers: {
        embeddings: this.deps.embeddings.model,
        rerank: this.deps.reranker?.name ?? 'none',
        generation: this.deps.generator.name,
      },
    };

    return {
      answer: generated.text,
      citations,
      refused: generated.refused,
      trace,
      context,
    };
  }
}

/** One row per candidate, carrying every score it collected along the way. */
function describeRetrieval(run: RetrievalRun): RagTrace['retrieved'] {
  const rows = new Map<string, RagTrace['retrieved'][number]>();

  const upsert = (hit: ScoredChunk) => {
    const existing = rows.get(hit.chunk.id) ?? {
      id: hit.chunk.id,
      source: hit.chunk.source,
      heading: hit.chunk.heading || hit.chunk.title,
      dense: 0,
      used: false,
    };
    rows.set(hit.chunk.id, existing);
    return existing;
  };

  for (const hit of run.dense) upsert(hit).dense = round(hit.score);
  for (const hit of run.lexical) upsert(hit).bm25 = round(hit.score);
  for (const hit of run.fused) upsert(hit).fused = round(hit.score);
  for (const hit of run.reranked) upsert(hit).rerank = round(hit.score);
  run.hits.forEach((hit, index) => {
    const row = upsert(hit);
    row.used = true;
    row.rank = index + 1;
  });

  return [...rows.values()].sort(
    (left, right) => Number(right.used) - Number(left.used) || right.dense - left.dense,
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
```

**Block by block:**

- **`retrieve()` and `ask()` are separate on purpose.** Retrieval is what you measure when
  something is wrong, and the only way to measure it independently is to be able to call it
  without generating an answer. The ablation uses `retrieve()`; `ask()` is a thin composition on
  top of it.
- **Every stage appends to `stages` with a `detail` string that contains numbers**: candidates,
  eligible, below floor, overlap between arms, best rerank score, kept count, blocks, tokens,
  dropped. The trace is designed to be *read*, not just logged.
- **`describeRetrieval` builds one row per candidate** and fills in each score it collected along
  the way — dense, BM25, fused, rerank — plus the rank that reached the prompt. That single
  table is the answer to "why did this document win?", and it is why the guide can quote exact
  numbers for every claim it makes.
- **Refusal short-circuits before generation.** `context.blocks.length === 0` means the gate
  already decided, so `generate` is never called and the stage reports `0ms · refused`.
- **`RagPipeline.create` is the only place the stages are wired.** A preset changes values, not
  structure, which is what keeps the ablation honest: there is no second code path to
  accidentally improve.

---

## 7. The Measurement Discipline

```bash
npm run cli -- eval        # per-case: recall, MRR, nDCG, facts, citations
npm run cli -- ablation    # per-preset: recall, MRR, nDCG, refusal, falseRef, tokens, p50
npm run cli -- calibrate   # both floors, swept
```

Three rules the code enforces, and they are worth copying:

1. **Retrieval and generation are measured separately.** The ablation varies retrieval controls
   and therefore reports retrieval metrics; `facts` appears only in `eval`, next to the per-case
   diagnosis. Mixing them attributes a generator problem to a retrieval change.
2. **Both failure directions are reported.** `refusal` (unanswerable questions correctly
   refused) and `falseRef` (answerable questions wrongly refused) always travel together,
   because any single number can be gamed by moving a floor.
3. **Every number is reproducible offline.** The same command on another machine produces the
   same table, which is what makes a regression reviewable in a pull request.

---

## 8. Production Notes From the Notes, Mapped to Code

| Lecture 12 concern | Where it lives here |
| :--- | :--- |
| Version everything that changes the index | `IndexRecord.embedText` + the model/dimensions guard in the store |
| Never re-index in place | the store is built at boot; a re-index is a deployment |
| Filter before scoring, always | `VectorQuery.mode = 'pre'` and the filter demo |
| Tenant isolation fails closed | `isVisible` in `store/filters.ts`, plus ingestion-time validation |
| Refusal must be cheap and testable | `REFUSAL`, the gate, and `generate 0ms · refused` in the trace |
| Citations must be verifiable | labels assigned in `assemble`, verified in `verifyCitations` |
| Prompt injection is an authority problem | `<documents>` framing, `sanitiseEvidence`, and citation-only answers |
| Every answer must be explainable | `RagTrace`, returned by both the CLI and the API |
| Measure before and after | `eval/run.ts` presets and the golden set |
| Know your p50 and your token bill | `summarise` and `averageContextTokens` |

---

## 9. What to Take Away

- **Ablate one control at a time, on the same questions.** Otherwise you learn nothing from a
  difference.
- **Report recall and refusal together.** Every floor moves both, in opposite directions.
- **Measure retrieval and generation separately.** The failure tree tells you which one broke.
- **Make the golden set small enough to run on every change.** Fourteen cases run in a second.
- **Return the trace from the API.** Debuggability is a product feature.
- **Take access from the request.** Defaults are how tenants leak.
- **Write down the honest limits.** Every number in this codebase is a lower bound on what the
  same pipeline does with real embeddings and a real model.

---

## 10. Where to Go From Here

The pipeline is deliberately small, so the extensions are obvious and each one is a chapter of
its own:

- **Real embeddings** — set `OPENAI_API_KEY` and re-run `calibrate`. The floors will move; that
  is the point of the sweep.
- **A real reranker** — set `RERANK=cohere`, then re-calibrate `RERANK_MIN_BEST` for its score
  distribution.
- **A real store** — the `MemoryVectorStore` interface (`upsert`, `query`, `deleteBySource`,
  `count`) is the same one Qdrant and pgvector adapters implement in Lecture 10's codebase.
- **More cases** — the golden set is the asset that compounds. Every production bug that gets
  fixed should add a case, or it will come back.
- **Semantic chunking where structure is missing** — `CHUNK_STRATEGY=semantic` on transcripts,
  with the size cap left in place.

> **Back to:** [Chapter 00](./00_Overview_Provider_Structure_and_File_Map.md) ·
> [Guide index](./README.md) · [Lecture 12 notes](../../notes/README.md) ·
> [Consolidated notes](../../notes/Lecture_12_Complete_Notes.md)


