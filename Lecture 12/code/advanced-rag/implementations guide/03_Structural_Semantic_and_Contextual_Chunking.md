# Chapter 03: Structural, Semantic and Contextual Chunking

> **Chapter Goal:** Fill in the three fields the fixed chunker leaves empty — `heading`,
> `breadcrumb` and `parentId` — and add the one sentence of context that makes a bare
> sentence findable. This is the single largest quality change in the lecture, and it is
> measurable: **0 orphans** instead of 22, and recall from 0.571 to 0.643 before any other
> control is touched.

> **Lecture mapping:** Notes Chapter 03 — structural chunking, the two-pass rule for long
> sections and tables, semantic breakpoints, parent-child retrieval, contextual retrieval and
> late chunking.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/ingest/structural-chunker.ts` | 268 | heading stack, breadcrumbs, sibling merge, table protection, small-to-big parents |
| `src/ingest/semantic-chunker.ts` | 85 | similarity breakpoints — the third family, and why it is not the default |
| `src/ingest/context.ts` | 119 | template and LLM context prefixes, and the string that gets embedded |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- chunks detail        # compare the fixed and structural chunkers side by side
CONTEXTUALIZE=none npm run cli -- chunks   # structural chunks without the context prefix
```

The detail table from Chapter 02 is the before/after for this chapter:

```text
Fixed · 1,000 chars / 150 — no heading, no parent, no context:
#  source         heading  tok  parent  context  text…
1  damaged-goods  (none)   210  no      no       # Damaged and Faulty Goods Policy
2  damaged-goods  (none)   205  no      no       licy. ## What the customer gets

Structural · 400 tokens / 80 + contextual prefix:
#  source         damaged-goods  Reporting window           168  yes     yes   Damage or a fault that is visible…
4  damaged-goods  Escalation matrix          385  yes     yes   The escalation path depends on the order value…
```

---

## 2. The Structural Chunker — `src/ingest/structural-chunker.ts`

```ts
import { countTokens, sha256, tokenizer } from '../lib/text.js';
import type { Chunk, SourceDocument } from '../types.js';

/**
 * Structural chunking — use the document's own shape instead of blind windows.
 *
 * Three rules, each of which fixes a specific failure from the notes:
 *
 *  1. **Headings are boundaries.** A section about the 7-day electronics window
 *     never shares a chunk with a section about restocking fees, so the two rules
 *     cannot be blended into one paragraph by a window that happens to straddle
 *     them.
 *  2. **Every child carries its breadcrumb.** `Returns › Return window` is
 *     prepended to the text that gets embedded. A bare sentence like "This does
 *     not apply to electronics." is now findable by "electronics return window".
 *  3. **Every child keeps its parent.** The whole section is stored alongside the
 *     child, so answer time can swap a 90-token fragment for the 400-token section
 *     it came from — precision at retrieval, completeness at generation.
 *
 * Tables are never split: a table cut in half is not a smaller table, it is a lie.
 */

export interface StructuralChunkOptions {
  /** Child target size in tokens. 250–400 is the working range. */
  size: number;
  /** Tokens carried from the end of one child into the next. */
  overlap: number;
  /** Cap for the parent text stored with each child. */
  parentMaxTokens: number;
  /**
   * Sections smaller than this are merged with the next sibling under the same
   * parent, because a 30-token chunk with a heading is not a document section —
   * it is a fragment that will match on one word and answer nothing.
   */
  minTokens?: number;
}

interface Section {
  heading: string;
  breadcrumb: string;
  body: string;
}

interface SectionGroup {
  heading: string;
  breadcrumb: string;
  text: string;
  tokens: number;
}

export function chunkStructural(doc: SourceDocument, options: StructuralChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];

  // Small-to-big: the parent is the smallest complete unit that fits the parent
  // budget. For a short policy the document *is* that unit, so a retrieved child
  // can be answered from the whole policy. For a long document the section is the
  // right unit instead — the document would blow the budget and bury the answer.
  const documentTokens = countTokens(doc.text);
  const documentIsParent = documentTokens <= options.parentMaxTokens;

  for (const group of groupSections(splitSections(doc.text, doc.title), options)) {
    const parentId = documentIsParent
      ? sha256(doc.source, 'document')
      : sha256(doc.source, 'parent', group.breadcrumb);
    const parentText = documentIsParent ? doc.text : clipTokens(group.text, options.parentMaxTokens);

    for (const piece of packSection(group.text, options)) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: sha256(doc.source, group.breadcrumb, chunkIndex, piece),
        text: piece,
        source: doc.source,
        title: doc.title,
        heading: group.heading,
        breadcrumb: group.breadcrumb,
        chunkIndex,
        tokens: countTokens(piece),
        parentId,
        parentText,
        meta: doc.meta,
      });
    }
  }

  return chunks;
}

/**
 * Merge undersized siblings, then leave everything else alone.
 *
 * Two sections are siblings when their breadcrumbs share the same parent
 * (`Policy › Restocking fee` and `Policy › Exclusions`), which means a merge never
 * crosses a heading level and never mixes two topics the author separated at the
 * top level. Siblings keep being merged while the running total is still below
 * `minTokens` and the next section fits inside `size`, so the result is a chunk
 * between 150 and 400 tokens instead of a 60-token fragment. When a merge happens
 * the second heading is kept inline in the text, so the label survives into the
 * embedding and into the citation.
 */
function groupSections(sections: readonly Section[], options: StructuralChunkOptions): SectionGroup[] {
  const minTokens = options.minTokens ?? 150;
  const groups: SectionGroup[] = [];

  for (const section of sections) {
    const tokens = countTokens(section.body);
    const previous = groups.at(-1);

    const canMerge =
      previous !== undefined &&
      previous.tokens < minTokens &&
      parentOf(previous.breadcrumb) === parentOf(section.breadcrumb) &&
      previous.tokens + tokens <= options.size;

    if (canMerge && previous) {
      previous.text = `${previous.text}\n\n## ${section.heading}\n${section.body}`;
      previous.tokens = countTokens(previous.text);
      continue;
    }

    groups.push({ heading: section.heading, breadcrumb: section.breadcrumb, text: section.body, tokens });
  }

  return groups;
}

