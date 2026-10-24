# Chapter 12 — Service: How the Application Chooses a Resource

> **MCP does not choose the Resource. Your application does.** That sentence is the whole of Chapter 05,
> and it is a *responsibility* rather than a feature: the protocol hands you a catalogue, and picking from
> it is ordinary application code that you have to write, justify and measure. All five strategies the
> lecture names are implemented here, because each one answers a question the others cannot.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/selectionService.ts` (512 lines) — the largest service in the project |
| **Layer** | `services` — imports `config/constants.js` and the catalogue. No protocol, no transport, no model. |
| **Purpose** | The five selection strategies, the ACL filter, the ranking, and the reason attached to every choice. |
| **Exports** | `SelectionStrategy`, `SelectionScope`, `SelectionRequest`, `Selection`, `SelectionResult`, `ResourceRouter`, `bindUri()`, `admitted()`, `SelectionRule`, `DEFAULT_RULES`, `SelectionService`, `createSelectionService()` |
| **Lecture sections** | Ch05 §5.2–5.6 (all five strategies), Ch05 §"Filter *before* ranking", Ch05 §"Observability: log the *why*", Ch03 §3.6 |
| **Runs** | `npm run lifecycle` step 8 — five queries, every strategy exercised |

---

## Commands

```bash
# five queries, and every strategy that fires for each
npm run lifecycle 2>/dev/null | sed -n '/^8\./,/^9\./p'

# the same engine through the host, with the user's own words
curl -s 'http://127.0.0.1:8080/ask?message=show%20me%20task%202'
curl -s 'http://127.0.0.1:8080/ask?message=what%20is%20on%20my%20plate'
```

---

## The five strategies

The header names them and gives the reason all five exist:

| # | Strategy | The note | Its score | What it answers that the others cannot |
| :---: | :--- | :--- | :--- | :--- |
| 1 | **user selection** | §5.2 — the user attached it | `1` | Precision and explainability are *perfect*: a human chose. Zero ranking cost |
| 2 | **application state** | §5.3 — the app knows something the user did not say | `0.8`–`0.85` | *"No additional AI decision is required."* Deterministic, no inference |
| 3 | **retrieval** | §5.4 — metadata scored against the message | computed | Handles phrasings nobody anticipated |
| 4 | **LLM routing** | §5.5 — a model ranks the shortlist | `1` if promoted | Disambiguates when several Resources score alike |
| 5 | **rules** | §5.6 — a declared pattern → resource table | `0.9`–`0.95` | Binds a variable that appears **only in the message**, such as a task id |

Read the "what it answers" column as a partition, because that is the argument. Each strategy covers a case
the others structurally cannot:

- **Only the user** knows what they meant, so only strategy 1 can be trusted absolutely.
- **Only the application** knows the session's project scope and what is on screen — no amount of message
  analysis recovers that.
- **Only retrieval** can match a phrasing the author never enumerated.
- **Only a model** can break a genuine tie between two plausible Resources.
- **Only rules** can extract `2` from *"show me task 2"* and bind it to a template.

That last one is the least obvious and the most concrete. Retrieval can tell you that *"show me task 2"* is
about tasks; it cannot tell you **which** task. A rule with a capture group can:

```ts
pattern: /\btasks?\s*#?(\d{1,9})\b/i,
variables: (match) => ({ taskId: match[1] ?? "" }),
```

So `task://tasks/2` — a *specific* address — becomes selectable, which retrieval alone could never do. The two
strategies are complementary in the strongest sense: retrieval finds the family, the rule picks the member.

---

## `src/services/selectionService.ts` — the full file

```ts
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
```

### Block-by-block

**Block 1 — the strategy names and the scope (lines 29–48).**

```ts
export type SelectionStrategy = "user" | "state" | "retrieval" | "llm" | "rule";

export interface SelectionScope {
  userId: string;
  projects: readonly string[];
  focus?: string;
  isAdmin: boolean;
}
```

*The five strategies, named so a log line can say which one fired.* A string-literal union rather than an enum,
which means it serialises to JSON as-is and can be used directly as a metric label — `selection.strategy.user`
is a counter name built from this type.

`SelectionScope` is *what the application knows about this request that the message does not say*, and its
doc comment singles out `focus`:

> `focus` is the important one: a host knows which document is on screen, and that is application state in the
> purest sense — **no inference, no model**.

Four fields, each with a named consumer, and the split is the security boundary:

| Field | Read by | **Not** read by |
| :--- | :--- | :--- |
| `userId` | The ACL (`admitted`) | The ranker |
| `projects` | Strategy 2 | The ranker |
| `focus` | Strategy 2 | The ranker |
| `isAdmin` | The ACL (`admitted`) | The ranker |

*Who is asking. Used by the ACL, never by the ranker.* That comment on `userId` is a design constraint worth
stating plainly: **the ranker must not know who is asking.** If relevance depended on identity, the ranking
scores would encode information about the user, and a low score would leak that a Resource exists but is
irrelevant *to them*. Keeping identity out of scoring means the ranker's output is identical for every user,
and the ACL is the only thing that varies — which is what makes the ACL auditable.

**Block 2 — the request and the result (lines 50–92).**

```ts
export interface SelectionRequest {
  message: string;
  attached?: readonly string[];
  scope: SelectionScope;
  limit: number;
  router?: ResourceRouter;
}
```

Five fields, and the doc comment on `router` is the key architectural decision:

> Strategy 4, **injected rather than imported**, so the selection path is testable with no model anywhere in
> the picture.

That is the same discipline as `now` in the store and the cache (Chapters 07, 10): the one thing that would
make this module untestable offline is a hard dependency, so it is a parameter. And note it is *optional* — the
pipeline runs without it, which is what lets `npm run lifecycle` exercise four strategies with no API key.

