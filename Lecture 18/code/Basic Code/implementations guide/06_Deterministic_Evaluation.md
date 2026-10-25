# Chapter 06 — Deterministic Evaluation — Code as the Judge

> **Layer 1: the eight checks that need no model.** Chapter 05 of the notes draws the line
> with one question — *can I write this check without reading the meaning of the answer
> text?* If yes, it belongs here, it costs nothing, and it can run on every commit.
>
> In this application, **eight** properties are deterministic and **five** are semantic.
> Teams that send all thirteen to a judge are paying for eight checks they could have had
> for free.

---

## File details

| | `src/services/text.ts` | `src/services/deterministic.ts` |
|---|---|---|
| **Lines** | 76 | 132 |
| **Layer** | services (shared) | services |
| **Purpose** | the one definition of "content terms" and "overlap" | the eight checks, and what each one compared |
| **Exports** | `terms()`, `overlap()` | `runChecks()` |
| **Imports** | **nothing** | `config`, `types` |
| **Notes sections** | Ch05 §5.3.3 | Ch05 §5.2, §5.3.1–5.3.5, Ch07 §7.6, Ch08 §8.1 |

**`text.ts` exists because two services need it.** Retrieval (`knowledgeBase.ts`) and the
judge stand-in (`model.ts`) both compare text by shared content terms. Duplicating the rule
would mean the judge and retrieval could disagree about what a word is — and a judge that
disagrees with retrieval reports unfaithfulness that retrieval never caused.

---

## Commands

```bash
# Chapter 05 §5.3 — the checks behave like normal software tests.
npm run eval 2>&1 | head -12
#   --- Layer 1 · deterministic (code as the judge) ---
#   deterministic  pass rate 1
```

```bash
# Chapter 05 §5.3.4 — and they fail with expected/actual, not with a score.
RETRIEVAL_TOPK=2 npm run eval 2>&1 | sed -n '/failures/,/GATE/p'
#   policy-return-window   [deterministic]
#       No unexpected source: expected=return-policy actual=return-policy, refund-policy
```

```bash
# Chapter 05 §5.2 — the operational budget is a check, not a metric.
EVAL_MAX_LATENCY_MS=0 npm run eval 2>&1 | grep -A1 'Latency'
```

---

## `src/services/text.ts` — the full file

```ts
/**
 * Chapter 02 §2.2 / Chapter 06 §6.3 — shared text helpers.
 *
 * Two services need to compare text by meaning-of-words: the retrieval stand-in
 * and the judge stand-in. Keeping the rule in one place means "what counts as
 * evidence" has exactly one definition in this project — which matters, because
 * a judge that disagrees with retrieval about what a word is will report
 * unfaithfulness that retrieval never caused.
 */

/**
 * Words that carry no retrieval or grading signal for a policy question.
 *
 * Without this list, "What is the weather in Paris?" would match a policy
 * document on the word "the", retrieve it, and *fail* the dataset's
 * `expectedSource: null` assertion — a false failure caused entirely by stop
 * words. Chapter 05 §5.3.4's "assert absence when nothing is expected" only
 * works if retrieval can honestly return nothing.
 *
 * The temporal words (`after`, `before`, `ago`, `later`) belong here for the same
 * reason: in "after 30 days" the signal is `30`, not `after`. A stop list is not a
 * list of unimportant words — it is a list of words that do not *discriminate*
 * between documents.
 */
const STOP_WORDS = new Set([
  "a", "after", "ago", "all", "am", "an", "and", "are", "as", "at", "be", "been",
  "before", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "get", "got", "had", "has", "have", "he", "her", "hi", "him", "his", "how",
  "i", "if", "in", "is", "it", "its", "later", "long", "many", "may", "me",
  "might", "much", "must", "my", "no", "not", "of", "on", "or", "our", "please",
  "shall", "she", "should", "so", "still", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "to", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "would", "yes", "you", "your",
]);

/**
 * A deliberately crude stemmer: strip a plural/gerund/past ending, then a
 * trailing "e".
 *
 * It exists so that "returned" and "return", or "arrive" and "arrived", are the
 * same term. It is *not* a linguistics library, and Chapter 05 §5.3.3's
 * "normalise before comparing" is the habit it stands in for: the cheapest
 * false failures in an eval suite come from comparisons that were too literal.
 */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");
}

/** The content terms of a string: lower-cased, split, de-stopped and stemmed. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

/**
 * How much of `text` appears in `reference`, as a fraction of `text`'s terms.
 *
 * A fraction rather than a count, because the callers compare strings of very
 * different lengths: a two-word question against a paragraph, and a golden
 * answer against a full sentence.
 */
export function overlap(text: string, reference: string): number {
  const wanted = terms(text);

  if (wanted.length === 0) {
    return 0;
  }

  const available = new Set(terms(reference));

  return wanted.filter((term) => available.has(term)).length / wanted.length;
}
```

