# Chapter 09: Context Engineering

> **Chapter Goal:** Turn a ranked list into the exact string the model reads — and then make the
> answer verifiable. Four operations (expand, dedupe, order, budget) and one contract (cite a
> label that exists, or refuse with a fixed sentence).

> **Lecture mapping:** Notes Chapter 08 — context engineering as a discipline, precedence when
> documents disagree, lost-in-the-middle ordering, label design, prompt-injection framing and
> the four-clause prompt contract.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/context/assemble.ts` | 170 | expansion, dedupe, precedence, budget, bookending, labels, sanitising |
| `src/generate.ts` | 200 | the grounded prompt, the extractive generator, the OpenAI generator, citation verification |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- ask "Is the AX-204 still covered after 18 months?"   # an answer with citations
npm run cli -- ask "Can I pay with Bitcoin?"                        # a refusal with a trace
EXPAND_PARENTS=false npm run cli -- ask "Is the AX-204 still covered after 18 months?"
```

---

## 2. Measured Output

### 2.1 An answer

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts ask Is the AX-204 still covered after 18 months?

Q: Is the AX-204 still covered after 18 months?

A: The AX-204 over-ear headphones carry a 12-month manufacturer warranty. [1] The AX-210 studio monitors carry 24 months. [1] The BX-900 wireless earbuds carry 24 months because they are sold as a premium product. [1] Batteries and charging cases are covered for 6 months, and consumable parts such as ear tips are not covered at all. [1]

Citations:
  [1] ok  warranty.md › Coverage by product

Context blocks:
  [1] warranty.md › Coverage by product · 530 tok · general · parent

Trace:
  dense       0ms  24 candidates · 24 eligible · 20 below 0.15
  bm25        0ms  4 hits · 2 also in dense
  rrf         0ms  k=60 · 6 fused from 4+4
  rerank      1ms  heuristic · 6 scored · best 0.770 · 1 kept
  assemble    2ms  1 blocks · 530 tokens · 0 dropped
  generate    1ms  extractive · 1 citations
  total      11ms  24 candidates · 530 context tokens · 0 invalid citations
```

### 2.2 A refusal

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts ask Can I pay with Bitcoin?

Q: Can I pay with Bitcoin?

A: I don't have that information in the company documents.

Citations: none

Context blocks:

Trace:
  dense       1ms  24 candidates · 24 eligible · 24 below 0.15
  bm25        0ms  1 hits · 0 also in dense
  rrf         0ms  k=60 · 1 fused from 0+1
  rerank      1ms  heuristic · 1 scored · best 0.067 · nothing cleared the gate
  assemble    0ms  0 blocks · 0 tokens · 0 dropped
  generate    0ms  extractive · refused
  total       2ms  24 candidates · 0 context tokens · 0 invalid citations
```

Three things are worth noticing across the two outputs:

1. **The answer cites a real block, and the block is a whole document.** `[1] warranty.md
   (whole document, match in "Coverage by product")` — the retrieval found the 246-token
   *Coverage by product* section, and the assembly expanded it to the whole warranty policy
   because that policy fits the parent budget. The citation names both, so a human can check
   the claim and read the surrounding rules.
2. **The refusal never called the model.** `generate 0ms · extractive · refused` and
   `0 context tokens`: the gate decided nothing was relevant, so `assemble` produced zero
   blocks and the generator was not invoked. Compare with the answer above, where
   `generate 2ms` is real work.
3. **The trace explains the answer without a debugger.** Every stage, its latency, every
   candidate with each score it collected, the rank that reached the prompt, the token count
   and the invalid-citation count. If the answer is wrong, the trace says which stage to blame.


---

## 3. Assembly — `src/context/assemble.ts`

```ts
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
```

**Block by block:**

- **Four operations, in this order, for a reason.** Expand (precision for finding, completeness
  for answering) → dedupe (five siblings do not make an answer five times more likely, they
  push the contradicting evidence out of the window) → order (relevance, with specificity
  breaking near-ties) → budget (drop the weakest until it fits, never drop the best).
