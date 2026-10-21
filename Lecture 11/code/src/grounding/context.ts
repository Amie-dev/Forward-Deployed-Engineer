import { countTokens } from '../ingest/chunker.js';
import { clip } from '../lib/text.js';
import type { Match } from '../types/rag.types.js';

/** One labelled piece of evidence, exactly as it appears inside `<documents>`. */
export interface ContextBlock {
  label: number;
  chunkId: string;
  source: string;
  section: string;
  text: string;
}

export interface AssembledContext {
  blocks: ContextBlock[];
  text: string;
  tokens: number;
}

/** Rough characters-per-token ratio, used only when a single chunk must be clipped. */
const CHARS_PER_TOKEN = 4;

/**
 * Turn matches into the evidence block of the prompt.
 *
 * Rules that matter more than they look:
 *   - Order is preserved: best match first, because attention is U-shaped and
 *     the last chunk is read almost as carefully as the first.
 *   - Labels are assigned here, not by the model, so a citation can be verified
 *     against a map instead of a guess.
 *   - The token budget is enforced before the call, not after the bill.
 */
export function assembleContext(matches: readonly Match[], maxTokens: number): AssembledContext {
  const blocks: ContextBlock[] = [];
  let tokens = 0;

  for (const match of matches) {
    const blockTokens = countTokens(match.text);

    if (tokens + blockTokens > maxTokens) {
      // Never send an empty evidence block: one clipped chunk beats a refusal.
      if (blocks.length === 0) {
        const text = clip(match.text, maxTokens * CHARS_PER_TOKEN);
        blocks.push({ label: 1, chunkId: match.id, source: match.source, section: match.section, text });
        tokens = countTokens(text);
      }
      break;
    }

    blocks.push({
      label: blocks.length + 1,
      chunkId: match.id,
      source: match.source,
      section: match.section,
      text: match.text,
    });
    tokens += blockTokens;
  }

  return { blocks, text: blocks.map(formatBlock).join('\n\n'), tokens };
}

/** `[1] refund-policy.md · Refund window` — the label the model must cite. */
export function formatBlock(block: ContextBlock): string {
  const heading = block.section ? `${block.source} · ${block.section}` : block.source;
  return `[${block.label}] ${heading}\n${block.text}`;
}

/**
 * Read the blocks back out of a rendered prompt.
 *
 * Only the offline extractive generator needs this; a real model reads the text.
 */
export function parseContextBlocks(text: string): ContextBlock[] {
  return text
    .split(/\n{2,}(?=\[\d+\]\s)/)
    .flatMap((raw) => {
      const match = /^\[(\d+)\]\s+([^\n]*)\n?([\s\S]*)$/.exec(raw.trim());
      if (!match) return [];

      const [source = 'unknown', section = ''] = match[2].split(' · ');
      return [
        {
          label: Number(match[1]),
          chunkId: '',
          source,
          section,
          text: match[3].trim(),
        },
      ];
    });
}
