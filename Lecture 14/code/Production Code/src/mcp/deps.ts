import type { RateLimiter } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { TaskService } from "../services/taskService.js";

/**
 * The wiring contract shared by the three primitive registrars.
 *
 * Everything a capability needs arrives as an argument rather than an import,
 * which is what makes Chapter 08's testing claim concrete: *three of the four
 * test layers need no model at all.* `registerTools(server, deps)` can be
 * exercised against a fake service with no transport, no child process and no
 * LLM anywhere in the picture.
 */
export interface ServerDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly service: TaskService;
  readonly limiter: RateLimiter;
  /** Per-call budget, in milliseconds (Chapter 08 — timeouts). */
  readonly timeoutMs: number;
}
