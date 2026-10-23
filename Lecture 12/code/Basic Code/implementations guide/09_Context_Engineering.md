# Chapter 09 — Context Engineering

> **Goal of this chapter:** assemble the prompt. Retrieval decides what is
> *available*; context engineering decides what is *salient*. All four policies can
> be in the context and the model can still answer from the wrong one — that is a
> **generation failure**, and its fix costs no latency and no re-indexing.
>
> **Lecture chapter:** [08 — Context Engineering](../../../notes/08_Context_Engineering.md)
> (the assembly pipeline, lost in the middle, precedence, labels, budget,
> framing and injection).

---

## 9.1 File details

| Property | Value |
|---|---|
| **Path** | `src/services/context.ts` |
| **Layer** | context |
| **Purpose** | turn ranked hits into the exact string that would be sent to a model |
| **Imports** | `type Config`, `type Hit` |
| **Exports** | `type ContextBlock`, `type AssembledContext`, `estimateTokens`, `assembleContext` |
| **Imported by** | `services/index.ts`, `services/generate.ts` (type only) |
| **Lecture sections** | 08 §"the assembly pipeline", §"ordering", §"precedence", §"labels", §"budget", §"framing" |

### The six steps of the pipeline, and the line that implements each

| Step (notes) | Implementation |
|---|---|
| 1 dedupe | `seen` + `unique` |
| 2 order | `SPECIFICITY` + `ordered` |
| 3 label | `render()` — `[n] heading (source, category, effective)` |
| 4 budget | `tokens` + `maxContextTokens`, dropping whole chunks |
| 5 frame | `<precedence>` + `<sources>` regions |
| 6 question last | the final element of the `text` array |

---

## 9.2 Commands

```bash
cd "Lecture 12/code/Basic Code"

npm run ask                             # prints the assembled context verbatim
MAX_CONTEXT_TOKENS=80 npm run ask       # shrink the budget and watch chunks drop
K_CONTEXT=1 npm run ask                 # one chunk only: the specific rule survives
```

---

## 9.3 Full file

**Path:** `src/services/context.ts`

```ts
import type { Config } from "../config/config.js";
import type { AssembledContext, ContextBlock, Hit } from "../models/types.js";

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
 *
 * `ContextBlock` and `AssembledContext` are contracts (Chapter 14).
 */

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
```

```ts
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
```

---

## 9.4 Block-by-block explanation

**Block 1 — the two types: what a block is, and what the prompt is**

```ts
export type ContextBlock = { label: number; chunkId: string; docId: string; heading: string; body: string; meta: string };
export type AssembledContext = { text: string; blocks: ContextBlock[]; ids: string[]; tokens: number };
```

- `AssembledContext` carries the rendered `text` **and** the structure it came from.
  That duality is what makes the project evaluable: `generate.ts` scores sentences per
  block, `eval.ts` measures context precision per `docId`, and the CLI prints `text`
  verbatim. Rendering once and throwing the structure away would force every later
  stage to re-parse the prompt.
- `ids` is the flat list of chunk ids that made it in — the join key back to the
  index, and the field `eval.ts` uses to ask "was the expected document retrieved?".

**Block 2 — `SPECIFICITY`: the ordering policy, as data**

```ts
const SPECIFICITY: Record<string, number> = {
  damaged: 0,
  electronics: 0,
  product: 0,
  general: 1,
  internal: 2,
};
```

- One number per category, and the number *is* the policy: **lower goes first**.
  Every category-specific policy (damaged, electronics, product) is tier 0; the
  general policy is tier 1; internal material is tier 2.
- This is the notes' *"most specific and most decisive first, most general last"*
  written as a table instead of a comment. Changing the policy means changing a
  number, and the sort needs no edit.
- `?? 1` at the use site gives any unmapped category the general tier, so a new
  category can never crash the sort.

**Block 3 — `PRECEDENCE`: the referee, as trusted text**