`limit` is *a hard cap on how many selections may come back*, and it is `request.limit` rather than a service
option because the budget belongs to the *caller*: a `GET /plan` might allow three, a follow-up question one.

```ts
export interface SelectionResult {
  chosen: Selection[];
  refused: string[];
  unbindable: string[];
  candidates: number;
  strategies: SelectionStrategy[];
}
```

Five fields, and the three lists are the honest part:

| Field | Content | Why it is reported |
| :--- | :--- | :--- |
| `chosen` | The winners, ranked and capped | The answer |
| `refused` | URIs the ACL removed, *named rather than dropped silently* | So a refusal is visible, not invisible |
| `unbindable` | Descriptors that could not become a readable URI | Distinguishes "not allowed" from "not addressable" |
| `candidates` | How many the ranker actually saw | The denominator for a hit rate |
| `strategies` | Which fired, **in the order consulted** | *Log the why* — and the order is itself information |

The `refused` / `unbindable` split is a genuinely useful distinction to have made. Both mean "you asked for this
and did not get it", and they have completely different causes and fixes:

```text
refused     task://user/456/profile   → the ACL said no. A policy outcome.
unbindable  task                      → the template had no value for {taskId}.
                                         Nothing was decided; the address was incomplete.
```

Collapsing them into one `skipped` list would mean an operator could not tell a permissions problem from a
selection bug — and those go to different people.

```ts
export interface Selection {
  uri: string;
  name: string;
  strategy: SelectionStrategy;
  reason: string;
  /** 0..1. Strategies have different scales, and that is honest — it is a rank, not a probability. */
  score: number;
}
```

*With the sentence an operator needs at 2 a.m.* — and `reason` is a `string`, not a code. That is a deliberate
choice: a code would be more compact and would need a lookup table to read, while a sentence is directly
readable in a log line and in the assembled prompt's fence. The cost is a few bytes per selection; the benefit is
that Chapter 21's "log the why" needs no translation step.

The `score` comment is the most important line in the interface: **it is a rank, not a probability.** The
strategies use different scales on purpose — a user's explicit choice is `1`, a session fact is `0.8`, a keyword
match might be `0.33`. Treating these as probabilities and combining them statistically would be a category
error: they are *ordinal* signals from incomparable sources, and the only meaningful operation is comparison
within the same URI. What the scores do is provide a **total order** so the budget can drop the weakest — which
is exactly what Chapter 06's cap needs.

**Block 3 — `Proposal` and `ResourceRouter` (lines 94–122).**

```ts
interface Proposal {
  descriptor: ResourceDescriptor;
  variables: Record<string, string>;
  strategy: SelectionStrategy;
  reason: string;
  score: number;
}
```

**A strategy proposes a descriptor plus whatever variables it can bind** — and the word *proposes* is doing work.
A `Proposal` is not a `Selection`: it carries a `descriptor` (possibly still templated) rather than a `uri`. The
pipeline below turns proposals into selections by binding, and a proposal that cannot be bound never becomes one.

That two-stage design is what lets the ACL run on *variables* rather than on a URI. A proposal for the
`user-profile` descriptor carries `{ userId: "123" }`, and the ACL can ask *is `123` the actor?* — a question that
is unanswerable from the template `user://{userId}/profile` alone.

```ts
export type ResourceRouter = (
  message: string,
  shortlist: readonly Selection[],
) => Promise<string | undefined>;
```

Strategy 4's contract, and the doc comment states the security property:

> It receives **only** the shortlist, and returns a URI from it — or nothing. That is the security property, not
> a convenience: a router that can name a resource the host never showed it has been handed the ability to widen
> its own authority (Notes Ch05 §5.5).

Read the signature carefully, because it is the whole guarantee:

- **The parameter is `shortlist: readonly Selection[]`** — the router is given the candidates, not the catalogue.
  It has no way to enumerate anything else.
- **`readonly`** — it cannot reorder or mutate the list it was handed.
- **The return is `string | undefined`** — a *URI*, not a Selection. It has no channel for a score or a reason,
  so it cannot claim authority it was not given.
- **`undefined` is legal** — the router declining is a normal outcome, not an error.

And the enforcement is not in the type, it is in the pipeline: even if a router returns a URI outside the
shortlist, the caller discards it. The type makes the correct thing natural; the `find` makes the incorrect thing
impossible. That belt-and-braces pattern is deliberate — see Block 8.

**Block 4 — `bindUri` (lines 124–147).**

```ts
const TEMPLATE_VARIABLE = /\{([A-Za-z0-9_]+)\}/g;

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
```

*Turns a descriptor plus variables into a concrete, readable URI.* The doc comment states what the `undefined`
is for:

> Returns `undefined` when a variable cannot be bound, which is what stops the selector ever proposing
> `task://tasks/{taskId}` — **an address that means "any task", and therefore no address at all.**

That is the failure this function exists to prevent. A selector that emitted the raw template would be proposing
a URI that is *syntactically* fine and *semantically* meaningless — and worse, it would be a URI a client might
forward, asking the server to resolve a template as if it were an address. So binding failure is a **value**, and
the pipeline collects those descriptors into `unbindable` rather than proceeding.

Three details:

**`value === undefined || value === ""`** — both cases are unbound. An empty string is not a value: it would
produce `task://projects/`, which Chapter 08's template grammar correctly rejects (`+` requires at least one
character). Treating it as unbound here means the selector never proposes an address the resolver would refuse.

**`encodeURIComponent(value)`** — the inverse of the `decodeURIComponent` in `catalogue.resolve` (Chapter 08). A
variable containing a space becomes `%20`, so the URI is well-formed, and the round trip through resolve returns
the original value. The two functions are a matched pair, and putting the encode on the *producing* side is what
keeps the URIs in logs and audit records valid.

