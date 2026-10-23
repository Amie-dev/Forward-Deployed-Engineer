import { contextFence } from "../config/constants.js";
import type { BudgetedBlock, ContextBlock, ContextBudget } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { ResourceRouter, SelectionResult, SelectionService } from "../services/selectionService.js";
import type { PromptMessage } from "../services/promptService.js";
import type { McpClient } from "./client.js";
import type { HostPolicy, Session } from "./policy.js";

/**
 * Notes Ch05 §"The missing piece" and Ch02 §"Size and token budget" — **context
 * assembly**: the step that turns a catalogue and a message into the exact text
 * a model will read.
 *
 * This is the file Chapter 05 is really about. *"MCP does not prescribe how a
 * host selects a Resource"* means this code is the application's own
 * responsibility — and so are the four things it has to get right:
 *
 *  1. **Select** — the five strategies, in `selectionService`.
 *  2. **Authorise, again** — the selector already filtered by ACL, but the read
 *     path checks *again*. Belt and braces is not paranoia here: the selector's
 *     filter protects the ranking, and this one protects the *read*, which is
 *     the thing that actually touches data.
 *  3. **Budget** — cap the count, cap each body, cap the total, and say out loud
 *     when something was cut (Notes Ch02 §"Size and token budget").
 *  4. **Log the why** — strategy, candidates, chosen URIs, bytes. Notes Ch05
 *     §"Observability" calls this *"one line you can read at 2 a.m."*, and this
 *     function emits exactly that line.
 *
 * A failure to read one resource is deliberately **not** fatal. Three resources
 * where one backend is down is a worse answer, not a failed request — so the
 * reads are settled independently and the failures are named in the log.
 */

export interface AssembledContext {
  /** The system message: the preamble plus the fenced resource blocks. */
  system: string;
  /** The prompt's own messages, untouched and in order. */
  messages: PromptMessage[];
  /** URIs whose bodies made it into the system message. */
  included: string[];
  /** URIs the budget removed, named rather than forgotten. */
  dropped: string[];
  /** URIs the policy refused before a read was even attempted. */
  refused: string[];
  /** URIs that were selected but failed to read. */
  failed: string[];
  /** URIs whose bodies were cut to fit. */
  truncated: string[];
  /** Characters placed into the system message. */
  chars: number;
  /** Everything the selector decided, for the audit trail. */
  selection: SelectionResult;
}

export interface AssembleRequest {
  message: string;
  /** URIs the user attached explicitly — strategy 1. */
  attached?: readonly string[];
  session: Session;
  /**
   * The prompt's own messages, echoed into the result so a single object
   * describes the entire model input.
   */
  promptMessages?: readonly PromptMessage[];
  /** Strategy 4. Absent in offline mode, and the selection still works. */
  router?: ResourceRouter;
  /** Overrides the configured cap, for a caller that knows better. */
  limit?: number;
}

export async function assembleContext(
  request: AssembleRequest,
  deps: {
    client: McpClient;
    policy: HostPolicy;
    selection: SelectionService;
    budget: ContextBudget;
    logger: Logger;
    metrics: Metrics;
    maxResourcesPerRequest: number;
  },
): Promise<AssembledContext> {
  const { message, session } = request;
  const limit = request.limit ?? deps.maxResourcesPerRequest;

  const selection = await deps.selection.select({
    message,
    attached: request.attached,
    scope: {
      userId: session.actor,
      projects: session.projects,
      isAdmin: session.isAdmin,
    },
    limit,
    router: request.router,
  });

  const refused: string[] = [];
  const readable: string[] = [];

  // The read-time authorisation pass. The selector already removed what the
  // session may not *see*; this removes what it may not *read*.
  for (const chosen of selection.chosen) {
    const decision = deps.policy.mayRead(chosen.uri, session);

    if (decision.allowed) {
      readable.push(chosen.uri);
      continue;
    }

    refused.push(chosen.uri);
    deps.metrics.count("context.refused");
    deps.logger.warn("context.refused", { uri: chosen.uri, reason: decision.reason });
  }

  /**
   * Reads are settled independently.
   *
   * `Promise.all` would make one broken backend fail the whole request, which
   * turns a degraded answer into no answer — the wrong trade every time.
   */
  const settled = await Promise.allSettled(
    readable.map(async (uri) => {
      const body = await deps.client.read(uri);
      return { uri, body };
    }),
  );

  const blocks: ContextBlock[] = [];
  const failed: string[] = [];

  settled.forEach((outcome, index) => {
    const uri = readable[index] ?? "(unknown)";

    if (outcome.status === "rejected") {
      failed.push(uri);
      deps.metrics.count("context.read_failed");
      deps.logger.warn("context.read_failed", {
        uri,
        message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      return;
    }

    const strategy = selection.chosen.find((chosen) => chosen.uri === uri)?.strategy ?? "unknown";

    blocks.push({ uri, strategy, text: outcome.value.body.text });
  });

  /**
   * Three caps, applied in a fixed order: count → each body → the total.
   *
   * The budget returns *what it did*, not just what survived, which is what
   * makes a truncation explainable instead of mysterious.
   */
  const fit = deps.budget.fit(blocks);

  const system = composeSystem(fit.blocks);
  const truncated = fit.blocks.filter((block) => block.truncated).map((block) => block.uri);

  /**
   * Notes Ch05 §"Observability: log the *why*" — the single line that answers
   * *"why did the model see this?"*, *"was the catalogue even right?"*, *"was
   * the ranker close?"* and *"was it worth the tokens?"*
   *
   * `reasons` is the part that makes it a *decision record* rather than a
   * request log: every URI is paired with the strategy that chose it and the
   * sentence explaining why.
   */
  deps.metrics.count("context.assembled");
  deps.metrics.observe("context.chars", fit.usedChars);
  deps.logger.info("context.assembled", {
    strategies: selection.strategies,
    candidates: selection.candidates,
    chosen: selection.chosen.map((chosen) => chosen.uri),
    included: fit.blocks.map((block) => block.uri),
    dropped: fit.dropped,
    refused,
    failed,
    truncated,
    chars: fit.usedChars,
    reasons: selection.chosen.map((chosen) => `${chosen.uri} ← ${chosen.strategy}: ${chosen.reason}`),
  });

  return {
    system,
    messages: [...(request.promptMessages ?? [])],
    included: fit.blocks.map((block) => block.uri),
    dropped: fit.dropped,
    refused,
    failed,
    truncated,
    chars: fit.usedChars,
    selection,
  };
}

/**
 * Builds the system message: a short preamble, then one fenced block per
 * resource.
 *
 * The fences are **machine-generated** — `--- <uri> (chosen by <strategy>) ---` —
 * and never come from resource content. That matters more than it looks:
 * resource content is untrusted text that gains system-level authority the
 * moment it lands in a prompt, so the boundary between *our* instructions and
 * *their* text has to be drawn by us (Notes Ch04 §"Do not let Resources become a
 * prompt-injection channel").
 *
 * The empty case is written out rather than left blank, because a model given
 * silence invents context and a model told *"none was selected"* does not.
 */
function composeSystem(blocks: readonly BudgetedBlock[]): string {
  const preamble = [
    "You are a task management assistant.",
    "",
    "Use the context below whenever it is relevant to the question.",
  ];

  if (blocks.length === 0) {
    return [...preamble, "", "No additional context was selected for this request."].join("\n");
  }

  const sections = blocks.flatMap((block) => [contextFence(block.uri, block.strategy), block.text, ""]);

  return [...preamble, "", ...sections].join("\n").trimEnd();
}
