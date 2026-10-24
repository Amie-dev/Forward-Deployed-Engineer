# Chapter 20 — Host: Policy — Tools, Resources, Prompts

> **The host's security layer.** Lecture 14's governing sentence was *"discovering a tool does not mean the model
> should automatically be allowed to execute everything."* Lecture 15 adds two more surfaces with the same shape of
> problem, and this file answers all three in one place.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/host/policy.ts` (262 lines) |
| **Layer** | `host` |
| **Purpose** | Classify tools into three tiers, hold a session-scoped ACL over the resource catalogue, and gate the prompt menu. |
| **Exports** | `DiscoveredTool`, `TrustTier`, `PolicyDecision`, `ToolReview`, `ConsentRequest`, `ConsentHandler`, `Session`, `ResourceDecision`, `HostPolicy`, `createHostPolicy()` |
| **Lecture sections** | Ch04 §"Authorisation and validation live in the handler", Ch05 §"Filter *before* ranking", Ch06 §"Keep the count small", Ch03 §3.5 |
| **Runs** | `npm run lifecycle` steps 2 and 7 · `GET /read?uri=user://456/profile` |

---

## Commands

```bash
# the tool decision table
npm run lifecycle 2>/dev/null | sed -n '/^2\./,/^3\./p'

# the same URI, three sessions
npm run lifecycle 2>/dev/null | sed -n '/^7\./,/^8\./p'

# the ACL through HTTP
curl -s 'http://127.0.0.1:8080/read?uri=user://456/profile'                      # 403
curl -s -H 'x-actor: 456' 'http://127.0.0.1:8080/read?uri=user://456/profile'    # 200
curl -s -H 'x-admin: true' 'http://127.0.0.1:8080/read?uri=user://456/profile'   # 200
```

---

## Three surfaces, three problems, one file

The header lists them, and the third line is the one to keep in mind:

| Surface | The problem | The answer |
| :--- | :--- | :--- |
| **Tools** | Discovery is an inventory, not a grant | `auto` / `confirm` / **never shown** |
| **Resources** | The application may read, but *"the application is code, and code has bugs"* | A session-scoped ACL over the catalogue |
| **Prompts** | The user chooses, but not every deployment wants every workflow | An allowlist |

> The third tool branch is still the strongest control in the whole architecture and still the cheapest: **an absent
> tool cannot be called by a model that was never told it existed.** No prompt injection reaches a capability the host
> never listed.

That sentence is the reason `visible()` exists as a separate method from `classify()`. Classifying a tool as `denied`
and then passing the full list to the model would be a policy that logs a decision it does not enforce. Removing the
tool from the list is what makes the decision real — and it is *cheap*, because it costs nothing at call time.

### Why the resource ACL lives here and not on the server

This is the chapter's most important architectural argument, and the header makes it in full:

> The server validates **shape** — is this a well-formed URI, is the scheme allowed, is the `{taskId}` a positive
> integer — and it must, because it cannot trust its callers. But it cannot enforce **ownership**, because it has no
> session: **an MCP server is a capability provider, not an identity provider.**
>
> The host has the session. So ownership is checked here, on the concrete URI, before the read is ever issued. That
> split is the honest one, and it is why `mayRead` takes a `Session` while the server's `readThrough` does not.

Read that as a division of labour, and it explains a signature difference that would otherwise look arbitrary:

| Check | Where | Why there |
| :--- | :--- | :--- |
| Is the scheme allow-listed? | **Both** | The server must not serve it; the host must not request it |
| Is the URI well-formed? | **Server** | Shape validation, and the server cannot trust its callers |
| Is `{taskId}` a positive integer? | **Server** | Shape validation |
| **May *this session* read this address?** | **Host** | Only the host has a session |

An MCP server serves *one* connection and has no idea who is behind it — the protocol has no session concept the server
can rely on for identity. So an ACL on the server side would have to trust the client's claim about who it is, which is
not an ACL at all. **The host is where identity exists, so the host is where ownership is enforced.**

---

## `src/host/policy.ts` — the full file

```ts
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
```

### Block-by-block

**Block 1 — `DiscoveredTool` and the tier types (lines 37–60).**

```ts
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
```

