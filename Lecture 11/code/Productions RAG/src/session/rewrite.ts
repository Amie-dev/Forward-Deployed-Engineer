import type { GenerationProvider } from '../generation/provider.js';
import { clip, keywords, words } from '../lib/text.js';
import type { Turn } from '../types/rag.types.js';

export interface QueryRewriter {
  /** Turn a conversational follow-up into a standalone search query. */
  rewrite(question: string, history: readonly Turn[]): Promise<string>;
}

const FOLLOW_UP = /^(and|also|but|what about|how about|same|those|these|it|its|they|them|that)\b/i;

/**
 * A follow-up is semantically empty on its own: "And for shoes?" embeds to noise.
 * Cheap signals are enough to decide whether rewriting is needed at all.
 */
export function isFollowUp(question: string): boolean {
  return FOLLOW_UP.test(question.trim()) || words(question).length <= 2;
}

/**
 * With a real model, rewriting is one short call. Without one, carry the topic
 * of the previous *search query* — not the previous answer, which is longer and
 * noisier — into the new query. Neither is magic; both are testable.
 */
export function createQueryRewriter(generator?: GenerationProvider): QueryRewriter {
  return generator ? new LlmQueryRewriter(generator) : new HeuristicQueryRewriter();
}

class HeuristicQueryRewriter implements QueryRewriter {
  async rewrite(question: string, history: readonly Turn[]): Promise<string> {
    const previous = history.at(-1);
    if (!previous || !isFollowUp(question)) return question;

    const topic = keywords(previous.searchQuery, 4).join(' ');
    return topic ? `${topic} ${question}` : question;
  }
}

class LlmQueryRewriter implements QueryRewriter {
  constructor(private readonly generator: GenerationProvider) {}

  async rewrite(question: string, history: readonly Turn[]): Promise<string> {
    if (history.length === 0 || !isFollowUp(question)) return question;

    const transcript = history
      .slice(-4)
      .map((turn) => `Customer: ${turn.question}\nAssistant: ${clip(turn.answer, 240)}`)
      .join('\n');

    const result = await this.generator.generate({
      instructions:
        'Rewrite the customer follow-up as one standalone search query. ' +
        'Return only the query — no quotes, no explanation.',
      messages: [
        {
          role: 'user',
          content: `Conversation:\n${transcript}\n\nFollow-up: ${question}\n\nStandalone search query:`,
        },
      ],
    });

    const rewritten = result.text.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim();
    return rewritten.length >= 3 ? rewritten.slice(0, 200) : question;
  }
}
