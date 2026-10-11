import { ChatMessage } from '../types/chat.types.js';

/**
 * Token Estimation & Budgeting Utility
 *
 * Implements token heuristics matching the Byte-Pair Encoding (BPE) profile
 * of cl100k_base / o200k_base tokenizers without requiring heavy native WASM bindings.
 */
export class TokenizerUtils {
  /**
   * Fast token estimation for a raw text string.
   * Standard heuristic: ~4 characters per token for English text,
   * with punctuation and whitespace weight adjustments.
   */
  public static estimateTextTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    // Split by whitespace and punctuation clusters
    const words = text.trim().split(/\s+/).length;
    const chars = text.length;

    // Weighted average: 1 token ≈ 0.75 words, 1 token ≈ 4 chars
    const charEstimate = Math.ceil(chars / 4.0);
    const wordEstimate = Math.ceil(words / 0.75);

    // Return the conservative (higher) estimate to avoid context overflow
    return Math.max(charEstimate, wordEstimate);
  }

  /**
   * Estimates tokens for an OpenAI Chat Message object.
   * ChatML format incurs ~4 structural formatting tokens per message:
   * <|im_start|>{role}\n{content}<|im_end|>
   */
  public static estimateMessageTokens(message: ChatMessage | { role: string; content: string }): number {
    const contentTokens = this.estimateTextTokens(message.content);
    const roleTokens = 1; // 'system', 'user', or 'assistant'
    const formattingTokens = 3; // Structural ChatML wrapper tokens

    return contentTokens + roleTokens + formattingTokens;
  }

  /**
   * Estimates total token count for an array of ChatML messages,
   * including the priming tokens for the assistant's generation.
   */
  public static estimateArrayTokens(messages: Array<ChatMessage | { role: string; content: string }>): number {
    let total = 3; // Every reply is primed with <|im_start|>assistant<|message|>
    for (const msg of messages) {
      total += this.estimateMessageTokens(msg);
    }
    return total;
  }
}
