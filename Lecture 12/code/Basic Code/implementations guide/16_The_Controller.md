# Chapter 16 — The Controller

> **Goal of this chapter:** read the file that turns HTTP into domain calls. A
> controller does three things — validate the request, call **one** service,
> shape the response — and nothing else.
>
> **Lecture chapters:** all of them. The controller is where Chapter 05's
> "server-derived scope" rule becomes visible in code.

---

## 16.1 File details

| Property | Value |
|---|---|
| **Path** | `src/controllers/ragController.ts` |
| **Layer** | HTTP in |
| **Purpose** | one function per route: validate → call one service → serialise |
| **Imports** | `Request`/`Response` (types), `config`, `Filter`/`Hit` (models), `DOCUMENTS`, `runPipeline`, `ablation`/`evaluate`/`GOLDEN`, `buildIndex`/`filterFrom`/`isEligible` |
| **Exports** | `health`, `search`, `ask`, `filters`, `evaluateHandler`, `ablationHandler` |
| **Imported by** | `routes/index.ts` |
| **Lecture sections** | 01 §"the trace", 05 §"server-derived scope", 09 §"the runbook" |

### The three jobs, and what is deliberately absent

| Job | Where |
|---|---|
| validate | `questionFrom(req.body)` — one function, one error message |
| call a service | `runPipeline`, `evaluate`, `ablation` — exactly one per handler |
| shape the response | `toHits()` and the JSON literals |

**Absent:** any retrieval logic, any filter construction from the request, any
`try/catch`. Errors are *thrown* and the middleware in Chapter 18 turns them into
status codes — one failure path, not six.

---

## 16.2 Commands

```bash
cd "Lecture 12/code/Basic Code"
npm run dev        # http://localhost:3100

curl localhost:3100/health
curl localhost:3100/filters
curl -X POST localhost:3100/search -H 'content-type: application/json' \
     -d '{"question":"Does the AX-204 wireless headphone support fast charging?"}'
curl -X POST localhost:3100/ask -H 'content-type: application/json' \
     -d '{"question":"Can I return my damaged headphones after 10 days?"}'

# the failure path
curl -X POST localhost:3100/ask -H 'content-type: application/json' -d '{}'
curl localhost:3100/nope
```

---

## 16.3 Full file

**Path:** `src/controllers/ragController.ts`

```ts
import type { Request, Response } from "express";
import { config } from "../config/config.js";
import type { Filter, Hit } from "../models/types.js";
import { DOCUMENTS } from "../services/documents.js";
import { ablation, evaluate, GOLDEN } from "../services/eval.js";
import { runPipeline } from "../services/index.js";
import { buildIndex, filterFrom, isEligible } from "../services/store.js";

/**
 * Chapter 14 — the controller.
 *
 * A controller does three things and nothing else:
 *   1. read and validate the request,
 *   2. call **one** service,
 *   3. shape the response.
 *
 * It contains no retrieval logic, which is what keeps every rule in the notes
 * reachable from both the CLI and HTTP without being written twice.
 */

/** The request contract, validated in one place (Chapter 16 turns the throw into a 400). */
function questionFrom(body: unknown): string {
  const question = (body as { question?: unknown } | null)?.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new Error("Body must be { question: string } with a non-empty question.");
  }
  return question.trim();
}

/** Chapters 08–09 — the ranked lists, flattened into JSON. */
function toHits(hits: Hit[]): { id: string; source: string; heading: string; score: number }[] {
  return hits.map((hit) => ({
    id: hit.chunk.id,
    source: hit.chunk.docId,
    heading: hit.chunk.breadcrumb,
    score: Number(hit.score.toFixed(4)),
  }));
}
```

