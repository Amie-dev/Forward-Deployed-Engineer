import { URI_SCHEME } from "../config/constants.js";
import type { ResourceCatalogue, ResourceDescriptor, SearchableEntry } from "../domain/resourceCatalogue.js";

/**
 * Notes Ch05 — **MCP does not choose the Resource. Your application does.**
 *
 * That sentence is the whole chapter, and it is a responsibility rather than a
 * feature: the protocol hands you a catalogue, and picking from it is ordinary
 * application code that you have to write, justify and measure.
 *
 * All five strategies the lecture names are implemented here, because each one
 * answers a question the others cannot:
 *
 *   1. **user selection** (§5.2) — the user attached it. Highest precision, zero
 *      ranking cost, perfectly explainable.
 *   2. **application state** (§5.3) — the app knows something the user did not
 *      say. *"No additional AI decision is required."*
 *   3. **retrieval** (§5.4) — metadata scored against the message. Note
 *      *metadata*: ranking happens before anything is read.
 *   4. **LLM routing** (§5.5) — a model ranks the shortlist. Optional, async, and
 *      never trusted blindly: the model may only choose from what it was shown.
 *   5. **rules** (§5.6) — a declared, reviewable pattern → resource table.
 *
 * Two of the chapter's engineering points are structural here rather than
 * comments: the **ACL filter runs before ranking** (§"Filter *before* ranking"),
 * and every selection carries a **reason** (§"Observability: log the *why*").
 */

/** The five strategies, named so a log line can say which one fired. */
export type SelectionStrategy = "user" | "state" | "retrieval" | "llm" | "rule";

/**
 * What the application knows about *this* request that the message does not say.
 *
 * `focus` is the important one: a host knows which document is on screen, and
 * that is application state in the purest sense — no inference, no model.
 */
export interface SelectionScope {
  /** Who is asking. Used by the ACL, never by the ranker. */
  userId: string;
  /** Projects this session is scoped to. Always relevant (Notes Ch05 §5.3). */
  projects: readonly string[];
  /** The URI the user is currently looking at, if any. */
  focus?: string;
  /** May this actor read personal data belonging to someone else? */
  isAdmin: boolean;
}

export interface SelectionRequest {
  /** The user's message. May be empty when only a prompt is in play. */
  message: string;
  /** URIs the user attached explicitly — strategy 1. */
  attached?: readonly string[];
  scope: SelectionScope;
  /** Hard cap on how many selections may come back (Notes Ch05 §"budget"). */
  limit: number;
  /**
   * Strategy 4, injected rather than imported, so the selection path is
   * testable with no model anywhere in the picture.
   */
  router?: ResourceRouter;
}

/** One choice, with the sentence an operator needs at 2 a.m. */
export interface Selection {
  uri: string;
  name: string;
  strategy: SelectionStrategy;
  reason: string;
  /** 0..1. Strategies have different scales, and that is honest — it is a rank, not a probability. */
  score: number;
}

export interface SelectionResult {
  chosen: Selection[];
  /** Candidates the ACL removed **before** ranking, named rather than dropped silently. */
  refused: string[];
  /** Descriptors that could not be turned into a readable URI (unbound template). */
  unbindable: string[];
  /** How many candidates the ranker actually saw. */
  candidates: number;
  /** Which strategies fired, in the order they were consulted. */
  strategies: SelectionStrategy[];
}

/** A strategy proposes a descriptor plus whatever variables it can bind. */
interface Proposal {
  descriptor: ResourceDescriptor;
  variables: Record<string, string>;
  strategy: SelectionStrategy;
  reason: string;
  score: number;
}

/**
 * Strategy 4's contract.
 *
 * It receives **only** the shortlist, and returns a URI from it — or nothing.
 * That is the security property, not a convenience: a router that can name a
 * resource the host never showed it has been handed the ability to widen its own
 * authority (Notes Ch05 §5.5).
 */
export type ResourceRouter = (
  message: string,
  shortlist: readonly Selection[],
) => Promise<string | undefined>;

const TEMPLATE_VARIABLE = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Turns a descriptor plus variables into a concrete, readable URI.
 *
 * Returns `undefined` when a variable cannot be bound, which is what stops the
 * selector ever proposing `task://tasks/{taskId}` — an address that means
 * "any task", and therefore no address at all.
 */
