import { parseContextBlocks } from '../grounding/context.js';
import { clip, contentWords, words } from '../lib/text.js';
import { REFUSAL_MESSAGE } from './prompt.js';
import type { GeneratedText, GenerationProvider, GenerationRequest } from './provider.js';

const MAX_SENTENCES = 3;
const MAX_SENTENCE_CHARS = 320;

/**
 * An offline stand-in for the model: it quotes the best-matching sentences out
 * of the evidence block and attaches their `[n]` labels.
 *
 * It cannot paraphrase, so it is not a real generator — but it exercises every
 * other part of the pipeline honestly: the prompt format, the label map, the
 * citation linker and the refusal path all behave exactly as they do with a
 * real model. Use it for demos, tests and CI. Use OpenAI for answers.
 */
export class ExtractiveProvider implements GenerationProvider {
  readonly name = 'extractive';
  readonly model = 'extractive-v1';

  async generate(request: GenerationRequest): Promise<GeneratedText> {
    const prompt = request.messages.at(-1)?.content ?? '';
    const question = extractTag(prompt, 'question');
    const blocks = parseContextBlocks(extractTag(prompt, 'documents'));

    const questionTerms = new Set(contentWords(question));
    const candidates = blocks
      .flatMap((block) =>
        answerUnits(block.text).map((unit) => ({
          sentence: unit,
          label: block.label,
          score: overlap(questionTerms, unit),
        })),
      )
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    if (candidates.length === 0) return { text: REFUSAL_MESSAGE };

    // One sentence per source keeps the answer readable and the citations honest.
    const chosen: typeof candidates = [];
    const usedLabels = new Set<number>();

    for (const candidate of candidates) {
      if (usedLabels.has(candidate.label)) continue;
      usedLabels.add(candidate.label);
      chosen.push(candidate);
      if (chosen.length === MAX_SENTENCES) break;
    }

    return {
      text: chosen.map((candidate) => `${clip(candidate.sentence, MAX_SENTENCE_CHARS)} [${candidate.label}]`).join(' '),
    };
  }
}

/** Shared terms, normalised so a long rambling sentence cannot win on length alone. */
function overlap(questionTerms: ReadonlySet<string>, sentence: string): number {
  if (questionTerms.size === 0) return 0;

  let shared = 0;
  for (const word of new Set(words(sentence))) {
    if (questionTerms.has(word)) shared++;
  }

  return shared / Math.sqrt(questionTerms.size);
}

/**
 * Paragraph units, with a list glued to the line that introduces it.
 *
 * "Refund window:" followed by "• Apparel 3 days • Footwear 7 days" is one
 * answer. Quoting only the introducing paragraph would drop every number from
 * the reply, which is exactly the failure this stub exists to expose.
 */
function answerUnits(text: string): string[] {
  const units: string[] = [];

  for (const paragraph of text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
    const previous = units.at(-1);
    const startsList = /^([-*•]|\d+\.)\s/.test(paragraph);

    if (previous !== undefined && previous.endsWith(':') && startsList) {
      units[units.length - 1] = `${previous}\n${paragraph}`;
      continue;
    }

    units.push(paragraph);
  }

  return units;
}

function extractTag(text: string, tag: 'documents' | 'question'): string {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return match?.[1]?.trim() ?? '';
}
