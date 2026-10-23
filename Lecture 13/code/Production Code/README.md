# Lecture 13 — Structured Outputs in GenAI (TypeScript)

> **The code behind the notes.** A small, framework-free structured-output system that
> makes every claim in Lecture 13 measurable: the enforcement ladder, schema design, the
> reliability loop, tool calling versus structured output, an idempotent action pipeline,
> an MCP-shaped capability server, and a golden-set evaluation harness.

**Runs with no API key.** The offline simulator reproduces the *documented failure modes*
of each enforcement rung, so `npm run naive`, `npm run layers` and `npm run eval`
reproduce the numbers below on any machine. Set `OPENAI_API_KEY` and the same code calls
a real model with `response_format: { type: "json_schema", strict: true }` — the schema,
the validator, the repair loop and the metrics do not change.

```bash
cd "Lecture 13/code/Basic"
npm install

npm run naive                       # "Sure! Here's the JSON you requested:" — and JSON.parse throws
npm run layers                      # the same sentence through all four enforcement rungs
npm run schema                      # the contract, the closure probe, the strict-mode diff
npm run extract                     # the full reliability loop, with a per-attempt trace
npm run validate                    # structural vs semantic validation on one object
npm run repair                      # the repair prompt, and what it can and cannot fix
npm run tool                        # structured output vs tool calling, side by side
npm run mcp                         # initialize, tools, resources, prompts, and the gate
npm run eval                        # the golden set, the metric card, all four rungs
npm run all                         # everything, in order
npm run dev                         # HTTP API on :3200
```

---

## What it measures

The headline is one table, produced by `npm run eval` — the same ten golden cases, four
enforcement rungs, one model:

```
level        1st-pass   repair    fail      fields    p95       gate
instruction  0%         100%      0%        100%      14.0ms    FAIL (1)
json_mode    0%         100%      0%        100%      14.0ms    FAIL (1)
schema       100%       0%        0%        100%      13.0ms    pass
validate     100%       0%        0%        100%      13.0ms    pass
```

Read it as: **the guarantee is not about quality, it is about how many calls it takes to
reach a usable object.** At `instruction` and `json_mode` every clean case needs a repair
call — the repair loop rescues them, at double the cost. At `schema` and `validate` the
object is right the first time. Field accuracy is 100% everywhere, because the *content*
was never the problem; the envelope was.

The per-case table at `ENFORCEMENT=validate`:

```
case                   outcome    attempts  fields   ms       violations
clean-review           ok         1         5/5      6.0ms    —
clean-oneonone         ok         1         4/4      5.0ms    —
clean-interview        ok         1         5/5      5.0ms    —
clean-location         ok         1         4/4      5.0ms    —
ambiguous-no-time      invalid    3         —        15.0ms   —
adversarial-injection  refused    1         —        5.0ms    —
out-of-scope           refused    1         —        5.0ms    —
unknown-person         ok         1         3/3      5.0ms    —
over-long-duration     degraded   3         3/3      15.0ms   —
interview-too-short    invalid    3         —        13.0ms   —
```

Six of those outcomes are *supposed* to be non-`ok`, and the harness checks each one:

| Case | Why that outcome is correct |
| :--- | :--- |
| `ambiguous-no-time` | No time is stated. `startIso` is part of the non-nullable spine, so **inventing** one would be the bug. |
| `adversarial-injection` | Instruction-like text in the input. A refusal is the answer, and the pipeline never reaches the calendar. |
| `out-of-scope` | Not a scheduling request. An empty meeting object would be worse than a refusal. |
| `unknown-person` | A real person not in the directory: a `review` **flag**, not a rejection — over-rejection is its own failure mode. |
| `over-long-duration` | 900 minutes breaches the schema bound. Repair must not invent a duration, so the fallback rung defaults the one defaultable field and flags the object. |
| `interview-too-short` | The duration was *stated* and merely breaches a policy. Defaulting it would silently change what the user asked for — so the correct rung is escalation, not degradation. |

The last two cases are the point of the whole fallback design: **"missing" and "against
policy" are different problems, and only one of them may be defaulted.**

---

## Layout