export function bindUri(descriptor: ResourceDescriptor, variables: Record<string, string>): string | undefined {
  let unbound = false;

  const uri = descriptor.uri.replace(TEMPLATE_VARIABLE, (_match, name: string) => {
    const value = variables[name];

    if (value === undefined || value === "") {
      unbound = true;
      return "";
    }

    return encodeURIComponent(value);
  });

  return unbound ? undefined : uri;
}

/**
 * Notes Ch05 §"Filter *before* ranking" — *if a user may not read a resource, it
 * should not be in the candidate set at all.*
 *
 * Why before, and not after: **ranking leaks.** A model asked to choose between
 * resources it should not see has been told they exist. Filtering afterwards is
 * filtering after the decision, which is too late.
 */
export function admitted(descriptor: ResourceDescriptor, variables: Record<string, string>, scope: SelectionScope): boolean {
  if (descriptor.audience === "public") {
    return true;
  }

  // Personal data: the URI's own variable must name the actor. An admin may
  // read anyone's, and that exception is declared rather than implied.
  return scope.isAdmin || variables.userId === scope.userId;
}

/**
 * The only variable a host can fill from session state is the actor's own id.
 *
 * Everything else — a project slug, a task id — has to come from the message, a
 * rule, or the user. Filling them from a session would mean the selector was
 * guessing which task the user meant, which is exactly the guess Chapter 05
 * warns against making silently.
 */
function sessionVariables(descriptor: ResourceDescriptor, scope: SelectionScope): Record<string, string> {
  return descriptor.uri.includes("{userId}") ? { userId: scope.userId } : {};
}

/* ── Strategy 1 — user selection (Notes Ch05 §5.2) ────────────────────────── */

/**
 * *"A client may allow users to explicitly attach a Resource."*
 *
 * The highest-quality strategy there is: precision and explainability are both
 * perfect because a human chose, and the ranking cost is zero. It is also why
 * `description` is a **user-facing** field (Notes Ch03 §3.6) — a checkbox
 * labelled `company://leave-policy` is unusable; one labelled *"Leave Policy"*
 * is not.
 */
function byUserChoice(attached: readonly string[], catalogue: ResourceCatalogue, scope: SelectionScope): Proposal[] {
  const proposals: Proposal[] = [];

  for (const uri of attached) {
    const resolved = catalogue.resolve(uri);

    if (resolved === undefined) {
      // A user may attach a URI the catalogue does not know. It is not an error
      // worth failing the request over — it is simply not selectable, and the
      // caller will see it in `unbindable`.
      continue;
    }

    proposals.push({
      descriptor: resolved.descriptor,
      variables: { ...sessionVariables(resolved.descriptor, scope), ...resolved.variables },
      strategy: "user",
      reason: "the user attached this Resource explicitly",
      // 1, and nothing may outrank it: an explicit choice beats any guess.
      score: 1,
    });
  }

  return proposals;
}

/* ── Strategy 2 — application state (Notes Ch05 §5.3) ─────────────────────── */

/**
 * *"The application already knows the user's current project … no additional AI
 * decision is required."*
 *
 * This strategy deliberately does **not** read the message. It fires from what
 * the session knows, which is what makes it the cheapest and the most
 * deterministic of the five — and why it runs before retrieval rather than
 * competing with it.
 */
function byAppState(scope: SelectionScope, catalogue: ResourceCatalogue): Proposal[] {
  const proposals: Proposal[] = [];

  // The session's project scope: the brief is relevant whatever was typed.
  for (const project of scope.projects) {
    const descriptor = catalogue.byName("project");

    if (descriptor !== undefined) {
      proposals.push({
        descriptor,
        variables: { projectId: project },
        strategy: "state",
        reason: `the session is scoped to project "${project}", so its brief is always relevant`,
        score: 0.8,
      });
    }
  }

  // The document already on screen. A host knows this with certainty.
  if (scope.focus !== undefined) {
    const resolved = catalogue.resolve(scope.focus);

    if (resolved !== undefined) {
      proposals.push({
        descriptor: resolved.descriptor,
        variables: { ...sessionVariables(resolved.descriptor, scope), ...resolved.variables },
        strategy: "state",
        reason: "the user is already looking at this Resource",
        score: 0.85,
      });
    }
  }

  return proposals;
}