function parentOf(breadcrumb: string): string {
  return breadcrumb.split(' › ').slice(0, -1).join(' › ');
}

/**
 * Walk the markdown, tracking the heading stack.
 *
 * The H1 is the document title, so it is not repeated in the breadcrumb. Anything
 * before the first heading becomes a section of its own rather than being dropped,
 * because silently losing the preamble is how policy documents lose their caveats.
 */
export function splitSections(body: string, title: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];

  let buffer: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;

    const parts = stack.map((entry) => entry.text).filter((heading) => heading !== title);
    sections.push({
      heading: parts.at(-1) ?? title,
      breadcrumb: parts.length > 0 ? `${title} › ${parts.join(' › ')}` : title,
      body: text,
    });
  };

  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }

    const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }

    flush();
    const level = heading[1].length;
    const text = heading[2].trim();

    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text });
  }

  flush();
  return sections;
}


/**
 * Pack a section into child windows.
 *
 * Paragraphs are the atomic unit; a paragraph too large for one child is broken
 * at sentence boundaries; a table is never broken at all. Overlap is carried as
 * the trailing tokens of the previous child, which is why a rule that straddles a
 * boundary still appears complete in one of the two children.
 */
export function packSection(body: string, options: StructuralChunkOptions): string[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (countTokens(paragraph) <= options.size || isTable(paragraph)) {
      units.push(paragraph);
    } else {
      units.push(...groupSentences(paragraph, options.size));
    }
  }

  const pieces: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  for (const unit of units) {
    const unitTokens = countTokens(unit);

    if (buffer.length > 0 && bufferTokens + unitTokens > options.size) {
      const text = buffer.join('\n\n');
      pieces.push(text);

      const carry = options.overlap > 0 ? tailTokens(text, options.overlap) : '';
      buffer = carry ? [carry] : [];
      bufferTokens = carry ? countTokens(carry) : 0;
    }

    buffer.push(unit);
    bufferTokens += unitTokens;
  }

  if (buffer.length > 0) pieces.push(buffer.join('\n\n'));

  // Overlap can make a short next window identical to the previous one.
  return pieces.filter((piece, index) => piece.trim().length > 0 && piece !== pieces[index - 1]);
}

function isTable(block: string): boolean {
  return block.split('\n').every((line) => line.trim().startsWith('|'));
}

function groupSentences(text: string, size: number): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]?/g) ?? [text];
  const groups: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer.length > 0 && countTokens(buffer + sentence) > size) {
      groups.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
  }

  if (buffer.trim()) groups.push(buffer.trim());
  return groups;
}

