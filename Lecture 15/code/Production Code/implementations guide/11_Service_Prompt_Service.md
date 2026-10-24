# Chapter 11 — Service: Reusable Prompt Templates

> **Prompts: reusable interaction templates, controlled by the user.** Three rules from the notes are
> load-bearing here, and the file is shaped around them: **`MCP Prompt ≠ LLM Response`**; **a prompt never
> reads live data**; and **a prompt should only reference capabilities its own server exposes.** The payoff of
> the first rule is that the whole prompt path is testable without a model.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/promptService.ts` (275 lines) |
| **Layer** | `services` — imports `zod` and `core/errors.js`. **Nothing else.** No model client, no task store, no catalogue, no transport. |
| **Purpose** | Declare three prompts as data, derive their advertised arguments from their schemas, and render messages after validating the arguments. |
| **Exports** | `PromptMessage`, `PromptArgument`, `PromptSpec`, `PromptSummary`, `PromptRender`, `PromptService`, `createPromptService()` |
| **Lecture sections** | Ch06 §6.3–6.9 (prompts, hygiene, staleness), Ch07 §7.2/7.3/7.4 |
| **Runs** | `npm run lifecycle` step 10 · `GET /prompts` and `GET /prompt?name=…` |

---

## Commands

```bash
# the menu, with each argument's shape
npm run lifecycle 2>/dev/null | sed -n '/^10\./,/^11\./p'
curl -s http://127.0.0.1:8080/prompts

# render one — no model is called
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day&availableHours=4'
```

---

## The three rules

The header states them, and each one has a structural consequence in the file.

**Rule 1 — `MCP Prompt ≠ LLM Response`.**

> Nothing in this file calls a model, and nothing in it **can**: a prompt is a *message template*, and the
> messages it returns are the input to a model call that happens somewhere else (Notes Ch07 §7.3).

The claim *"nothing in it can"* is stronger than "does not", and it is true in the strongest available sense:
`promptService.ts` imports `zod` and `PromptError`, and **nothing else**. There is no model client in scope, no
`fetch`, no API key. A function that wanted to call a model would have to import something first — and that
import would be visible in a diff.

That is the structural half. The practical half is the payoff:

> Because a template is a pure function of its arguments, the whole prompt path is **testable without a model**
> (Notes Ch07 §"Test the prompt path without a model").

`render(args)` takes a record and returns messages. No I/O, no clock, no state. `npm run lifecycle` step 10
proves it end to end with no credentials on the machine.

**Rule 2 — a prompt never reads live data.**

> It may *ask the model* to call a tool; it must not pre-bake the answer. A prompt that embeds a snapshot of the
> board is stale the second after it is fetched, and the model then quotes yesterday's state with total
> confidence (Notes Ch06 §6.9).

Look at what `plan_day`'s render actually produces:

```text
First read my current pending tasks using the list_tasks tool, then apply the guidelines in the task://guidelines resource.
```

It names `list_tasks` and `task://guidelines` — it does **not** contain a task list or a copy of the guidelines.
The difference is not stylistic; it is the difference between a template and a cache. A prompt that embedded the
board would be wrong the moment anything changed, and — worse — the model would have no way to know it was
looking at a snapshot. By referring to the *capability* instead, the prompt is correct forever and the facts are
fetched at the moment they are needed.

**Rule 3 — a prompt references only its own server's capabilities.**

> Every template below names `list_tasks` and the `task://` Resources, which this same server registers — that
> is what makes it a *recommended workflow for this server* rather than a generic wish (Notes Ch07 §7.2).

This is the rule that makes a prompt a *contract* rather than a suggestion. A prompt that said "search the web
for my tasks" would be inert on this server; a prompt that names `list_tasks` refers to something the client can
actually verify exists in `tools/list`. Note that the names used are the real registered names — `list_tasks`,
`task://guidelines`, `task://backlog`, `task://summary`, `task://projects/{projectId}` — so a rename in the
catalogue would make a prompt wrong, which is a reviewable coupling rather than a hidden one.

---

## `src/services/promptService.ts` — the full file