/* ── Strategy 5 — rules (Notes Ch05 §5.6) ─────────────────────────────────── */

/**
 * A declared mapping from a message pattern to a Resource.
 *
 * Rules are data, not code, and that is the point: a reviewer can read the whole
 * policy in one table, and a rule that starts misfiring can be deleted without
 * touching a scorer. They also do the job retrieval structurally cannot — binding
 * a template variable that only appears in the *message*, such as a task id.
 */
export interface SelectionRule {
  name: string;
  pattern: RegExp;
  /** The descriptor `name` this rule attaches. */
  descriptor: string;
  /** Fill the descriptor's template variables from the match. */
  variables: (match: RegExpExecArray) => Record<string, string>;
  reason: string;
  score: number;
}

export const DEFAULT_RULES: readonly SelectionRule[] = [
  {
    name: "named-task-id",
    pattern: /\btasks?\s*#?(\d{1,9})\b/i,
    descriptor: "task",
    variables: (match) => ({ taskId: match[1] ?? "" }),
    reason: "the message names a specific task id, so that task's document is addressable",
    score: 0.95,
  },
  {
    name: "named-project",
    pattern: /\b(?:project|epic|brief)\s+([a-z0-9][a-z0-9_-]*)/i,
    descriptor: "project",
    variables: (match) => ({ projectId: match[1] ?? "" }),
    reason: "the message names a project, so that project's brief is addressable",
    score: 0.9,
  },
];

function byRules(
  message: string,
  rules: readonly SelectionRule[],
  catalogue: ResourceCatalogue,
): Proposal[] {
  const proposals: Proposal[] = [];

  for (const rule of rules) {
    const match = rule.pattern.exec(message);

    if (match === null) {
      continue;
    }

    const descriptor = catalogue.byName(rule.descriptor);

    if (descriptor === undefined) {
      continue;
    }

    proposals.push({
      descriptor,
      variables: rule.variables(match),
      strategy: "rule",
      reason: `${rule.reason} (rule "${rule.name}")`,
      score: rule.score,
    });
  }

  return proposals;
}

/* ── Strategy 3 — retrieval (Notes Ch05 §5.4) ─────────────────────────────── */

/**
 * Tokens long enough to carry meaning.
 *
 * Three characters is a deliberate floor: below it, `a`, `of` and `to` match
 * everything, which inflates every score and makes the rank meaningless.
 */
function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3))];
}

/**
 * Scores one descriptor against a message.
 *
 * Two signals, weighted differently, because they are differently reliable: a
 * declared **keyword** is a deliberate statement by the resource's author, while
 * an incidental match on the **description** is what lets a phrasing nobody
 * anticipated still find something. A ranker with only the first is brittle; one
 * with only the second is noisy.
 *
 * The result is normalised to `0..1` so it can be compared with the other
 * strategies' scores. It is a rank, not a probability — and this is deliberately
 * the level of sophistication a first implementation should have, because a
 * ranker you can explain beats one you cannot.
 */
function scoreDescriptor(descriptor: ResourceDescriptor, tokens: readonly string[], message: string): number {
  const lower = message.toLowerCase();

  const keywordHits = descriptor.keywords.filter((keyword) => lower.includes(keyword)).length;

  const descriptionTokens = new Set(tokenize(`${descriptor.title} ${descriptor.description}`));
  const tokenHits = tokens.filter((token) => descriptionTokens.has(token)).length;

  if (keywordHits === 0 && tokenHits === 0) {
    return 0;
  }

  return Math.min(1, (keywordHits * 2 + tokenHits) / 6);
}

/**
 * *"Retrieval … is used to identify relevant Resources."*
 *
 * Note what is being scored: the **metadata**, never the content. That is what
 * makes retrieval possible before anything is read, and it is why the chapter
 * says MCP and RAG are complements rather than rivals — MCP gives RAG a standard
 * source of truth, and the *ranking* decision stays here, in the application.
 */