- **`SPECIFICITY` is a claim about the corpus, not a heuristic.** `electronics` and `damage` are
  product-specific policies; `general` is the fallback. Writing that down as a map means the
  precedence rule can be reviewed and changed, instead of being an implicit property of whatever
  order the retriever happened to return.
- **The dedupe key is the parent when expanding, the chunk otherwise.** That is what collapses
  five children of the same document into one block, and it is why the warranty answer shows
  `2 blocks · 1207 tokens · 2 dropped` instead of five overlapping fragments.
- **`compareBlocks` quantises the score into bands before comparing specificity.** This is not
  cleverness for its own sake: a comparator that mixes `score` and `specificity` is not
  transitive, and `Array.sort` is allowed to produce nonsense when a comparator contradicts
  itself. Bands make it a total order.
- **The budget keeps the first block even when it alone exceeds the budget**, clipping it with
  `clipTokens` instead. Dropping the best evidence to satisfy a token limit is how a system
  becomes confidently useless.
- **Bookending is `[best, ...reverse(rest)]`**, which places the strongest block first, the
  second strongest last, and the weakest in the middle. Those are the two positions a long
  context actually attends to.
- **Labels are assigned *after* ordering**, so `[1]` is always the strongest block. The model
  never invents a numbering scheme; it cites labels that exist.
- **`render` states the scope in the header** — `(product-specific)` or `(general)` — and, for an
  expanded block, says `(whole document, match in "…")`. That header is what makes the
  precedence rule *enforceable* rather than merely described in the system prompt.
- **`sanitiseEvidence` strips the crudest injection phrases and nothing more.** It is defence in
  depth, not a solution: a retrieved document is attacker-controlled whenever a customer can
  upload one, so the real defence is the instruction hierarchy plus the requirement that every
  claim cite a block that already exists.

---

## 4. Generation — `src/generate.ts`

```ts
import { queryTerms, sentences, stemsOf } from './lib/text.js';
import type { AssembledContext, Citation, ContextBlock } from './types.js';

/**
 * Answer generation, bounded by the evidence.
 *
 * The contract has four clauses and the code enforces three of them structurally:
 *
 *  1. use only `<documents>`                    → the prompt says so, and the
 *                                                 extractive generator literally
 *                                                 cannot do otherwise;
 *  2. cite the label that supports each claim   → labels are assigned by code, then
 *                                                 verified after generation;
 *  3. refuse when the evidence does not answer  → an exact sentence, returned
 *                                                 without a model call when there is
 *                                                 no evidence at all;
 *  4. product-specific beats general on conflict → told to the model, and enforced
 *                                                 by block order.
 *
 * Refusal is one string, exported, compared by identity. "I'm sorry, I can't help
 * with that" is not a contract; it is a mood.
 */

export const REFUSAL = "I don't have that information in the company documents.";

export interface GenerationResult {
  text: string;
  refused: boolean;
}

export interface Generator {
  readonly name: string;
  generate(input: { question: string; context: AssembledContext }): Promise<GenerationResult>;
}

/**
 * Offline generator: quotes the best-matching sentences and cites their blocks.
 *
 * This is not a language model, and pretending otherwise would hide the thing the
 * lecture is about — which chunk was retrieved. It scores every sentence of every
 * block against the question, keeps the best three, and attaches the label of the
 * block each sentence came from. The output reads badly on purpose: it is evidence,
 * not prose.
 */
export class ExtractiveGenerator implements Generator {
  readonly name = 'extractive';

  async generate({ question, context }: { question: string; context: AssembledContext }): Promise<GenerationResult> {
    if (context.blocks.length === 0) return { text: REFUSAL, refused: true };

    const queryStems = queryTerms(question);

    interface Candidate {
      sentence: string;
      label: number;
      block: number;
      index: number;
      score: number;
    }

    const candidates: Candidate[] = [];

    context.blocks.forEach((block, blockIndex) => {
      sentences(block.text).forEach((sentence, index) => {
        const stems = stemsOf(sentence);
        const overlap = queryStems.filter((term) => stems.has(term)).length;
        if (overlap === 0) return;

        // Numbers are what customers actually ask about: 7 days, 48 hours, 15%.
        // A sentence that covers every query term is worth more than one that
        // covers half of them, even when both mention a number.
        const score = overlap * 2 + (/\d/.test(sentence) ? 1 : 0) + (overlap === queryStems.length ? 1 : 0);
        candidates.push({ sentence, label: block.label, block: blockIndex, index, score });
      });
    });

    if (candidates.length === 0) {
      // Evidence exists but shares no vocabulary with the question. Quote the best
      // block rather than inventing a bridge to it.
      const first = context.blocks[0];
      return { text: `${compact(first.text)} [${first.label}]`, refused: false };
    }

    const byScore = [...candidates].sort(
      (left, right) => right.score - left.score || left.block - right.block || left.index - right.index,
    );

    // Two sentences from the strongest block (a policy rule and its exception often
    // live in adjacent sentences), then the best remaining sentences from anywhere.
    const picked: Candidate[] = byScore.filter((candidate) => candidate.block === 0).slice(0, 2);
    for (const candidate of byScore) {
      if (picked.length >= MAX_SENTENCES) break;
      if (picked.some((chosen) => chosen.sentence === candidate.sentence)) continue;
      picked.push(candidate);
    }

    // Read them back in document order: an answer that jumps between sections is
    // harder for a human to verify than one that quotes them in sequence.
    picked.sort((left, right) => left.block - right.block || left.index - right.index);

    const body = picked.map((entry) => `${compact(entry.sentence)} [${entry.label}]`).join(' ');
    return { text: body, refused: false };
  }
}

/** Long enough to keep a full rule with its numbers, short enough to stay quotable. */
const MAX_SENTENCES = 4;

export class OpenAiGenerator implements Generator {
  readonly name = 'openai';

  constructor(private readonly options: { apiKey: string; model: string }) {}

  async generate({ question, context }: { question: string; context: AssembledContext }): Promise<GenerationResult> {
    if (context.blocks.length === 0) return { text: REFUSAL, refused: true };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${context.text}\n\nQuestion: ${question}` },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat completion failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const text = payload.choices[0]?.message.content.trim() ?? REFUSAL;

    return { text, refused: isRefusal(text) };
  }
}