/** The last `maxTokens` tokens of a string — the overlap that is actually carried. */
export function tailTokens(text: string, maxTokens: number): string {
  const encoder = tokenizer();
  const ids = encoder.encode(text);
  if (ids.length <= maxTokens) return text;
  return encoder.decode(ids.slice(ids.length - maxTokens)).trim();
}

/** Hard cap on tokens, used for parent text and prompt budgets alike. */
export function clipTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const encoder = tokenizer();
  const ids = encoder.encode(text);
  if (ids.length <= maxTokens) return text;
  return encoder.decode(ids.slice(0, maxTokens)).trim();
}
```

**Block by block:**

- **`StructuralChunkOptions`** adds `minTokens` to the usual `size`/`overlap`, plus
  `parentMaxTokens`. `minTokens` is the anti-orphan control: a 60-token chunk with a heading
  is not a document section, it is a fragment.
- **`chunkStructural` decides the parent once per document, not once per chunk.** If the
  whole document fits in `parentMaxTokens` (700 tokens by default), the *document* is the
  parent; otherwise the *section* is. That is the small-to-big rule: retrieve the precise
  child, answer from the smallest complete unit that fits the budget. On this corpus the
  short policies get document parents and the long `damaged-goods.md` gets section parents —
  both behaviours are exercised by one command.
- **`splitSections` walks the markdown and maintains a heading stack.** Two details matter:
  it ignores `#` inside fenced code blocks (so a shell comment does not become a heading), and
  it keeps anything before the first heading as its own section rather than dropping it —
  silently losing a preamble is how policy documents lose their caveats.
- **`breadcrumb` is `title › H2 › H3` with the H1 removed** (it is already the title). That
  string is what turns "This does not apply to electronics." into something findable, and it
  is also what the citation shows the customer.
- **`groupSections` merges undersized siblings.** Two sections are siblings when their
  breadcrumbs share a parent, so a merge never crosses a heading level. The merged text keeps
  the second heading inline (`## Restocking fee`), so the label survives into the embedding.
  This is the fix for the 62-token `semantic` fragments in Chapter 02's table.
- **`packSection` treats paragraphs as atoms, sentences as the fallback, and tables as
  indivisible.** A paragraph larger than the window is split at sentence boundaries; a table
  is never split, because a table cut in half is not a smaller table, it is a lie.
- **Overlap is carried as the trailing tokens of the previous child** (`tailTokens`), so a
  rule that straddles a boundary still appears complete in one of the two children. The
  filter at the end drops a window that is identical to the previous one, which happens when
  a short section is consumed entirely by the overlap.
- **`clipTokens` is the budget primitive** used by both parent text and, later, the prompt
  budget in Chapter 09. One function, two uses, so the arithmetic is identical everywhere.


---

## 3. Semantic Chunking — `src/ingest/semantic-chunker.ts`

```ts
import type { EmbeddingProvider } from '../embeddings.js';
import { cosine } from '../lib/vectors.js';
import { countTokens, sha256 } from '../lib/text.js';
import type { Chunk, SourceDocument } from '../types.js';

/**
 * Semantic chunking — cut where the topic changes, not where the counter says.
 *
 * The algorithm is three lines of arithmetic wrapped in a lot of judgement:
 *
 *  1. split the document into sentences;
 *  2. embed them all in one batch;
 *  3. start a new chunk wherever consecutive sentences are *dissimilar* enough
 *     (cosine below `threshold`), or the chunk would exceed `maxTokens`.
 *
 * Why it is not the default here: the breakpoints depend on a similarity
 * threshold that is specific to the embedding model and the corpus, so a value
 * tuned on legal contracts silently produces 40-token chunks on policy text.
 * Headings are free, stable and explainable; embeddings are none of those. Use
 * semantic chunking where structure is missing (transcripts, scraped HTML), and
 * keep the size cap so a single long sentence cannot create a 2,000-token chunk.
 */

export interface SemanticChunkOptions {
  maxTokens: number;
  /** Cosine below this between neighbouring sentences opens a new chunk. */
  threshold: number;
  /** Never emit a chunk smaller than this many tokens; merge it forward instead. */
  minTokens: number;
}

export async function chunkSemantic(
  doc: SourceDocument,
  embeddings: EmbeddingProvider,
  options: SemanticChunkOptions,
): Promise<Chunk[]> {
  const sentences = (doc.text.match(/[^.!?\n]+[.!?]?/g) ?? [doc.text])
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) return [];

  const vectors = await embeddings.embed(sentences);
  const groups: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    const tokens = countTokens(sentence);

    const boundary =
      current.length > 0 &&
      (currentTokens + tokens > options.maxTokens ||
        (index > 0 && cosine(vectors[index - 1], vectors[index]) < options.threshold));

    if (boundary && currentTokens >= options.minTokens) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(sentence);
    currentTokens += tokens;
  }

  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const text = group.join(' ').trim();
    return {
      id: sha256(doc.source, 'semantic', index, text),
      text,
      source: doc.source,
      title: doc.title,
      // Semantic breaks are not headings: we can label the chunk, not name it.
      heading: `segment ${index + 1}`,
      breadcrumb: doc.title,
      chunkIndex: index,
      tokens: countTokens(text),
      parentId: null,
      meta: doc.meta,
    };
  });
}
```

