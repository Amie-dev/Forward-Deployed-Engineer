import { openai } from '../lib/openai.js';
import { config } from '../config/env.js';

export class SummarizerService {
  /**
   * Generates a concise two-sentence executive summary of an incoming customer ticket.
   *
   * @param ticket - Raw text from customer support incident report.
   * @returns Generated two-sentence summary string.
   */
  async summarize(ticket: string): Promise<string> {
    const prompt = `Summarize this support ticket in two sentences:\n\n${ticket}`;

    const completion = await openai.chat.completions.create({
      model: config.AI_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: config.AI_TEMPERATURE,
    });

    const summary = completion.choices[0]?.message?.content;

    if (!summary) {
      throw new Error('LLM provider returned an empty completion response.');
    }

    return summary.trim();
  }
}

export const summarizerService = new SummarizerService();
