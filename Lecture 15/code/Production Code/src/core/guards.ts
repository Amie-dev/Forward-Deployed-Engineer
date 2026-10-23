import { truncationMarker } from "../config/constants.js";
import { AppError, ResourceError, ToolError } from "./errors.js";

/**
 * The guards that answer one question: *how much of the host's budget may one
 * call consume?*
 *
 * Three of them, and Lecture 15 needs all three for different reasons:
 *
 *  · **rate limit** — how many calls per minute (Notes Ch05 §"rate limits");
 *  · **timeout** — how long one call may run. `prompts/get` is a local template
 *    render and `resources/read` may reach a backend, so the two budgets differ
 *    on purpose (Notes Ch07 §"Streaming, timeouts and cancellation");
 *  · **context budget** — how much *text* may enter the prompt. This is the one
 *    Lecture 15 introduces, and the one most implementations skip: Notes Ch02
 *    §"Size and token budget" and Ch05 §"Context budget is the real constraint"
 *    both make the point that a resource you cannot afford to read is not
 *    context, it is a denial-of-service against your own token budget.
 *
 * None of the three is optional in production, and none of them is the kind of
 * thing you want re-implemented inside every handler.
 */

/**
 * A sliding-window limiter: at most `perMinute` hits per key in any 60-second
 * window.
 *
 * Keys are namespaced by primitive (`tool:list_tasks`, `resource:read`) rather
 * than global, because a global limit lets one noisy capability starve every
 * other one the server offers. The key is also where a caller identity would go
 * once the transport carries one.
 *
 * A sliding window is chosen over a fixed bucket on purpose: a fixed bucket lets
 * a caller spend the whole allowance at 11:59:59 and again at 12:00:00, which is
 * precisely the burst the limit exists to stop.
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
      // capability must not be able to extend its own penalty forever.
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
 * exactly what the error taxonomy carries. A hung capability must never be able
 * to stall the whole host, and the timer is always cleared so a fast call cannot
 * leak a handle.
 *
 * `origin` decides which error class is thrown, because a tool timeout must
 * reach the model as an `isError` result while a resource timeout must reach the
 * client as a protocol error (Notes Ch03 §3.9).
 */
export async function withTimeout<T>(
  work: () => Promise<T> | T,
  milliseconds: number,
  label: string,
  origin: AppError["origin"] = "tool",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(work()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const message = `${label} exceeded its ${milliseconds} ms budget.`;
          const recovery =
            "Retry once. If it fails again, treat this capability as temporarily unavailable rather than retrying in a loop.";

          reject(
            origin === "resource"
              ? new ResourceError("UNAVAILABLE", message, recovery, { retryable: true })
              : new ToolError("UNAVAILABLE", message, recovery, true),
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


/** One resource body, already read, waiting to be placed into a prompt. */
export interface ContextBlock {
  uri: string;
  /** Which selection strategy chose it — Notes Ch05 §"log the why". */
  strategy: string;
  text: string;
}

/** A block after the budget has had its say. */
export interface BudgetedBlock extends ContextBlock {
  /** True when the body was cut, so the caller can say so out loud. */
  truncated: boolean;
  /** The size before clipping — the number that makes a truncation explainable. */
  originalChars: number;
}

export interface FitResult {
  blocks: BudgetedBlock[];
  /** URIs that did not fit at all, named rather than silently forgotten. */
  dropped: string[];
  usedChars: number;
}

export interface ContextBudgetLimits {
  maxResources: number;
  maxResourceChars: number;
  maxContextChars: number;
}

export interface ContextBudget {
  readonly limits: ContextBudgetLimits;
  /** Trim one body to the per-resource cap, marking it if anything was cut. */
  clip(uri: string, strategy: string, text: string): BudgetedBlock;
  /**
   * Fit an ordered, already-ranked list of blocks into the total context cap.
   *
   * Order is respected because the caller ranked it: the first block is the one
   * the selector believed in most, and it is the one that must survive.
   */
  fit(blocks: readonly ContextBlock[]): FitResult;
}

/**
 * The three caps from Notes Ch05 §"Context budget is the real constraint",
 * applied in a fixed order so the outcome is explainable:
 *
 *     cap the count  →  cap each body  →  cap the total
 *
 * Each stage removes a different failure. Capping the count stops accidental
 * fan-out. Capping each body stops one huge document dominating. Capping the
 * total protects latency, cost and — most importantly — answer quality, because
 * a prompt stuffed past its useful size gets *worse* answers, not better ones.
 *
 * Truncation is never silent: the marker appended here is the reason a cut read
 * is still an honest read (Notes Ch02 §"Size and token budget").
 */
export function createContextBudget(limits: ContextBudgetLimits): ContextBudget {
  const clip = (uri: string, strategy: string, text: string): BudgetedBlock => {
    if (text.length <= limits.maxResourceChars) {
      return { uri, strategy, text, truncated: false, originalChars: text.length };
    }

    return {
      uri,
      strategy,
      text: text.slice(0, limits.maxResourceChars) + truncationMarker(limits.maxResourceChars, text.length),
      truncated: true,
      originalChars: text.length,
    };
  };

  return {
    limits,
    clip,

    fit(blocks) {
      const dropped: string[] = [];
      const kept: BudgetedBlock[] = [];

      // Stage 1 — cap the count. `slice` keeps the highest-ranked entries.
      for (const overflow of blocks.slice(limits.maxResources)) {
        dropped.push(overflow.uri);
      }

      // Stage 2 — cap each body.
      const clipped = blocks
        .slice(0, limits.maxResources)
        .map((block) => clip(block.uri, block.strategy, block.text));

      // Stage 3 — cap the total, in rank order.
      let usedChars = 0;

      for (const block of clipped) {
        const remaining = limits.maxContextChars - usedChars;

        if (remaining <= 0) {
          dropped.push(block.uri);
          continue;
        }

        if (block.text.length <= remaining) {
          kept.push(block);
          usedChars += block.text.length;
          continue;
        }

        // The last block that half-fits is clipped rather than dropped: a
        // partial document the model is told about beats a missing one.
        kept.push({
          ...block,
          text: block.text.slice(0, remaining) + truncationMarker(remaining, block.originalChars),
          truncated: true,
        });
        usedChars += remaining;
      }

      return { blocks: kept, dropped, usedChars };
    },
  };
}
