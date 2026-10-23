# Chapter 13 — The CLI

> **Goal of this chapter:** the *first* entry point. One file, six commands, and
> the reason the project is checkable without starting a server: every claim in the
> notes has a command that shows it.
>
> **Lecture chapters:** all of them. Each command is labelled with the chapter it
> demonstrates.

---

## 13.1 File details

| Property | Value |
|---|---|
| **Path** | `src/cli.ts` |
| **Layer** | entry (the command-line door) |
| **Purpose** | parse a subcommand + optional question, dispatch, print |
| **Imports** | `config`, `Filter`/`Hit` (models), `fixedChunks`/`structuralChunks`, `DOCUMENTS`, `ablation`/`evaluate`/`GOLDEN`, `runPipeline`, `buildIndex`/`filterFrom`/`isEligible` |
| **Exports** | none — it is a process entry point |
| **Imported by** | nobody (it is a top of the graph) |
| **Lecture sections** | all |

### The six commands, and the chapter each demonstrates

| Command | Prints | Demonstrates |
|---|---|---|
| `npm run ask` | trace + assembled prompt + answer | Ch 09–12 |
| `npm run search` | the four ranked lists + gate + timings | Ch 09–10 |
| `npm run chunks` | chunk counts, ids, and one document both ways | Ch 06–07 |
| `npm run filters` | eight eligibility scenarios | Ch 08 |
| `npm run eval` | per-case metrics + summary | Ch 14 |
| `npm run ablation` | one control at a time | Ch 14 |

> **Note.** The CLI is a *second* entry point beside `src/index.ts` (the HTTP
> server, Chapter 19). It imports the same services, which is why a change to a
> control shows up in both the CLI output and the API response without any
> duplicated code.

---

## 13.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run ask
npm run search
npm run chunks
npm run filters
npm run eval
npm run ablation

# with your own question (everything after `--` becomes the argument)
npm run ask -- "Does the AX-204 wireless headphone support fast charging?"
npm run search -- "Who won the Indian Premier League in 2026?"
```


---

## 13.3 Full file

**Path:** `src/index.ts`

```ts
#!/usr/bin/env node
import { config } from "./config/config.js";
import type { Filter, Hit } from "./models/types.js";
import { fixedChunks, structuralChunks } from "./services/chunking.js";
import { DOCUMENTS } from "./services/documents.js";
import { ablation, evaluate, GOLDEN } from "./services/eval.js";
import { runPipeline } from "./services/index.js";
import { buildIndex, filterFrom, isEligible } from "./services/store.js";

/**
 * Chapter 18 — the CLI: one command per chapter, so every claim in the notes can
 * be seen without starting a server.
 *
 *   npm run ask        Chapter 11 — the full pipeline, ending in an answer
 *   npm run search     Chapters 07–09 — the same pipeline, stage by stage
 *   npm run chunks     Chapters 05–06 — fixed vs structural chunking
 *   npm run filters    Chapter 07 — eligibility, access and time
 *   npm run eval       Chapter 13 — per-case retrieval and generation metrics
 *   npm run ablation   Chapter 13 — one control at a time
 *
 * It imports the same services as `controllers/ragController.ts`, because the
 * CLI and the HTTP API are two doors into one domain layer.
 */
const DEFAULT_QUESTION = "Can I return my damaged headphones after 10 days?";

const show = (hit: Hit): string =>
  `${hit.score.toFixed(4)}  ${hit.chunk.docId}  ${hit.chunk.breadcrumb}`;

function listHits(title: string, hits: Hit[], limit = 3): void {
  console.log(`\n  ${title} (${hits.length})`);
  if (hits.length === 0) {
    console.log("    (empty)");
    return;
  }
  for (const hit of hits.slice(0, limit)) console.log(`    ${show(hit)}`);
  if (hits.length > limit) console.log(`    … ${hits.length - limit} more`);
}