/**
 * The four clauses, written as instructions rather than hopes.
 *
 * Note what is *not* here: no "be helpful", no persona, no tone guidance. Every
 * sentence either constrains the evidence or defines the citation format, because
 * those are the two things that fail silently.
 */
const SYSTEM_PROMPT = `You answer questions about Northwind Audio policies.

Rules, in order of precedence:
1. Use only the evidence inside <documents>. Do not use prior knowledge.
2. Cite the supporting block after every claim, like this: [1]. Use only labels that appear in the documents.
3. If the documents do not answer the question, reply with exactly this sentence and nothing else: ${REFUSAL}
4. If a product-specific block and a general block disagree, the product-specific block wins. State which one you followed.
5. Quote numbers exactly as they appear. Do not round, convert or infer them.`;

/** Labels the answer actually used, resolved against the blocks that were sent. */
export function verifyCitations(answer: string, blocks: readonly ContextBlock[]): Citation[] {
  const labels = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );

  return labels.map((label) => {
    const block: ContextBlock | undefined = blocks.find((candidate) => candidate.label === label);
    return {
      label,
      source: block?.source ?? '(none)',
      heading: block?.heading ?? '(unknown)',
      valid: Boolean(block),
    };
  });
}

/** Every citation resolved, and at least one of them — otherwise the answer floats. */
export function hasValidEvidence(citations: readonly Citation[]): boolean {
  return citations.length > 0 && citations.every((citation) => citation.valid);
}

export function isRefusal(text: string): boolean {
  return text.trim().includes(REFUSAL);
}

function compact(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 397)}…` : trimmed;
}

export function createGenerator(config: {
  provider: 'extractive' | 'openai';
  model: string;
  apiKey?: string;
}): Generator {
  if (config.provider === 'openai') {
    if (!config.apiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.');
    return new OpenAiGenerator({ apiKey: config.apiKey, model: config.model });
  }
  return new ExtractiveGenerator();
}
```