**`DiscoveredTool` re-declares the annotation shape rather than importing the SDK's type** — and that is deliberate, for
the same reason `core/errors.ts` writes its own JSON-RPC codes (Chapter 05): this module should not depend on a
transport. It describes the *subset* of a tool the policy cares about, and every annotation is optional because a
server may omit them entirely.

That optionality is load-bearing. `tool.annotations?.destructiveHint === true` in `classify` below is an explicit
`=== true` comparison rather than a truthiness check, because **`undefined` must mean "no claim was made" rather than
"safe"**. A server that omitted annotations gets the conservative treatment — see the branches.

**`TrustTier` is three values, and the middle one is the interesting one.** `auto` and `denied` are opposites; `confirm`
is the case where the operation is legitimate *and* dangerous, so the answer is "ask a human". That third tier is what
makes the policy usable: a binary allow/deny would force every destructive tool into one bucket, and the honest answer
for `delete_task` is neither.

**`PolicyDecision` carries a `reason` string.** Same choice as `Selection.reason` (Chapter 12): a sentence rather than a
code, because it is printed in the decision table and written to the audit log, and both audiences are human.

**Block 2 — the consent seam (lines 62–71).**

```ts
export interface ConsentRequest {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * In a real host this renders a dialog and awaits a click. Injecting it keeps
 * the policy pure and testable, and keeps the demo's answers reproducible.
 */
export type ConsentHandler = (request: ConsentRequest) => Promise<boolean>;
```

**A function type, injected rather than implemented.** The comment gives both reasons: it keeps the policy **pure**
(no UI, no I/O) and it keeps the demo's answers **reproducible**.

The reproducibility half is what makes a scripted walkthrough possible. `npm run lifecycle` passes a handler (Chapter 26)
that **declines the first request and approves the rest**, so that a single run *would* exercise both branches of the
gate with no human present — and a hard-coded `confirm()` would make the walkthrough interactive and therefore
untestable.

