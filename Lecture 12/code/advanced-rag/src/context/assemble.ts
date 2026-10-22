import { countTokens } from '../lib/text.js';
import { clipTokens } from '../ingest/structural-chunker.js';
import type { AssembledContext, ContextBlock, ScoredChunk } from '../types.js';

/**
 * Context engineering — the last stage, and the one with the smallest budget.
 *
 * Retrieval decides *which* evidence exists; this stage decides *what the model
 * actually reads*. Four operations, in this order, for a reason:
 *
 *  1. **Expand.** A 90-token child is precise but incomplete: it may say "the fee
 *     does not apply" without saying which fee. Swap it for its parent section,
 *     which is complete but less precise. Precision for finding, completeness for
 *     answering.
 *  2. **Deduplicate.** Parent expansion collapses five children of the same
 *     section into one block. Five near-identical chunks do not make an answer
 *     five times more likely; they make it five times more expensive, and they
 *     push the contradicting evidence out of the window.
 *  3. **Precedence.** When a general policy and a product-specific policy sit in
 *     the same band of relevance, the specific one is placed first and labelled as
 *     specific. The model is not asked to infer which document wins; it is told.
 *  4. **Budget, then order.** Drop the weakest until the window fits, then place
 *     the strongest block first and the second strongest *last* — the two positions
 *     a long context actually attends to.
 */

export interface AssembleOptions {
  maxTokens: number;
  expandParents: boolean;
  bookendOrder: boolean;
}

/** Product-specific policy beats general policy; it is a claim about the corpus. */
const SPECIFICITY: Record<string, number> = {
  electronics: 3,
  damage: 3,
  warranty: 2,
  shipping: 2,
  general: 1,
};

/** Scores within this band are treated as a tie for ordering purposes. */
const SCORE_BAND = 0.05;

export function assemble(hits: readonly ScoredChunk[], options: AssembleOptions): AssembledContext {
  const deduped = new Map<string, ContextBlock>();

  for (const hit of hits) {
    const expandable = options.expandParents && Boolean(hit.chunk.parentText);
    const text = expandable ? (hit.chunk.parentText as string) : hit.chunk.text;
    // A parent block collapses every sibling that pointed at the same document (or
    // the same section), which is the deduplication that keeps five near-identical
    // chunks from spending five slots in the window.
    const key = expandable ? `parent:${hit.chunk.parentId}` : hit.chunk.id;

    const block: ContextBlock = {
      label: 0,
      chunkId: hit.chunk.id,
      source: hit.chunk.source,
      heading: hit.chunk.heading || hit.chunk.title,
      text,
      tokens: countTokens(text),
      score: hit.score,
      specificity: SPECIFICITY[hit.chunk.meta.category] ?? 1,
      expanded: expandable,
    };

    const existing = deduped.get(key);
    // Keep the best-scoring representative of a shared parent, but keep the
    // parent text (it is identical for every sibling by construction).
    if (!existing || block.score > existing.score) deduped.set(key, block);
  }

  const ordered = [...deduped.values()].sort(compareBlocks);

  // Budget: walk in priority order, keep what fits, never drop the best block.
  const kept: ContextBlock[] = [];
  let tokens = 0;

  for (const block of ordered) {
    if (kept.length > 0 && tokens + block.tokens > options.maxTokens) continue;
    const fitted = block.tokens > options.maxTokens && kept.length === 0
      ? { ...block, text: clipTokens(block.text, options.maxTokens), tokens: options.maxTokens }
      : block;

    kept.push(fitted);
    tokens += fitted.tokens;
  }

  const final = options.bookendOrder && kept.length > 2
    // [best, ...reverse(rest)] puts the second best last and the weakest middle.
    ? [kept[0], ...kept.slice(1).reverse()]
    : kept;

  const blocks = final.map((block, index) => ({ ...block, label: index + 1 }));

  return {
    text: render(blocks),
    blocks,
    tokens,
    dropped: hits.length - blocks.length,
  };
}

/**
 * Relevance first; specificity only breaks ties inside the same score band.
 *
 * Quantising the score is what makes this a total order. A naive comparator that
 * mixes `score` and `specificity` is not transitive, and `Array.sort` is allowed
 * to produce nonsense when the comparator contradicts itself.
 */
function compareBlocks(left: ContextBlock, right: ContextBlock): number {
  const leftBand = Math.round(left.score / SCORE_BAND);
  const rightBand = Math.round(right.score / SCORE_BAND);

  if (leftBand !== rightBand) return rightBand - leftBand;
  if (left.specificity !== right.specificity) return right.specificity - left.specificity;
  return right.score - left.score;
}


/**
 * Render the blocks into the string that goes into the prompt.
 *
 * Three details carry most of the weight:
 *
 *  - `<documents>` marks the boundary between *rules* (the system prompt) and
 *    *data* (everything here). A document that says "ignore previous instructions"
 *    is inside the data region, and the instruction hierarchy says data does not
 *    command the model.
 *  - `[n]` labels are assigned here, by code, in the order the model reads them.
 *    The model never invents a numbering scheme; it only cites labels that exist.
 *  - Each block is labelled with its source *and* its policy category, so the model
 *    can see that one block is the electronics exception and another is the general
 *    rule. That label is what makes precedence enforceable.
 */
function render(blocks: readonly ContextBlock[]): string {
  if (blocks.length === 0) return '';

  const body = blocks
    .map((block) => {
      const scope = block.specificity >= 3 ? 'product-specific' : 'general';
      // An expanded block is the parent document, but the *match* came from one
      // section. Saying both is what lets the model cite the right place and still
      // read the surrounding rules.
      const header = block.expanded
        ? `[${block.label}] ${block.source} (whole document, match in "${block.heading}") (${scope})`
        : `[${block.label}] ${block.source} › ${block.heading} (${scope})`;
      return `${header}\n${sanitiseEvidence(block.text)}`;
    })
    .join('\n\n');

  return `<documents>\n${body}\n</documents>`;
}

/**
 * Defence in depth, not a solution.
 *
 * A retrieved document is attacker-controlled whenever a customer can upload one.
 * Removing the crudest injection phrases raises the cost of the attack and does
 * nothing about a clever one — which is why the real defence is the instruction
 * hierarchy plus the fact that answers must cite a chunk that already exists.
 */
export function sanitiseEvidence(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i.test(line))
    .filter((line) => !/disregard\s+(the\s+)?(system|previous)\s+(prompt|instructions)/i.test(line))
    .join('\n');
}
