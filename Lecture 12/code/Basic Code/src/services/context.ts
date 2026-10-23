import type { Config } from "../config/config.js";
import type { Hit } from "./search.js";

/**
 * Chapter 08 — context engineering.
 *
 * Retrieval decides what is *available*; context engineering decides what is
 * *salient*. The assembly pipeline from the notes:
 *
 *   1 dedupe → 2 order → 3 label → 4 budget → 5 frame → 6 question last
 *
 * Ordering is the fix for the running example: most specific and most decisive
 * **first**, most general **last**, and the question at the very **end**.
 */
export type ContextBlock = {
  label: number;
  chunkId: string;
  docId: string;
  heading: string;
  body: string;
  meta: string;
};

export type AssembledContext = {
  text: string;
  blocks: ContextBlock[];
  ids: string[];
  tokens: number;
};

/** Chapter 08 — specificity: a category policy outranks the general one. */
const SPECIFICITY: Record<string, number> = {
  damaged: 0,
  electronics: 0,
  product: 0,
  general: 1,
  internal: 2,
};

const PRECEDENCE = [
  "1. A category-specific policy overrides the general policy.",
  "2. An exception overrides a rule.",
  "3. A newer policy overrides an older one.",
  "4. Do not infer policy that is not stated.",
].join("\n");

/** Chapter 08 — a rough token count; the budget only needs the right order of magnitude. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function assembleContext(hits: Hit[], question: string, cfg: Config): AssembledContext {
  // 1 — dedupe: overlap and hybrid fusion both produce the same chunk twice.
  const seen = new Set<string>();
  const unique = hits.filter((hit) => {
    if (seen.has(hit.chunk.id)) return false;
    seen.add(hit.chunk.id);
    return true;
  });

  // 2 — order: specific first, general last; within a tier, keep the rank.
  const ordered = [...unique].sort((a, b) => {
    const tier = (SPECIFICITY[a.chunk.category] ?? 1) - (SPECIFICITY[b.chunk.category] ?? 1);
    return tier !== 0 ? tier : b.score - a.score;
  });

  // 3 — label + 4 — budget: drop *whole* chunks, never truncate one.
  const blocks: ContextBlock[] = [];
  let tokens = estimateTokens(PRECEDENCE);
  for (const hit of ordered) {
    const meta =
      `source: ${hit.chunk.docId}, category: ${hit.chunk.category}, effective ${hit.chunk.effectiveFrom}`;
    const block: ContextBlock = {
      label: blocks.length + 1,
      chunkId: hit.chunk.id,
      docId: hit.chunk.docId,
      heading: hit.chunk.breadcrumb,
      body: hit.chunk.body,
      meta,
    };
    const cost = estimateTokens(render(block));
    if (tokens + cost > cfg.maxContextTokens) break;
    tokens += cost;
    blocks.push(block);
  }

  // 5 — frame: rules are trusted, retrieved text is delimited data.
  // 6 — question last: final position, strong attention.
  const text = [
    "<precedence>",
    PRECEDENCE,
    "</precedence>",
    "",
    "<sources>",
    ...blocks.map(render),
    "</sources>",
    "",
    `Question: ${question}`,
  ].join("\n");

  return { text, blocks, ids: blocks.map((block) => block.chunkId), tokens };
}

/** Chapter 08 — labels make chunks self-describing: numbering, scope, category, date. */
function render(block: ContextBlock): string {
  return `[${block.label}] ${block.heading} (${block.meta})\n${block.body.trim()}`;
}
