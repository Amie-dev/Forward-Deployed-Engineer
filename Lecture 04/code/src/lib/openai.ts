import OpenAI from 'openai';
import { config } from '../config/env.js';

/**
 * Checks whether a valid live OpenAI API key is configured.
 */
export const isLiveApiKeyConfigured = (): boolean => {
  return (
    typeof config.OPENAI_API_KEY === 'string' &&
    config.OPENAI_API_KEY.startsWith('sk-') &&
    config.OPENAI_API_KEY.length > 20
  );
};

/**
 * Shared singleton instance of the OpenAI client.
 *
 * Operational Advantages:
 * - Connection Pooling: Reuses HTTP keep-alive sockets across requests, eliminating TLS renegotiation latency.
 * - Automatic Backoff: Performs exponential backoff on HTTP 429 rate limits and transient 5xx gateway faults.
 * - Socket Timeout: Caps request execution at 30 seconds to prevent hanging worker threads.
 */
export const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 30000,
});