```ts
const PRECEDENCE = [
  "1. A category-specific policy overrides the general policy.",
  "2. An exception overrides a rule.",
  "3. A newer policy overrides an older one.",
  "4. Do not infer policy that is not stated.",
].join("\n");
```

- Four sentences, and they are the actual fix for the running example. Reordering
  alone reduces the chance the model reads the general rule first; stating precedence
  tells it what to do when both are present. The notes' point is that this costs no
  latency and no re-indexing.
- Note rule 4: *"Do not infer policy that is not stated."* It is the instruction that
  makes refusal the correct behaviour when the evidence is thin.
- This constant is **never** built from retrieved text. That is the trust boundary
  (Block 7): rules are code, sources are data.

**Block 4 — `estimateTokens`**

```ts
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

- Four characters per token is the standard English approximation. The notes'
  requirement for a budget is only that it is *the right order of magnitude* — this is
  not a tokenizer, and it does not need to be.
- `Math.ceil` so any non-empty text costs at least one token.

**Block 5 — steps 1 and 2: dedupe, then order**

```ts
  const seen = new Set<string>();
  const unique = hits.filter((hit) => {
    if (seen.has(hit.chunk.id)) return false;
    seen.add(hit.chunk.id);
    return true;
  });
```

- Dedupe is not optional here, for two independent reasons: overlapping fixed chunks
  can share text, and RRF merges two lists that may both contain a chunk. Without this
  step the same evidence could occupy two of the four context slots — and the model
  would read it as corroboration.
- A `Set` makes the check O(1), so the whole pass is linear.

```ts
  const ordered = [...unique].sort((a, b) => {
    const tier = (SPECIFICITY[a.chunk.category] ?? 1) - (SPECIFICITY[b.chunk.category] ?? 1);
    return tier !== 0 ? tier : b.score - a.score;
  });
```

- A **two-key sort**: tier first, score second. The `tier !== 0 ? tier : ...` pattern
  is how you express "sort by A, then by B" in one comparator.
- `[...unique]` copies before sorting because `Array.prototype.sort` mutates, and the
  caller's array is the pipeline's `reranked` list — mutating it would silently change
  the trace the CLI prints.
- This is the lost-in-the-middle mitigation: the decisive, specific policy is placed
  at the **start** of the sources region, where attention is strongest.

**Block 6 — steps 3 and 4: label, and spend the budget**

```ts
  const blocks: ContextBlock[] = [];
  let tokens = estimateTokens(PRECEDENCE);
  for (const hit of ordered) {
    const meta = `source: ${hit.chunk.docId}, category: ${hit.chunk.category}, effective ${hit.chunk.effectiveFrom}`;
    const block: ContextBlock = { label: blocks.length + 1, chunkId: hit.chunk.id, docId: hit.chunk.docId, heading: hit.chunk.breadcrumb, body: hit.chunk.body, meta };
    const cost = estimateTokens(render(block));
    if (tokens + cost > cfg.maxContextTokens) break;
    tokens += cost;
    blocks.push(block);
  }
```

- `let tokens = estimateTokens(PRECEDENCE)` — the precedence block is charged to the
  budget **first**, because it is always present. Forgetting it would make the cap a
  lie by a few dozen tokens.
- `label: blocks.length + 1` gives `[1]`, `[2]`, … in the order the blocks are added.
  The numbering is therefore both the citation key and the position — which is what
  makes "the model cited the general policy" a diagnosable statement.
- `meta` is built from the chunk's metadata and is what the notes call the label:
  *"numbering enables citation; the section resolves ambiguity; the category links
  'headphones' to 'electronics'; the date defeats superseded policy."* Each of those
  four claims maps to one part of `render`'s output.
- **`break`, not `continue`, and no truncation.** This is the notes' budget rule:
  *"drop whole low-ranked chunks when over budget — truncating a chunk can delete the
  exception clause."* Because the list is already ordered best-first, `break` drops
  the tail, which is exactly right; `continue` would let a small low-ranked chunk
  squeeze in past a large high-ranked one.
- `render(block)` is called once to price the block and again later to emit it. That
  is a deliberate trade: one extra string build in exchange for the guarantee that the
  priced text and the emitted text are byte-identical.

**Block 7 — steps 5 and 6: frame, then ask**

```ts
  const text = [
    "<precedence>", PRECEDENCE, "</precedence>",
    "",
    "<sources>", ...blocks.map(render), "</sources>",
    "",
    `Question: ${question}`,
  ].join("\n");