```ts
/** Chapter 17 — liveness, plus the controls that produced the last answer. */
export function health(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    service: "lecture-12-basic-rag",
    documents: DOCUMENTS.length,
    chunks: buildIndex(DOCUMENTS, config).length,
    // Only the non-sensitive knobs: never the tenant or the ACL.
    controls: {
      chunkStrategy: config.chunkStrategy,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      kRetrieve: config.kRetrieve,
      kContext: config.kContext,
      minScore: config.minScore,
      hybrid: config.hybrid,
      rrfK: config.rrfK,
      rerank: config.rerank,
      rerankMinBest: config.rerankMinBest,
      maxContextTokens: config.maxContextTokens,
    },
  });
}

/** Chapters 07–09 — the retrieval trace, without the answer. */
export function search(req: Request, res: Response): void {
  const question = questionFrom(req.body);
  const trace = runPipeline(question, config);
  res.json({
    question,
    filter: trace.filter,
    corpus: { chunks: trace.chunks, eligible: trace.eligible },
    dense: toHits(trace.dense),
    lexical: toHits(trace.lexical),
    fused: toHits(trace.fused),
    reranked: toHits(trace.reranked),
    gate: {
      best: trace.reranked[0] ? Number(trace.reranked[0].score.toFixed(4)) : null,
      min: config.rerankMinBest,
      passed: trace.passed,
    },
    context: {
      blocks: trace.context.blocks.length,
      tokens: trace.context.tokens,
      ids: trace.context.ids,
    },
    timings: trace.timings,
  });
}

/** Chapters 10–11 — the assembled prompt and the grounded answer. */
export function ask(req: Request, res: Response): void {
  const question = questionFrom(req.body);
  const trace = runPipeline(question, config);
  res.json({
    question,
    answer: trace.answer.text,
    citations: trace.answer.citations,
    refused: trace.answer.refused,
    sources: trace.context.blocks.map((block) => ({
      label: block.label,
      source: block.docId,
      heading: block.heading,
    })),
    context: trace.context.text,
    tokens: trace.context.tokens,
  });
}

/** Chapter 07 — eligibility, access control and time travel, as JSON. */
export function filters(_req: Request, res: Response): void {
  const index = buildIndex(DOCUMENTS, config);
  const base = filterFrom(config);

  const scenarios: { label: string; filter: Filter }[] = [
    { label: "category in [electronics, general] (correct tiers)", filter: { ...base, categories: ["electronics", "general"] } },
    { label: "category == electronics (the bug)", filter: { ...base, categories: ["electronics"] } },
    { label: 'tenant = "" (fail closed)', filter: { ...base, tenant: "" } },
    { label: "asOf = 2026-02-01 (before the new policy)", filter: { ...base, asOf: "2026-02-01", categories: ["electronics", "general"] } },
  ];

  res.json({
    scenarios: scenarios.map(({ label, filter }) => ({
      scenario: label,
      eligible: [...new Set(index.filter((chunk) => isEligible(chunk, filter)).map((chunk) => chunk.docId))],
    })),
  });
}

/** Chapter 13 — the golden set, per case and in aggregate. */
export function evaluateHandler(_req: Request, res: Response): void {
  const { metrics, cases } = evaluate();
  res.json({ golden: GOLDEN.length, metrics, cases });
}

/** Chapter 13 — the ablation table. */
export function ablationHandler(_req: Request, res: Response): void {
  res.json({ presets: ablation() });
}
```

---

## 16.4 Block-by-block explanation

**Block 1 — the header comment is the job description**

```ts
/**
 * Chapter 14 — the controller.
 *
 * A controller does three things and nothing else:
 *   1. read and validate the request,
 *   2. call **one** service,
 *   3. shape the response.
 */
```

- Three numbered jobs, and the rule that makes the layer testable: **one service
  call per handler.** If a handler called `hybridSearch` and then `rerank` itself,
  the pipeline would have two orchestrators and the trace would diverge between
  HTTP and the CLI.

**Block 2 — `questionFrom`: validation in one place**

```ts
function questionFrom(body: unknown): string {
  const question = (body as { question?: unknown } | null)?.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new Error("Body must be { question: string } with a non-empty question.");
  }
  return question.trim();
}
```

- `body: unknown`, not `any`: the parameter type forces the cast, and the cast
  forces the checks. Express gives you `any`, which would let `req.body.question`
  flow into the pipeline as `undefined`.
- `?.question` guards a `null` body (a request with no JSON at all).
- The check is two conditions: *is it a string* and *is it non-empty after
  trimming*. A body of `{"question":"   "}` is rejected — otherwise a
  whitespace-only question would embed to the zero vector.
- The error message is written as an **instruction** ("Body must be …"), the same
  convention Chapter 05 uses for ingest errors. Chapter 18 maps it to a `400` by
  its prefix.
- **`.trim()` before returning** means every downstream stage sees a normalised
  question, so the trace, the citations and the answer all agree.

**Block 3 — `toHits`: one serialiser for four lists**

```ts
function toHits(hits: Hit[]): { id: string; source: string; heading: string; score: number }[] {
  return hits.map((hit) => ({
    id: hit.chunk.id, source: hit.chunk.docId,
    heading: hit.chunk.breadcrumb, score: Number(hit.score.toFixed(4)),
  }));
}
```

- Four fields and nothing else: the same three the CLI prints (score, source,
  heading) plus the chunk id. An `IndexedChunk` also carries a 256-dimension
  `vector`; serialising it would put kilobytes of noise in every response.
- `Number(hit.score.toFixed(4))` rounds the score — because after fusion the same
  field holds an RRF value and after reranking a joint score, and both should
  read consistently in JSON.
- One helper used by four lists means the response shape cannot drift between
  `dense`, `lexical`, `fused` and `reranked`.