function header(question: string): void {
  console.log(`\nQuestion: ${question}`);
  console.log(
    `Filter  : tenant=${config.tenantId} acl=[${config.acl.join(", ")}] asOf=${config.asOf} categories=[${config.categories.join(", ")}]`,
  );
}
```

```ts
/** Chapters 04–07 — the retrieval trace, in the order the notes draw it. */
function commandSearch(question: string): void {
  const trace = runPipeline(question);
  header(question);
  console.log(
    `Corpus  : ${DOCUMENTS.length} documents → ${trace.chunks} chunks → ${trace.eligible} eligible`,
  );

  listHits("1 · dense (cosine, above the floor)", trace.dense);
  listHits("2 · lexical (BM25)", trace.lexical);
  listHits(`3 · fused (RRF, k = ${config.rrfK})`, trace.fused);
  listHits("4 · reranked (joint score)", trace.reranked);

  const best = trace.reranked[0]?.score.toFixed(4) ?? "n/a";
  console.log(`\n  Gate    : best ${best} vs ${config.rerankMinBest} → ${trace.passed ? "pass" : "REFUSE"}`);
  console.log(`  Context : ${trace.context.blocks.length} blocks, ~${trace.context.tokens} tokens`);
  console.log(`  Timings : ${JSON.stringify(trace.timings)} ms`);
}

/** Chapter 08 — the assembled prompt and the grounded answer. */
function commandAsk(question: string): void {
  const trace = runPipeline(question);
  commandSearch(question);

  console.log("\n── assembled context ─────────────────────────────────");
  console.log(trace.context.text);
  console.log("\n── answer ────────────────────────────────────────────");
  console.log(trace.answer.text);
  console.log(
    `\ncitations: [${trace.answer.citations.join(", ")}]  refused: ${trace.answer.refused}`,
  );
}
```

```ts
/** Chapters 02–03 — chunking and the overlap arithmetic. */
function commandChunks(): void {
  const size = config.chunkSize;
  const overlap = config.chunkOverlap;
  console.log(`\nchunk size = ${size} tokens, overlap = ${overlap} tokens`);
  console.log(
    `step = S - O = ${size - overlap}   storage multiplier = S / (S - O) = ${(size / (size - overlap)).toFixed(2)}x`,
  );

  for (const strategy of ["fixed", "structural"] as const) {
    const chunks = buildIndex(DOCUMENTS, { ...config, chunkStrategy: strategy });
    console.log(`\n${strategy}: ${chunks.length} chunks`);
    for (const chunk of chunks) console.log(`  ${chunk.id}\n    ${chunk.breadcrumb}`);
  }

  const doc = DOCUMENTS.find((d) => d.id === "return-policy-electronics")!;
  console.log("\n── the same document, both ways ──────────────────────");
  console.log("fixed:");
  for (const chunk of fixedChunks(doc, config)) console.log(`  • ${chunk.body}`);
  console.log("structural:");
  for (const chunk of structuralChunks(doc)) {
    console.log(`  • ${chunk.breadcrumb}\n    ${chunk.body}`);
  }
}
```

```ts
/** Chapter 05 — eligibility, not preference. */
function commandFilters(): void {
  const index = buildIndex(DOCUMENTS, config);
  const base = filterFrom(config);

  const eligible = (filter: Filter): string[] => [
    ...new Set(index.filter((chunk) => isEligible(chunk, filter)).map((chunk) => chunk.docId)),
  ];

  const rows: [string, Filter][] = [
    ["category in [electronics, general]   (correct tiers)", { ...base, categories: ["electronics", "general"] }],
    ["category == electronics              (the bug)", { ...base, categories: ["electronics"] }],
    ["category == general                  (too narrow)", { ...base, categories: ["general"] }],
    ['tenant = ""                          (fail closed)', { ...base, tenant: "" }],
    ["acl = [support, customer]            (default)", base],
    ["acl = [finance]                      (internal SOP visible)", { ...base, acl: ["finance"], categories: ["internal"] }],
    ["asOf = 2026-02-01                    (before the new policy)", { ...base, asOf: "2026-02-01", categories: ["electronics", "general"] }],
    ["asOf = 2026-06-01                    (superseded policy gone)", { ...base, asOf: "2026-06-01", categories: ["electronics", "general"] }],
  ];

  console.log("\nChapter 05 — what is eligible, and what is invisible\n");
  for (const [label, filter] of rows) {
    const docs = eligible(filter);
    console.log(`${label}\n    ${docs.length} docs: ${docs.join(", ") || "(none)"}`);
  }
}
```

```ts
/** Chapter 09 — retrieval metrics beside generation metrics. */
function commandEval(): void {
  const { metrics, cases } = evaluate();
  console.log(`\nChapter 09 — golden set (${GOLDEN.length} cases)\n`);
  for (const row of cases) {
    const mark = row.recall === 1 && row.correct === 1 ? "✓" : "✗";
    console.log(
      `${mark} recall ${row.recall}  prec ${row.precision.toFixed(2)}  mrr ${row.reciprocal.toFixed(3)}  ${row.refused ? "refused" : "answered"}  ${row.question}`,
    );
    console.log(`    expected : ${row.expected.join(", ") || "(none — must refuse)"}`);
    console.log(`    retrieved: ${row.retrieved.join(", ") || "(none)"}`);
  }
  console.log(
    `\nsummary  chunks ${metrics.chunks}  recall ${metrics.recall}  precision ${metrics.precision}  mrr ${metrics.mrr}  refusal ${metrics.refusal}  ctx tokens ${metrics.contextTokens}`,
  );
}