```ts
import * as z from "zod/v4";
import { PromptError } from "../core/errors.js";

/**
 * Notes Ch06 §6.3–6.8 — **Prompts**: reusable interaction templates, controlled
 * by the **user**.
 *
 * Three rules from the notes are load-bearing here, and this file is shaped
 * around them:
 *
 *  1. **`MCP Prompt ≠ LLM Response`.** Nothing in this file calls a model, and
 *     nothing in it can: a prompt is a *message template*, and the messages it
 *     returns are the input to a model call that happens somewhere else
 *     (Notes Ch07 §7.3).
 *
 *  2. **A prompt never reads live data.** It may *ask the model* to call a tool;
 *     it must not pre-bake the answer. A prompt that embeds a snapshot of the
 *     board is stale the second after it is fetched, and the model then quotes
 *     yesterday's state with total confidence (Notes Ch06 §6.9).
 *
 *  3. **A prompt should only reference capabilities its own server exposes.**
 *     Every template below names `list_tasks` and the `task://` Resources, which
 *     this same server registers — that is what makes it a *recommended workflow
 *     for this server* rather than a generic wish (Notes Ch07 §7.2).
 *
 * Because a template is a pure function of its arguments, the whole prompt path
 * is **testable without a model** (Notes Ch07 §"Test the prompt path without a
 * model"). That is the practical payoff of rule 1.
 */

export interface PromptMessage {
  role: "user" | "assistant";
  text: string;
}

/** What `prompts/list` advertises about one argument (Notes Ch06 §6.6). */
export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

/**
 * One prompt, declared as data.
 *
 * `argsSchema` is the **single source of truth** for the arguments: the
 * advertised list is derived from it, and `get` validates against it. Keeping a
 * separate hand-written argument list is how a server ends up advertising an
 * argument it then refuses, which is worse than advertising none.
 */
export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  /**
   * Prompt text is a product artefact: changing it changes model behaviour, so
   * the change is versioned and reviewable (Notes Ch06 §"Prompt hygiene").
   */
  version: string;
  argsSchema: z.ZodObject<z.ZodRawShape>;
  render(args: Record<string, string | undefined>): PromptMessage[];
}

export interface PromptSummary {
  name: string;
  title: string;
  description: string;
  version: string;
  arguments: PromptArgument[];
}

export interface PromptRender {
  name: string;
  version: string;
  description: string;
  messages: PromptMessage[];
}

export interface PromptService {
  /** Everything `prompts/list` reports — including each argument's shape. */
  list(): PromptSummary[];
  /** Everything `prompts/get` returns, after validating and substituting. */
  get(name: string, args: Record<string, unknown>): PromptRender;
  /** The raw spec, for a host that wants to render its own menu. */
  byName(name: string): PromptSpec | undefined;
}

/** A one-message prompt: the common case, and the one that reads best. */
const user = (text: string): PromptMessage[] => [{ role: "user", text }];

/**
 * The prompt menu.
 *
 * Three prompts, deliberately — Notes Ch06 §"Keep the count small": *ten
 * excellent workflows beat sixty mediocre ones, because the menu is a product
 * surface.* They are also chosen to cover the three argument shapes a server
 * actually has to handle:
 *
 *   plan_day          one required argument
 *   review_workload   no arguments at all
 *   weekly_plan       one required and one optional
 */
const PROMPTS: readonly PromptSpec[] = [
  {
    name: "plan_day",
    title: "Plan my day",
    description:
      "Build an ordered plan for the tasks already on the backlog, using the hours the user has available. The prompt supplies the instructions; list_tasks supplies the facts.",
    version: "1.0.0",
    argsSchema: z.object({
      availableHours: z
        .string()
        .trim()
        .regex(/^\d{1,2}(\.\d)?$/, "must be a number of hours, e.g. 4 or 7.5")
        .describe("Number of hours available today, e.g. 4"),
    }),
    render: ({ availableHours }) =>
      user(
        [
          "Help me plan my pending tasks for today.",
          "",
          "First read my current pending tasks using the list_tasks tool, then apply the guidelines in the task://guidelines resource.",
          "",
          `I have ${availableHours} hours available today.`,
          "",
          "Give me a concise and ordered plan. Do not invent tasks: every task you mention must have come from list_tasks.",
        ].join("\n"),
      ),
  },
  {
    name: "review_workload",
    title: "Review my workload",
    description:
      "Look at the current backlog and say whether it is realistic, and what to drop first. Takes no arguments, because the question is the same every time it is asked.",
    version: "1.0.0",
    argsSchema: z.object({}),
    render: () =>
      user(
        [
          "Review my current workload.",
          "",
          "Read task://backlog and task://summary, then tell me:",
          "1. whether the total is realistic for one person, and",
          "2. which tasks I should drop or defer first, and why.",
          "",
          "Be specific: name the tasks you would drop, and never mention a task the resources did not return.",
        ].join("\n"),
      ),
  },
  {
    name: "weekly_plan",
    title: "Create weekly plan",
    description:
      "Turn one project's backlog into a week of scheduled work. Takes the project to plan, and optionally the date the week starts.",
    version: "1.0.0",
    argsSchema: z.object({
      project: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9_-]*$/i, "must be a project slug, e.g. fde")
        .describe("Project slug to plan, e.g. fde"),
      startDate: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date, e.g. 2026-10-26")
        .optional()
        .describe("Optional ISO date the week starts on, e.g. 2026-10-26"),
    }),
    render: ({ project, startDate }) =>
      user(
        [
          `Create a weekly plan for the project "${project}".`,
          "",
          `Read task://projects/${project} to get the tasks, and task://guidelines for the rules.`,
          startDate === undefined ? "Assume the week starts today." : `The week starts on ${startDate}.`,
          "",
          "Spread the work across five days, keep at most three high-priority items per day, and say explicitly which tasks did not fit.",
        ].join("\n"),
      ),
  },
];

