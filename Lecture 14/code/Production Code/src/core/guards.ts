import { ToolError } from "./errors.js";

/**
 * Chapter 08 §"Timeouts, retries and circuit breaking" and §"Rate limits".
 *
 * Both guards answer the same question — *how much of the host's budget may one
 * call consume?* — which is why they live together. Neither is optional in
 * production, and neither is the kind of thing you want re-implemented inside
 * every tool handler.
 */

/**
 * A sliding-window limiter: at most `perMinute` hits per key in any 60-second
 * window.
 *
 * Keys are per tool rather than global, because a global limit lets one noisy
 * tool starve every other capability the server offers. The key is also where a
 * caller identity would go once the transport carries one.
 *
 * A sliding window is chosen over a fixed bucket on purpose: a fixed bucket
 * lets a caller spend the whole allowance at 11:59:59 and again at 12:00:00,
 * which is precisely the burst the limit exists to stop.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.perMinute) {
      // Do not record the rejected attempt: a caller that hammers a limited
      // tool must not be able to extend its own penalty forever.
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

/**
 * Runs `work` inside a budget.
 *
 * The timeout is deliberately a **result**, not a protocol error: the call did
 * start, so the honest report is `UNAVAILABLE` with retry guidance — which is
 * exactly what `ToolError` carries. A hung capability must never be able to
 * stall the whole host, and the timer is always cleared so a fast call cannot
 * leak a handle.
 */
export async function withTimeout<T>(work: () => Promise<T> | T, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(work()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError(
              "UNAVAILABLE",
              `${label} exceeded its ${milliseconds} ms budget.`,
              "Retry once. If it fails again, treat this capability as temporarily unavailable rather than retrying in a loop.",
              true,
            ),
          );
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