**One honest gap, verified rather than assumed:** the walkthrough never actually invokes the gate, because it never
calls a `confirm`-tier tool. `delete_task` is classified `confirm` (visible in step 2's table) but no step calls it, so
`requestConsent` is never reached and no `policy.consent` line appears in the log:

```bash
npm run lifecycle 2>/dev/null | grep -i consent
#    confirm  delete_task     destructiveHint is set: irreversible, so it needs explicit consent
#    (that is the policy *table* row, not a gate invocation)

npm run lifecycle 2>&1 >/dev/null | grep -c '"event":"policy.consent"'
#    0
```

So the seam is wired and the scripted handler is correct, but the *demonstration* of the consent gate is missing from the
walkthrough. Wiring a scripted gate and then never triggering it is exactly the kind of thing that looks complete in a
code review and is empty in a run — which is why it is recorded here rather than left as an implied claim.

And the purity half matters for the real deployment: the HTTP host passes a handler that **denies by default** and logs
`consent.not_implemented` (Chapter 25), because that surface never invokes tools. So the same policy works for a
scripted CLI, a browser host, and a host that does not call tools at all — and the difference is one injected function.

Note the request carries the **arguments** (`args: Record<string, unknown>`), not just the tool name. That is what lets a
real dialog say *"Delete task #2 'Review pull request'?"* rather than *"Allow delete_task?"* — and a user cannot give
informed consent to the second.

**Block 3 — `Session`, and where identity comes from (lines 73–86).**

```ts
export interface Session {
  /** The user id this session acts as. */
  actor: string;
  /** Projects this session is scoped to. */
  projects: readonly string[];
  /** May this session read personal data belonging to someone else? */
  isAdmin: boolean;
}
```

*Who is asking.* And the doc comment above it is a one-line security rule:

> It comes from the session — **never from the model**, because a model-authored identity is a privilege escalation
> waiting to happen.

That is worth stating explicitly because the alternative is easy to build by accident. A tool schema with an
`owner` field (which `create_task` has, Chapter 14) means the model *supplies* an owner. If an ACL read that value as
identity, a model could claim to be anyone — and a prompt injection could make it claim to be an admin. So `Session` is
constructed by the host from its own transport-level knowledge, and `actor` is used by the ACL while the model-supplied
`owner` is only ever *data*.

`projects: readonly string[]` is `readonly` so the selection engine (Chapter 12) cannot reorder the session's scope.
And `isAdmin` is a single boolean rather than a role list — enough for this system, and the place a real one would grow.

**Block 4 — `ResourceDecision`, and the 403/404 distinction (lines 88–101).**

```ts
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
```

**The `code` field is the design**, and the comment is the argument: a policy decision returns a **failure class**
from the taxonomy (Chapter 05), so the caller answers with the right HTTP status rather than one it invented.

*"A client cannot tell a typo from a permissions problem"* is the concrete harm. Both are refusals, both feel the same
to a server, and they need completely different responses from the user:

| Situation | Status | What the user should do |
| :--- | :--- | :--- |
| `task://nope` — a typo | **404** | Fix the address |
| `user://456/profile` — someone else's data | **403** | Stop trying; this is not a mistake |

Collapsing them into one status means a user with a typo is told they lack permission (and goes looking for an admin),
while a user probing for data is told their address is wrong (and keeps trying variants). **The status is part of the
security response, not just a description of it.**

One honest wart: on an *allowed* decision the `code` field still has to be filled, and the implementation uses
`"INVALID_INPUT"` — which is meaningless in that position. The field is required rather than optional, so the allowed
path carries a filler. It is harmless (nothing reads `code` when `allowed` is true) and it is the kind of thing a
stricter design would model as a discriminated union:

```ts
// what a stricter version would look like
type ResourceDecision =
  | { allowed: true; reason: string }
  | { allowed: false; code: FailureCode; reason: string };
```

Noted rather than changed, because the union would complicate every consumer for a field that is already inert.

**Block 5 — the `HostPolicy` interface (lines 103–124).**

```ts
export interface HostPolicy {
  classify(tool: DiscoveredTool): PolicyDecision;
  review(tools: readonly DiscoveredTool[]): ToolReview[];
  visible(tools: readonly DiscoveredTool[]): DiscoveredTool[];
  requestConsent(request: ConsentRequest): Promise<boolean>;
  mayRead(uri: string, session: Session): ResourceDecision;
  mayUsePrompt(name: string, session: Session): ResourceDecision;
}
```

Six methods, and the shape of the interface is the chapter's structure:

| Group | Methods | Answers |
| :--- | :--- | :--- |
| Tools | `classify`, `review`, `visible`, `requestConsent` | What may the model see, and what needs asking? |
| Resources | `mayRead(uri, session)` | May *this session* read *this address*? |
| Prompts | `mayUsePrompt(name, session)` | Is this workflow offered? |

The two ACL methods take a `Session` and the tool methods do not — which is the correct asymmetry, and it is the same
split as the header's argument. Tool policy is about the *catalogue* (what exists and how dangerous it is), which is
session-independent. Resource and prompt policy is about *this caller*, which requires a session.

**`mayRead` takes a resolved URI, and the comment explains why that matters:**

> Takes a resolved URI, not a template: ownership is a property of an address, and `user://{userId}/profile` has no
owner until the variable is bound.

That is the same ordering argument as Chapter 12's bind-then-filter, at the policy layer. A template cannot be
authorised because it does not name anyone; `user://456/profile` can, because `456` is right there in the string. So the
ACL is applied to concrete addresses, and the selection engine's job (Chapter 12) is to produce them.

**Block 6 — `createHostPolicy` and the options (lines 126–139).**

```ts
export function createHostPolicy(options: {
  allowDestructive: boolean;
  requireConsent: boolean;
  allowedSchemes: ReadonlySet<string>;
  catalogue: ResourceCatalogue;
  allowedPrompts: readonly string[];
  requestConsent: ConsentHandler;
  logger: Logger;
}): HostPolicy {
```

Seven options, and each maps to one of the three surfaces plus two cross-cutting concerns:

| Option | Surface | Its config knob |
| :--- | :--- | :--- |
| `allowDestructive` | Tools | `MCP_HOST_ALLOW_DESTRUCTIVE` |
| `requireConsent` | Tools | `MCP_HOST_REQUIRE_CONSENT` |
| `allowedSchemes` | Resources | `MCP_ALLOWED_RESOURCE_SCHEMES` |
| `catalogue` | Resources | *(the descriptor table)* |
| `allowedPrompts` | Prompts | `MCP_HOST_ALLOWED_PROMPTS` |
| `requestConsent` | Tools | *(injected function)* |
| `logger` | — | for policy events |

Note `catalogue` is injected here for the same reason it is in `ServerDeps` (Chapter 13): **so ownership can be checked
without a round trip.** The host holds its own copy of the descriptor table, which is *shared source* rather than shared
state — the two processes agree on the shape of a Resource without either trusting the other's answer about ownership.

**Block 7 — `classify`, the three branches (lines 140–166).**

```ts
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
```

**Four branches, and the order is a precedence.** `denied` is checked before `confirm` before `auto`, so a deployment
with `allowDestructive: false` cannot be talked into `confirm` by also setting `requireConsent: true` — the strictest
applicable rule wins.

**`tool.annotations?.destructiveHint === true` — the `=== true` is not stylistic.** With a truthiness check,
`undefined` (no annotation) would be falsy and therefore treated as non-destructive, which is the wrong default: a
server that omitted annotations should not get the benefit of the doubt. `=== true` means only an *explicit* claim of
safety-adjacent metadata counts, and everything else falls to the final branch.

**The `reason` strings name the config knob**, not just the rule: *"…and MCP_HOST_ALLOW_DESTRUCTIVE is false"*. That is
what makes the lifecycle's step 2 table actionable — an operator reading `denied delete_task` is told exactly which
setting produced it.

**Branch 1 is the interesting one, and it exists for a real configuration.** With `allowDestructive: true` and
`requireConsent: false`, a destructive tool is auto-approved — and the reason says so plainly: *"destructive, but
consent is disabled by configuration"*. That is not a bug; it is a deployment that has decided its tools are safe to run
unattended, and the policy reports the decision rather than hiding it. **A policy that only has reasons for its refusals
is a policy whose permissions are invisible.**

**The final branch distinguishes read-only from merely non-destructive:**

```ts
reason: tool.annotations?.readOnlyHint === true ? "readOnlyHint is set" : "no destructive hint"
```

So `list_tasks` reports *"readOnlyHint is set"* while `create_task` reports *"no destructive hint"* — two different
justifications for the same tier, both visible in the table. That is what the lifecycle's step 2 shows, and it is why a
reader can tell at a glance *why* each tool was auto-approved.

**Block 8 — `review`, `visible` and `requestConsent` (lines 168–201).**

```ts
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
```

**`review` and `visible` both call `classify`** — so the table the operator reads and the list the model receives cannot
disagree. That is the single-source-of-truth discipline again, and it matters more here than usual: a policy that
*reports* a tool as `denied` while *passing* it to the model would be worse than no policy, because the log would be
reassuring and wrong.

**`visible` logs the hiding, and the comment explains the log level:**

> Logged as a *policy* event, not an error: hiding a tool is a deliberate decision, and an operator needs to be able to
> see it.

So it is `warn` with an event name `policy.tool_hidden` — not an error, and not silent. The distinction is operational:
an operator asking *"why can the model not delete tasks?"* finds the answer in the log stream at the moment the tool was
filtered out, with the reason naming the config knob.

**`requestConsent` wraps the injected handler and logs the outcome.** Both branches are logged — `approved: true` and
`approved: false` — because a **refusal is as important to record as an approval**. A user declining a deletion is an
event the audit trail must show, and it is the one a naive implementation would omit (logging only successful
operations).

Note it is `async` and awaited, so a real dialog can take as long as a human needs — and the policy does not block on
anything else meanwhile.

**Block 9 — `mayRead`, the ACL (lines 203–251).**

```ts
mayRead(uri, session) {
  const scheme = options.catalogue.schemeOf(uri);

  if (scheme === undefined || !options.allowedSchemes.has(scheme)) {
    return {
      allowed: false,
      code: "FORBIDDEN",
      reason: `scheme "${scheme ?? "?"}" is not in the host allow-list`,
    };
  }

  const resolved = options.catalogue.resolve(uri);

  if (resolved === undefined) {
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

  if (session.isAdmin) {
    return { allowed: true, code: "INVALID_INPUT", reason: `session is an admin, so "${descriptor.name}" is readable` };
  }

  if (variables.userId !== undefined && variables.userId === session.actor) {
    return { allowed: true, code: "INVALID_INPUT", reason: `"${descriptor.name}" belongs to the session's own user` };
  }

  return {
    allowed: false,
    code: "FORBIDDEN",
    reason: `"${descriptor.name}" belongs to another user and the session is not an admin`,
  };
}
```

**Six checks in a fixed order, and the order is the design.** Each one is cheap, and each one produces a *different*
answer — which is what makes the refusal diagnosable.

| # | Check | On failure | Why here |
| :---: | :--- | :--- | :--- |
| 1 | Scheme allow-listed? | **403** `scheme "file" is not in the host allow-list` | Cheapest, and a scheme is not a resource — the address may be well-formed while the *scheme* is not served |
| 2 | Does the catalogue resolve it? | **404** `the URI does not match any advertised Resource` | A typo, not a permissions problem |
| 3 | Is it public? | allowed | The common case, and the fastest exit |
| 4 | Is the session an admin? | allowed | An explicit, declared exception |
| 5 | Is the variable the actor's own? | allowed | The ownership check |
| 6 | Otherwise | **403** `belongs to another user and the session is not an admin` | The refusal, with the reason |

The **order of 1 and 2 is deliberate**, and the comment on check 1 states the distinction: *the address may be
well-formed, but this deployment does not serve its scheme at all — a **permissions** answer, not a not-found one.* So
`file:///etc/passwd` is a 403 (this deployment does not serve that scheme) while `task://nope` is a 404 (that scheme is
served, and nothing matches). Both are refusals; the codes tell the caller different things.