/**
 * Derives the advertised argument list from the schema.
 *
 * Optionality is probed by parsing `undefined` rather than by inspecting a
 * modifier chain. It is one line, it cannot drift from what `get` will actually
 * do, and it stays correct across schema-library changes — which matters,
 * because a menu that lies about which arguments are required is worse than a
 * menu with no arguments at all.
 */
function argumentsOf(schema: z.ZodObject<z.ZodRawShape>): PromptArgument[] {
  /**
   * `z.ZodRawShape` types its values as the *core* schema, which does not carry
   * the classic surface (`description`, `safeParse`) this derivation needs. The
   * cast names that gap explicitly instead of hiding it behind `any`.
   */
  const shape = schema.shape as Record<string, z.ZodType>;

  return Object.entries(shape).map(([name, field]) => ({
    name,
    description: field.description ?? `The ${name} argument.`,
    required: !field.safeParse(undefined).success,
  }));
}

export function createPromptService(prompts: readonly PromptSpec[] = PROMPTS): PromptService {
  const byName = new Map(prompts.map((prompt) => [prompt.name, prompt]));

  return {
    list: () =>
      prompts.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        version: prompt.version,
        arguments: argumentsOf(prompt.argsSchema),
      })),

    byName: (name) => byName.get(name),

    get(name, args) {
      const spec = byName.get(name);

      if (spec === undefined) {
        // Notes Ch07 §7.4 — fail loudly on an unknown prompt. A silent fallback
        // to a client-side prompt means the server's recommended workflow stops
        // being used and nobody notices.
        throw new PromptError(
          "NOT_FOUND",
          `Unknown prompt: "${name}".`,
          `Call prompts/list to read the available names (${[...byName.keys()].join(", ")}).`,
        );
      }

      const parsed = spec.argsSchema.safeParse(args);

      if (!parsed.success) {
        // The detail names the argument, because the caller is a UI that has to
        // tell a user which field to fix.
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
          .join("; ");

        throw new PromptError(
          "INVALID_INPUT",
          `Invalid arguments for prompt "${name}" — ${detail}.`,
          "Send the arguments exactly as prompts/list advertises them, or omit optional ones.",
        );
      }

      const messages = spec.render(parsed.data as Record<string, string | undefined>);

      if (messages.length === 0) {
        // An empty message list is not a valid prompt result: the caller asked
        // for a workflow and got nothing, which is a bug worth failing on rather
        // than a model call worth making (Notes Ch07 §7.4).
        throw new PromptError(
          "UNAVAILABLE",
          `Prompt "${name}" produced no messages.`,
          "Report this as a server-side bug; do not fall back to an empty model call.",
          { httpStatus: 500 },
        );
      }

      return {
        name: spec.name,
        version: spec.version,
        description: spec.description,
        messages,
      };
    },
  };
}
```

### Block-by-block

**Block 1 — the message and argument shapes (lines 28–42).**

```ts
export interface PromptMessage {
  role: "user" | "assistant";
  text: string;
}

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}
```

`PromptMessage` mirrors the protocol's own shape — a role and a text — with two roles, not three. There is no
`system` role here, and that is a deliberate omission worth noting: the MCP prompt result carries a list of
*messages*, and a system prompt is the host's business, not a template's. A prompt that could inject a system
message would be a prompt that could rewrite the host's instructions, which is precisely the injection surface
Chapter 04 warns about. Restricting to `user | assistant` keeps a template's reach to what it should have.

`PromptArgument` is what `prompts/list` advertises about one argument — three fields, and the third is the one
that matters. `required: boolean` is what lets a client's UI mark a field, and getting it wrong is the failure
the derivation below exists to prevent.

**Block 2 — `PromptSpec`, where the schema is the source of truth (lines 44–66).**

```ts
export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  version: string;
  argsSchema: z.ZodObject<z.ZodRawShape>;
  render(args: Record<string, string | undefined>): PromptMessage[];
}
```

Six fields, and the doc comment singles out `argsSchema`:

> `argsSchema` is the **single source of truth** for the arguments: the advertised list is derived from it, and
> `get` validates against it. Keeping a separate hand-written argument list is how a server ends up **advertising
> an argument it then refuses**, which is worse than advertising none.

That failure mode is worth spelling out, because it is the natural way to write this. The obvious implementation
has two lists — one for `prompts/list` (what to tell the client) and one for `prompts/get` (what to check) — and
they drift the first time someone adds an argument and updates only one. The client then renders a form with a
field the server rejects, and the user's experience is that the recommended workflow does not work.

Deriving the list from the schema makes drift impossible: there is one list, and it is a function of the schema.

The `version` field carries its own comment: *Prompt text is a product artefact: changing it changes model
behaviour, so the change is versioned and reviewable.* That framing is the reason a prompt has a version and a
tool does not. A tool's behaviour is its code; a prompt's behaviour is *the model's* behaviour, which changes
whenever a word changes. Versioning it makes the change visible in review and attributable in an incident.

`render(args: Record<string, string | undefined>)` — the parameter type is precise. Every argument arrives as a
string (the protocol has no other scalar for prompt arguments), and `| undefined` reflects that an optional one
may be absent. So `startDate === undefined` is the check the `weekly_plan` renderer performs, and the type makes
that branch compulsory.

**Block 3 — the service interface and the `user()` helper (lines 68–95).**

```ts
export interface PromptService {
  list(): PromptSummary[];
  get(name: string, args: Record<string, unknown>): PromptRender;
  byName(name: string): PromptSpec | undefined;
}
```

Three methods, and the input types tell you who calls each:

| Method | `args` type | Caller |
| :--- | :--- | :--- |
| `list()` | — | `prompts/list`, and the host's menu cache |
| `get(name, args)` | `Record<string, unknown>` | `prompts/get` — args came off a wire |
| `byName(name)` | — | *A host that wants to render its own menu* |

`get` takes `unknown` and `render` takes `string | undefined` — the same two-stage pattern as `taskService`
(Chapter 09): the public boundary accepts anything and proves it, and the internal renderer receives a value that
has already been validated. `byName` is exposed for a host that wants the raw spec rather than the derived
summary — the host in this project uses it to build its own prompt allowlist (Chapter 20).

```ts
const user = (text: string): PromptMessage[] => [{ role: "user", text }];
```

*A one-message prompt: the common case, and the one that reads best.* All three prompts use it, which is itself
informative — every workflow here is a single user message. A multi-message prompt would be for a few-shot
example (a user turn, an assistant turn, then the real question), and none of these need one. The helper exists
so that the *shape* of a prompt is visible at a glance in the table below: `user(...)` means one message.

**Block 4 — the three prompts (lines 97–188).**

The menu's doc comment gives the count and the reason:

> Three prompts, deliberately — Notes Ch06 §"Keep the count small": *ten excellent workflows beat sixty
> mediocre ones, because the menu is a product surface.* They are also chosen to cover the three argument shapes
> a server actually has to handle:

```text
plan_day          one required argument
review_workload   no arguments at all
weekly_plan       one required and one optional
```

Three prompts covering three argument shapes, so the derivation below is exercised in all its cases. The full
table:

| name | title | version | arguments |
| :--- | :--- | :--- | :--- |
| `plan_day` | Plan my day | 1.0.0 | `availableHours` (**required**) |
| `review_workload` | Review my workload | 1.0.0 | *(none)* |
| `weekly_plan` | Create weekly plan | 1.0.0 | `project` (**required**), `startDate` (optional) |

**`plan_day` — the argument schema, and what it is for:**

```ts
argsSchema: z.object({
  availableHours: z
    .string()
    .trim()
    .regex(/^\d{1,2}(\.\d)?$/, "must be a number of hours, e.g. 4 or 7.5")
    .describe("Number of hours available today, e.g. 4"),
}),
```

Three decisions in four lines:

**`.string()`, not `z.coerce.number()`.** The protocol carries prompt arguments as strings, so the schema
describes the wire. Coercing to a number would be describing something that never arrives.

**The regex is deliberately loose.** `/^\d{1,2}(\.\d)?$/` accepts `4`, `12`, `7.5` and rejects `abc`, `-1`, `999`
and `4.25`. It bounds the *shape* — at most two integer digits, at most one decimal — without claiming to know
what a valid working day is. That restraint matters: a schema that rejected `12` because "nobody works twelve
hours" would be encoding a business judgement in a *transport* validation, and the model is perfectly capable of
handling an odd answer. The bound is anti-garbage, not policy.

**`.describe("Number of hours available today, e.g. 4")` becomes the advertised argument description** — it is
what `argumentsOf` reads, and therefore what the client's UI shows. Same principle as `taskSchema`'s
`.describe()` calls (Chapter 09): these strings are user-facing, not comments.

**The rendered text, and the instruction it ends with:**

```ts
[
  "Help me plan my pending tasks for today.",
  "",
  "First read my current pending tasks using the list_tasks tool, then apply the guidelines in the task://guidelines resource.",
  "",
  `I have ${availableHours} hours available today.`,
  "",
  "Give me a concise and ordered plan. Do not invent tasks: every task you mention must have come from list_tasks.",
].join("\n")
```

Five sentences doing five different jobs, and the last one is the most interesting:

| Sentence | Its job |
| :--- | :--- |
| *"Help me plan my pending tasks for today."* | States the goal |
| *"First read … using the `list_tasks` tool, then apply … `task://guidelines`"* | **Names the capabilities to use, in order** |
| *"I have 4 hours available today."* | Supplies the argument |
| *"Give me a concise and ordered plan."* | Constrains the output shape |
| *"Do not invent tasks: every task you mention must have come from `list_tasks`."* | **Constrains the output content** |