**Block 4 — `health`**

```ts
export function health(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    service: "lecture-12-basic-rag",
    documents: DOCUMENTS.length,
    chunks: buildIndex(DOCUMENTS, config).length,
    // Only the non-sensitive knobs: never the tenant or the ACL.
    controls: { chunkStrategy: config.chunkStrategy, … },
  });
}
```

- The `_req` prefix is the convention for "required by Express, unused by me".
- `chunks` is computed live, so `/health` doubles as a **configuration check**:
  change `CHUNK_STRATEGY` and this number moves from 19 to 12.
- `controls` lists the retrieval knobs and **deliberately omits `tenantId`,
  `acl` and `asOf`**. A health endpoint is often public; the authorisation
  boundary is not something to publish. That comment is the whole reason the
  object is written out by hand instead of spreading `config`.

**Block 5 — `search`: the trace, as JSON**

```ts
export function search(req: Request, res: Response): void {
  const question = questionFrom(req.body);
  const trace = runPipeline(question, config);
  res.json({ question, filter: trace.filter, corpus: {…}, dense: toHits(trace.dense), …, gate: {…}, context: {…}, timings: trace.timings });
}
```

- **Two lines of work** (`questionFrom`, `runPipeline`) and then pure shaping.
  That ratio is what "the controller contains no retrieval logic" means in
  practice.
- `filter: trace.filter` is echoed back because a surprising result is almost
  always explained by which documents were eligible. It is safe to echo: it comes
  from config, not from the caller.
- `gate.best` uses a ternary rather than `?.` because the JSON should say `null`
  explicitly when there are no candidates — an absent field would be ambiguous
  between "no candidates" and "not computed".
- The context is summarised (`blocks`, `tokens`, `ids`) rather than returned in
  full, because `/search` is the *diagnostic* endpoint; `/ask` is where the
  prompt text is worth sending.

**Block 6 — `ask` and `filters`**

```ts
export function ask(req, res) { … res.json({ question, answer, citations, refused, sources, context, tokens }); }

export function filters(_req, res) {
  const scenarios: { label: string; filter: Filter }[] = [
    { label: "category in [electronics, general] (correct tiers)", filter: { ...base, categories: ["electronics", "general"] } },
    …
  ];
  res.json({ scenarios: scenarios.map(({ label, filter }) => ({ scenario: label, eligible: […] })) });
}
```

- `/ask` returns `sources` as `{ label, source, heading }` triples, so a caller
  can render "claim → [n] → document" without parsing the prompt. `context` is
  returned in full because that is the string a model would receive — the point of
  the whole project.
- `/filters` is the Chapter 07 table over HTTP: an array of `{ label, filter }`
  where every filter is a spread of the same `base`, so the scenarios differ by
  exactly one field. That is the same `{ ...base, … }` pattern the ablation uses
  in Chapter 13.
- `[...new Set(…)]` de-duplicates documents, because several chunks of one
  document are one eligible document.

**Block 7 — the two evaluation handlers**

```ts
export function evaluateHandler(_req, res) { const { metrics, cases } = evaluate(); res.json({ golden: GOLDEN.length, metrics, cases }); }
export function ablationHandler(_req, res) { res.json({ presets: ablation() }); }
```

- Both are two-liners: the services already return JSON-shaped data, so the
  controller adds nothing but the envelope.
- `golden: GOLDEN.length` is included so a caller can see the sample size beside
  the metrics — a metric without its n is not a measurement.
- These handlers take **no request body**. They are `GET`s over a fixed golden
  set, which is why they are the only two functions here that ignore the request
  entirely.

---

## 16.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run dev &

curl -s localhost:3100/health | head -c 200; echo
curl -s -X POST localhost:3100/ask -H 'content-type: application/json' \
  -d '{"question":"Can I return my damaged headphones after 10 days?"}' \
  | python3 -m json.tool | head -20
```

Expected (excerpt): `/health` reports `"documents": 7` and `"chunks": 19`; `/ask`
returns `"refused": false` with two `sources` and a `context` containing the
`<precedence>` block. The failure paths:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3100/ask \
  -H 'content-type: application/json' -d '{}'      # 400
curl -s -o /dev/null -w '%{http_code}\n' localhost:3100/nope   # 404
```

---

## 16.6 Checkpoint

1. **What are the controller's three jobs?** Validate the request, call one
   service, shape the response — in that order.
2. **Why does `questionFrom` take `unknown` rather than `any`?** So the cast is
   forced and the runtime checks cannot be skipped.
3. **Why does `/health` not return `config` wholesale?** Because `config`
   contains the tenant and the ACL, and a health endpoint is usually public.

**Next:** [Chapter 17 — The routes](./17_The_Routes.md)