```

- **Framing.** The prompt has three regions with three trust levels:
  - `<precedence>` — rules, written by us, trusted.
  - `<sources>` — retrieved text, **untrusted**, delimited as data.
  - `Question: …` — user input, untrusted, never concatenated into the rules region.
  That is the notes' region table. The delimiter is doing real work: it tells the model
  where data stops, so a policy document containing the phrase "ignore previous
  instructions" is *data*, not an instruction.
- **Question last.** The notes' ordering rule ends with the question in the final
  position, where attention is strong. It is also why the question is a labelled line
  rather than a separate message — in this demo there is only one prompt.
- `...blocks.map(render)` spreads the rendered blocks as separate array elements, so
  each becomes its own line group after `join("\n")`.
- The empty strings (`""`) are paragraph breaks between regions — cosmetic, but they
  keep the prompt readable when `npm run ask` prints it.

**Block 8 — `render`: the label, in one place**

```ts
function render(block: ContextBlock): string {
  return `[${block.label}] ${block.heading} (${block.meta})\n${block.body.trim()}`;
}
```

- One function, used for pricing and for emitting, so the two can never disagree.
- The output is exactly the notes' label example:

  ```text
  [1] Electronics Return Policy → Return window (source: return-policy-electronics, category: electronics, effective 2026-03-01)
  Electronic products can be returned within 7 days of delivery.
  ```

- `body.trim()` because the chunker already trimmed, but a block assembled from a
  differently-shaped source should not produce stray blank lines.

---

## 9.5 Run / verify

```bash
cd "Lecture 12/code/Basic Code"
npm run ask
```

Expected (the assembled context, verbatim):

```text
<precedence>
1. A category-specific policy overrides the general policy.
2. An exception overrides a rule.
3. A newer policy overrides an older one.
4. Do not infer policy that is not stated.
</precedence>

<sources>
[1] Electronics Return Policy → Return window (source: return-policy-electronics, category: electronics, effective 2026-03-01)
Electronic products can be returned within 7 days of delivery.
[2] Damaged Product Reporting Policy → Exception (source: damaged-product-policy, category: damaged, effective 2026-01-01)
Damage reported after 48 hours is treated as a normal return and follows the return policy for the product category.
[3] Electronics Return Policy → Scope (source: return-policy-electronics, category: electronics, effective 2026-03-01)
This policy overrides the general return policy for all electronic products, including headphones and speakers.
[4] General Return Policy → Return window (source: return-policy-general, category: general, effective 2026-01-01)
Customers may return an item within 30 days of delivery for a full refund.
</sources>

Question: Can I return my damaged headphones after 10 days?
```

Read the block order: **two specific policies, then the general one last**. The
general 30-day rule is still present — deliberately, because it is relevant — but it
arrives fourth, after the rules that override it, and after a precedence block that
says so explicitly.

---

## 9.6 Checkpoint

1. **Which step fixes the running example?** Ordering plus precedence. Both are in
   this file, and neither touches retrieval.
2. **Why `break` and not `continue` when the budget is exceeded?** Because the list is
   ordered best-first, so the tail is the right thing to drop — and because truncating
   a chunk could delete the exception clause.
3. **Why is retrieved text wrapped in `<sources>`?** To mark it as data rather than
   instructions, so an injected sentence inside a document cannot become a rule.

**Next:** [Chapter 10 — Grounded answer or refusal](./10_Grounded_Answer_or_Refusal.md)