**`unbound` as a flag, not a thrown error.** A `replace` callback cannot return `undefined`, so the flag is the
mechanism. Note the replacement returns `""` on failure and the flag suppresses the whole result — so a partially
bound URI is never produced. That is the right semantics: half an address is not a shorter address.

**Block 5 — `admitted`, the ACL (lines 149–164).**

```ts
export function admitted(descriptor: ResourceDescriptor, variables: Record<string, string>, scope: SelectionScope): boolean {
  if (descriptor.audience === "public") {
    return true;
  }

  return scope.isAdmin || variables.userId === scope.userId;
}
```

*Notes Ch05 §"Filter **before** ranking" — if a user may not read a resource, it should not be in the candidate set
at all.* And the doc comment gives the reason in three words:

> Why before, and not after: **ranking leaks.** A model asked to choose between resources it should not see has
> been told they exist. Filtering afterwards is filtering after the decision, which is too late.

That is the sharpest security argument in the file, and it is worth following through. Suppose the ACL ran after
ranking. Then strategy 4 — the LLM router — would be shown a shortlist containing `user://456/profile`. Even if
the final result filtered it out, the model has now been *told that a profile for user 456 exists and is relevant
to this query*. That is an information leak with no trace in the output: the response looks clean, and the model
knows something it should not. Worse, in a retrieval-augmented setup the model could mention it.

Filtering before ranking means the candidate set the router sees is already the set the user may read. **The
router cannot leak what it was never shown** — which is why the shortlist-only contract on `ResourceRouter` and
this ordering are two halves of one guarantee.

The rule itself is four lines:

| Condition | Result |
| :--- | :--- |
| `audience === "public"` | Admitted, unconditionally |
| `scope.isAdmin` | Admitted — *an admin may read anyone's, and that exception is declared rather than implied* |
| `variables.userId === scope.userId` | Admitted — it is the actor's own |
| otherwise | **Refused** |

Note it reads the **variables**, not the URI — which is exactly why binding runs before filtering (Block 7). And
note the default is refusal: the function returns `true` in two named cases and `false` otherwise, rather than
returning `false` in a couple of cases and `true` by default. A new audience value would fail closed.

**Block 6 — `sessionVariables` (lines 166–178).**

```ts
function sessionVariables(descriptor: ResourceDescriptor, scope: SelectionScope): Record<string, string> {
  return descriptor.uri.includes("{userId}") ? { userId: scope.userId } : {};
}
```

*The only variable a host can fill from session state is the actor's own id.*

> Everything else — a project slug, a task id — has to come from the message, a rule, or the user. Filling them
> from a session would mean the selector was **guessing which task the user meant**, which is exactly the guess
> Chapter 05 warns against making silently.

This is a small function with a large constraint, and the constraint is about *silent guessing*. The session knows
who you are; it does not know which task you mean. So the one variable the session can supply is `userId`, and the
check is a string search on the template — `includes("{userId}")`.

Note the asymmetry with `projects`: strategy 2 fills `projectId` from `scope.projects`, but through an *explicit*
proposal with a stated reason (*"the session is scoped to project \"fde\", so its brief is always relevant"*) —
not through this generic helper. That is the right split: a session-derived *project* is a claim the application
is making and should therefore be attributed; a session-derived *identity* is simply who is asking, and needs no
justification.

**Block 7 — strategy 1, user selection (lines 180–216).**

```ts
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
      score: 1,
    });
  }

  return proposals;
}
```

*"A client may allow users to explicitly attach a Resource."* — and the doc comment argues for why this is the
best strategy there is:

> The highest-quality strategy there is: precision and explainability are both perfect because a human chose, and
> the ranking cost is zero. It is also why `description` is a **user-facing** field (Notes Ch03 §3.6) — a checkbox
> labelled `company://leave-policy` is unusable; one labelled *"Leave Policy"* is not.

That last sentence closes a loop back to Chapter 08. The catalogue's `title` and `description` are not only
retrieval text for a ranker — they are the **labels on the checkboxes** of the attach-a-resource UI. A catalogue
written for a machine only would be unusable as a picker, and a catalogue written for a human only would rank
poorly. Writing them for both is what the field's dual role demands.

**`score: 1`, and the comment is emphatic:** *1, and nothing may outrank it: an explicit choice beats any guess.*
The maximum possible score, given to the one strategy that involves no inference at all. Since strategy 4 also
assigns `1` when it promotes, the tie-break (Block 8) matters — but strategy 4 only ever *reorders* the chosen
list, it does not compete with strategy 1 for inclusion.

**An unknown attached URI is skipped, not raised:**

```ts
if (resolved === undefined) {
  continue;
}
```