That last instruction is a *hallucination guard*, and it is the sentence a naive prompt omits. A model asked to
"plan my day" will happily produce a plausible-looking plan containing tasks that do not exist — it has no
reason not to, and the output looks right. Naming the constraint explicitly ("must have come from `list_tasks`")
ties every claim to a verifiable source, and it is enforceable by the reader of the output: an invented task is
visible as one that is not in the backlog.

The second sentence is the rule-2 mechanism in prose: it tells the model *where* the facts come from rather than
supplying them. Note the ordering word — *"First read …, then apply …"* — which encodes a dependency the model
would otherwise have to infer.

**`review_workload` — the no-argument prompt:**

```ts
argsSchema: z.object({}),
```

An **empty object schema**, not `undefined` and not omitted. `z.object({})` parses `{}` successfully and rejects
nothing, which is exactly right: the prompt takes no arguments, so any call with no arguments succeeds. And
`argumentsOf` over an empty shape returns `[]`, so `prompts/list` advertises `arguments: []` — a client renders a
button with no form.

The description explains why there are no arguments: *"Takes no arguments, because the question is the same
every time it is asked."* That is a good test for whether a prompt needs arguments: if the text would be
identical every time, the arguments are decoration.

**`weekly_plan` — one required and one optional:**

```ts
startDate: z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date, e.g. 2026-10-26")
  .optional()
  .describe("Optional ISO date the week starts on, e.g. 2026-10-26"),
```