/** Chapter 09 — one control at a time, same golden set. */
function commandAblation(): void {
  const rows = ablation();
  console.log("\nChapter 09 — ablation (one control at a time)\n");
  console.log("preset       chunks  recall  prec   mrr    refusal  ctx tok");
  for (const row of rows) {
    const m = row.metrics;
    console.log(
      `${row.preset.padEnd(12)} ${String(m.chunks).padEnd(7)} ${m.recall.toFixed(3)}   ${m.precision.toFixed(3)}  ${m.mrr.toFixed(3)}  ${m.refusal.toFixed(3)}    ${m.contextTokens}`,
    );
  }
}

const [, , command = "ask", ...rest] = process.argv;
const question = rest.join(" ").trim() || DEFAULT_QUESTION;

switch (command) {
  case "ask":
    commandAsk(question);
    break;
  case "search":
    commandSearch(question);
    break;
  case "chunks":
    commandChunks();
    break;
  case "filters":
    commandFilters();
    break;
  case "eval":
    commandEval();
    break;
  case "ablation":
    commandAblation();
    break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log("Use one of: ask | search | chunks | filters | eval | ablation");
    process.exitCode = 1;
}
```

---

## 13.4 Block-by-block explanation

**Block 1 — the shebang, and the imports**

```ts
#!/usr/bin/env node
import { config } from "./config/config.js";
...
import { buildIndex, filterFrom, isEligible, type Filter } from "./services/store.js";
```

- The shebang makes the compiled file directly executable, so `./dist/index.js ask` works.
  It costs one line and removes a wrapper script.
- `src/index.ts` imports from **six** service files plus config — the most of any file in
  the project — because it is the presentation layer: it is allowed to know about every
  stage, and nothing is allowed to know about it.
- Note that it does not import `context.ts`, `generate.ts`, `rerank.ts` or `search.ts` for
  the *pipeline* — it reaches them through `runPipeline`'s `Trace`. The CLI depends on the
  **trace contract**, not on the individual services. That is why adding a stage to the
  pipeline needs no CLI change beyond printing a new field.

**Block 2 — the default question**

```ts
const DEFAULT_QUESTION = "Can I return my damaged headphones after 10 days?";
```

- The lecture's running example, in one constant. Every command that takes a question falls
  back to it, so `npm run ask` with no argument reproduces the example in the notes
  exactly — which is what makes this guide's expected outputs stable.

**Block 3 — `show` and `listHits`: one ranking, one printer**

```ts
const show = (hit: Hit): string =>
  `${hit.score.toFixed(4)}  ${hit.chunk.docId}  ${hit.chunk.breadcrumb}`;