### Block-by-block

**Block 1 — the stop list, and why it is not "unimportant words".**

```ts
const STOP_WORDS = new Set([ "a", "after", "ago", "all", …, "your" ]);
```

The comment in the file states the principle, and it is worth restating because it is the
subtle part: **a stop list is a list of words that do not discriminate between documents.**

| Word class | Example | Why it is dropped |
| :--- | :--- | :--- |
| articles, pronouns | "the", "your" | present in every document, so they separate nothing |
| auxiliaries | "is", "have", "will" | grammatical scaffolding, not content |
| question words | "how", "when", "where" | they describe the *question*, not the *answer* |
| temporal prepositions | "after", "before", "ago", "later" | in "after 30 days" the signal is `30` |

Note `"long"` and `"many"` in the list. They are content-ish words, but in this corpus they
appear only in questions ("how long", "how many") and never in a policy document — so
keeping them would dilute every query's term count without ever helping a match.

**The list is a tuning surface, and it was tuned by running the eval.** The temporal words
were added after `policy-reworded-window` failed the relevance metric: the question
"Can I return a product **after** 3 weeks?" scored `2/4` instead of `3/4` purely because
`after` was counted as a content term. That is the honest version of how stop lists get
built.

**Block 2 — the crude stemmer.**

```ts
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");
}
```

Two `replace` calls, and the second one is the one people miss:

| Input | After `/(ing|ed|es|s)$/` | After `/e$/` |
| :--- | :--- | :--- |
| `returned` | `return` | `return` |
| `return` | `return` | `return` |
| `arrived` | `arriv` | `arriv` |
| `arrive` | `arrive` | `arriv` |
| `products` | `product` | `product` |
| `takes` | `take` | `tak` |
| `take` | `take` | `tak` |

Without the trailing-`e` strip, `arrived` → `arriv` and `arrive` → `arrive` would never
match, and the delivery-estimate case would fail on a *linguistic* technicality. With it,
both sides converge.

It is deliberately not a linguistics library. Chapter 05 §5.3.3's instruction — *normalise
before comparing* — is about the habit, not about being correct in general: the cheapest
false failures in an eval suite come from comparisons that were too literal.

**Block 3 — `terms()`, and the order of operations.**

```ts
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}
```

The order matters, and each step is doing something:

| Step | Why here |
| :--- | :--- |
| `.toLowerCase()` | before splitting, so the regex only needs `a-z` |
| `.split(/[^a-z0-9]+/)` | splits on *everything* that is not alphanumeric — punctuation, hyphens, newlines. This is why `ORD-101` becomes `ord` and `101` |
| `.filter(length > 1)` | drops single characters, including the `3` in "3 weeks" — a lone digit is not a term |
| `.filter(!STOP_WORDS.has(word))` | **before** stemming, so the stop list is written in normal English |
| `.map(stem)` | last, because stemming can change a word's shape in ways the stop list should not have to know about |

That `ORD-101` → `["ord", "101"]` detail is load-bearing for the routing: `orderIdIn()`
uses a regex on the raw question, while `terms()` never sees an order id as a single token.
The two never interfere.

**Block 4 — `overlap()`, and the direction of the fraction.**

```ts
export function overlap(text: string, reference: string): number {
  const wanted = terms(text);
  if (wanted.length === 0) return 0;
  const available = new Set(terms(reference));
  return wanted.filter((term) => available.has(term)).length / wanted.length;
}
```

The signature reads `overlap(text, reference)` and returns *the fraction of `text`'s terms
that appear in `reference`* — the denominator is always the **first** argument. Every caller
has to get this right:

