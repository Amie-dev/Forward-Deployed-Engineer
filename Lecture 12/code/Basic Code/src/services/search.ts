import type { Config } from "../config/config.js";
import { analyze, cosine, embed } from "./embeddings.js";
import type { IndexedChunk } from "./store.js";

/**
 * Chapters 04 and 06 — the two retrievers and their fusion.
 *
 * Order of operations (Chapter 04): **filter → search → threshold → cut at K**.
 * The caller filters, so both retrievers see exactly the same eligible set —
 * Chapter 05's "same filter on both retrievers".
 */
export type Hit = { chunk: IndexedChunk; score: number };

/** Chapter 04 — dense retrieval: meaning, with a floor and a K. */
export function denseSearch(chunks: IndexedChunk[], query: string, cfg: Config): Hit[] {
  const queryVector = embed(query);
  return chunks
    .map((chunk) => ({ chunk, score: cosine(queryVector, chunk.vector) }))
    .filter((hit) => hit.score >= cfg.minScore) // the floor makes refusal possible
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.kRetrieve); // K is a budget
}

/**
 * Chapter 06 — BM25: what the text *says*.
 *
 *   IDF            rare terms dominate — the SKU outweighs "fast"
 *   TF saturation  the 10th occurrence adds little (k1)
 *   length norm    long documents do not win by volume (b)
 */
export function bm25Search(chunks: IndexedChunk[], query: string, cfg: Config): Hit[] {
  const terms = analyze(query);
  const documentFrequency = new Map<string, number>();
  const tokensById = new Map<string, string[]>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = analyze(chunk.text);
    tokensById.set(chunk.id, tokens);
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = totalLength / Math.max(chunks.length, 1);

  const scored = chunks.map((chunk) => {
    const tokens = tokensById.get(chunk.id) ?? [];
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);

    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      const saturation = (frequency * (cfg.bm25K1 + 1)) /
        (frequency + cfg.bm25K1 * (1 - cfg.bm25B + cfg.bm25B * (tokens.length / averageLength)));
      score += idf * saturation;
    }
    return { chunk, score };
  });

  return scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.kRetrieve);
}

/**
 * Chapter 06 — Reciprocal Rank Fusion.
 *
 *   RRF(d) = Σ 1 / (k + rank_i(d)),  k = 60
 *
 * It fuses **ranks**, because a cosine score and a BM25 score are incomparable
 * scales. Two rules from the notes are enforced here: both lists share one id
 * space (we join on `chunk.id`), and the output score is renamed — after fusion
 * `score` is an RRF score (~0.016–0.033), never a similarity.
 */
export function rrfFuse(lists: Hit[][], k: number): Hit[] {
  const fused = new Map<string, Hit>();

  for (const list of lists) {
    list.forEach((hit, position) => {
      const contribution = 1 / (k + position + 1);
      const existing = fused.get(hit.chunk.id);
      if (existing) existing.score += contribution;
      else fused.set(hit.chunk.id, { chunk: hit.chunk, score: contribution });
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/**
 * Chapter 06 — hybrid: meaning **and** exact terms.
 * `off` keeps the naive baseline (dense only) so the ablation can prove the gain.
 */
export function hybridSearch(
  chunks: IndexedChunk[],
  query: string,
  cfg: Config,
): { dense: Hit[]; lexical: Hit[]; fused: Hit[] } {
  const dense = denseSearch(chunks, query, cfg);
  const lexical = cfg.hybrid === "rrf" ? bm25Search(chunks, query, cfg) : [];
  const fused = cfg.hybrid === "rrf" ? rrfFuse([dense, lexical], cfg.rrfK) : dense;
  return { dense, lexical, fused };
}
