import type { ContextBudget } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { SelectionService } from "../services/selectionService.js";
import type { AuditLog } from "./audit.js";
import type { McpClient } from "./client.js";
import type { HostPolicy } from "./policy.js";

/**
 * The wiring contract for the host half of the application.
 *
 * The mirror image of `mcp/deps.ts`, and the parallel is deliberate: the *server*
 * hands its three primitive registrars one object, and the *host* hands its four
 * controllers one object. In both cases the object is the only thing a layer
 * receives, which is what makes every layer constructible in a test with no
 * transport, no child process and no model.
 *
 * The controllers never import `client.ts`, `policy.ts` or `selectionService.ts`
 * directly. They receive this, which is why swapping the Streamable HTTP client
 * for an in-process one — or a real consent dialog for the scripted one — is a
 * change to `routes/index.ts` and nothing else.
 */
export interface HostDeps {
  /** The only door to the MCP server. */
  readonly client: McpClient;
  /** Consent, tool tiers, the resource ACL and the prompt allowlist. */
  readonly policy: HostPolicy;
  /** The five selection strategies. */
  readonly selection: SelectionService;
  /** The three caps that keep a prompt from eating its own budget. */
  readonly budget: ContextBudget;
  /** The record of what was decided, with hashed arguments. */
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly metrics: Metrics;

  /** The knobs the controllers need, gathered so they are read in one place. */
  readonly limits: {
    maxResourcesPerRequest: number;
    maxResourceChars: number;
    maxContextChars: number;
  };
}
