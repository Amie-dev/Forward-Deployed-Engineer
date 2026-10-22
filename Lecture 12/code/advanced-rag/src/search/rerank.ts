import { queryTerms, stem, stemsOf, terms } from '../lib/text.js';
import type { ScoredChunk } from '../types.js';

/**
 * Reranking: a second, slower opinion about the same twenty-five candidates.
 *
 * A bi-encoder (stage 1) embeds the query and the document *separately*, so it can
 * never notice that the query says "10 days" while the document says "within 48
 * hours". A cross-encoder reads them together and scores the pair — exactly the
 * judgement a support agent makes — and it costs a model call per candidate, which
 * is why it only ever sees a short list.
 *
 * Two implementations:
 *  - `HeuristicReranker` is deterministic and offline. It is not a neural
 *    cross-encoder; it is a *joint* scorer over query and chunk, which is enough to
 *    demonstrate the stage and keeps the demo runnable with no API key.
 *  - `CohereReranker` is a real cross-encoder behind an HTTP call, with the same
 *    interface, so switching is a config change.
 */

export interface Reranker {
  readonly name: string;
  /** Returns the same hits, rescored and reordered, cut to `topN`. */
  rerank(query: string, hits: readonly ScoredChunk[], topN: number): Promise<ScoredChunk[]>;
}

export interface RerankGate {
  /**
   * Minimum score the *best* candidate must reach before any evidence is used.
   * This is the "is there anything relevant here at all" decision, and it is the
   * one number you calibrate for a reranker.
   */
  minBest: number;
  /** How far below the best result a chunk may sit and still survive. */
  maxDrop: number;
  maxK: number;
}

export interface GateResult {
  kept: ScoredChunk[];
  dropped: number;
  /** True when nothing cleared `minBest`: the caller should refuse without a model call. */
  refused: boolean;
}

/**
 * Weighted joint scorer. Every term is in 0–1 so the weights mean something:
 *
 *   coverage  0.45 — IDF-weighted share of the query's terms present in the chunk
 *   heading   0.20 — share of them that appear in the breadcrumb (the subject)
 *   phrase    0.20 — longest contiguous query phrase found verbatim
 *   proximity 0.15 — how tightly the matched terms cluster (a window, not a bag)
 *
 * Coverage is IDF-weighted *within the candidate set*, and that single detail is
 * what makes the scorer useful. A question like "my earpiece is silent, can I get a
 * refund?" contains `refund`, which appears in every policy and therefore proves
 * nothing, and `silent`, which appears in exactly one section and therefore proves a
 * lot. Counting both as one matched term puts the refund-timing policy first;
 * weighting by rarity puts the damage policy first, which is the correct answer.
 *
 * Proximity is the part a bag-of-words model cannot do: "damage reported after 48
 * hours" and "48 hours … damage" are the same bag but different claims, and the
 * second is usually the exception you must not miss.
 */
export class HeuristicReranker implements Reranker {
  readonly name = 'heuristic';

  async rerank(query: string, hits: readonly ScoredChunk[], topN: number): Promise<ScoredChunk[]> {
    // Stemmed on both sides: a customer writes "exchange", the document says
    // "exchanged", and a joint scorer must see those as the same term.
    const queryStems = queryTerms(query);
    const queryWords = terms(query);

    const documentStems = hits.map((hit) => stemsOf(`${hit.chunk.breadcrumb} ${hit.chunk.text}`));
    const idf = inverseDocumentFrequency(documentStems);
    const totalQueryWeight = queryStems.reduce((sum, term) => sum + idf(term), 0);

    const scored = hits.map((hit, index) => {
      const stems = documentStems[index];
      const document = `${hit.chunk.breadcrumb} ${hit.chunk.text}`;
      const documentWords = terms(document);

      const matched = queryStems.reduce((sum, term) => sum + (stems.has(term) ? idf(term) : 0), 0);
      const coverage = totalQueryWeight === 0 ? 0 : matched / totalQueryWeight;

      const headingStems = stemsOf(hit.chunk.breadcrumb);
      const heading = queryStems.filter((term) => headingStems.has(term)).length / Math.max(1, queryStems.length);

      const phrase = longestPhrase(queryWords, documentWords) / Math.min(3, Math.max(1, queryWords.length));
      // Positions matter for proximity, so the stemmed words keep their order.
      const proximity = proximityScore(queryStems, documentWords.map(stem));

      const score = 0.45 * coverage + 0.2 * heading + 0.2 * phrase + 0.15 * proximity;
      return { chunk: hit.chunk, score, origin: 'rerank' as const };
    });

    scored.sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
    return scored.slice(0, topN);
  }
}