`.optional()` is the whole difference, and the renderer consumes it with a ternary that produces **different
prose** rather than a different template:

```ts
startDate === undefined ? "Assume the week starts today." : `The week starts on ${startDate}.`,
```

Both branches are complete sentences, so the prompt reads naturally either way. The tempting alternative —
`` `The week starts on ${startDate ?? "today"}.` `` — produces *"The week starts on today."*, which is
ungrammatical and subtly changes the meaning from an instruction to a statement. Small, and exactly the kind of
thing a prompt review should catch.

Note the renderer also names a *templated* Resource: `` `Read task://projects/${project} to get the tasks` ``.
The prompt composes the URI from its own argument, so it refers to a capability the server registers without
having to read anything — rule 2 and rule 3 satisfied in one line.

And the last instruction repeats the guidelines' own rule as an output constraint:

```text
Spread the work across five days, keep at most three high-priority items per day, and say explicitly which tasks did not fit.
```

*"say explicitly which tasks did not fit"* is the interesting clause. It asks for the **negative** result — the
work that was left out — which is the information a user most needs and a model is least likely to volunteer. A
plan that silently drops three tasks looks complete; a plan that says *"these three did not fit"* is actionable.

**Block 5 — `argumentsOf`, deriving the menu from the schema (lines 190–213).**

```ts
function argumentsOf(schema: z.ZodObject<z.ZodRawShape>): PromptArgument[] {
  const shape = schema.shape as Record<string, z.ZodType>;

  return Object.entries(shape).map(([name, field]) => ({
    name,
    description: field.description ?? `The ${name} argument.`,
    required: !field.safeParse(undefined).success,
  }));
}
```

**This fifteen-line function is what makes the "single source of truth" claim true.** It turns a zod object into
the advertised argument list, and it is worth walking through each field.

**`schema.shape`** is zod's record of field name → field schema. `Object.entries` gives the names in declaration
order, which becomes the order in `prompts/list` — so the menu order matches the schema order, with no second
list to keep sorted.

**`description: field.description ?? \`The ${name} argument.\``** reads the `.describe()` string from the field,
with a fallback that is still useful. A field without a `.describe()` produces *"The availableHours argument."*
— not great, but better than an empty string, and it is a nudge to add one.

**`required: !field.safeParse(undefined).success`** is the clever line, and the doc comment defends it:

> Optionality is probed by **parsing `undefined`** rather than by inspecting a modifier chain. It is one line, it
> cannot drift from what `get` will actually do, and it stays correct across schema-library changes — which
> matters, because **a menu that lies about which arguments are required is worse than a menu with no arguments
> at all.**

Consider the alternative: inspecting the schema's internals to detect an `.optional()` wrapper. That requires
knowing how the library represents optionality, it breaks when the library changes its internals, and — most
importantly — it is a *second* implementation of a rule the parser already implements. Asking the parser directly
cannot disagree with the parser.

The test is exact: `z.string()` fails `safeParse(undefined)`, so `required` is `true`;
`z.string().optional()` succeeds, so `required` is `false`. And for `z.object({})` there are no entries, so the
loop produces `[]`.

