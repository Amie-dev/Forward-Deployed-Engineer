import type { Logger } from "../core/logger.js";
import type { FailureCode } from "../core/errors.js";
import type { ResourceCatalogue } from "../domain/resourceCatalogue.js";

/**
 * Notes Ch04 §"Authorisation and validation live in the handler" and Ch05
 * §"Filter *before* ranking" — **the host's security layer**.
 *
 * Lecture 14's governing sentence was *"discovering a tool does not mean the
 * model should automatically be allowed to execute everything."* Lecture 15 adds
 * two more surfaces with the same shape of problem, and this file answers all
 * three in one place:
 *
 *   **Tools**     discovery is an inventory, not a grant → auto / confirm / never shown
 *   **Resources** the application may read, but "the application is code, and
 *                 code has bugs" → a session-scoped ACL over the catalogue
 *   **Prompts**   the user chooses, but not every deployment wants every
 *                 workflow → an allowlist
 *
 * The third tool branch is still the strongest control in the whole architecture
 * and still the cheapest: **an absent tool cannot be called by a model that was
 * never told it existed.** No prompt injection reaches a capability the host
 * never listed.
 *
 * ## Why the resource ACL lives here and not on the server
 *
 * The server validates *shape* — is this a well-formed URI, is the scheme
 * allowed, is the `{taskId}` a positive integer — and it must, because it cannot
 * trust its callers. But it cannot enforce *ownership*, because it has no
 * session: an MCP server is a capability provider, not an identity provider.
 *
 * The host has the session. So ownership is checked here, on the concrete URI,
 * before the read is ever issued. That split is the honest one, and it is why
 * `mayRead` takes a `Session` while the server's `readThrough` does not.
 */

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

/**
 * Who is asking.
 *
 * It comes from the session — **never from the model**, because a
 * model-authored identity is a privilege escalation waiting to happen.
 */
export interface Session {
  /** The user id this session acts as. */
  actor: string;
  /** Projects this session is scoped to. */
  projects: readonly string[];
  /** May this session read personal data belonging to someone else? */
  isAdmin: boolean;
}

export interface ResourceDecision {
  allowed: boolean;
  /**
   * Why not, as a failure class — so the caller can answer with the *right*
   * status instead of one it guessed.
   *
   * The distinction is not cosmetic: "this address does not exist" (404) and
   * "you may not read this address" (403) tell a caller two entirely different
   * things, and collapsing them means a client cannot tell a typo from a
   * permissions problem.
   */
  code: FailureCode;
  reason: string;
}

export interface HostPolicy {
  /** Classify one tool. Pure: no I/O, no user interaction, no hidden state. */
  classify(tool: DiscoveredTool): PolicyDecision;
  /** The decision table for a whole catalogue — what the host prints and audits. */
  review(tools: readonly DiscoveredTool[]): ToolReview[];
  /** Which tools the model is even allowed to see. */
  visible(tools: readonly DiscoveredTool[]): DiscoveredTool[];
  /** Run the consent gate for a `confirm`-tier tool. */
  requestConsent(request: ConsentRequest): Promise<boolean>;

  /**
   * Notes Ch04 §"Do not put privileged data behind a URI the host can read
   * freely" — may *this session* read *this concrete URI*?
   *
   * Takes a resolved URI, not a template: ownership is a property of an address,
   * and `user://{userId}/profile` has no owner until the variable is bound.
   */
  mayRead(uri: string, session: Session): ResourceDecision;

  /** Notes Ch06 §"Keep the count small" — is this workflow offered to this session? */
  mayUsePrompt(name: string, session: Session): ResourceDecision;
}

export function createHostPolicy(options: {
  /** When false, destructive tools are hidden from the model entirely. */
  allowDestructive: boolean;
  /** When true, a destructive tool needs an explicit approval before it runs. */
  requireConsent: boolean;
  /** The schemes the host will even attempt to read (Notes Ch03 §3.5). */
  allowedSchemes: ReadonlySet<string>;
  /** The descriptor table, so ownership can be checked without a round trip. */
  catalogue: ResourceCatalogue;
  /** Prompt names this deployment offers. Empty means "every registered prompt". */
  allowedPrompts: readonly string[];
  requestConsent: ConsentHandler;
  logger: Logger;
}): HostPolicy {
  const classify = (tool: DiscoveredTool): PolicyDecision => {
    const destructive = tool.annotations?.destructiveHint === true;

    // Branch 3 — never shown. Policy beats discovery.
    if (destructive && !options.allowDestructive) {
      return { tier: "denied", reason: "destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false" };
    }

    // Branch 2 — ask the user. Irreversible operations never run on the model's
    // authority alone.
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

    mayRead(uri, session) {
      const scheme = options.catalogue.schemeOf(uri);

      if (scheme === undefined || !options.allowedSchemes.has(scheme)) {
        // The address may be well-formed, but this deployment does not serve its
        // scheme at all — a permissions answer, not a not-found one.
        return {
          allowed: false,
          code: "FORBIDDEN",
          reason: `scheme "${scheme ?? "?"}" is not in the host allow-list`,
        };
      }

      const resolved = options.catalogue.resolve(uri);

      if (resolved === undefined) {
        // Nothing in the catalogue matches: this is a 404, and saying 403 would
        // hide a typo behind a permissions error.
        return {
          allowed: false,
          code: "NOT_FOUND",
          reason: "the URI does not match any advertised Resource",
        };
      }

      const { descriptor, variables } = resolved;

      if (descriptor.audience === "public") {
        return { allowed: true, code: "INVALID_INPUT", reason: `"${descriptor.name}" is public` };
      }

      // Personal data. The variable must name the actor — checked on the *bound*
      // URI, which is the whole reason this function takes a concrete address.
      if (session.isAdmin) {
        return {
          allowed: true,
          code: "INVALID_INPUT",
          reason: `session is an admin, so "${descriptor.name}" is readable`,
        };
      }

      if (variables.userId !== undefined && variables.userId === session.actor) {
        return {
          allowed: true,
          code: "INVALID_INPUT",
          reason: `"${descriptor.name}" belongs to the session's own user`,
        };
      }

      return {
        allowed: false,
        code: "FORBIDDEN",
        reason: `"${descriptor.name}" belongs to another user and the session is not an admin`,
      };
    },

    mayUsePrompt(name, session) {
      if (options.allowedPrompts.length === 0 || options.allowedPrompts.includes(name)) {
        return { allowed: true, code: "INVALID_INPUT", reason: "the prompt is offered by this deployment" };
      }

      return {
        allowed: false,
        code: "FORBIDDEN",
        reason: `prompt "${name}" is not enabled for this deployment (actor ${session.actor})`,
      };
    },
  };
}

