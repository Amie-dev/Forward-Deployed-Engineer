import OpenAI from 'openai';
import { config } from '../config/env.js';

/**
 * Shared singleton instance of the OpenAI client.
 *
 * Benefits:
 * - Reuses HTTP keep-alive connections (avoids TLS handshake overhead on every ticket).
 * - Implements automatic exponential backoff on HTTP 429 rate limits or transient 500 errors.
 * - Enforces timeout limits so slow cloud responses don't exhaust server sockets.
 */
export const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 30000, // 30 seconds
});
