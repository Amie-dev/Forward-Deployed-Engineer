#!/usr/bin/env node
import { config } from "./config/config.js";
import { structuralChunks, fixedChunks } from "./services/chunking.js";
import { DOCUMENTS } from "./services/documents.js";
import { ablation, evaluate, GOLDEN } from "./services/eval.js";
import { runPipeline } from "./services/index.js";
import type { Hit } from "./services/search.js";
import { buildIndex, filterFrom, isEligible, type Filter } from "./services/store.js";

/**
 * The CLI — one command per chapter, so every claim in the notes can be seen.
 *
 *   npm run ask        Chapter 08 — the full pipeline, ending in an answer
 *   npm run search     Chapters 04–07 — the same pipeline, stage by stage
 *   npm run chunks     Chapters 02–03 — fixed vs structural chunking
 *   npm run filters    Chapter 05 — eligibility, access and time
 *   npm run eval       Chapter 09 — per-case retrieval and generation metrics
 *   npm run ablation   Chapter 09 — one control at a time
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
