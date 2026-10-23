# Chapter 15: Host — Policy, Consent & Filtering

> **Chapter goal:** Turn a discovered tool catalogue into a *decision* — auto-approve, ask the
> user, or never show it — and put that decision in the host, where the authority lives.

---

## 15.1 File details

| | |
| :--- | :--- |
| **Path** | `src/host/policy.ts` |
| **Layer** | host (imports only `type Logger` from `core/`) |
| **Purpose** | Classify discovered tools into trust tiers from their annotations and the host's configuration, filter what the model may see, and run the consent gate |
| **Imports** | `type Logger` from `../core/logger.js` |
| **Exports** | `interface DiscoveredTool`, `type TrustTier`, `interface PolicyDecision`, `interface ToolReview`, `interface ConsentRequest`, `type ConsentHandler`, `interface HostPolicy`, `createHostPolicy()` |
| **Consumed by** | `src/host/client.ts` |
| **Lecture sections** | [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §8.1 (the host's security layer), §"Threat model" |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the decision table
npm run host | sed -n '11,15p'

# the other branch: destructive tools never shown at all
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host | sed -n '11,15p'
```

---

## 15.2 Full file

```ts
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
```

## 15.3 Block-by-block explanation

### Block 1 — the lecture sentence, and the three branches

The header comment opens with the one sentence the whole file implements:

> *"Discovering a tool does not mean the model should automatically be allowed to execute
> everything."*

Then it names the structure that sentence implies:

> Discovery is an **inventory, not a grant**, so the host turns a discovered catalogue into three
> sets:
>
> ```text
> auto-approve   read-only, low risk       → the model may call it directly
> ask the user   needs approval            → a consent gate runs first
> never shown    not permitted by policy   → the model is never told it exists
> ```

That is the lecture's own diagram, in three lines. The three branches are exhaustive and mutually
exclusive, and each one is a different *kind* of control:

| Branch | Mechanism | What it protects against |
| :--- | :--- | :--- |
| **auto-approve** | the host does nothing | nothing — this is the fast path for safe tools |
| **ask the user** | an out-of-band decision | a mistaken model choice, and a user who did not intend the action |
| **never shown** | the tool is not in `tools/list` | everything — including prompt injection |

**Why the third branch is the strongest control.** The comment says it precisely:

> The third branch is the strongest control in the whole architecture and the cheapest one: an
> absent tool cannot be called by a model that was never told it existed. No prompt injection
> reaches a capability the host never listed.

Compare the three defences against a prompt injection that says *"delete all tasks"*:

1. **Auto-approving `delete_task`** — the injection works. The model calls it and the host executes
   it.
2. **Requiring consent** — the injection reaches a dialog. A distracted user clicks Allow and the
   injection works. The defence depends on human attention.
3. **Never showing `delete_task`** — the model has no tool named `delete_task`. It cannot call what
   it does not know exists, no matter what the prompt says. The defence depends on nothing.

That is why the third branch is described as *cheapest*: it costs one filter over an array, and it
removes the attack rather than gating it.

**"No prompt injection reaches a capability the host never listed"** is the sentence to remember.
It is the architectural version of Chapter 05's "an absent tool cannot be called".

### Block 2 — `DiscoveredTool`: the structural minimum

```ts
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
```

**What it does:** declares the smallest shape the policy needs from a discovered tool.
**How it works:** a structural type — four optional fields, two of which the policy never reads.

**This is deliberately *not* the SDK's `Tool` type.** Three reasons, and they matter:

1. **It documents what the policy actually uses.** A reader can see at a glance that the policy
   reads `name` and `annotations.destructiveHint`, and never touches `inputSchema`,
   `outputSchema`, `title` or `_meta`. That is a reviewable claim.
2. **It keeps the policy testable with a literal.** A test can write
   `classify({ name: "delete_task", annotations: { destructiveHint: true } })` — no SDK, no server,
   no transport. Chapter 08's testing claim ("three of the four layers need no model") extended to
   the host.
3. **Structural typing makes it free.** TypeScript's assignability is structural, so an SDK `Tool`
   satisfies `DiscoveredTool` without a cast, an adapter or a `Pick<>`. The SDK's `Tool` has *more*
   fields, and extra fields are always acceptable when assigning to a variable.

**`description` is declared but never read.** That is a small inconsistency worth naming: it is
there because a `ToolReview` row could reasonably include it for a UI, and because the interface
mirrors the SDK's shape closely enough to be recognisable. If a linter flagged unused fields it
would be a candidate for removal.

**The four annotation hints are all optional, and `boolean | undefined` is the honest type.**
`destructiveHint` may be absent (the server chose not to say), `false` (the server says it is safe)
or `true` (the server says it is dangerous). **Absent is not the same as `false`**, which is why
`classify` compares with `=== true` rather than using a truthiness check — see Block 4.

### Block 3 — the types: `TrustTier`, `PolicyDecision`, `ToolReview`, `ConsentHandler`

```ts
export type TrustTier = "auto" | "confirm" | "denied";

export interface PolicyDecision {
  tier: TrustTier;
  reason: string;
}

export interface ToolReview {
  name: string;
  tier: TrustTier;
  reason: string;
}

export interface ConsentRequest {
  tool: string;
  args: Record<string, unknown>;
}

export type ConsentHandler = (request: ConsentRequest) => Promise<boolean>;
```

**What they do:** name the vocabulary of the decision, and the boundary where the user is asked.
**How it works:** four small types, each earning its place.

**`TrustTier` is a three-value string union, not an enum.** It compiles to nothing, serialises as
`"confirm"` in a log line, and — the important part — an `if`/`switch` over it is
*exhaustiveness-checked* by TypeScript. Adding a fourth tier would produce a compile error at every
place that handles tiers, which is exactly the safety you want for a security decision.

**`PolicyDecision` pairs the tier with a `reason`.** The reason is not decoration: it is what makes
the decision *auditable* and *explainable*. Compare the two possible outputs for `delete_task`:

```text
{ tier: "confirm" }
{ tier: "confirm", reason: "destructiveHint is set: irreversible, so it needs explicit consent" }
```

The first tells a reviewer what happened. The second tells them *why* — and the reason ends up in the
log line, the printed decision table, and the audit trail. **A security decision without a stated
reason is a decision nobody can review.**

**`ToolReview` is `PolicyDecision` plus a name.** It exists so the whole decision table can be
produced in one call (`review(tools)`) and printed as a table. Without it, a caller would have to zip
names and decisions together, and the two could drift out of order.

The overlap between `PolicyDecision` and `ToolReview` is resolved by `review`'s implementation, which
spreads rather than copies:

```ts
return tools.map((tool) => ({ name: tool.name, ...classify(tool) }));
```

One source of truth for the decision; the review row adds a label. If `PolicyDecision` gained a
field, `ToolReview` would need it too — and TypeScript would point at the spread if the shapes
diverged.

**`ConsentRequest` carries the tool name *and the arguments*.** Deliberate, and important: a consent
dialog that says "allow `delete_task`?" is not enough information to answer. The user needs to know
*which task*. `args: Record<string, unknown>` gives the dialog the raw arguments, which is what a
real host renders as "Delete task #2 — Publish the notes?".

**`ConsentHandler` is a *function type*, injected rather than implemented.** The comment explains
both halves:

> In a real host this renders a dialog and awaits a click. Injecting it keeps the policy pure and
> testable, and keeps the demo's answers reproducible.

The same dependency-injection discipline as `ServerDeps` (Chapter 09), applied to the one thing in
the host that is genuinely interactive. Three consequences:

| | If the policy rendered its own dialog | If the handler is injected |
| :--- | :--- | :--- |
| **Testability** | needs a UI, or a mock of one | pass `async () => true` |
| **Purity** | `classify` and `requestConsent` would be one untestable unit | `classify` stays pure; only consent does I/O |
| **Determinism** | a human answers differently each run | the demo's answers are scripted |

The `Promise<boolean>` return type is the honest one: a dialog is asynchronous, and the policy has to
wait. A synchronous `boolean` would force every real implementation to lie about that.

### Block 4 — `classify`: the decision, in four branches

```ts
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
```

**What it does:** maps one tool to one tier plus a reason. Pure — no I/O, no state, no logger.
**How it works:** four returns, ordered by severity, with an early exit at each.

**`tool.annotations?.destructiveHint === true` — the comparison is `=== true`, not truthiness.**
This is the most important line in the file, and the reasoning is worth stating fully.

The expression has three possible values: `true`, `false`, or `undefined` (the annotation is absent).
A truthiness check (`if (destructive)`) would collapse `undefined` and `false` into "not destructive"
— which happens to be right *here*, but only by accident. The explicit `=== true` states the policy:
**only a positive, explicit declaration of destructiveness is treated as destructive.**

Now the security consequence. A server that omits `destructiveHint` is *not* saying "this tool is
safe" — it is saying nothing. This policy's default for a tool that says nothing is `auto` (the final
return), which is the permissive choice. **That is a real limitation, and it is stated rather than
hidden:** annotations are hints from an untrusted party, and this policy trusts a `true` signal while
treating the absence of a signal as non-destructive. A stricter host would invert it — `denied` unless
`readOnlyHint === true` — and Chapter 08's threat model is explicit that a server can mislabel its own
tools. The README's "Honest limits" section carries the same caveat.

**The branch order encodes the precedence: deny > confirm > auto.** Reading top to bottom:

1. **If destructive and destructive tools are not allowed at all → `denied`.** Checked first because
   it is the strongest control: a tool that should not exist in the catalogue must not reach the
   `confirm` branch either. Hence the comment: *"Branch 3 — never shown. Policy beats discovery."*
2. **If destructive and consent is required → `confirm`.**
3. **If destructive and consent is disabled → `auto`.** The escape hatch: an operator who has
   deliberately turned consent off gets permissive behaviour, and the `reason` records that it was a
   *configuration* choice rather than a safety judgement.
4. **Otherwise → `auto`**, with a reason distinguishing two sub-cases: a read-only tool
   (`readOnlyHint === true`) versus a tool with no destructive hint.

**The four reasons are written for an operator, not for a log parser.** Each names the *flag* that
produced the decision, so a reader can trace it back:

| Reason | Traceable to |
| :--- | :--- |
| `destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false` | the annotation **and** the env var |
| `destructiveHint is set: irreversible, so it needs explicit consent` | the annotation and `MCP_HOST_REQUIRE_CONSENT` |
| `destructive, but consent is disabled by configuration` | the annotation and `MCP_HOST_REQUIRE_CONSENT=false` |
| `readOnlyHint is set` / `no destructive hint` | the annotation, or its absence |

Naming the environment variable is the detail that makes debugging possible: an operator who expected
`delete_task` to be hidden reads the reason and immediately knows which switch to flip.

**Why is `classify` a `const` arrow rather than a method?** Because it is used three times — once in
the returned object (`classify,`), and once each inside `review` and `visible`. Defining it once,
outside the returned object, avoids duplicating the logic or reaching through `this`. It also keeps
`classify` genuinely pure: it closes over `options` and nothing else.

### Block 5 — `review` and `visible`: the table, and the filter

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
```

**`review` is the explanation; `visible` is the enforcement.** Both call the same `classify`, so the
table a host prints can never disagree with the filter it applies. That single-source property is
worth naming: a common bug in policy code is a printed table that drifts from the actual rule.

**`review` returns every tool, including denied ones.** That is the point — an operator needs to see
*what was hidden and why*, not just what survived. `visible` is the one that drops them.

**`tools: readonly DiscoveredTool[]` on both.** The `readonly` array type says these functions do not
mutate the caller's catalogue. `map` and `filter` both return new arrays, so the guarantee is real
rather than aspirational — and `readonly` documents it at the signature, so a future implementation
that reached for `tools.push(...)` would be a compile error.

**`logger.warn("policy.tool_hidden", …)`, not `logger.error`.** The comment is precise about why:

> Logged as a *policy* event, not an error: hiding a tool is a deliberate decision, and an operator
> needs to be able to see it.

This is a subtle point about log levels. Hiding a tool is **not a failure** — it is the system working
exactly as designed. Logging it at `error` would make a correctly-configured deployment look broken,
and would train an operator to ignore the error channel. Logging it at `warn` says "this deserves
attention" without saying "something went wrong". It also means the line is visible at
`MCP_LOG_LEVEL=warn`, which is the level a production deployment is likely to run at.

**The event name `policy.tool_hidden` is a noun phrase, not a sentence.** Per Chapter 03's
convention, events are identifiers: `event="policy.tool_hidden"` is greppable and groupable, and the
`tool` and `reason` fields carry the specifics. A message like `"hid delete_task"` would be
unqueryable.

**`visible` logs inside the `filter` callback, once per denied tool.** An alternative is to compute
the review first and filter over it, which would log at the same points — but this form classifies
each tool once and logs only when the answer is `denied`, so a tool that is *shown* produces no log
line at all. That is the right volume: with four tools and one hidden, the startup log has one policy
line, not four.

### Block 6 — `requestConsent`: the wrapper that records the answer

```ts
async requestConsent(request) {
  const approved = await options.requestConsent(request);
  options.logger.info("policy.consent", { tool: request.tool, approved });
  return approved;
},
```

**What it does:** delegates to the injected handler and logs the outcome.
**How it works:** await, log, return — three lines, each with a purpose.

**Why wrap the injected handler at all?** Because the *decision* must be recorded, and the handler is
the one place that cannot be trusted to record it. A real dialog implementation is UI code; a test
implementation is a stub; neither should be responsible for the audit trail. Wrapping puts the logging
in the policy, where it belongs, and makes it impossible for an implementation to forget.

**`approved` is logged as a boolean, not as prose.** `{"tool":"delete_task","approved":false}` is a
field a dashboard can count. `"the user declined to delete the task"` is a sentence a human can read
and a query cannot. Same convention as the rest of the logger.

**`logger.info`, not `warn`.** Unlike hiding a tool, asking the user is the *normal* path for a
`confirm`-tier tool — so it is `info`. The `approved: false` case is the interesting one, but it is
still an expected outcome rather than a fault. Chapter 16's audit trail records it as
`outcome: "denied"`, which is where the distinction becomes queryable.

**The return value is passed through unchanged.** The wrapper adds observability without altering
behaviour — the definition of a good decorator. If the handler threw, the exception would propagate and
no `policy.consent` line would be written; the caller (`callWithPolicy` in Chapter 17) has no `try`
around it, so a throwing dialog would fail the whole turn. That is deliberate: a broken consent
mechanism should stop the operation, never fall through to executing it.

### Block 7 — what is deliberately *not* here

Three omissions are worth naming, because each is a plausible addition that was rejected.

**No name-based allowlist or denylist.** A production host would likely add one, because a server can
mislabel its own tools: `delete_task` declaring `destructiveHint: false` would sail through
`classify`. The mitigation is a host-owned map from tool name to tier that takes precedence over
annotations. It is omitted here to keep the decision rule readable — the annotation-driven rule is the
one the lecture describes — but the gap is real and is documented rather than papered over.

**No rate limiting or per-tool budgets.** Those live in the *server* (Chapter 06), because they protect
the server's own resources. A host-side budget would be a different control — protecting the user's
wallet — and the lecture's §"Rate limits and quotas" table distinguishes the two.

**No persistent policy.** `createHostPolicy` takes its configuration as arguments and reads no files.
A real host might load policy from a signed configuration; here it comes from two environment variables
(Chapter 02). The important property — that the policy is *constructed once* and then consulted purely
— holds either way.

---

## 15.4 Run / verify

The decision table, with the default configuration:

```bash
npm run host | sed -n '11,15p'
```

```text
4. host policy -> 4 of 4 tools shown to the model
   auto     complete_task  no destructive hint
   auto     create_task    no destructive hint
   confirm  delete_task    destructiveHint is set: irreversible, so it needs explicit consent
   auto     list_tasks     readOnlyHint is set
```

Four rows, and every one is traceable to the annotation table from Chapter 10:

| Tool | `destructiveHint` | `readOnlyHint` | Tier | Reason source |
| :--- | :---: | :---: | :--- | :--- |
| `complete_task` | `false` | `false` | `auto` | no destructive hint |
| `create_task` | `false` | `false` | `auto` | no destructive hint |
| `delete_task` | **`true`** | `false` | **`confirm`** | `destructiveHint` + `MCP_HOST_REQUIRE_CONSENT` |
| `list_tasks` | `false` | **`true`** | `auto` | `readOnlyHint is set` |

Note that `list_tasks` gets a *different* reason from the other two `auto` rows, because it is the only
tool with `readOnlyHint: true`. The policy distinguishes "positively declared safe" from "nothing
declared", even though both land on `auto` — which is the `reason` field earning its place.

Now the other branch. Turn destructive tools off entirely and watch the third tier appear:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host | sed -n '11,15p'
```

```text
4. host policy -> 3 of 4 tools shown to the model
   auto     complete_task  no destructive hint
   auto     create_task    no destructive hint
   denied   delete_task    destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false
   auto     list_tasks     readOnlyHint is set
```

**Three of four.** `delete_task` is `denied`, and the header line reports `3 of 4 tools shown to the
model` — the filter has taken effect. Downstream in the same run, every invocation of `delete_task` is
refused, and the audit trail records `decision: blocked`:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host 2>/dev/null | sed -n '26,30p'
```

```text
7. consent     -> delete_task is destructive (Chapter 08 §8.1)
   x delete_task refused by host policy (destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false)
   delete_task id=2     -> not invoked
   x delete_task refused by host policy (destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false)
   delete_task id=2     -> (not invoked)
```

Note that the `7. consent` heading is now misleading in this configuration — no consent is ever asked,
because the tool never gets that far. The heading is printed unconditionally by the demo (Chapter 17);
the *behaviour* is what the policy decides. That is a small cosmetic wart in the demo output, and it is
honest to point at it rather than pretend the label adapts.

And the log line the policy emits, which is the operator's view of the same decision:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host 1>/dev/null 2>/tmp/hidden.txt
grep tool_hidden /tmp/hidden.txt
```

```text
{"ts":"…","level":"warn","event":"policy.tool_hidden","host":"task-host","tool":"delete_task","reason":"destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false"}
```

One `warn` line, with the tool name and the reason — visible at `MCP_LOG_LEVEL=warn`, and greppable as
`event="policy.tool_hidden"`. Block 5's log decision, in the output.

Finally, confirm the policy is a pure function by driving it directly — no server, no transport, no
model:

```bash
npx tsx -e '
import { createHostPolicy } from "./src/host/policy.ts";
import { createLogger } from "./src/core/logger.ts";

const tools = [
  { name: "list_tasks", annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "create_task", annotations: { destructiveHint: false } },
  { name: "delete_task", annotations: { destructiveHint: true } },
  { name: "mystery_tool" },
];

const silent = createLogger("error");

for (const allowDestructive of [true, false]) {
  const policy = createHostPolicy({
    allowDestructive, requireConsent: true,
    requestConsent: async () => true, logger: silent,
  });
  console.log(`\nMCP_HOST_ALLOW_DESTRUCTIVE=${allowDestructive}`);
  for (const row of policy.review(tools)) {
    console.log(`  ${row.tier.padEnd(8)} ${row.name.padEnd(14)} ${row.reason}`);
  }
  console.log(`  visible: ${policy.visible(tools).length}/${tools.length}`);
}
'
```

```text
MCP_HOST_ALLOW_DESTRUCTIVE=true
  auto     list_tasks     readOnlyHint is set
  auto     create_task    no destructive hint
  confirm  delete_task    destructiveHint is set: irreversible, so it needs explicit consent
  auto     mystery_tool   no destructive hint
  visible: 4/4

MCP_HOST_ALLOW_DESTRUCTIVE=false
  auto     list_tasks     readOnlyHint is set
  auto     create_task    no destructive hint
  denied   delete_task    destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false
  auto     mystery_tool   no destructive hint
  visible: 3/4
```

Two things this probe proves that the demo cannot:

1. **`classify` needs no SDK, no server and no model.** Four object literals, a quiet logger and a stub
   consent handler — that is the whole test setup. Chapter 08's "three of the four test layers need no
   model", extended to the host.
2. **`mystery_tool` — a tool that declares *no* annotations at all — lands on `auto`.** That is the
   documented limitation from Block 4, demonstrated rather than described. It is exactly the case a
   name-based allowlist would catch, and it is why the gap is written down instead of glossed over.

---

## 15.5 Checkpoint

1. **Discovery is an inventory, not a grant.** A tool in `tools/list` is not a tool the model is
   authorised to run.
2. **Three tiers, and the strongest is `denied`.** An absent tool cannot be called by a model that was
   never told it exists — no prompt injection reaches a capability the host never listed.
3. **The branch order encodes the precedence: deny > confirm > auto.** A tool that should not be in the
   catalogue must not reach the consent gate either.
4. **`=== true`, not truthiness.** Only a positive declaration of destructiveness counts; an absent
   annotation is treated as non-destructive, which is the documented, permissive limitation.
5. **Every decision carries a `reason` naming the flag behind it** — the annotation and, where relevant,
   the environment variable. A security decision without a stated reason cannot be reviewed.
6. **`review` and `visible` share one `classify`**, so the printed table can never disagree with the
   enforced filter.
7. **Hiding a tool is a `warn`, not an `error`.** It is the system working as designed, and logging it as
   a fault would train an operator to ignore the error channel.
8. **The consent handler is injected**, so the policy stays pure and the demo's answers stay
   reproducible.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 14 — Entry Point: STDIO & Shutdown](./14_Entry_Point_Stdio.md)

**Next:** [Chapter 16 — Host: The Audit Trail](./16_Host_Audit.md)






