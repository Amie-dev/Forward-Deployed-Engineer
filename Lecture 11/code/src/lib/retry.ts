export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry transient failures with exponential backoff and jitter.
 *
 * Retrying a 400 is pointless — it will fail the same way three times and just
 * triples the latency. Only 429 and 5xx are retried; anything without a status
 * (connection reset, DNS blip) is assumed transient.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 300, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;

      onRetry?.(error, attempt);
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await sleep(delay);
    }
  }

  throw lastError;
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true;
}