function listHits(title: string, hits: Hit[], limit = 3): void {
  console.log(`\n  ${title} (${hits.length})`);
  if (hits.length === 0) {
    console.log("    (empty)");
    return;
  }
  for (const hit of hits.slice(0, limit)) console.log(`    ${show(hit)}`);
  if (hits.length > limit) console.log(`    … ${hits.length - limit} more`);
}
```

- `show` prints three fields and nothing else: **score, document id, breadcrumb**. That is
  the notes' baseline-inspection habit — *"print the retrieved text with its score, id and
  metadata"* — reduced to one line. The breadcrumb makes the row readable without printing
  the body.
- `hits.length` is printed in the title even when the list is truncated, so the reader
  always knows the true size. `(10)` with three rows shown and `… 7 more` is honest;
  printing only the visible rows would not be.
- The `(empty)` branch matters more than it looks: an empty list is the *evidence* that the
  floor or the gate worked. Printing nothing at all would be ambiguous.
- `limit = 3` is a default parameter, so `listHits(title, hits)` and
  `listHits(title, hits, 5)` both work — the same pattern as `buildIndex`'s `docs` default.

**Block 4 — `header`: the filter, on every question**

```ts
function header(question: string): void {
  console.log(`\nQuestion: ${question}`);
  console.log(`Filter  : tenant=${config.tenantId} acl=[...] asOf=${config.asOf} categories=[...]`);
}
```

- Printing the filter next to every question is a deliberate diagnostic choice. When a
  result surprises you, the first question is *"which documents were even eligible?"* — and
  the answer is on screen.
- It reads from the global `config` rather than from the trace, which is correct here: the
  CLI *is* the process that owns the configuration.

**Block 5 — `commandSearch`: the trace, stage by stage**

```ts
  const trace = runPipeline(question);
  header(question);
  console.log(`Corpus  : ${DOCUMENTS.length} documents → ${trace.chunks} chunks → ${trace.eligible} eligible`);

  listHits("1 · dense (cosine, above the floor)", trace.dense);
  listHits("2 · lexical (BM25)", trace.lexical);
  listHits(`3 · fused (RRF, k = ${config.rrfK})`, trace.fused);
  listHits("4 · reranked (joint score)", trace.reranked);

  const best = trace.reranked[0]?.score.toFixed(4) ?? "n/a";
  console.log(`\n  Gate    : best ${best} vs ${config.rerankMinBest} → ${trace.passed ? "pass" : "REFUSE"}`);
  console.log(`  Context : ${trace.context.blocks.length} blocks, ~${trace.context.tokens} tokens`);
  console.log(`  Timings : ${JSON.stringify(trace.timings)} ms`);
```

- The four numbered lists are the notes' pipeline diagram, printed in order: dense →
  lexical → RRF → rerank. Printing all four (not just the winner) is what makes the
  *comparison* visible — you can see BM25 promote a chunk that dense missed.
- `Corpus: 7 documents → 19 chunks → 15 eligible` is three chapters in one line: the corpus
  (03), the chunker (04), the filter (05).
- `trace.reranked[0]?.score.toFixed(4) ?? "n/a"` uses optional chaining because the reranked
  list *can* be empty. `?.` plus `?? "n/a"` means the line cannot throw — a small thing that
  matters in a diagnostic tool, where a crash destroys the evidence you were about to look
  at.
- `JSON.stringify(trace.timings)` prints all four stage timings at once. Because `timings` is
  a `Record<string, number>`, a new stage appears here with no change to this line.
- `trace.passed ? "pass" : "REFUSE"` prints the decision in the vocabulary of the notes. The
  gate's value and threshold are both shown, so a reader can see *why* it passed.

**Block 6 — `commandAsk`: reuse, don't duplicate**

```ts
function commandAsk(question: string): void {
  const trace = runPipeline(question);
  commandSearch(question);

  console.log("\n── assembled context ─────────────────────────────────");
  console.log(trace.context.text);
  console.log("\n── answer ────────────────────────────────────────────");
  console.log(trace.answer.text);
  console.log(`\ncitations: [...]  refused: ${trace.answer.refused}`);
}
```

- `ask` calls `commandSearch(question)` rather than repeating the trace printing — and it
  runs the pipeline **twice** as a result. On a corpus this size that is free
  (sub-millisecond), and it keeps the two commands independently runnable. Extracting a
  `printTrace(trace)` helper and calling it from both is the refactor you would do if the
  pipeline were expensive; the duplication here is the simpler trade at this scale.
- Printing `trace.context.text` **verbatim** is the point of the whole project: it is the
  actual string that would be sent to a model, including the `<precedence>` and `<sources>`
  regions. Nothing about it is hidden behind an abstraction.
- The last line prints `citations` and `refused` as separate values, so a reader can verify
  the claim in Chapter 10 — a refusal cites nothing.

**Block 7 — `commandChunks`: the same document, both ways**

```ts
  for (const strategy of ["fixed", "structural"] as const) {
    const chunks = buildIndex(DOCUMENTS, { ...config, chunkStrategy: strategy });
    console.log(`\n${strategy}: ${chunks.length} chunks`);
    for (const chunk of chunks) console.log(`  ${chunk.id}\n    ${chunk.breadcrumb}`);
  }