**Block by block:**

- **Three steps: split sentences, embed them in one batch, cut where neighbours are
  dissimilar.** `cosine(vectors[i-1], vectors[i]) < threshold` opens a new chunk, and so does
  exceeding `maxTokens`.
- **`minTokens` is a merge-forward guard**, not a merge-backward one: a group smaller than
  `minTokens` is absorbed into the next group instead of being emitted. Without it, one short
  sentence between two long ones becomes its own chunk.
- **Why it is not the default, with the evidence from Chapter 02's table:** on this corpus it
  produced **73 chunks at 62 tokens with 41 orphans**. The threshold that separates topics in
  a legal contract produces fragments in a hard-wrapped policy. Breakpoints depend on the
  model *and* the corpus, and neither of those is stable; headings are free, stable and
  explainable.
- **Where it is the right tool:** transcripts, scraped HTML, chat logs — text with no
  structure to exploit. Keep the `maxTokens` cap in that case, or one long sentence becomes a
  2,000-token chunk.
- **`heading: 'segment N'`** is an honest label: a semantic break is not a heading, so the
  chunk can be identified but not named.

---

## 4. Contextual Retrieval — `src/ingest/context.ts`

```ts
import type { Chunk, SourceDocument } from '../types.js';

/**
 * Contextual retrieval — the fix for the chunk that forgot what it was about.
 *
 * A chunk that says "This does not apply to electronics." is unresolvable on its
 * own: it has a pronoun and no antecedent. Two ways to fix that:
 *
 *  - **template** (offline, deterministic): the breadcrumb plus the document's
 *    metadata is turned into one sentence of context. Free, reproducible, and
 *    enough for most policy corpora because the document already knows what it is.
 *  - **llm** (Anthropic's contextual retrieval): ask a model to write one or two
 *    sentences situating the chunk in the document. Better on messy prose, costs
 *    one call per chunk at ingest, and needs a cache or it becomes the most
 *    expensive thing in the pipeline.
 *
 * The prefix is prepended to the text that gets *embedded*, and it is also shown
 * to the reader at answer time. That is deliberate: the same words that make the
 * chunk findable make the citation understandable.
 */

export type ContextMode = 'none' | 'template' | 'llm';

export function templateContext(chunk: Chunk, doc?: SourceDocument): string {
  const subject = chunk.meta.productIds.length > 0
    ? `${chunk.meta.category} policy covering ${chunk.meta.productIds.join(', ')}`
    : `${chunk.meta.category} policy`;

  const validity = chunk.meta.effectiveTo
    ? `in force from ${chunk.meta.effectiveFrom ?? 'unrecorded'} until ${chunk.meta.effectiveTo}`
    : `in force from ${chunk.meta.effectiveFrom ?? 'unrecorded'}`;

  const section = chunk.breadcrumb || doc?.title || chunk.source;
  return `Context: this passage is from "${section}" in "${chunk.title}", a ${subject}, ${validity}.`;
}

/**
 * One model call per chunk, at ingest time, cached by chunk id.
 *
 * The prompt is short on purpose: the model's job is to *situate* the chunk, not
 * to summarise it. Summaries lose the exact numbers ("48 hours") that retrieval
 * is supposed to preserve.
 */
export async function llmContext(
  doc: SourceDocument,
  chunk: Chunk,
  options: { apiKey: string; model: string },
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content:
            'Write one short sentence that situates the passage inside the document. ' +
            'Name the document and the section, and state what the passage is about. ' +
            'Do not summarise the passage, do not add facts, do not use the word "excerpt".',
        },
        {
          role: 'user',
          content: `<document>\n${doc.text.slice(0, 6000)}\n</document>\n\n<passage>\n${chunk.text}\n</passage>`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Contextual retrieval failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return payload.choices[0]?.message.content.trim() ?? templateContext(chunk, doc);
}

/** Attach a context prefix to every chunk. The `none` mode returns the input untouched. */
export async function contextualize(
  chunks: readonly Chunk[],
  docs: ReadonlyMap<string, SourceDocument>,
  options: { mode: ContextMode; apiKey?: string; model: string },
): Promise<Chunk[]> {
  if (options.mode === 'none') return [...chunks];

  const cache = new Map<string, string>();
  const output: Chunk[] = [];

  for (const chunk of chunks) {
    const doc = docs.get(chunk.source);
    let prefix = cache.get(chunk.id);

    if (!prefix) {
      if (options.mode === 'llm' && doc && options.apiKey) {
        prefix = await llmContext(doc, chunk, { apiKey: options.apiKey, model: options.model });
      } else {
        prefix = templateContext(chunk, doc);
      }
      cache.set(chunk.id, prefix);
    }

    output.push({ ...chunk, contextPrefix: prefix });
  }

  return output;
}

/**
 * The exact string that is embedded.
 *
 * Order matters: context first, then the breadcrumb, then the text. Embedding
 * models weight the beginning of the input more heavily, and the beginning is
 * where the *subject* belongs — the specific words are already in the text.
 */
export function embedText(chunk: Chunk): string {
  return [chunk.contextPrefix, chunk.breadcrumb, chunk.text].filter(Boolean).join('\n').trim();
}
```