*It is not an error worth failing the request over — it is simply not selectable.* This is the correct severity
call. A stale bookmark or a typo in a client's attach list should not turn a user's question into an error; it
should simply not contribute a Resource. (Note the comment says the caller "will see it in `unbindable`" — in
practice such a URI is dropped here rather than recorded, since it never becomes a proposal. The honest reading
is that it is silently ignored, which is the right behaviour for a user's own stale input.)

**The variable merge order is the subtle line:**

```ts
text: variables: { ...sessionVariables(resolved.descriptor, scope), ...resolved.variables },
```

Session variables first, the URI's own variables second — so **the URI wins** on a collision. That is right: the
user attached `user://123/profile`, and the URI's `123` is what they meant. If the session's `userId` overwrote
it, an admin attaching someone else's profile would silently get their own.

**Block 8 — strategy 2, application state (lines 218–262).**

```ts
function byAppState(scope: SelectionScope, catalogue: ResourceCatalogue): Proposal[] {
  const proposals: Proposal[] = [];

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
```

**The function takes no `message` parameter**, and that is the point of the strategy. The doc comment says so:

> This strategy deliberately does **not** read the message. It fires from what the session knows, which is what
> makes it the cheapest and the most deterministic of the five — and why it runs before retrieval rather than
> competing with it.

The signature enforces it: there is no way to read the message, because it was not passed. That is a stronger
guarantee than a comment saying "do not look at the message".

Two sub-strategies, with different scores and different justifications:

| Trigger | Score | Reason |
| :--- | :--- | :--- |
| The session's project scope | `0.8` | *the session is scoped to project "fde", so its brief is always relevant* |
| The document on screen (`focus`) | `0.85` | *the user is already looking at this Resource* |

`focus` scores slightly higher than the project scope, which is the right ordering: a project scope is a
*setting*, while the document on screen is an *act*. The user opened that document; that is a stronger signal than
their session's configuration.

Note the project loop uses `catalogue.byName("project")` — the descriptor, looked up by name — and binds
`{ projectId: project }` itself. It is deliberately *not* going through `sessionVariables`, because this is a
claim the application is making rather than an identity the session simply has. That distinction was noted in
Block 6, and it is what makes the `reason` honest: *"the session is scoped to project … so its brief is always
relevant"* is an argument the application is asserting, not a fact about who is asking.

`focus` goes through `catalogue.resolve` like an attached URI, because a host's focus *is* a URI — and it is
validated the same way, so a host cannot inject a focus that the catalogue does not recognise.

**Block 9 — strategy 5, rules (lines 264–313).**

```ts
export interface SelectionRule {
  name: string;
  pattern: RegExp;
  descriptor: string;
  variables: (match: RegExpExecArray) => Record<string, string>;
  reason: string;
  score: number;
}
```

*A declared mapping from a message pattern to a Resource*, and the doc comment is the argument for rules as data:

> Rules are **data, not code**, and that is the point: a reviewer can read the whole policy in one table, and a
> rule that starts misfiring can be deleted without touching a scorer. They also do the job retrieval
> structurally cannot — **binding a template variable that only appears in the message**, such as a task id.

Five fields, and each answers a review question:

| Field | The question it answers in review |
| :--- | :--- |
| `name` | Which rule fired? (appears in the `reason`) |
| `pattern` | What does it match? |
| `descriptor` | What does it attach? |
| `variables` | What does it extract? |
| `reason` + `score` | Why, and how strongly? |

**`variables` is a function, not a record.** That is what makes extraction possible: the match object is passed in
and the rule decides how to interpret it. A static record could only bind constants.

```ts
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
```

Two rules, and the patterns repay reading character by character:

**`named-task-id`: `/\btasks?\s*#?(\d{1,9})\b/i`**

| Part | Matches | Why |
| :--- | :--- | :--- |
| `\b` | A word boundary | So `mytask5` does not match — only a standalone word |
| `tasks?` | `task` or `tasks` | *"task 2"* and *"tasks 2"* are the same request |
| `\s*` | Optional whitespace | `task2` and `task 2` both work |
| `#?` | Optional `#` | *"task #2"* — how people actually type it |
| `(\d{1,9})` | **The capture** | Bounded to 9 digits, so it cannot capture a long numeric string |
| `\b` | Word boundary | `task 2abc` does not match |

The `\d{1,9}` bound is a small piece of defensiveness: without it, a message containing a 40-digit number would
capture all of it, and the bound is what keeps the extracted `taskId` a plausible identifier. The `?? ""` in
`variables` is the `noUncheckedIndexedAccess` guard — `match[1]` is `string | undefined`, and returning `""`
means the URI fails to bind (Block 4) rather than becoming `task://tasks/undefined`.

**`named-project`: `/\b(?:project|epic|brief)\s+([a-z0-9][a-z0-9_-]*)/i`**

Three alternative nouns, because a user might say any of them, and the capture reuses the **same slug grammar as
`projectId`'s schema** in Chapter 09: `[a-z0-9][a-z0-9_-]*`. That is not a coincidence — the rule extracts
something that must satisfy the schema, so matching the schema's shape here means the rule cannot extract a value
that will then be rejected.

The scores — `0.95` for the task id, `0.9` for the project — sit **above** strategy 2's `0.8`/`0.85`, and the
ordering is deliberate: a rule that found an explicit id in the message is a stronger signal than a session's
project scope, because the user actually said it. Both still sit below `1`, because an explicit attachment
outranks any inference.

```ts
function byRules(message: string, rules: readonly SelectionRule[], catalogue: ResourceCatalogue): Proposal[] {
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
```

A straightforward loop with two guards. The `reason` interpolation is worth noting:

```ts
reason: `${rule.reason} (rule "${rule.name}")`,
```

So the reason reads *"the message names a specific task id, so that task's document is addressable (rule
\"named-task-id\")"*. **The rule's name is appended to its reason**, which is what makes a misfiring rule
debuggable: an operator reading the log knows not only *why* something was selected but *which rule* to delete.
That is the practical payoff of `name` being a required field.

**Block 10 — strategy 3, retrieval (lines 315–383).**

```ts
function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3))];
}
```

*Tokens long enough to carry meaning.* The doc comment explains the floor:

> Three characters is a deliberate floor: below it, `a`, `of` and `to` match everything, which inflates every score
> and makes the rank meaningless.

That is the whole rationale for a stop-word list replaced by a length filter: instead of enumerating English
stop words (which would be language-specific and never complete), require every token to be at least three
characters. It is crude and it works, because the tokens that matter are almost always longer than the words that
do not.

The chain: `toLowerCase()` (case-insensitive matching), `split(/[^a-z0-9]+/)` (split on anything that is not a
letter or digit, which handles punctuation and whitespace together), `filter(length >= 3)`, then `new Set` to
**de-duplicate** — so a message repeating "task" five times does not weight that term five times. The spread turns
the `Set` back into an array.

```ts
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
```

Two signals, weighted, and the doc comment defends the asymmetry:

> Two signals, weighted differently, because they are differently reliable: a declared **keyword** is a deliberate
> statement by the resource's author, while an incidental match on the **description** is what lets a phrasing
> nobody anticipated still find something. A ranker with only the first is brittle; one with only the second is
> noisy.

That is the design in one sentence, and it explains the weights:

| Signal | How it is matched | Weight | Why |
| :--- | :--- | :--- | :--- |
| `keywords` | `lower.includes(keyword)` — **substring** | `× 2` | Author-declared, and a substring match lets the stem `"priorit"` hit *priority*, *prioritise*, *prioritised* |
| description + title tokens | Set membership — **exact token** | `× 1` | Broader recall, lower precision |

The keyword check being a **substring** match is what makes the stems in the catalogue work. Chapter 08's
`guidelines` descriptor declares `"priorit"`, and `lower.includes("priorit")` matches *"how do I prioritise"*,
*"my priorities"*, and *"prioritising"* — three different inflections from one four-word list entry.

The normalisation is `/ 6` with `Math.min(1, ...)`, and the numbers are worth working through:

```text
1 keyword hit,  0 token hits  → 2/6 = 0.33
2 keyword hits, 0 token hits  → 4/6 = 0.67
0 keyword hits, 2 token hits  → 2/6 = 0.33
3 keyword hits, 4 token hits  → 10/6 → clamped to 1.00
```

So six "points" of evidence saturates the score. The `Math.min(1, ...)` is what keeps the score in `0..1` — the
range the `Selection` interface promises — and it is needed because `keywordHits` is unbounded (a descriptor could
declare twenty keywords). The clamp means "very strong match" rather than producing a score of 3.3 that would
break the comparison with other strategies' scores.

**The zero short-circuit** — `if (keywordHits === 0 && tokenHits === 0) return 0;` — is redundant mathematically
(the division already yields 0) and useful semantically: it makes explicit that a descriptor with no evidence
scores exactly zero, which is the condition `byRetrieval` filters on.

```ts
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
```

A map → filter → map pipeline, and the doc comment states the constraint that makes it possible:

> Note what is being scored: the **metadata**, never the content. That is what makes retrieval possible before
> anything is read, and it is why the chapter says MCP and RAG are complements rather than rivals — **MCP gives RAG
> a standard source of truth, and the *ranking* decision stays here, in the application.**

Three details:

**`tokens.length === 0` returns early.** A message of only short words — *"what is on my plate"* tokenizes to
`["what", "plate"]`... but *"a b c"* yields `[]` — produces no proposals rather than scoring everything at zero.
Same result, but it skips the whole scan, and it makes the "no signal" case explicit.

**`.filter((scored) => scored.score > 0)`** — descriptors with no evidence are dropped before they become
proposals. Without it, every Resource would be proposed with a score of 0 and the `candidates` count would always
be the full catalogue, making the number meaningless.

**`score.toFixed(2)` in the reason** — *"the message scores 0.33 against this Resource's metadata"*. Two decimal
places, because the score is a rank and more precision would suggest a precision that does not exist.

And note `variables: sessionVariables(entry.descriptor, scope)` — retrieval binds **only** the session's own id,
which is why a retrieval proposal for the `project` or `task` template always fails to bind and lands in
`unbindable`. That is correct behaviour and it is visible in the lifecycle output: retrieval can surface
`task://backlog` and `task://summary` (fixed URIs, which always bind) but can never produce `task://tasks/2`,
because it has no id. **Only a rule can supply one.**

**Block 11 — the pipeline (lines 385–512).**

```ts
export function createSelectionService(options: {
  catalogue: ResourceCatalogue;
  /** Overridable, so a test can pin the rule table instead of the default one. */
  rules?: readonly SelectionRule[];
}): SelectionService {
  const { catalogue } = options;
  const rules = options.rules ?? DEFAULT_RULES;
```

Two dependencies, one of them injectable. The comment on `rules` states the purpose: *so a test can pin the rule
table instead of the default one.* Rules are policy, and policy should be replaceable without editing the engine —
which is the same argument as rules-as-data, applied to the whole table.

**Step 1 — the strategies, in trust order (lines 396–414).**

```ts
const strategies: SelectionStrategy[] = [];
const proposals: Proposal[] = [];

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
```

The doc comment above them is the rule:

> The strategies are consulted in **descending order of how much they can be trusted**, and that order is also the
> tie-break when two of them propose the same URI: an explicit choice outranks a session fact, which outranks a
> declared rule, which outranks a score.

Three things to note about the mechanics:

**All four run — there is no short-circuit.** Even if the user attached a Resource, retrieval still runs. That is
deliberate: an attachment is one Resource, and the model may still benefit from the backlog and the guidelines.
Strategy 1 outranks the others for *ordering*, not for *exclusion*.

**`strategies` records only the strategies that produced something.** `if (userPicks.length > 0)` — so the array in
`SelectionResult` is *which strategies fired*, not which were consulted. That is what makes the lifecycle's
`strategies=[state, retrieval]` line meaningful: it means the other three found nothing.

**The order is `user → state → rule → retrieval`**, which is not the notes' numbering (1, 2, 3, 4, 5 with rules
last). The trust ordering puts rules *before* retrieval, because a rule that matched an explicit pattern is more
reliable than a keyword score — and the notes' numbering is about *kinds* of strategy, not about priority. The
final order in `strategies` is therefore the trust order, which is also the order an operator reads.