**Check 5 is where "ownership is a property of an address" becomes code:**

```ts
if (variables.userId !== undefined && variables.userId === session.actor) {
```

The `variables` came from `catalogue.resolve` (Chapter 08), which extracted and **decoded** them. So the comparison is
between two normalised strings — `session.actor` from the host's transport layer, `variables.userId` from the URI. And
`!== undefined` guards the case where a future `owner`-audience descriptor has no `{userId}` variable at all; without it,
`undefined === undefined` would be true and the check would *pass* for the wrong reason. A small guard against a
fail-open bug.

**The admin branch is 4, before 5** — so an admin reading their *own* profile gets the admin reason rather than the
ownership one. Both are `allowed`, so the ordering only affects which sentence appears in the lifecycle's step 7 table.
It is checked first because it is the broader permission: a session that can read anything does not need its ownership
checked.

And note the refusal names **both** facts: *"belongs to another user **and** the session is not an admin"*. That phrasing
tells a caller that there are two ways this could have been allowed, which is more useful than "access denied".

**Block 10 — `mayUsePrompt` (lines 253–261).**

```ts
mayUsePrompt(name, session) {
  if (options.allowedPrompts.length === 0 || options.allowedPrompts.includes(name)) {
    return { allowed: true, code: "INVALID_INPUT", reason: "the prompt is offered by this deployment" };
  }

  return {
    allowed: false,
    code: "FORBIDDEN",
    reason: `prompt "${name}" is not enabled for this deployment (actor ${session.actor})`,
  };
}
```