There is one honest wart, and the comment names it:

> `z.ZodRawShape` types its values as the *core* schema, which does not carry the classic surface (`description`,
> `safeParse`) this derivation needs. **The cast names that gap explicitly instead of hiding it behind `any`.**

That is the right way to handle a library typing gap: a narrow cast to `Record<string, z.ZodType>` with a comment
saying why, rather than `any` which would silence the compiler everywhere downstream. And because the cast is
narrow, `field.description` and `field.safeParse` are still type-checked.

**Block 6 — `createPromptService` (lines 215–275).**

```ts
export function createPromptService(prompts: readonly PromptSpec[] = PROMPTS): PromptService {
  const byName = new Map(prompts.map((prompt) => [prompt.name, prompt]));
```

A factory with an injectable prompt list — so a test can build a two-prompt service instead of reasoning about
the real three. `byName` is the lookup index, built once.

**`list`** maps each spec to a summary, calling `argumentsOf` on the schema. That is the derivation, applied at
`prompts/list` time — so the advertised arguments are always exactly what `get` will validate.

**`get` — three failure branches, and the first is the chapter's most important refusal:**

```ts
const spec = byName.get(name);

if (spec === undefined) {
  throw new PromptError(
    "NOT_FOUND",
    `Unknown prompt: "${name}".`,
    `Call prompts/list to read the available names (${[...byName.keys()].join(", ")}).`,
  );
}
```

*Notes Ch07 §7.4 — fail loudly on an unknown prompt. A silent fallback to a client-side prompt means the server's
recommended workflow stops being used and nobody notices.*

That is the argument for a hard refusal rather than a graceful degradation. A host that quietly falls back to a
generic prompt when the server does not recognise a name produces a system that *works* — badly — and no signal
that anything is wrong. The failure is invisible until someone compares the output to the intended workflow.

And the recovery sentence is generated from the live menu:

```text
Call prompts/list to read the available names (plan_day, review_workload, weekly_plan).
```

The names come from `[...byName.keys()]` — the actual registered prompts — so the sentence cannot list a prompt
that does not exist. That is the same "derive from the source" discipline as `argumentsOf`, applied to an error
message.

**The argument validation branch:**

```ts
const parsed = spec.argsSchema.safeParse(args);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");

  throw new PromptError(
    "INVALID_INPUT",
    `Invalid arguments for prompt "${name}" — ${detail}.`,
    "Send the arguments exactly as prompts/list advertises them, or omit optional ones.",
  );
}
```

The comment explains the message's shape: *the detail names the argument, because the caller is a UI that has to
tell a user which field to fix.* That is the right audience analysis — `prompts/get` is called by a host, on
behalf of a user who is looking at a form. The error has to be specific enough to highlight a field.

The recovery sentence points at the *contract* rather than the value: *"Send the arguments exactly as
prompts/list advertises them, or omit optional ones."* That is actionable for a host, because the host is the
thing that read the menu in the first place — if the args do not match, the host's copy of the menu is stale or
was misread.

**The empty-messages branch, which is a server bug rather than a caller error:**

```ts
const messages = spec.render(parsed.data as Record<string, string | undefined>);

if (messages.length === 0) {
  throw new PromptError(
    "UNAVAILABLE",
    `Prompt "${name}" produced no messages.`,
    "Report this as a server-side bug; do not fall back to an empty model call.",
    { httpStatus: 500 },
  );
}
```

*An empty message list is not a valid prompt result: the caller asked for a workflow and got nothing, which is a
bug worth failing on rather than a model call worth making (Notes Ch07 §7.4).*

This is a genuinely defensive check, and it is worth understanding what it prevents. If a renderer returned
`[]` — a bug, since all three return `user(...)` — the `prompts/get` result would be a valid protocol message
containing no messages. A host would send *nothing* to the model and receive an answer generated from the system
prompt alone. The failure would appear as a nonsensical answer, not as an error, and it would be very hard to
trace back to a renderer bug.

Three details: the class is `UNAVAILABLE` (the renderer failed to produce something usable), the recovery says
*"Report this as a server-side bug; do not fall back to an empty model call"* — aimed at the developer, and
naming the wrong behaviour explicitly so a host author does not "fix" it that way — and `{ httpStatus: 500 }`
overrides the default 503, because a broken renderer is a server fault, not a transient one.

The `as Record<string, string | undefined>` cast is the one bridge between the validated data and the renderer's
parameter type. Zod's output type for these schemas is an object whose values are `string | undefined` (optional
fields), which is what the renderer declares — the cast names the equivalence rather than leaving it implicit.

**The return value carries the version:**

```ts
return { name: spec.name, version: spec.version, description: spec.description, messages };
```