**Step 2 — bind, then filter (lines 416–449).**

```ts
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

  admittedSelections.push({ uri, name: proposal.descriptor.name, strategy: proposal.strategy, reason: proposal.reason, score: proposal.score });
}
```

**The ordering of these two checks is load-bearing, and the doc comment says why:**

> Binding comes first because the ACL needs the *variables* to decide who a URI belongs to, and a template has no
> owner — only `user://123/profile` does. Filtering an unbound template would mean **guessing**.

That is the precise argument. `admitted` reads `variables.userId` and compares it to `scope.userId`. For the
`user-profile` descriptor, `variables.userId` is whatever the proposal supplied — which for a retrieval proposal is
`sessionVariables`' output, and for a user attachment is the URI's own value. So the ACL can only be applied once
the variables exist, and binding is what produces them.

The two failure branches produce the two distinct lists from Block 2:

| Check fails | Recorded in | Meaning |
| :--- | :--- | :--- |
| `bindUri` → `undefined` | `unbindable` (the descriptor **name**) | The address was incomplete — nothing was decided |
| `admitted` → `false` | `refused` (the bound **URI**) | A policy decision: this session may not read it |

Note the asymmetry in what is recorded: `unbindable` gets the descriptor *name* (there is no URI to report — that
is the point), while `refused` gets the bound *URI* (so an operator can see exactly which address was denied).
Each list records what it can.