```

- `["fixed", "structural"] as const` makes the array a tuple of literals, so `strategy` has
  the type `"fixed" | "structural"` — exactly what `chunkStrategy` requires. The `as const`
  is doing real type work here, not decoration.
- `{ ...config, chunkStrategy: strategy }` runs the *whole* ingest twice with one setting
  changed — the same spread technique as the ablation, used for a two-row comparison.
- Printing every chunk id (`return-policy-electronics#1#7cfa05be`) shows Chapter 02's id
  scheme in the wild: the source, the index and the content hash.
- The final section prints the *same document* under both strategies — the clearest possible
  demonstration of Chapter 02/03: the fixed chunks carry the markdown and cut mid-sentence,
  while the structural chunks each name their own section.

**Block 8 — `commandFilters`: eligibility as a table**

```ts
  const rows: [string, Filter][] = [
    ["category in [electronics, general]   (correct tiers)", { ...base, categories: ["electronics", "general"] }],
    ["category == electronics              (the bug)", { ...base, categories: ["electronics"] }],
    ...
  ];

  for (const [label, filter] of rows) {
    const docs = eligible(filter);
    console.log(`${label}\n    ${docs.length} docs: ${docs.join(", ") || "(none)"}`);
  }
```

- `[string, Filter][]` is a tuple array, and the tuple is what keeps each label glued to the
  filter it describes. Iterating with `for (const [label, filter] of rows)` reads as a
  two-column table in the source.
- Every scenario is a **spread of the same base filter** with one field changed, so the table
  is provably a comparison of one variable at a time — the notes' "one change at a time"
  discipline applied to a diagnostic rather than an experiment.
- The labels are padded with spaces to align the output. That is a deliberate choice to make
  the table readable in a terminal, and it is the only place in the project where
  presentation formatting appears inside a string literal.
- `docs.join(", ") || "(none)"` prints `(none)` for an empty array, because `[].join(", ")`
  is `""`, which is falsy. That single `||` is why the fail-closed row reads
  `0 docs: (none)` instead of a blank line.
- `eligible` is a local closure over `index` and `isEligible`, so the eight rows share one
  index build — and more importantly, so the comparison cannot depend on eight separate
  ingests.

**Block 9 — `commandEval` and `commandAblation`: metrics, formatted**

```ts
  for (const row of cases) {
    const mark = row.recall === 1 && row.correct === 1 ? "✓" : "✗";
    console.log(`${mark} recall ${row.recall}  prec ${row.precision.toFixed(2)}  mrr ${row.reciprocal.toFixed(3)}  ${row.refused ? "refused" : "answered"}  ${row.question}`);
    console.log(`    expected : ${row.expected.join(", ") || "(none — must refuse)"}`);
    console.log(`    retrieved: ${row.retrieved.join(", ") || "(none)"}`);
  }
```