**Block by block:**

- **`templateContext`** builds one sentence from what the document already knows:
  *"this passage is from \"Returns › Return window\" in \"Electronics Returns Policy\", an
  electronics policy covering AX-204, BX-900, in force from 2026-01-01."* It is deterministic,
  free, and enough for a corpus whose documents know what they are. Note that it states the
  **validity window** — which is what lets a superseded policy be recognised as such.
- **`llmContext`** is the Anthropic-style version: one model call per chunk at ingest time,
  with a prompt that says *situate, do not summarise*. Summarising loses the exact numbers
  ("48 hours") that retrieval exists to preserve. The prompt caps the output at 80 tokens,
  because a context prefix that is longer than the chunk defeats the purpose.
- **`contextualize` caches by chunk id** and falls back to the template when no key is
  present. Ingest-time LLM cost is proportional to corpus size, so the cache is not an
  optimisation, it is the difference between a re-index being affordable and not.
- **`embedText` fixes the order: context, then breadcrumb, then text.** Embedding models
  weight the beginning of the input more heavily, and the beginning is where the *subject*
  belongs — the specific words are already in the body.
- **The same string is used for retrieval and for the citation.** The words that make a chunk
  findable are the words that make it understandable, so there is no separate "index view"
  and "display view" to drift apart.

---

## 5. What the Change Is Worth

| | fixed · 1,000 chars | structural · 400 / 80 |
| :--- | ---: | ---: |
| chunks | 31 | 27 |
| average tokens | 177 | 172 |
| storage multiplier | 1.14× | **0.96×** |
| orphans | 22 | **0** |
| recall@5 (ablation) | 0.571 | **0.643** |
| context tokens per answer | 725 | **348** |

The last two rows are the interesting ones. Recall rose by seven points *and* the context
halved: better chunks are not just more findable, they are also more specific, so five of
them carry less noise than five blind windows. That is the opposite of the usual
"bigger chunks give more context" intuition, and it is the reason the notes call chunking
the ceiling rather than a tuning knob.

---

## 6. What to Take Away

- **Headings are free structure. Use them before anything clever.**
- **Every child should carry its breadcrumb.** It costs tokens and buys retrieval precision.
- **Merge undersized siblings; never cross a parent.** A 60-token chunk is a fragment.
- **Tables are indivisible.** Splitting one produces a chunk that is wrong rather than small.
- **Parent = the smallest complete unit that fits the budget.** Document for short policies,
  section for long ones.
- **Semantic chunking is for structureless text.** Measure it before adopting it — here it
  was a 2.7× chunk explosion with 41 orphans.
- **Prefix the embedding text with context, breadcrumb, then body** — and use the same string
  for the citation.

> **Where This Goes Next:** [Chapter 04](./04_Indexing_Embeddings_and_the_Vector_Store.md)
> turns these chunks into vectors and puts them in a store that can filter while it scans.

