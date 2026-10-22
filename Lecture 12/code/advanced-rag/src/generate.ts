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