**Block by block:**

- **`REFUSAL` is one exported string, compared by identity.** "I'm sorry, I can't help with
  that" is not a contract; it is a mood. One exact sentence means the refusal is testable, and
  `isRefusal` is a substring check rather than a classifier.
- **`ExtractiveGenerator` scores every sentence of every block against the question** using the
  same stemmed term matching as the reranker, plus a bonus for sentences containing numbers —
  because the numbers are what customers ask about (7 days, 48 hours, 15%).
- **It takes two sentences from the strongest block and then the best remaining sentences from
  anywhere, capped at four, and prints them in document order.** A policy rule and its exception
  often live in adjacent sentences, and an answer that jumps between sections is harder for a
  human to verify than one that quotes them in sequence.
- **When no sentence shares vocabulary with the question, it quotes the best block verbatim**
  rather than inventing a bridge to it. That is the honest failure mode of a lexical generator,
  and it is visible in the output rather than hidden.
- **This generator does not reason, and the guide says so.** It cannot conclude that 10 days is
  past a 7-day window. That is why `eval` reports `facts 0.583` while `refusal` is 1.000, and why
  the failure tree labels those cases `generation-miss` — retrieval was right, the answer was
  incomplete. Swapping in `LLM_PROVIDER=openai` changes exactly that column.
- **`SYSTEM_PROMPT` is five numbered clauses and nothing else.** No persona, no tone guidance.
  Every sentence either constrains the evidence or defines the citation format, because those
  are the two things that fail silently. Clause 4 is the precedence rule; clause 5 stops the
  model from rounding `5 to 7` into "about a week".
- **`verifyCitations` resolves every `[n]` against the blocks that were sent.** An unresolvable
  label is counted as `invalidCitations` in the trace — the metric that catches a model
  inventing sources, and the reason citations are assigned by code rather than by the prompt.
- **`hasValidEvidence` requires at least one citation, all of them valid.** An answer with no
  citations is floating, even when it reads well.

---

## 5. What Context Engineering Is Actually Worth

| configuration | blocks | context tokens | recall | facts |
| :--- | ---: | ---: | ---: | ---: |
| `rerank` (no expansion) | up to 5 chunks | 566 | 0.821 | 0.583 |
| `full` (expansion + bookend) | 2–4 parents | 865 | 0.821 | 0.583 |
| `full-wide` (8 candidates → parents) | 3–4 parents | 918 | 0.821 | 0.583 |

Read this table carefully, because it does **not** show a win. Expansion costs ~300 extra
context tokens and moves neither recall nor the fact score on this corpus, for two honest
reasons:

1. **The documents are small.** When a section fits inside one child, the parent *is* the child,
   and expansion is a no-op. On a 40-page contract the same code would replace five 200-token
   fragments with one complete section, which is the case the technique exists for.
2. **The generator is lexical.** A bigger block gives a real model more to reason with; it gives
   a sentence-picker more sentences to mis-rank. That is why `facts` does not move — and it is
   exactly the lesson of the notes: *a control is only good for a generator, and you have to
   measure it with the generator you ship.*

The columns that *do* move are the ones Chapter 10 reports: refusal (0.000 → 1.000), because the
gate lives in the retrieval path, and context tokens, because that is what expansion costs.

---

## 6. What to Take Away

- **Assemble in four steps: expand, dedupe, order, budget.** Each one fixes a named failure.
- **Precedence belongs in the header and in the prompt.** Do not ask the model to infer which
  document wins.
- **Bookend the evidence.** Best first, second-best last.
- **Never drop the best block to satisfy a budget.** Clip it instead.
- **Labels are assigned by code, then verified.** That is what makes a citation checkable.
- **One exact refusal sentence.** Testable refusals are the only refusals you can improve.
- **Expansion is a bet on the generator.** Measure it with the model you ship.

> **Where This Goes Next:** [Chapter 10](./10_Evaluation_Ablation_and_the_API.md) measures all of
> it — one control at a time — and exposes the pipeline over HTTP.


