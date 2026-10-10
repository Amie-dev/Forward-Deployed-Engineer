import { openai } from '../lib/openai.js';
import { config } from '../config/env.js';

export interface TokenUsageMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AuditedSummaryResult {
  summary: string;
  responseId: string;
  model: string;
  finishReason: string;
  usage: TokenUsageMetrics;
  estimatedCostUsd: number;
}

export class AuditedSummarizerService {
  /**
   * Generates a summary while capturing complete token economics and response telemetry.
   *
   * @param ticket - Raw text from customer support incident report.
   * @returns AuditedSummaryResult containing text, token usage, and cost estimation.
   */
  async summarizeWithAudit(ticket: string): Promise<AuditedSummaryResult> {
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

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason ?? 'unknown';

    const usage: TokenUsageMetrics = {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    };

    // Calculate approximate cost (e.g. $0.15/1M prompt tokens, $0.60/1M completion tokens for mini tier)
    const promptCost = (usage.promptTokens / 1_000_000) * 0.15;
    const completionCost = (usage.completionTokens / 1_000_000) * 0.60;
    const estimatedCostUsd = Number((promptCost + completionCost).toFixed(7));

    console.log(
      `[AI Audit Log] ID: ${completion.id} | Model: ${completion.model} | Finish: ${finishReason} | InTokens: ${usage.promptTokens} | OutTokens: ${usage.completionTokens} | EstCost: $${estimatedCostUsd}`
    );

    return {
      summary: text.trim(),
      responseId: completion.id,
      model: completion.model,
      finishReason,
      usage,
      estimatedCostUsd,
    };
  }
}

export const auditedSummarizerService = new AuditedSummarizerService();