**Step 3 — collapse duplicates, keeping the strongest reason (lines 451–459).**

```ts
const byUri = new Map<string, Selection>();

for (const selection of admittedSelections) {
  const existing = byUri.get(selection.uri);

  if (existing === undefined || selection.score > existing.score) {
    byUri.set(selection.uri, selection);
  }
}
```

*Collapse duplicates, keeping the strongest reason to believe in each.* This is where the strategy ordering pays
off, and it is worth working through the concrete case from the lifecycle.

For the query *"what is on my plate"*, `task://backlog` is proposed by **retrieval** (its keywords include `plate`)
and also by nothing else. But for *"show me task 2"*, `task://projects/fde` is proposed by **state** (the session's
project scope, score `0.8`) and possibly by retrieval too. Whichever proposal has the higher score wins, and the
`strategy` and `reason` fields come along with it.

So the winner's `reason` is the *strongest* justification available, not an arbitrary one. That matters because the
reason is what ends up in the log and in the assembled prompt's fence (`--- task://projects/fde (chosen by state) ---`).
A dedup that kept the *first* proposal would report whatever happened to run first — and since retrieval runs last,
the first proposal is usually the most trustworthy, which is why the ordering makes this correct in practice *and*
the `score` comparison makes it correct in principle. Both, deliberately.

Note the comparison is `>` not `>=`, so on an exact tie the **earlier** proposal wins — which, given the ordering,
is the more trustworthy one. Ties are broken by trust order for free.

**Step 4 — rank, then cap (lines 461–470).**

```ts
const ranked = [...byUri.values()].sort(
  (left, right) => right.score - left.score || left.uri.localeCompare(right.uri),
);

const candidates = ranked.length;
let chosen = ranked.slice(0, request.limit);
```

The comparator has two clauses, and the second one matters more than it looks:

```ts
right.score - left.score              // descending by score
  || left.uri.localeCompare(right.uri)  // then ascending by URI
```

**The URI tie-break makes the output deterministic.** Two Resources with identical scores would otherwise be
ordered by `Map` insertion order, which follows proposal order, which follows the strategies — so the same query
could produce a different `chosen` order between runs if anything upstream changed. Sorting by URI as the
secondary key means the result is a pure function of the inputs. That is the same reasoning as `snapshot()`'s sort
(Chapter 04) and `stats().projects`' sort (Chapter 09): **unstable ordering makes output undiffable.**

And the comment on the cap:

> Rank, then cap. The cap is applied *after* ranking so the budget removes the weakest candidates rather than the
> last ones discovered.

That ordering is the difference between a budget and a truncation. Capping before ranking would drop whichever
Resources happened to be proposed last — which is retrieval, the strategy with the broadest recall and the least
specific evidence. Ranking first means the cap always removes the *weakest* evidence, so a tight budget degrades
the context gracefully rather than arbitrarily.

`candidates` is captured **before** the slice, which is why it is a useful metric: it is the size of the ranked
pool, not the size of the answer.

**Step 5 — strategy 4, the LLM router, and the security check (lines 472–500).**

```ts
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
```

Five things are happening, and the doc comment names the important one:

> Strategy 4 runs last, because it needs a shortlist to choose *from* — and it may only choose from that shortlist.
> The `find` is **the security check, not a lookup**: a router that returns a URI it was never shown gets its
> answer discarded, so the model cannot widen its own authority.

**1. The guard is `chosen.length > 1`.** A router is only consulted when there is a genuine choice to make. With
zero or one candidate there is nothing to disambiguate, and calling a model would be pure latency. That is the
condition that makes strategy 4 *optional* rather than a mandatory step.

**2. `await` — this is the only async step.** The other four strategies are synchronous, so the pipeline is
synchronous except here. That is a good property: four of five strategies cost nothing, and the one that costs a
model call is opt-in per request.

**3. `chosen.find((selection) => selection.uri === picked)` is the enforcement.** A router that returns
`task://secret` — a URI it was never shown — gets `undefined`, and the whole promotion is skipped. The type
(`string | undefined`) already discourages it; the `find` makes it impossible. **This is why the belt-and-braces
matters**: the type is a contract for honest implementations, and the `find` is the guarantee for dishonest ones.
And it is a real threat model, not a hypothetical — the router is *a model*, and a model is an untrusted input
source that could be manipulated by the message it is reading.

**4. The promotion reorders rather than filters.** The promoted selection is moved to the front and the rest keep
their order:

```ts
chosen = [promoted, ...chosen.filter((selection) => selection.uri !== promoted.uri)];
```

Nothing is dropped, so a router mistake cannot remove context — it can only change what comes first. That is a
bounded blast radius for an untrusted component, which is the right shape.

**5. `score: 1` and a reason that preserves the original.** The promoted selection is scored `1` — the same as an
explicit user choice — because the model is being used as a decision-maker and its choice should survive a
re-ranking. And the reason **chains** both justifications:

