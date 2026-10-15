/**
 * Time-related helpers.
 *
 * Streaming correctness is *temporal*: TTFT, ITL, stall detection and timeouts
 * all depend on measuring and waiting precisely. These primitives are
 * deliberately tiny and dependency-free.
 */

/** Milliseconds since process start — monotonic, unaffected by wall-clock drift. */
export function nowMs(): number {
  return performance.now();
}

/**
 * Abortable sleep. Every wait on the streaming path MUST be interruptible,
 * otherwise a cancelled request keeps a provider call (and its token spend)
 * alive until the timer fires — the "zombie generation" anti-pattern.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAbortError(message = 'The operation was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError');
}

/** Round-trip millisecond duration with sub-millisecond precision. */
export function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 100) / 100;
}

/** Introduce bounded jitter so parallel streams do not resonate in lockstep. */
export function jitter(base: number, spreadRatio = 0.3): number {
  const spread = base * spreadRatio;
  return Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
}