**The empty-list convention, and it is the right one:** `allowedPrompts.length === 0` means **every registered prompt is
offered**. That is why `.env` ships `MCP_HOST_ALLOWED_PROMPTS=` empty (Chapter 01) — the allowlist is opt-in, and an
unconfigured deployment offers everything.

The alternative convention (empty means "nothing allowed") would be a secure-by-default choice, and it would make the
default deployment useless: every prompt would be refused until someone listed them. Given that prompts are
*read-only templates* that change no state (Chapter 16), offering them by default is the correct trade — and the
allowlist exists for a deployment that wants to narrow the menu.

Note the refusal names the **actor**, which is unusual for a message about a deployment-wide setting. It is there
because the same request from a different session might be allowed (once the allowlist is configured per-session),
and because an audit record of a prompt refusal should say who was refused.

---

## Run / verify

### 1. The tool decision table

```bash
npm run lifecycle 2>/dev/null | sed -n '/^2\./,/^3\./p'
```

```text
2. tools/list  -> 4 discovered, 4 shown to the model
   auto     create_task     no destructive hint
   auto     list_tasks      readOnlyHint is set
   auto     complete_task   no destructive hint
   confirm  delete_task     destructiveHint is set: irreversible, so it needs explicit consent
```

Four tools, four decisions, and the `reason` column names which annotation produced each — `readOnlyHint is set` for the
one tool that is genuinely read-only, `no destructive hint` for the two that are merely not destructive, and the
`destructiveHint` sentence for `delete_task`.