```text
the router chose it from 5 candidates (state: the session is scoped to project "fde", so its brief is always relevant)
```

So the audit trail records *both* why the application proposed it and why the model preferred it. Neither
explanation is lost, which is what makes a strategy-4 decision reviewable after the fact.

Note the `strategy` field is overwritten to `"llm"` while the original strategy is preserved *inside the reason*.
That is the right trade: the metric (`selection.strategy.llm`) counts model-assisted choices, and the human-readable
reason retains the full provenance.

**A design note on honesty.** The main README states plainly that strategy 4 is **injected, not wired**: the
lifecycle does not pass a router, because doing so would put a model inside the selection path. So `llm` never
appears in the demo's `strategies` output — and that is the trade-off Ch05 §5.5 warns about, made explicit rather
than hidden behind an implementation that happens to work offline.

---

## Run / verify

### 1. Five queries, and which strategy fires for each

```bash
npm run lifecycle 2>/dev/null | sed -n '/^8\./,/^9\./p'
```

```text
8. selection   -> the application chooses, and every choice carries its reason
   "what is on my plate"
      strategies=[state, retrieval] candidates=2
      chosen: task://projects/fde ← state; task://backlog ← retrieval
   "how busy am I?"
      strategies=[state, retrieval] candidates=3
      chosen: task://projects/fde ← state; task://summary ← retrieval; task://guidelines ← retrieval
   "plan my day"
      strategies=[state, retrieval] candidates=2
      chosen: task://projects/fde ← state; task://guidelines ← retrieval
   "show me task 2"
      strategies=[state, rule, retrieval] candidates=5
      chosen: task://tasks/2 ← rule; task://projects/fde ← state; task://backlog ← retrieval
   "what should I do in project media"
      strategies=[state, rule, retrieval] candidates=5
      chosen: task://projects/media ← rule; task://projects/fde ← state; task://backlog ← retrieval
   "show me task 2" + the user attached task://summary
      strategies=[user, state, rule, retrieval] top=task://summary (score 1) — an explicit choice beats every guess
```

Six queries, and every strategy except `llm` fires at least once. Read the two most interesting rows:

**`"show me task 2"` → `task://tasks/2 ← rule` at the top.** This is the strategy that retrieval structurally
cannot replace. The message contains no keyword that could match a *specific* task document — the `task`
descriptor's keywords are `["task detail", "one task", "task id"]`, none of which is "2". The rule's capture group
extracted `2` and bound it:

```text
pattern: /\btasks?\s*#?(\d{1,9})\b/i   →   match[1] === "2"   →   { taskId: "2" }   →   task://tasks/2
```

Note the candidate count jumps from 2 to **5** on this query, and the retrieval strategy also fires (the word
"task" matches). So the rule did not *replace* retrieval — it added a Resource retrieval could not produce, and
outranked it.

**`"what should I do in project media"` → `task://projects/media ← rule`.** The same mechanism for a different
template: the `named-project` rule's alternatives `(?:project|epic|brief)` matched "project", the slug grammar
captured `media`, and `task://projects/media` became addressable. Meanwhile strategy 2 still proposes
`task://projects/fde` from the session scope — so the model receives *both* the project the user asked about and
the project the session is scoped to. That is exactly the behaviour you want, and it is only possible because the
strategies compose rather than compete.

**The final row is the score scale in action.** `top=task://summary (score 1)` — the user attached it, so it scores
the maximum and outranks the rule's `0.95`. The line the walkthrough prints says it: *an explicit choice beats
every guess.*

### 2. Every choice carries its reason

Not visible in step 8 (which prints only URIs and strategies), but it is in the result and in the log:

```bash
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | grep selection | head -4
```

The `reason` strings the engine produces:

| Strategy | Reason |
| :--- | :--- |
| `user` | `the user attached this Resource explicitly` |
| `state` | `the session is scoped to project "fde", so its brief is always relevant` |
| `state` | `the user is already looking at this Resource` |
| `rule` | `the message names a specific task id, so that task's document is addressable (rule "named-task-id")` |
| `retrieval` | `the message scores 0.50 against this Resource's metadata` |

Each is a complete sentence naming the evidence, and the rule's includes the rule's own name so a misfiring rule
is identifiable from a log line. That is Ch05 §"Observability: log the *why*" satisfied literally.

### 3. Strategy 4, injected — and its security check proven

Since the lifecycle passes no router, this needs a probe. Four scenarios:

```text
--- no router (4 strategies) ---
strategies=[state, rule, retrieval] candidates=5
      chosen: task://tasks/2 <- rule (0.95); task://projects/fde <- state (0.8); task://backlog <- retrieval (0.5)

--- router returns a URI FROM the shortlist ---
strategies=[state, rule, retrieval, llm] candidates=5
      chosen: task://backlog <- llm (1); task://tasks/2 <- rule (0.95); task://projects/fde <- state (0.8)
      top reason: the router chose it from 5 candidates (retrieval: the message scores 0.50 against this Resource's metadata)

--- router returns a URI it was NEVER shown ---
strategies=[state, rule, retrieval] candidates=5
      chosen: task://tasks/2 <- rule (0.95); task://projects/fde <- state (0.8); task://backlog <- retrieval (0.5)
      llm in strategies: false
```

**Scenario 1** is the baseline: three strategies, five candidates, ranked by score.

**Scenario 2 is strategy 4 working.** The router was asked to choose from the shortlist and picked the *last*
entry — `task://backlog`, the weakest candidate at `0.5`. It was promoted to the front with `score: 1`, and
`llm` appears in `strategies`. Two details to notice:

- **Nothing was dropped.** The promoted Resource moved to the front; the other two kept their order. A router
  mistake can therefore change *what comes first*, never *what is available* — a bounded blast radius for an
  untrusted component.