/** Rare terms are evidence; terms that appear in everything are noise. */
function inverseDocumentFrequency(documents: ReadonlyArray<Set<string>>): (term: string) => number {
  const total = documents.length || 1;
  const frequency = new Map<string, number>();

  for (const document of documents) {
    for (const term of document) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }

  return (term) => {
    const df = frequency.get(term) ?? 0;
    return Math.log(1 + (total - df + 0.5) / (df + 0.5));
  };
}

/** A real cross-encoder. Same interface, one HTTP call, no SDK. */
export class CohereReranker implements Reranker {
  readonly name = 'cohere';

  constructor(private readonly options: { apiKey: string; model: string }) {}

  async rerank(query: string, hits: readonly ScoredChunk[], topN: number): Promise<ScoredChunk[]> {
    if (hits.length === 0) return [];

    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        query,
        documents: hits.map((hit) => `${hit.chunk.breadcrumb}\n${hit.chunk.text}`),
        top_n: topN,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere rerank failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as { results: Array<{ index: number; relevance_score: number }> };

    return payload.results.map((result) => ({
      chunk: hits[result.index].chunk,
      score: result.relevance_score,
      origin: 'rerank' as const,
    }));
  }
}


/**
 * The gate, which is the part people forget.
 *
 * A reranker does not only reorder — it also tells you that *nothing* was relevant.
 * Keeping the top 5 no matter what is how a system ends up confidently answering
 * from the fifth-best chunk with a score of 0.03.
 *
 * The gate is deliberately two-sided and asymmetric:
 *
 *  - **`maxDrop`** does the actual cutting, relative to the best result of *this*
 *    query. It cannot be defeated by a query whose scores are compressed, which is
 *    exactly what happens when every term in the question is a common one.
 *  - **`minBest`** answers the only absolute question that matters: is the best
 *    candidate relevant at all? When it is not, the caller refuses *without calling
 *    the model*, and the refusal costs nothing.
 *
 * A fixed per-chunk floor — the intuitive design — fails the moment the score
 * distribution moves, which is why it is not what this function does.
 */
export function gateReranked(hits: readonly ScoredChunk[], gate: RerankGate): GateResult {
  if (hits.length === 0) return { kept: [], dropped: 0, refused: true };

  const best = hits[0].score;
  if (best < gate.minBest) return { kept: [], dropped: hits.length, refused: true };

  const kept = hits.filter((hit) => hit.score >= best - gate.maxDrop).slice(0, gate.maxK);
  return { kept, dropped: hits.length - kept.length, refused: false };
}

export function createReranker(
  kind: 'none' | 'heuristic' | 'cohere',
  options: { apiKey?: string; model: string },
): Reranker | null {
  if (kind === 'none') return null;
  if (kind === 'cohere') {
    if (!options.apiKey) throw new Error('RERANK=cohere requires COHERE_API_KEY.');
    return new CohereReranker({ apiKey: options.apiKey, model: options.model });
  }
  return new HeuristicReranker();
}

/** Length of the longest run of query terms that appears contiguously in the text. */
function longestPhrase(queryTerms: readonly string[], textTerms: readonly string[]): number {
  let best = 0;

  for (let start = 0; start < queryTerms.length; start++) {
    for (let length = 1; start + length <= queryTerms.length; length++) {
      const phrase = queryTerms.slice(start, start + length);
      if (containsRun(textTerms, phrase)) best = Math.max(best, length);
      else break;
    }
  }

  return best;
}

function containsRun(textTerms: readonly string[], phrase: readonly string[]): boolean {
  for (let index = 0; index + phrase.length <= textTerms.length; index++) {
    if (phrase.every((term, offset) => textTerms[index + offset] === term)) return true;
  }
  return false;
}

/** 1 when the matched terms sit next to each other, → 0 as they drift apart. */
function proximityScore(queryTerms: readonly string[], textTerms: readonly string[]): number {
  if (queryTerms.length < 2) return 0;

  let span = Number.POSITIVE_INFINITY;

  for (let start = 0; start < textTerms.length; start++) {
    if (!queryTerms.includes(textTerms[start])) continue;

    const seen = new Set<string>([textTerms[start]]);
    for (let end = start + 1; end < Math.min(textTerms.length, start + 40); end++) {
      if (queryTerms.includes(textTerms[end])) seen.add(textTerms[end]);
      if (seen.size >= 2) {
        span = Math.min(span, end - start);
        break;
      }
    }
  }

  return Number.isFinite(span) ? 1 / (1 + span / 12) : 0;
}
