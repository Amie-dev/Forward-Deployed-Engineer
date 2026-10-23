import type { Config } from "../config/config.js";
import type { Hit } from "../models/types.js";
import { contentTerms } from "./embeddings.js";

/**
 * Chapter 07 — reranking and two-stage retrieval.
 *
 * Retrieval earns the right to be *considered*; reranking decides who is *heard*
 * — over a candidate set it cannot enlarge. A production system uses a
 * cross-encoder (query and document read **jointly**). Offline we use a joint
 * lexical scorer: coverage, exact phrase and heading match, which is exactly the
 * signal a bi-encoder cannot express.
 *
 * The gate is the second half of the chapter: if the best candidate cannot clear
 * `rerankMinBest`, the pipeline returns **nothing** and the answer refuses.
 */
export function rerank(
  query: string,
  candidates: Hit[],
  cfg: Config,
): { results: Hit[]; passed: boolean } {
  const terms = contentTerms(query);
  const phrase = query.toLowerCase().trim();

  const results = candidates
    .map((hit) => {
      const text = hit.chunk.text.toLowerCase();
      const matched = terms.filter((term) => text.includes(term)).length;
      const coverage = terms.length === 0 ? 0 : matched / terms.length;
      const exact = phrase.length > 0 && text.includes(phrase) ? 1 : 0;
      const heading = terms.some((term) => hit.chunk.breadcrumb.toLowerCase().includes(term)) ? 1 : 0;

      // A joint score in [0, 1], so the gate is a number a human can reason about.
      const score = Number((0.6 * coverage + 0.25 * exact + 0.15 * heading).toFixed(4));
      return { chunk: hit.chunk, score };
    })
    .sort((a, b) => b.score - a.score);

  const passed = results.length > 0 && results[0].score >= cfg.rerankMinBest;
  return { results, passed };
}