| Caller | Call | Meaning |
| :--- | :--- | :--- |
| retrieval | `overlap(question, document)` | how much of the *question* the document covers |
| judge, relevance | `overlap(question, answer)` | how much of the question the answer addresses |
| judge, correctness | `overlap(goldenAnswer, answer)` | how much of the golden answer is present |
| judge, faithfulness | `overlap(answer, evidence)` | how much of the answer is grounded |

Note that faithfulness asks `overlap(answer, evidence)` — *of the answer's claims, how many
appear in the evidence* — not the reverse. Asking the reverse would give a high score to a
one-word answer backed by a long document, which is precisely the wrong incentive.

The `wanted.length === 0` guard returns `0`, not `1`. An empty text is not a perfect match
for anything; it is an absence of evidence, and the score should say so.

---

## `src/services/deterministic.ts` — the full file

```ts
import { config } from "../config/config.js";
import type { AgentResponse, CheckResult, GoldenCase } from "../domain/types.js";

/**
 * Chapter 05 §5.3 — Layer 1: the deterministic check catalogue.
 *
 * Every check here answers a question whose value is *objectively knowable*.
 * That is Chapter 08 §8.1's one-line test:
 *
 *     Can I write this check without reading the meaning of the answer text?
 *       YES -> deterministic
 *       NO  -> judge
 *
 * All eight of these say yes, which is why they cost nothing and run on every
 * commit. The five that say no live in `judge.ts`.
 *
 * Two habits are worth noticing in the code below, because both prevent the
 * cheapest false failures in an eval suite (Chapter 05 §5.3.3–5.3.4):
 *
 *   - arguments are compared **normalised**, so `ord-101` and `ORD-101` agree;
 *   - when a case expects *nothing*, the check asserts **absence**, so
 *     over-retrieval and needless tool calls are failures rather than silence.
 */

/** Chapter 02 §2.2 — the shape of a refusal. Used only where a refusal is expected. */
const REFUSAL_PATTERN = /I can only help|I do not have information/i;

function check(name: string, passed: boolean, expected: string, actual: string): CheckResult {
  return { name, passed, expected, actual };
}

/** Keep a failure message readable: the report quotes these values verbatim. */
function show(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/**
 * Chapter 07 §7.6 — run the catalogue against one response.
 *
 * Note the shape of every predicate: `expectedX === null || ...`. A check that
 * has no expectation is **not skipped** — it still runs, still reports, and passes
 * trivially while naming what it expected. Chapter 07 §7.6 wants the full list
 * visible on every case, because "which checks ran" is itself information.
 */
export function runChecks(evalCase: GoldenCase, response: AgentResponse): CheckResult[] {
  const { expectedTool, expectedToolArgument, expectedSource, category } = evalCase;
  const { toolsUsed, toolArguments, retrievedDocuments } = response;

  return [
    // 1 · Response exists.
    // Chapter 05 §5.3.1 — must not be conflated with a refusal: a refusal is a
    // valid answer, an empty completion is a broken one.
    check(
      "Response exists",
      response.answer.trim() !== "",
      "a non-empty answer",
      response.answer.trim() === "" ? "(empty)" : `${response.answer.slice(0, 60)}…`,
    ),

    // 2 · Correct tool used (positive form).
    check(
      "Expected tool used",
      expectedTool === null || toolsUsed.includes(expectedTool),
      expectedTool ?? "no tool (policy question)",
      show(toolsUsed),
    ),

    // 3 · No unexpected tool (negative form).
    // Chapter 07 §7.6 calls this one out: on a policy question it asserts that the
    // agent did *not* reach for the order database — a correctness, cost and
    // privacy assertion in one line.
    check(
      "No unexpected tool",
      expectedTool === null ? toolsUsed.length === 0 : toolsUsed.every((name) => name === expectedTool),
      expectedTool ?? "no tool",
      show(toolsUsed),
    ),

    // 4 · Correct tool argument.
    // Chapter 05 §5.3.3 — this is what separates "wrong tool" from "right tool,
    // wrong argument". The two are different bugs with different owners.
    check(
      "Expected argument passed",
      expectedToolArgument === null ||
        toolArguments.some((argument) => argument.toUpperCase() === expectedToolArgument.toUpperCase()),
      expectedToolArgument ?? "no argument expected",
      show(toolArguments),
    ),

    // 5 · Expected source retrieved (positive form).
    check(
      "Expected source retrieved",
      expectedSource === null || retrievedDocuments.includes(expectedSource),
      expectedSource ?? "no document (order question)",
      show(retrievedDocuments),
    ),

    // 6 · No unexpected source (negative form).
    // This is the check that catches over-retrieval: the agent pulling irrelevant
    // policy text into the context and contaminating its own answer.
    check(
      "No unexpected source",
      expectedSource === null
        ? retrievedDocuments.length === 0
        : retrievedDocuments.every((id) => id === expectedSource),
      expectedSource ?? "no document",
      show(retrievedDocuments),
    ),

    // 7 · Refusal when out of scope.
    // Chapter 05 §5.3.5's caveat applies: this is deterministic *because the
    // refusal is a known shape*. With a real model the wording drifts, and a
    // brittle pattern turns a good refusal into a failure — which is why the
    // pattern is deliberately loose rather than an equality test.
    check(
      "Refusal when out of scope",
      category !== "C" || REFUSAL_PATTERN.test(response.answer),
      category === "C" ? "a refusal" : "not a refusal case",
      REFUSAL_PATTERN.test(response.answer) ? "a refusal" : "an answer",
    ),

    // 8 · Latency budget.
    // Chapter 05 §5.2 — an operational budget is a *check*, not a metric: latency
    // is measurable, so no judge is involved.
    check(
      "Latency within budget",
      response.trace.latencyMs <= config.budget.maxLatencyMs,
      `<= ${config.budget.maxLatencyMs} ms`,
      `${response.trace.latencyMs} ms`,
    ),
  ];
}
```