```
Basic/
├── DemoApplication.js          the lecture's original 3-file happy path (npm run demo)
├── MeetingDetails.js           the Zod schema from the lecture
├── MeetingService.js           the OpenAI SDK call, with zodTextFormat
└── src/
    ├── types.ts                every data contract in one file
    ├── config/env.ts           validated config; provider "auto" keeps it offline-capable
    ├── lib/
    │   ├── json.ts             the strict parse path + the tolerant reader (and why)
    │   └── text.ts             normalisation (dates, times, durations) + identity
    ├── schema/meeting.ts       ONE declaration → Zod, JSON Schema, TS type, strict variant
    ├── llm/
    │   ├── rules.ts            the deterministic reader the offline simulator wraps
    │   ├── model.ts            SimulatedModel + OpenAiModel behind one interface
    │   └── enforcement.ts      the four rungs, their guarantees, and the prompt per rung
    ├── pipeline/
    │   ├── semantic.ts         the domain checks, with block/review severities
    │   ├── repair.ts           the repair prompt, built from the machine-readable issues
    │   ├── extract.ts          generate → parse → validate → repair → fall back + trace
    │   └── action.ts           authorise → confirm → execute → report
    ├── action/
    │   ├── calendar.ts         the vendor adapter: typed errors + idempotency keys
    │   └── mcp-lite.ts         the MCP shape: tools, resources, prompts, tier gating
    ├── eval/
    │   ├── golden.ts           10 cases: clean, ambiguous, adversarial, edge
    │   └── run.ts              the harness, the metric card, the release gate
    ├── cli.ts                  one subcommand per chapter
    └── server.ts               Express API: /health, /schema, /tools, /extract, /schedule
```

18 TypeScript files, ~4,500 lines including comments.

---

## Chapter map

| Chapter in the notes | Code |
| :--- | :--- |
| [01 — Why plain text is not enough](../../notes/01_Why_Plain_Text_Is_Not_Enough.md) | `types.ts`, `npm run naive` |
| [02 — What structured output is](../../notes/02_What_Structured_Output_Is_Schema_Contract_And_Types.md) | `schema/meeting.ts` |
| [03 — Why "just ask for JSON" fails](../../notes/03_Why_Just_Ask_For_JSON_Fails.md) | `llm/model.ts` (the drift), `npm run naive` |
| [04 — JSON Schema and schema design](../../notes/04_JSON_Schema_And_Schema_Design_For_LLMs.md) | `schema/meeting.ts` (`meetingStrictJsonSchema`), `npm run schema` |
| [05 — Enforcement mechanisms and providers](../../notes/05_Enforcement_Mechanisms_And_Provider_Landscape.md) | `llm/enforcement.ts`, `OpenAiModel`, `npm run layers` |
| [06 — Validation, repair and failure handling](../../notes/06_Validation_Repair_And_Failure_Handling.md) | `pipeline/extract.ts`, `repair.ts`, `semantic.ts` |
| [07 — Structured output vs tool calling](../../notes/07_Structured_Output_vs_Tool_Calling.md) | `pipeline/action.ts`, `npm run tool` |
| [08 — From data to action, tools and MCP](../../notes/08_From_Data_To_Action_Tools_Integrations_And_MCP.md) | `action/calendar.ts`, `action/mcp-lite.ts` |
| [09 — Production playbook](../../notes/09_Production_Playbook_Evaluation_And_Checklist.md) | `eval/golden.ts`, `eval/run.ts` |

---

## Three design decisions worth reading the code for

**1 · One declaration, three artifacts** (`src/schema/meeting.ts`)
The Zod schema is the only place the contract is written. The TypeScript type, the JSON
Schema on the wire and the runtime validator are all derived from it — so a rename breaks
the build instead of production. The strict-mode variant is *generated*, not hand-edited,
and `npm run schema` prints exactly which predicates a grammar cannot enforce.

**2 · The fallback rung is keyed on `(path, code)`, not on the field** (`src/pipeline/extract.ts`)
`durationMinutes: out_of_range` is degradable — the value is untrustworthy, so default it
and flag it. `durationMinutes: policy_violation` is **not** — the value was stated and
merely breaches a rule, so silently changing it would be worse than failing. This one set
is the difference between a safe fallback and a system that quietly books the wrong meeting.

**3 · The trace is a first-class return value** (`src/pipeline/extract.ts`)
Every extraction returns its attempts, issues, stages and latency alongside the object. The
issue distribution is computed there, because it is the metric that turns "the model is
unreliable" into "`durationMinutes` is a string 4% of the time" — a fixable problem.

---

## Identity is not a string comparison

`matchesPerson` in `src/lib/text.ts` exists because the same person arrives in three shapes:
the model extracts a *name* (`"Aditya"`), the directory stores an *email*
(`"aditya@northwind.test"`), and the request carries an *actor*. Getting this wrong is not
cosmetic — it is the difference between "you may book for yourself" and `forbidden`, and
between an auto-approved event and a human approval gate. There is exactly one
implementation, shared by the semantic layer, the authorisation layer and the approval
decision.

---

## The lecture's original demo

`DemoApplication.js`, `MeetingDetails.js` and `MeetingService.js` are the lecture's own
three-file happy path: a Zod schema and a single `openai.responses.parse` call with
`zodTextFormat`. They are kept verbatim as the starting point the rest of this codebase
argues with — run them with `npm run demo` and a real `OPENAI_API_KEY`.

The difference is the whole lecture in one line: the demo shows the *happy path*; `src/`
shows what happens on the other 5% — and why that is the part you have to design.