- The `✓`/`✗` mark is computed from **two** conditions — `recall === 1 && correct === 1` — so
  a case that retrieves everything but answers the wrong way (or vice versa) is visibly
  failed. This is the notes' rule that retrieval and generation are separate: the mark only
  goes green when both are right.
- Printing `expected` next to `retrieved` makes a failure diagnosable without opening the
  golden set: the missing document is the difference between the two lines.
- `(none — must refuse)` on the expected line spells out the contract for the unanswerable
  case, so `retrieved: …` with `refused` above it is readable at a glance.

```ts
  console.log("preset       chunks  recall  prec   mrr    refusal  ctx tok");
  for (const row of rows) {
    const m = row.metrics;
    console.log(`${row.preset.padEnd(12)} ${String(m.chunks).padEnd(7)} ${m.recall.toFixed(3)}   ...`);
  }
```

- `padEnd(12)` and `padEnd(7)` fix the column widths so the numbers line up. The header
  string is hand-aligned to match, which is the honest way to do a table with no dependency.
- `toFixed(3)` on the rates and a raw integer for `contextTokens`: rates are compared to
  three decimals, token counts are not compared at all. The formatting encodes that
  distinction.

**Block 10 — argument parsing and dispatch**

```ts
const [, , command = "ask", ...rest] = process.argv;
const question = rest.join(" ").trim() || DEFAULT_QUESTION;

switch (command) {
  case "ask": commandAsk(question); break;
  ...
  default:
    console.log(`Unknown command: ${command}`);
    console.log("Use one of: ask | search | chunks | filters | eval | ablation");
    process.exitCode = 1;
}
```

- `process.argv` is `[node, script, ...args]`, so the two leading commas skip the first two
  entries. `command = "ask"` gives a default, which is why `tsx src/index.ts` with no
  arguments behaves like `npm run ask`.
- `rest.join(" ")` reassembles a multi-word question, and `.trim()` removes the leading space
  that `npm run ask -- "…"` can leave behind. `|| DEFAULT_QUESTION` handles the empty case.
- The `switch` is exhaustive over the six commands, with a `default` that **prints the valid
  commands** rather than throwing — an error message as an instruction, the same rule the
  project applies to ingest errors in Chapter 06.
- `process.exitCode = 1` rather than `process.exit(1)`: it lets Node finish flushing stdout
  before exiting, so the "unknown command" message is never lost. That matters in a CLI whose
  whole purpose is printing.

---

## 13.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run typecheck   # no output, exit 0
npm run ask
npm run search
npm run chunks
npm run filters
npm run eval
npm run ablation
```

All six commands should print without error. `npm run typecheck` is the machine check that the
whole project — every file in this guide — still compiles under `strict`.

---

## 13.6 Checkpoint

1. **Why does the CLI print all four ranked lists instead of only the winner?** So the
   comparison between retrievers is visible — the only way to see hybrid search working.
2. **What does `as const` do on `["fixed", "structural"]`?** It narrows the element type to
   the literal union, so the value can be spread into `chunkStrategy` without a cast.
3. **Why set `process.exitCode` instead of calling `process.exit`?** So stdout is flushed and
   the diagnostic message is not lost.

---

## 13.7 Why this is not the whole program

The CLI is one of **two** entry points. It is the right door for reading the
project — a command per chapter, output on screen — but it is not how the system
would be used. Part II builds the other door:

| Chapter | What it adds |
|---|---|
| [14 — Models](./14_Models_Every_Contract.md) | the contracts the CLI already imports from `models/types.js` |
| [15 — Utils](./15_Utils_One_Hash_Two_Uses.md) | the hash the chunker and the embedder already share |
| [16 — The controller](./16_The_Controller.md) | the same six behaviours, over HTTP |
| [17 — The routes](./17_The_Routes.md) | the bindings |
| [18 — Middleware](./18_Middleware_The_Failure_Path.md) | one failure path |
| [19 — The app and the server entry](./19_The_App_and_the_Server_Entry.md) | `createApp()` + `listen()` |

**Next:** [Chapter 14 — Models: every contract in one file](./14_Models_Every_Contract.md)







