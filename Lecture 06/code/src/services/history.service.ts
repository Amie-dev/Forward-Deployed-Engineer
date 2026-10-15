import { env } from '../config/env.js';
import type { Conversation, ProviderMessage } from '../types/stream.types.js';

/**
 * History assembly + context budgeting (Chapter 08.6).
 *
 * Context management is a *streaming* concern, not just a cost concern: prompt
 * length drives prefill time, which drives TTFT (§3.4). An unbounded transcript
 * therefore degrades the exact metric the user feels.
 *
 * The system prompt is also where the streaming contract is stated to the model:
 * it writes ONE message, not fragments, and it must not imitate the transport.
 */

export const STREAMING_SYSTEM_PROMPT = [
  'You are the assistant for a production AI chat product.',
  '',
  'Rules:',
  '1. Answer in ONE coherent message. Your output is delivered to the user incrementally as it is generated, but it must read as a single finished answer.',
  '2. Never emit transport artefacts: no "chunk", "delta", "[DONE]", JSON envelopes, or progress narration.',
  '3. Use markdown, but keep structures small: a partial code fence or table may be rendered before it is complete.',
  '4. If you do not know something, say so plainly rather than inventing detail.',
].join('\n');

export interface HistoryBudgetMetrics {
  systemTokens: number;
  historyTokens: number;
  estimatedPromptTokens: number;
  budgetTokens: number;
  includedMessages: number;
  discardedMessages: number;
  interruptedTurnsIncluded: number;
  /** `true` when even the newest message alone blows the budget (fail fast). */
  overBudget: boolean;
}

export interface HistoryBuildResult {
  messages: ProviderMessage[];
  metrics: HistoryBudgetMetrics;
}

/**
 * ≈4 chars/token. A real deployment uses the provider tokeniser; the point
 * enforced here is that SOME deterministic budget exists before dispatch, so the
 * system fails fast with `invalid_request` instead of surfacing a provider error
 * (hardening checklist #16).
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Mark a partial answer so the next turn does not read it as a complete one. */
export function annotateInterrupted(content: string): string {
  return `${content}\n\n[Note: this previous answer was interrupted before it finished.]`;
}

export class HistoryService {
  constructor(private readonly budgetTokens: number = env.HISTORY_TOKEN_BUDGET) {}

  public build(conversation: Conversation | undefined): HistoryBuildResult {
    const systemTokens = estimateTokens(STREAMING_SYSTEM_PROMPT);
    const messages: ProviderMessage[] = [{ role: 'system', content: STREAMING_SYSTEM_PROMPT }];

    if (!conversation) {
      return {
        messages,
        metrics: {
          systemTokens,
          historyTokens: 0,
          estimatedPromptTokens: systemTokens,
          budgetTokens: this.budgetTokens,
          includedMessages: 0,
          discardedMessages: 0,
          interruptedTurnsIncluded: 0,
          overBudget: false,
        },
      };
    }

    const remaining = Math.max(0, this.budgetTokens - systemTokens);
    const history: ProviderMessage[] = [];
    let historyTokens = 0;
    let interruptedTurnsIncluded = 0;
    let discarded = 0;

    // Walk BACKWARDS: recent turns matter most, and dropping the oldest keeps
    // the conversation coherent (the "lost in the middle" trade-off).
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (!message) continue;

      const content = message.status === 'interrupted' ? annotateInterrupted(message.content) : message.content;
      const cost = estimateTokens(content);

      if (historyTokens + cost > remaining) {
        discarded += 1;
        continue;
      }

      historyTokens += cost;
      if (message.status === 'interrupted') interruptedTurnsIncluded += 1;
      history.push({ role: message.role, content });
    }

    history.reverse();
    messages.push(...history);

    // The newest user message alone exceeding the budget is a request-level
    // failure, not something to be silently truncated.
    const newestUserTokens = history.length ? estimateTokens(history[history.length - 1]?.content ?? '') : 0;

    return {
      messages,
      metrics: {
        systemTokens,
        historyTokens,
        estimatedPromptTokens: systemTokens + historyTokens,
        budgetTokens: this.budgetTokens,
        includedMessages: history.length,
        discardedMessages: discarded,
        interruptedTurnsIncluded,
        overBudget: newestUserTokens > remaining,
      },
    };
  }
}

export const historyService = new HistoryService();