### Block-by-block

**Block 1 — the two helpers, and why `check()` exists.**

```ts
function check(name: string, passed: boolean, expected: string, actual: string): CheckResult {
  return { name, passed, expected, actual };
}

function show(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}
```

`check()` is trivial, and it is still worth having: it makes every check in the list
*declare its own name, verdict and evidence in one call*, so the list below reads as a table
rather than as eight blocks of object construction. When a check is added, the argument order
is the same as the one above it.

`show()` solves a presentation problem that is really a correctness problem. An empty array
stringifies to `""`, and a report line reading `actual=` looks like a bug in the reporter.
`"none"` is unambiguous, and it is the word a human would use.

**Block 2 — the `expectedX === null || …` pattern.**

```ts
expectedTool === null || toolsUsed.includes(expectedTool)
```

This appears in four of the eight checks, and it is the single most important pattern in the
file. It means: **a case with no expectation still runs the check, and passes trivially
while naming what it expected.**

The alternative — skipping checks that do not apply — would be wrong for two reasons:

| If you skip the check | Consequence |
| :--- | :--- |
| the report shows fewer checks on some cases | "8 checks passed" is no longer comparable with "6 checks passed" |
| a `null` expectation becomes invisible | nobody sees that "no unexpected source" was asserted, so nobody trusts it |

Chapter 07 §7.6 wants the full check list visible on *every* case, because "which checks
ran" is itself information. A green tick against `expected=no document` tells a reader
something a missing row does not.

**Block 3 — check 3, "No unexpected tool", and why the negative form is separate.**

```ts
expectedTool === null ? toolsUsed.length === 0 : toolsUsed.every((name) => name === expectedTool)
```

Checks 2 and 3 look like near-duplicates. They are not:

| Check | Question | Fails when |
| :--- | :--- | :--- |
| "Expected tool used" | was the *required* tool called? | the agent called no tool, or the wrong one |
| "No unexpected tool" | was *only* the required tool called? | the agent called the right tool **and** an extra one |

An agent that calls `getOrderStatus(ORD-101)` *and* `getRefundAmount(ORD-101)` passes check 2
and fails check 3. That is a real failure mode — an agent that hedges by calling everything it
can — and it is invisible to a single "tool was used" assertion.

On a Category A case (`expectedTool: null`) check 3 becomes `toolsUsed.length === 0`: **the
agent must not have touched the order database at all.** Chapter 07 §7.6 calls this out as a
correctness, cost and privacy assertion in one line.