function byRetrieval(message: string, catalogue: ResourceCatalogue, scope: SelectionScope): Proposal[] {
  const tokens = tokenize(message);

  if (tokens.length === 0) {
    return [];
  }

  return catalogue
    .searchable()
    .map((entry: SearchableEntry) => ({ entry, score: scoreDescriptor(entry.descriptor, tokens, message) }))
    .filter((scored) => scored.score > 0)
    .map(({ entry, score }) => ({
      descriptor: entry.descriptor,
      variables: sessionVariables(entry.descriptor, scope),
      strategy: "retrieval" as const,
      reason: `the message scores ${score.toFixed(2)} against this Resource's metadata`,
      score,
    }));
}

/* ── The pipeline ─────────────────────────────────────────────────────────── */

export interface SelectionService {
  select(request: SelectionRequest): Promise<SelectionResult>;
}

export function createSelectionService(options: {
  catalogue: ResourceCatalogue;
  /** Overridable, so a test can pin the rule table instead of the default one. */
  rules?: readonly SelectionRule[];
}): SelectionService {
  const { catalogue } = options;
  const rules = options.rules ?? DEFAULT_RULES;

  return {
    async select(request) {
      const { scope } = request;
      const strategies: SelectionStrategy[] = [];
      const proposals: Proposal[] = [];

      /**
       * The strategies are consulted in descending order of how much they can
       * be trusted, and that order is also the tie-break when two of them
       * propose the same URI: an explicit choice outranks a session fact, which
       * outranks a declared rule, which outranks a score.
       */
      const userPicks = byUserChoice(request.attached ?? [], catalogue, scope);
      if (userPicks.length > 0) strategies.push("user");
      proposals.push(...userPicks);

      const statePicks = byAppState(scope, catalogue);
      if (statePicks.length > 0) strategies.push("state");
      proposals.push(...statePicks);

      const rulePicks = byRules(request.message, rules, catalogue);
      if (rulePicks.length > 0) strategies.push("rule");
      proposals.push(...rulePicks);

      const retrieved = byRetrieval(request.message, catalogue, scope);
      if (retrieved.length > 0) strategies.push("retrieval");
      proposals.push(...retrieved);

      /**
       * Bind, then filter.
       *
       * Binding comes first because the ACL needs the *variables* to decide who
       * a URI belongs to, and a template has no owner — only `user://123/profile`
       * does. Filtering an unbound template would mean guessing.
       */
      const refused: string[] = [];
      const unbindable: string[] = [];
      const admittedSelections: Selection[] = [];

      for (const proposal of proposals) {
        const uri = bindUri(proposal.descriptor, proposal.variables);

        if (uri === undefined) {
          unbindable.push(proposal.descriptor.name);
          continue;
        }

        if (!admitted(proposal.descriptor, proposal.variables, scope)) {
          refused.push(uri);
          continue;
        }

        admittedSelections.push({
          uri,
          name: proposal.descriptor.name,
          strategy: proposal.strategy,
          reason: proposal.reason,
          score: proposal.score,
        });
      }

      // Collapse duplicates, keeping the strongest reason to believe in each.
      const byUri = new Map<string, Selection>();

      for (const selection of admittedSelections) {
        const existing = byUri.get(selection.uri);

        if (existing === undefined || selection.score > existing.score) {
          byUri.set(selection.uri, selection);
        }
      }

      // Rank, then cap. The cap is applied *after* ranking so the budget removes
      // the weakest candidates rather than the last ones discovered.
      const ranked = [...byUri.values()].sort(
        (left, right) => right.score - left.score || left.uri.localeCompare(right.uri),
      );

      const candidates = ranked.length;
      let chosen = ranked.slice(0, request.limit);

      /**
       * Strategy 4 runs last, because it needs a shortlist to choose *from* —
       * and it may only choose from that shortlist. The `find` is the security
       * check, not a lookup: a router that returns a URI it was never shown gets
       * its answer discarded, so the model cannot widen its own authority.
       */
      if (request.router !== undefined && chosen.length > 1) {
        const picked = await request.router(request.message, chosen);
        const promoted = picked === undefined ? undefined : chosen.find((selection) => selection.uri === picked);

        if (promoted !== undefined) {
          strategies.push("llm");

          chosen = [
            {
              ...promoted,
              strategy: "llm",
              score: 1,
              reason: `the router chose it from ${candidates} candidates (${promoted.strategy}: ${promoted.reason})`,
            },
            ...chosen.filter((selection) => selection.uri !== promoted.uri),
          ];
        }
      }

      return { chosen, refused, unbindable, candidates, strategies };
    },
  };
}
