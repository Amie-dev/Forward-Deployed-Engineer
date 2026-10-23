import type { Logger } from "../core/logger.js";

/**
 * Chapter 08 §8.1 — the host's security layer.
 *
 * The lecture's sentence is the entire design: *"Discovering a tool does not
 * mean the model should automatically be allowed to execute everything."*
 * Discovery is an **inventory, not a grant**, so the host turns a discovered
 * catalogue into three sets:
 *
 *   auto-approve   read-only, low risk       → the model may call it directly
 *   ask the user   needs approval            → a consent gate runs first
 *   never shown    not permitted by policy   → the model is never told it exists
 *
 * The third branch is the strongest control in the whole architecture and the
 * cheapest one: an absent tool cannot be called by a model that was never told
 * it existed. No prompt injection reaches a capability the host never listed.
 */

/** The part of a discovered tool definition this policy needs — nothing more. */
export interface DiscoveredTool {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export type TrustTier = "auto" | "confirm" | "denied";

export interface PolicyDecision {
  tier: TrustTier;
  reason: string;
}

/** One row of the decision table the host prints before it invokes anything. */
export interface ToolReview {
  name: string;
  tier: TrustTier;
  reason: string;
}

export interface ConsentRequest {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * In a real host this renders a dialog and awaits a click. Injecting it keeps
 * the policy pure and testable, and keeps the demo's answers reproducible.
 */
export type ConsentHandler = (request: ConsentRequest) => Promise<boolean>;

export interface HostPolicy {
  /** Classify one tool. Pure: no I/O, no user interaction, no hidden state. */
  classify(tool: DiscoveredTool): PolicyDecision;
  /** The decision table for a whole catalogue — what the host prints and audits. */
  review(tools: readonly DiscoveredTool[]): ToolReview[];
  /** Which tools the model is even allowed to see (Chapter 04: the host chooses). */
  visible(tools: readonly DiscoveredTool[]): DiscoveredTool[];
  /** Run the consent gate for a `confirm`-tier tool. */
  requestConsent(request: ConsentRequest): Promise<boolean>;
}

export function createHostPolicy(options: {
  /** When false, destructive tools are hidden from the model entirely. */
  allowDestructive: boolean;
  /** When true, a destructive tool needs an explicit approval before it runs. */
  requireConsent: boolean;
  requestConsent: ConsentHandler;
  logger: Logger;
}): HostPolicy {
  const classify = (tool: DiscoveredTool): PolicyDecision => {
    const destructive = tool.annotations?.destructiveHint === true;

    // Branch 3 — never shown. Policy beats discovery.
    if (destructive && !options.allowDestructive) {
      return { tier: "denied", reason: "destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false" };
    }

    // Branch 2 — ask the user. Irreversible operations never run on the
    // model's authority alone.
    if (destructive && options.requireConsent) {
      return { tier: "confirm", reason: "destructiveHint is set: irreversible, so it needs explicit consent" };
    }

    // Branch 1 — auto-approve.
    if (destructive) {
      return { tier: "auto", reason: "destructive, but consent is disabled by configuration" };
    }

    return {
      tier: "auto",
      reason: tool.annotations?.readOnlyHint === true ? "readOnlyHint is set" : "no destructive hint",
    };
  };

  return {
    classify,

    review(tools) {
      return tools.map((tool) => ({ name: tool.name, ...classify(tool) }));
    },

    visible(tools) {
      return tools.filter((tool) => {
        const decision = classify(tool);

        if (decision.tier === "denied") {
          // Logged as a *policy* event, not an error: hiding a tool is a
          // deliberate decision, and an operator needs to be able to see it.
          options.logger.warn("policy.tool_hidden", { tool: tool.name, reason: decision.reason });
          return false;
        }

        return true;
      });
    },

    async requestConsent(request) {
      const approved = await options.requestConsent(request);
      options.logger.info("policy.consent", { tool: request.tool, approved });
      return approved;
    },
  };
}
