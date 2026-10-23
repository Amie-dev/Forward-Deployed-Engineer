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
 * `Trace` is a contract (Chapter 02). This file is the composition root: it is
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