`version` travels with the rendered result, not just with the listing. So a host that logs what it sent to a model
can record which *version* of which prompt produced the answer — which is what makes the versioning in
`PromptSpec` useful rather than decorative. A prompt change that alters model behaviour is attributable after the
fact.

---

## Run / verify

### 1. The menu, derived from the schemas

```bash
npm run lifecycle 2>/dev/null | sed -n '/^10\./,/^11\./p'
```

```text
10. prompts/list -> 3 workflows, each advertising its own arguments
   plan_day(availableHours)
      Build an ordered plan for the tasks already on the backlog, using the hours the user has available. …(+68)
   review_workload()
      Look at the current backlog and say whether it is realistic, and what to drop first. Takes no argume…(+61)
   weekly_plan(project, startDate?)
      Turn one project's backlog into a week of scheduled work. Takes the project to plan, and optionally …(+25)
    prompts/get plan_day { availableHours: 4 } -> the messages, and nothing else
   Help me plan my pending tasks for today.
   
   First read my current pending tasks using the list_tasks tool, then apply the guidelines in the task://guidelines resource.
   
   I have 4 hours available today.
   
   …(+111)
    no model was called. That is Notes Ch07 §7.3, and it is why this step is testable.
```

The three signature lines are the derivation visible in output form:

| Line | What it shows |
| :--- | :--- |
| `plan_day(availableHours)` | One argument, no `?` → **required** |
| `review_workload()` | Empty parentheses → `z.object({})` produced `[]` |
| `weekly_plan(project, startDate?)` | The `?` → `startDate` is **optional** |

The `?` suffix is `argumentsOf`'s `required: false` rendered by the walkthrough. **No human wrote those three lines** — they are a function of the three schemas, which is the single-source-of-truth claim made observable. Add an argument to `weekly_plan`'s schema and the menu line changes on the next run, with nothing else to edit.

### 2. The menu over HTTP, with each argument's shape

```bash
curl -s http://127.0.0.1:8080/prompts
```

```json
{"prompts":[
  {"name":"plan_day","title":"Plan my day",
   "description":"Build an ordered plan for the tasks already on the backlog, using the hours the user has available. The prompt supplies the instructions; list_tasks supplies the facts.",
   "arguments":[{"name":"availableHours","description":"Number of hours available today, e.g. 4","required":true}],
   "offered":true},
  {"name":"review_workload",...,"arguments":[],"offered":true},
  {"name":"weekly_plan",...,
   "arguments":[{"name":"project","description":"Project slug to plan, e.g. fde","required":true},
                {"name":"startDate","description":"Optional ISO date the week starts on, e.g. 2026-10-26","required":false}],
   "offered":true}],
 "count":3}
```

Four things to read out of that:

**Every `description` is the `.describe()` string from the schema** — *"Number of hours available today, e.g. 4"*, *"Project slug to plan, e.g. fde"*. Nothing restates them. So the text a client's UI displays and the text the model sees come from one place.

**`required: true` / `required: false`** is `argumentsOf`'s probe, serialised. A client renders a form from this and marks `startDate` as optional.

**`arguments: []` for `review_workload`** — not `null`, not an absent key. An empty array is what `Object.entries({})` produces, and it is what lets a client distinguish "this prompt takes no arguments" from "this client did not ask".

**`offered: true`** is added by the host's controller, not by the prompt service — it is the host's prompt *allowlist* verdict (Chapter 20), reported next to the menu so an operator can see the policy applied. With `MCP_HOST_ALLOWED_PROMPTS=` empty, everything is offered.

### 3. A rendered prompt, and the proof that no model was called

```bash
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day&availableHours=4'
```

```json
{"name":"plan_day",
 "description":"Build an ordered plan for the tasks already on the backlog, using the hours the user has available. The prompt supplies the instructions; list_tasks supplies the facts.",
 "messages":[{"role":"user","text":"Help me plan my pending tasks for today.\n\nFirst read my current pending tasks using the list_tasks tool, then apply the guidelines in the task://guidelines resource.\n\nI have 4 hours available today.\n\nGive me a concise and ordered plan. Do not invent tasks: every task you mention must have come from list_tasks."}],
 "modelCalled":false,
 "note":"This is a message template, not an answer. prompts/get talks to the MCP server; the LLM call happens afterwards, elsewhere."}
```

Three fields carry the chapter's argument:

**`messages` contains exactly one `user` message** — the template, rendered. Not a completion, not a plan. The `list_tasks` instruction is *text in the message*, not a fetched result.

**`modelCalled: false`** — stated by the response rather than left for the reader to infer.

**`note`** names the rule and where the model call happens: *"This is a message template, not an answer. prompts/get talks to the MCP server; the LLM call happens afterwards, elsewhere."* That is the `MCP Prompt ≠ LLM Response` rule, delivered to whoever curls the endpoint.

