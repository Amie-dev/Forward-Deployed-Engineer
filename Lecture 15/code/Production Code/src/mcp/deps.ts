import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { RateLimiter } from "../core/guards.js";
import type { ResourceCatalogue } from "../domain/resourceCatalogue.js";
import type { PromptService } from "../services/promptService.js";
import type { ResourceService } from "../services/resourceService.js";
import type { TaskService } from "../services/taskService.js";

/**
 * The wiring contract shared by the three primitive registrars.
 *
 * Everything a capability needs arrives as an argument rather than an import,
 * which is what makes the testing claim concrete: `registerTools(server, deps)`
 * can be exercised against a fake service with no transport, no child process
 * and no model anywhere in the picture.
 *
 * Lecture 15 makes this contract do more work than Lecture 14's did, because
 * there are now three primitives with three different owners — and the *only*
 * thing that makes that legible is that all three receive the same object and
 * read different fields out of it.
 */
export interface ServerDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;

  /** The write side — reached by Tools. */
  readonly tasks: TaskService;
  /** The read side — reached by Resources. */
  readonly resources: ResourceService;
  /** The templates — reached by Prompts, and by nothing else. */
  readonly prompts: PromptService;
  /** The descriptor table, so the resource registrar can register declaratively. */
  readonly catalogue: ResourceCatalogue;

  /** Namespaced per primitive, so one noisy capability cannot starve the rest. */
  readonly limiter: RateLimiter;

  /**
   * Two budgets, not one: `prompts/get` is a local template render while
   * `resources/read` may reach a backend (Notes Ch07 §"Streaming, timeouts and
   * cancellation").
   */
  readonly toolTimeoutMs: number;
  readonly resourceTimeoutMs: number;

  /**
   * Notes Ch03 §3.5 — the URI schemes this server will resolve.
   *
   * Checked *before* a handler runs, which is what stops a template from
   * becoming an enumeration oracle over a scheme nobody meant to expose.
   */
  readonly allowedSchemes: ReadonlySet<string>;
}
