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
