import type { StreamErrorCode } from '../types/stream.types.js';

/**
 * A failure raised by a provider *during* generation.
 *
 * The distinction that matters for streaming (§7.7):
 *
 *  - `retryable === true` and NO bytes written yet  ⇒ retry with jitter, or
 *    answer with a real HTTP error status.
 *  - anything raised after the first byte            ⇒ the HTTP status is frozen
 *    at `200 OK`, so the failure must be signalled in-band and the partial text
 *    preserved (Anti-pattern #10: "the mid-stream retry" duplicates text).
 */
export class ProviderStreamError extends Error {
  constructor(
    public readonly code: StreamErrorCode,
    message: string,
    /** Safe to retry only *before* the first token reaches the client. */
    public readonly retryable: boolean = false,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderStreamError';
  }
}

/** Raised when the provider never produced a first delta inside the TTFT budget. */
export class ProviderTimeoutError extends ProviderStreamError {
  constructor(message: string) {
    super('provider_timeout', message, true);
    this.name = 'ProviderTimeoutError';
  }
}

/** Raised when the provider went silent after the first delta. */
export class UpstreamStallError extends ProviderStreamError {
  constructor(message: string) {
    super('upstream_stall', message, false);
    this.name = 'UpstreamStallError';
  }
}

/**
 * Classify an unknown thrown value into our in-band error taxonomy so that the
 * client always receives a machine-readable `code`.
 *
 * NOTE: `429`, `5xx` and connection resets are retryable *before* the first
 * token; after it they are terminal for this request.
 */
export function classifyProviderError(error: unknown): ProviderStreamError {
  if (error instanceof ProviderStreamError) return error;

  const status = (error as { status?: number } | undefined)?.status;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return new ProviderStreamError('provider_error', `Provider rate limit: ${message}`, true, error);
  }
  if (typeof status === 'number' && status >= 500) {
    return new ProviderStreamError('provider_error', `Provider ${status}: ${message}`, true, error);
  }
  return new ProviderStreamError('provider_error', message, false, error);
}