**The two `auto` reasons are different, and that is `classify`'s final branch working:**

| Tool | Tier | Reason | Which branch |
| :--- | :--- | :--- | :--- |
| `create_task` | `auto` | *no destructive hint* | Final branch, `readOnlyHint` not set |
| `list_tasks` | `auto` | *readOnlyHint is set* | Final branch, `readOnlyHint === true` |
| `complete_task` | `auto` | *no destructive hint* | Final branch |
| `delete_task` | **`confirm`** | *destructiveHint is set: irreversible…* | **Branch 2** |

A table that said `auto` four times without reasons would be unreadable; this one tells you *why* each tool is trusted.

### 2. `denied` — the strongest control, and it is cheap

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run lifecycle 2>/dev/null | sed -n '/^2\./,/^3\./p'
```

```text
2. tools/list  -> 4 discovered, 3 shown to the model
   auto     create_task     no destructive hint
   auto     list_tasks      readOnlyHint is set
   auto     complete_task   no destructive hint
   denied   delete_task     destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false
```

**`4 discovered, 3 shown`** — and the fourth line's `denied` is the branch that makes this a control rather than a
label. The tool was registered by the server, discovered by the client, classified, and then **removed from the list the
model sees**.

That is the header's argument made observable: *an absent tool cannot be called by a model that was never told it
existed.* No prompt injection reaches `delete_task` here, because there is nothing to inject — the capability is not in
the model's context at all.

And it is logged as a **policy event**, not an error:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run lifecycle 2>&1 >/dev/null | grep policy.tool_hidden
```

```json
{"event":"policy.tool_hidden","host":"lifecycle","tool":"delete_task","reason":"destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false"}
```

One line, naming the tool **and the config knob**. An operator asking *"why can the model not delete tasks?"* finds the
answer at the moment the tool was filtered, with the setting that produced it — which is what `classify`'s reason strings
naming their own config knobs was for.

### 3. The ACL: the same URI, three sessions

```bash
npm run lifecycle 2>/dev/null | sed -n '/^7\./,/^8\./p'
```

```text
7. the ACL     -> the same URI, judged by three different sessions
   actor 123   admin=false -> REFUSED  "user-profile" belongs to another user and the session is not an admin
   actor 456   admin=false -> ALLOWED  "user-profile" belongs to the session's own user
   actor 123   admin=true  -> ALLOWED  session is an admin, so "user-profile" is readable
```

**One URI, three sessions, two different answers** — and every row is a different branch of `mayRead`:

| Session | Result | Which check |
| :--- | :--- | :--- |
| `actor 123`, not admin | **REFUSED** | Check 6 — the final refusal |
| `actor 456`, not admin | ALLOWED | Check 5 — `variables.userId === session.actor` |
| `actor 123`, admin | ALLOWED | Check 4 — `session.isAdmin` |

Note rows 2 and 3 reach their answer through *different checks*, which is why the reasons differ. And note row 1's
reason names **both** facts: *"belongs to another user **and** the session is not an admin"* — telling a caller there
were two ways this could have been allowed.

Crucially, all three judged the **same string** — `user://456/profile` — and the only thing that varied was the session.
That is what makes this an ACL rather than a URI check.

### 4. The same ACL, through HTTP

```bash
curl -s 'http://127.0.0.1:8080/read?uri=user://456/profile'                      # 403
curl -s -H 'x-actor: 456' 'http://127.0.0.1:8080/read?uri=user://456/profile'    # 200
curl -s -H 'x-admin: true' 'http://127.0.0.1:8080/read?uri=user://456/profile'   # 200
```

```text
403
200
200
```

The session comes from headers in this deployment — `x-actor` and `x-admin` — which is a stated substitution rather
than a real authentication scheme (the main README says so). What matters is that the *shape* of the check is right: the
identity arrives from the transport, is turned into a `Session`, and the ACL reads it. Replacing the header with an
authenticated session is a change to the controller, not to `policy.ts`.

And the refusal is a **403 with the host's reason**:

```json
{"error":{"code":"FORBIDDEN","message":"Refused to read user://456/profile — \"user-profile\" belongs to another user and the session is not an admin.","recovery":"Read a Resource the session is entitled to, or ask an administrator for access.","retryable":false,"requestId":"c18ee97b"}}
```