- **The reason chains both justifications:** *"the router chose it from 5 candidates (retrieval: the message
  scores 0.50 against this Resource's metadata)"*. The audit trail records why the application proposed it **and**
  why the model preferred it, so neither explanation is lost.

**Scenario 3 is the security check, and it is the most important line of output in this chapter.** The router
returned `user://456/profile` — a URI that was never in the shortlist. The result:

- `llm` is **absent** from `strategies`.
- `chosen` is **byte-identical to scenario 1** — the unmodified ranking.
- The `user://456/profile` selection does not appear anywhere.

The enforcement is one expression:

```ts
const promoted = picked === undefined ? undefined : chosen.find((selection) => selection.uri === picked);
```

`find` returns `undefined` for a URI not in the array, so the whole promotion is skipped. **A router cannot widen
its own authority**, because the only URIs it can name are the ones it was handed. And the threat model is real,
not hypothetical: the router is a *model*, reading a *user's message*, so it is an untrusted input source that
could be steered by a prompt injection.

That is why the type is not the guarantee. `ResourceRouter`'s signature already discourages returning a foreign
URI (`shortlist: readonly Selection[]` gives it nothing else to enumerate), and a dishonest implementation can
ignore the signature entirely. The `find` is what holds.

### 4. The ACL, and `refused` versus `unbindable`

The same attachment, judged by two sessions:

```text
--- ACL: the same query as a non-owner, with an attachment ---
strategies=[user, state] candidates=1
      chosen: task://projects/fde <- state (0.8)
      refused: ["user://456/profile"]
      as admin: strategies=[user, state] candidates=2
      chosen: user://456/profile <- user (1); task://projects/fde <- state (0.8)
```

Four things to read out of it:

**`refused: ["user://456/profile"]`** — the attachment was proposed by strategy 1 (the user did attach it) and then
removed by `admitted`, and it is **named** rather than silently dropped. An operator can see that the user asked
for something and was denied, which is the difference between a policy working and a policy hiding.

**`candidates=1` versus `candidates=2`** — the ACL ran **before** ranking, so the denied Resource was never in the
candidate pool. It contributed nothing to the count, nothing to the ordering, and — critically — it was never
shown to any router. *Ranking leaks*, and this is what prevents it.

**`user://456/profile <- user (1)` as admin** — the `isAdmin` exception, admitted and scored the maximum because
the user still chose it explicitly. Note that the *admin* case also runs strategy 1 first: being an admin does not
change the ranking, only the filter.

**`unbindable` is empty in both cases**, which is the contrast worth noting. Nothing here failed to bind — the
refusal was a decision, not an incomplete address. The two lists answer different questions:

| List | Contains | Caused by | Fix belongs to |
| :--- | :--- | :--- | :--- |
| `refused` | The bound **URI** | The ACL | A policy or session decision |
| `unbindable` | The descriptor **name** | A missing template variable | The selector or the message |

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Why does each of the five strategies exist, in one line each?**
   `user` — only the user knows what they meant. `state` — only the application knows the session scope and the
   document on screen. `retrieval` — only scoring handles a phrasing nobody enumerated. `llm` — only a model can
   break a genuine tie. `rule` — only a pattern can bind a variable (a task id) that appears in the message.

2. **Why must the ACL run before ranking?**
   Because **ranking leaks**. A model asked to choose between Resources it may not see has been told they exist —
   an information leak with no trace in the output. Filtering first means a router cannot leak what it was never
   shown.

3. **Why does binding run before filtering?**
   Because the ACL needs the *variables* to decide who a URI belongs to, and a template has no owner. Only
   `user://123/profile` has one. Filtering an unbound template would mean guessing.

4. **What is the `score` field — a probability or a rank?**
   A **rank**. The strategies use deliberately incomparable scales (a user's choice is `1`, a session fact `0.8`, a
   keyword score computed). Combining them statistically would be a category error; the only meaningful operation
   is comparison within the same URI, which provides a total order for the budget to drop the weakest.

5. **How is a router prevented from widening its own authority?**
   It receives only the shortlist (`shortlist: readonly Selection[]`), returns only a URI, and the pipeline runs
   `chosen.find(...)` on the result — so a URI it was never shown is discarded and the promotion is skipped. The
   type discourages it; the `find` enforces it.

6. **What does a strategy-4 promotion change, and what does it not?**
   It changes *order*, not *membership* — the promoted Resource moves to the front and the rest keep their
   positions. So a router mistake cannot remove context, only reorder it. And the reason chains both
   justifications, so the original evidence is not lost.

7. **Why is the cap applied after ranking?**
   So the budget removes the *weakest evidence* rather than whichever Resources were proposed last. Capping first
   would drop retrieval's contributions — the broadest recall and the least specific evidence — arbitrarily.

8. **What is the difference between `refused` and `unbindable`?**
   `refused` is a policy decision (the ACL said no) and records the bound URI. `unbindable` is an incomplete
   address (a template variable had no value) and records the descriptor name. Collapsing them would make a
   permissions problem indistinguishable from a selection bug.

9. **Why does `scoreDescriptor` weight keywords twice as heavily as description tokens?**
   Because they are differently reliable: a declared keyword is a deliberate statement by the resource's author,
   while a description-token match is what lets an unanticipated phrasing find something. Only the first is
   brittle; only the second is noisy.

10. **Why does `tokenize` impose a three-character floor?**
    Because below it, `a`, `of` and `to` match everything — inflating every score and making the rank meaningless.
    A length filter replaces a language-specific stop-word list and is never incomplete.

---

**[← Chapter 11: The Prompt Service](./11_Service_Prompt_Service.md)** · **[Chapter 13: The MCP Wiring Contract →](./13_Mcp_Wiring_Contract.md)**