And the message text demonstrates rule 2 — the prompt never reads live data. It names `list_tasks` and `task://guidelines` as *capabilities to use*; it contains no task titles. The board could change completely between rendering this prompt and the model acting on it, and the prompt would still be correct.

### 4. The optional argument, rendered both ways

```bash
curl -s 'http://127.0.0.1:8080/prompt?name=weekly_plan&project=fde'
curl -s 'http://127.0.0.1:8080/prompt?name=weekly_plan&project=fde&startDate=2026-10-26'
```

With `startDate` omitted, the third line of the message is:

```text
Create a weekly plan for the project "fde".

Read task://projects/fde to get the tasks, and task://guidelines for the rules.
Assume the week starts today.

Spread the work across five days, keep at most three high-priority items per day, and say explicitly which tasks did not fit.
```

*"Assume the week starts today."* — the `startDate === undefined` branch, which is a complete sentence rather than a `?? "today"` interpolation that would have produced *"The week starts on today."*

Note also that the prompt composes the URI from its own argument — `` `Read task://projects/${project}` `` — so the message names `task://projects/fde`, a capability this server registers. Rule 3 in one line: the prompt refers to what the server can actually do.

### 5. The two refusals

```bash
curl -s 'http://127.0.0.1:8080/prompt?name=nope'
curl -s 'http://127.0.0.1:8080/prompt?name=plan_day'
```

```json
{"error":{"code":"NOT_FOUND","message":"Unknown prompt: \"nope\".","recovery":"Call GET /prompts to read the available names (plan_day, review_workload, weekly_plan).","retryable":false,"requestId":"8c16aa68"}}
{"error":{"code":"INVALID_INPUT","message":"Invalid arguments for prompt plan_day: availableHours: Invalid input: expected string, received undefined","recovery":"Correct the request to match the advertised contract, then retry once.","retryable":false,"requestId":"a1bd7267"}}
```

Two refusals, two codes, two different audiences:

| Case | Code | Status | The recovery names |
| :--- | :--- | :--- | :--- |
| Unknown prompt | `NOT_FOUND` | **404** | **The actual menu** — `plan_day, review_workload, weekly_plan` |
| Missing argument | `INVALID_INPUT` | **400** | **The field** — `availableHours: expected string, received undefined` |

The first recovery is generated from `[...byName.keys()]`, so it lists the real prompts. That is the *fail loudly* rule from Ch07 §7.4 made useful: a host that gets a 404 is told exactly which names exist, so it can fix its menu rather than silently falling back.

The second names the field because — as the code comment says — *the caller is a UI that has to tell a user which field to fix.*

And note the second message says *"Invalid arguments for prompt plan_day: availableHours: …"* — the prompt name **and** the field, so a log line identifies both without context.

### 6. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **How is `MCP Prompt ≠ LLM Response` enforced structurally, not just by convention?**
   `promptService.ts` imports `zod` and `PromptError` and nothing else — no model client, no `fetch`, no API key in scope. A function that wanted to call a model would have to add an import, which would be visible in a diff. The practical consequence is that the whole prompt path is testable offline.

2. **Why must a prompt never embed live data?**
   Because it would be stale the moment it was fetched, and the model would quote old state with confidence. The prompt refers to the *capability* (`list_tasks`, `task://guidelines`) so the facts are fetched at the moment they are needed — and the prompt stays correct forever.

3. **What breaks if the advertised argument list is hand-written?**
   It drifts from what `get` validates, and the server ends up **advertising an argument it then refuses** — a client renders a field the server rejects. Deriving the list from `argsSchema` makes that impossible.

4. **How is optionality determined, and why not by inspecting the schema?**
   By parsing `undefined`: `required: !field.safeParse(undefined).success`. Inspecting a modifier chain would be a second implementation of a rule the parser already implements, and it would break when the library changed its internals. Asking the parser cannot disagree with the parser.

5. **Why is an unknown prompt a hard refusal rather than a fallback?**
   Because a silent fallback produces a system that works *badly* with no signal — the server's recommended workflow stops being used and nobody notices. The refusal carries the live menu in its recovery sentence, so the caller can fix its copy.

6. **What does `version` on `PromptSpec` buy, and why does the rendered result carry it?**
   A prompt's behaviour is *the model's* behaviour, so a one-word change is a behavioural change worth reviewing. Carrying the version on the render means a host can record which version produced which answer, making the change attributable after the fact.

7. **Why is an empty message list a 500 rather than a valid result?**
   Because a valid protocol message containing no messages would send *nothing* to the model, which would then answer from the system prompt alone. The failure would surface as a nonsensical answer, not an error. The recovery sentence explicitly says *do not fall back to an empty model call*, so a host author does not "fix" it that way.

---

**[← Chapter 10: The Resource Service](./10_Service_Resource_Service.md)** · **[Chapter 12: The Selection Service →](./12_Service_Selection_Service.md)**