Compare that with `task://nope`, which is a **404** from check 2 — *"the URI does not match any advertised Resource"*.
Two refusals, two statuses, and the difference is exactly the one `ResourceDecision.code` exists to preserve: a typo and
a permissions problem need different responses from the user.

### 5. The prompt allowlist

With `MCP_HOST_ALLOWED_PROMPTS=` empty (the default), every prompt is offered:

```bash
curl -s http://127.0.0.1:8080/prompts | grep -o '"offered":[a-z]*' | sort | uniq -c
```

```text
      3 "offered":true
```

Narrow it and the verdict flips:

```bash
MCP_HOST_ALLOWED_PROMPTS=plan_day npx tsx src/routes/index.ts &
sleep 5
curl -s http://127.0.0.1:8080/prompts \
  | python3 -c 'import json,sys; [print(p["name"], "offered=" + str(p["offered"])) for p in json.load(sys.stdin)["prompts"]]'
```

```text
plan_day offered=true
review_workload offered=false
weekly_plan offered=false
```

**One prompt offered, two not** — and note what is *not* happening: the refused prompts are still **advertised**. The
`offered` field is the host's verdict reported next to the server's menu, so a client can render the full workflow list
and mark two of them unavailable, rather than being told they do not exist. That is the difference between a policy and
a lie about the catalogue.

The `offered` field is the host's verdict reported *next to* the server's menu — so an operator can see the policy
applied without correlating two endpoints. And `MCP_HOST_ALLOWED_PROMPTS=` empty meaning *all* is the convention
`mayUsePrompt` implements with `options.allowedPrompts.length === 0`.

### 6. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Why does the resource ACL live in the host and not on the server?**
   Because **an MCP server is a capability provider, not an identity provider** — it has no session, so it cannot enforce
   ownership. The server validates *shape*; the host enforces *ownership*, on the concrete URI, before the read is issued.
   That is why `mayRead` takes a `Session` and the server's `readThrough` does not.

2. **What are the three tool tiers, and why is the third one the strongest control?**
   `auto`, `confirm`, `denied`. `denied` removes the tool from the list the model sees — and *an absent tool cannot be
   called by a model that was never told it existed*, so no prompt injection can reach it.

3. **Why is `classify`'s destructive check written `=== true` rather than truthy?**
   Because `undefined` (no annotation) must mean "no claim was made" rather than "safe". A truthiness check would give a
   server that omitted annotations the benefit of the doubt.

4. **Why does `mayRead` return a `FailureCode` rather than a boolean?**
   So the caller answers with the right status. *"This address does not exist"* (404) and *"you may not read this
   address"* (403) tell a caller two entirely different things — collapsing them means a client cannot tell a typo from a
   permissions problem.

5. **Why is the scheme check first, and why is it a 403 rather than a 404?**
   Because a scheme is not a resource: the address may be well-formed while the *deployment* does not serve that scheme at
   all. That is a permissions answer, not a not-found one — which is why `file:///etc/passwd` is 403 and `task://nope` is
   404.

6. **Why does the ownership check guard `variables.userId !== undefined`?**
   Because without it, `undefined === undefined` would be true and the check would **pass for the wrong reason** — a
   fail-open bug. It guards the case where a future `owner`-audience descriptor has no `{userId}` variable.

7. **Why does an empty `MCP_HOST_ALLOWED_PROMPTS` mean "all" rather than "none"?**
   Because prompts are read-only templates that change no state, so offering them by default is the right trade — and
   "none" would make an unconfigured deployment useless. The allowlist is opt-in, for a deployment that wants to narrow
   the menu.

8. **What is verified about the consent gate, and what is not?**
   The seam is wired and the scripted handler is correct, but the walkthrough **never invokes it** — no step calls a
   `confirm`-tier tool, so no `policy.consent` line appears. That gap is documented rather than implied.

9. **Why is a *declined* consent logged as well as an approved one?**
   Because a user refusing a deletion is an event the audit trail must show — and it is the one a naive implementation
   omits by logging only successful operations.

---

**[← Chapter 19: The Host Client](./19_Host_Client.md)** · **[Chapter 21: Context Assembly →](./21_Host_Context_Assembly.md)**