**Block 4 — check 4, and the normalisation.**

```ts
expectedToolArgument === null ||
  toolArguments.some((argument) => argument.toUpperCase() === expectedToolArgument.toUpperCase())
```

Two details:

- **`.some()`, not `includes()`** — because the comparison is normalised. `includes()` would
  demand an exact string, and `"ord-101"` would fail against `"ORD-101"`.
- **`toUpperCase()` on both sides** — Chapter 05 §5.3.3's *"compare normalised values;
  case-sensitivity produces false failures."* The model is free to echo the user's casing;
  the check must not care.

This check is what makes the worked example from the notes expressible:

```text
Question:  Where is ORD-101?
Call:      getOrderStatus("ORD-999")

Tool Selection:  PASS   (check 2)
Tool Argument:   FAIL   (check 4)
```

Same response, two different verdicts, two different owners. That is only possible because
the tool name and its argument are recorded separately.

**Block 5 — check 6, the over-retrieval check.**

```ts
expectedSource === null
  ? retrievedDocuments.length === 0
  : retrievedDocuments.every((id) => id === expectedSource)
```

This is the check the `RETRIEVAL_TOPK=2` demo trips, and the failure message is exactly the
one the README quotes:

```text
No unexpected source: expected=return-policy actual=return-policy, refund-policy
```

Read the *shape* of that line: `expected` is one id, `actual` is two. A reader needs no domain
knowledge to understand the failure, and — crucially — no knowledge of the model to know that
the model is not at fault. The fix lives in retrieval, and the message says so by naming
documents rather than scores.

**Block 6 — check 7, and being honest about determinism.**

```ts
category !== "C" || REFUSAL_PATTERN.test(response.answer)
```

Chapter 05 §5.3.5 lists this check as deterministic *"if the refusal is an enum"* — and here
it is not an enum, it is prose. So the check is deterministic in the sense that *code decides
it*, and brittle in the sense that a real model's wording will drift.

The honest engineering response is the one taken: use a loose pattern rather than an equality
test, and say so in the comment. A brittle check that is *known* to be brittle is a check you
can fix when it misfires; a brittle check that pretends to be exact is a check that gets
deleted the first time it cries wolf.

**Block 7 — check 8, the budget, and why it is a check.**

```ts
response.trace.latencyMs <= config.budget.maxLatencyMs
```

Chapter 05 §5.2's point in one line: **latency and cost are deterministic, so no judge is
involved.** Sending "was it fast enough?" to an LLM would be absurd — and yet it is exactly
what happens when a team decides that "everything AI-related needs a judge".

Note it reads from `response.trace` rather than timing the call itself. The duration is already
on the trace, recorded by the agent alongside everything else about the request, so this check
is a pure function of `AgentResponse`. Nothing in `deterministic.ts` has to know what a clock
is — which is what makes the check trivially testable.

---

## Checkpoint

1. **What is the one-line test for "should this be deterministic"?**
   *Can I write this check without reading the meaning of the answer text?* Yes → code. No →
   judge. Eight of this application's properties pass the test; five do not.

2. **Why does a check with no expectation still run?**
   So the report shows the same check list on every case. "8 checks passed" is comparable;
   "6 checks passed" is not — and a missing row hides the fact that the assertion exists.

3. **Why are "Expected tool used" and "No unexpected tool" separate?**
   Because an agent can pass the first and fail the second: the right tool *plus* an extra
   one. Different failure, different fix, different owner.

4. **Why is the argument compared with `.some()` and `toUpperCase()`?**
   Because the model may echo the user's casing. Chapter 05 §5.3.3: case-sensitivity produces
   false failures — and a false failure in an eval suite is worse than a missing check,
   because it teaches the team to ignore red.

5. **Why is the latency budget a deterministic check rather than a metric?**
   Because it is measurable. Chapter 05 §5.2: latency and cost are deterministic, so no judge
   is involved — and paying tokens for a stopwatch is the clearest symptom of a team that has
   stopped asking which evaluator belongs where.

---

**[Chapter 07: LLM-as-a-Judge — Five Metrics and a Rubric →](./07_LLM_As_A_Judge.md)**
