# Chapter 09 — Online Evaluation and the Loop

> **Offline evals tell you whether you broke something you knew about. Online evals tell you what you
> didn't know about.** This chapter is the second half, and — more importantly — the arrow that turns
> the architecture from a line into a loop.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/online.ts` (135 lines) |
| **Layer** | services |
| **Purpose** | record real interactions, collect both kinds of feedback, and promote failures into candidate tests |
| **Exports** | `Interaction`, `OnlineSnapshot`, `createOnlineMonitor()`, `OnlineMonitor` |
| **Imports** | `node:crypto` (for ids), `domain/types` |
| **Notes sections** | Ch09 §9.3 (explicit + implicit feedback), §9.5 (the loop) |

**This is the only stateful module in the project.** Everything else is a pure function over inputs;
this one accumulates. That is why it is a *factory* (`createOnlineMonitor()`) rather than a set of
exported functions: state has to be owned by something, and making the owner explicit is what keeps
the rest of the project testable.

---

## Commands

```bash
npm start &

# 1. ask the same question twice — the second time is an implicit signal
A=$(curl -s 'http://127.0.0.1:8080/ask?q=Do+you+offer+gift+wrapping%3F' | python3 -c 'import json,sys; print(json.load(sys.stdin)["interactionId"])')
curl -s 'http://127.0.0.1:8080/ask?q=Do+you+offer+gift+wrapping%3F' > /dev/null

# 2. explicit feedback on the first one
curl -s -X POST http://127.0.0.1:8080/feedback -H 'Content-Type: application/json' \
  -d "{\"id\":\"$A\",\"verdict\":\"down\"}"

# 3. the queue, and the promotion
curl -s http://127.0.0.1:8080/online
curl -s -X POST http://127.0.0.1:8080/promote -H 'Content-Type: application/json' -d "{\"id\":\"$A\"}"
```

```text
{"interactions":2,"explicitUp":0,"explicitDown":1,"repeated":1,
 "explicitCoverage":0.5,"repeatRate":0.5,"candidates":[{"id":"465ad9ac", …}]}

{"testCase":{"id":"prod-465ad9ac","category":"edge","input":"Do you offer gift wrapping?",
             "expected":{},"evaluators":[{"kind":"code","checks":["json-valid","schema-valid"]}]},
 "note":"Captured from production. Fill in `expected` …"}
```

---

## `src/services/online.ts` — the full file

```ts
import { randomUUID } from "node:crypto";
import type { EvalCase } from "../domain/types.js";

/**
 * Chapter 09 §9.3 — **online evaluation**.
 *
 * Offline evaluation tells you whether you *broke* something you already knew
 * about. Online evaluation tells you what you *didn't* know about (§9.2: the
 * "distribution gap" between `"What is the return period?"` and
 * `"bro bought this yesterday but box gone can return???"`).
 *
 * This is the smallest honest version of the second half: record what real
 * interactions looked like, collect the two kinds of feedback the lecture names,
 * and — §9.5 — turn failures into candidate regression tests.
 */

export interface Interaction {
  id: string;
  input: string;
  answer: string;
  at: string;
  /** §9.3 "Explicit feedback" — 👍 / 👎. High signal, low volume. */
  explicit?: "up" | "down";
  /**
   * §9.3 "Implicit feedback" — behaviour as signal. The lecture's own example:
   * the user asks the same question again, which "may indicate that the first
   * answer was not useful".
   */
  repeated: boolean;
}

export interface OnlineSnapshot {
  interactions: number;
  explicitUp: number;
  explicitDown: number;
  repeated: number;
  /** §9.3 — "most users never click anything", so the rate is reported with its denominator. */
  explicitCoverage: number;
  repeatRate: number;
  /** The promotion queue: anything marked down, or asked twice. */
  candidates: Interaction[];
}

export function createOnlineMonitor() {
  const interactions: Interaction[] = [];

  return {
    record(input: string, answer: string): Interaction {
      const interaction: Interaction = {
        id: randomUUID().slice(0, 8),
        input,
        answer,
        at: new Date().toISOString(),
        repeated: false,
      };

      // Implicit signal: an identical question arriving again means the previous
      // answer did not land. Mark the *earlier* interaction, because that is the
      // one that failed.
      const previous = interactions.find((candidate) => candidate.input === input);

      if (previous !== undefined) {
        previous.repeated = true;
      }

      interactions.push(interaction);

      return interaction;
    },

    feedback(id: string, verdict: "up" | "down"): Interaction | undefined {
      const interaction = interactions.find((candidate) => candidate.id === id);

      if (interaction !== undefined) {
        interaction.explicit = verdict;
      }

      return interaction;
    },

    snapshot(): OnlineSnapshot {
      const up = interactions.filter((candidate) => candidate.explicit === "up").length;
      const down = interactions.filter((candidate) => candidate.explicit === "down").length;
      const repeated = interactions.filter((candidate) => candidate.repeated).length;
      const total = interactions.length;

      return {
        interactions: total,
        explicitUp: up,
        explicitDown: down,
        repeated,
        explicitCoverage: total === 0 ? 0 : Number(((up + down) / total).toFixed(2)),
        repeatRate: total === 0 ? 0 : Number((repeated / total).toFixed(2)),
        candidates: interactions.filter(
          (candidate) => candidate.explicit === "down" || candidate.repeated,
        ),
      };
    },

    /**
     * §9.5 — **the loop**: "production failures become future regression tests.
     * This creates a continuous improvement loop."
     *
     * Read the returned shape carefully, because the split is the lesson. The
     * *input* is captured automatically — that is the mechanical half. The
     * **expected behaviour** is not, and cannot be: deciding what the system
     * *should* have said is a human judgement (Chapter 07 §7.7). So this returns
     * a stub with an empty `expected` and says so, rather than inventing an
     * assertion from the answer that was already wrong.
     */
    promote(id: string): { testCase: EvalCase; note: string } | undefined {
      const interaction = interactions.find((candidate) => candidate.id === id);

      if (interaction === undefined) {
        return undefined;
      }

      return {
        testCase: {
          id: `prod-${interaction.id}`,
          category: "edge",
          input: interaction.input,
          expected: {},
          evaluators: [{ kind: "code", checks: ["json-valid", "schema-valid"] }],
        },
        note:
          "Captured from production. Fill in `expected` (mustMention / mustNotClaim / expectedDocs) " +
          "and add the judge evaluators you want, then bump the dataset revision — an unasserted case " +
          "cannot gate anything.",
      };
    },
  };
}

export type OnlineMonitor = ReturnType<typeof createOnlineMonitor>;
```

### Block-by-block

**Block 1 — `Interaction`: the record, with both feedback channels (§9.3).**

```ts
export interface Interaction {
  id: string;
  input: string;
  answer: string;
  at: string;
  explicit?: "up" | "down";
  repeated: boolean;
}
```

Two feedback fields, and they are shaped differently on purpose:

- **`explicit` is optional and absent until a user clicks.** §9.3's point about explicit feedback is
  that it is *"high-signal and low-volume"* — most users never click anything, and the ones who do are
  not a random sample. An absent field is the honest representation of "no signal", which is why it is
  not defaulted to `"up"`.
- **`repeated` is a non-optional boolean** because it is *derived*, not reported. It is always
  computable from the interaction history, so it always has a value.

Note what is **not** recorded: no user id, no session, no raw conversation. §9.3's risk column names
privacy, and the cheapest way to honour it is to record the smallest thing that supports the loop —
the input, the answer, and the two signals.

**Block 2 — `record`: the implicit signal, and whose fault it is.**

```ts
record(input: string, answer: string): Interaction {
  const interaction: Interaction = { id: randomUUID().slice(0, 8), input, answer,
                                     at: new Date().toISOString(), repeated: false };

  const previous = interactions.find((candidate) => candidate.input === input);
  if (previous !== undefined) previous.repeated = true;

  interactions.push(interaction);
  return interaction;
}
```

§9.3's implicit-feedback example, implemented literally: *"AI gives answer → user asks the same
question again. This may indicate that the first answer was not useful."*

The subtle line is `previous.repeated = true`. The signal is set on the **earlier** interaction, not
the new one — because the earlier interaction is the one that failed. Marking the *second* one would
point the promotion queue at a question that was asked in good faith rather than at the answer that
sent the user back.

The `id` is `randomUUID().slice(0, 8)` — the same eight-character convention as the request ids in
the MCP lectures, and for the same reason: long enough to be unique in a queue, short enough to paste
into a `curl` command.

**Block 3 — `feedback`: the explicit channel.**

```ts
feedback(id: string, verdict: "up" | "down"): Interaction | undefined {
  const interaction = interactions.find((candidate) => candidate.id === id);
  if (interaction !== undefined) interaction.explicit = verdict;
  return interaction;
}
```

Returning `undefined` for an unknown id — rather than throwing or creating one — is what lets the
controller answer `404` with a real message (*"No recorded interaction \"abc\""*). A method that
invented a record would turn a client bug into a success response.

**Block 4 — `snapshot`: rates, with their denominators (§9.3).**

```ts
snapshot(): OnlineSnapshot {
  const up = interactions.filter((c) => c.explicit === "up").length;
  const down = interactions.filter((c) => c.explicit === "down").length;
  const repeated = interactions.filter((c) => c.repeated).length;
  const total = interactions.length;

  return {
    interactions: total, explicitUp: up, explicitDown: down, repeated,
    explicitCoverage: total === 0 ? 0 : Number(((up + down) / total).toFixed(2)),
    repeatRate: total === 0 ? 0 : Number((repeated / total).toFixed(2)),
    candidates: interactions.filter((c) => c.explicit === "down" || c.repeated),
  };
}
```

Two numbers that are easy to get wrong, and both are reported **alongside** the counts rather than
instead of them:

- **`explicitCoverage` is the denominator, given a name.** A `down` count of 1 is meaningless without
  knowing whether it came from 2 interactions or 20,000. §9.3's *"most users never click anything"* is
  exactly why coverage belongs in the snapshot: a feedback rate of 0.05 is normal, and a dashboard
  showing only the thumbs-down count will always look alarming.
- **`repeatRate` is the implicit signal's aggregate.** A rising repeat rate is the cheapest early
  warning that a change made answers less useful — and it needs nobody to click anything.

`candidates` is the queue, and its predicate is the interesting part: **anything marked down, or
anything the user had to ask twice.** Both are evidence that an answer did not land, and this queue is
what §9.5's loop actually consumes.

**Block 5 — `promote`: the loop's mechanical half, and its deliberate limit (§9.5).**

```ts
promote(id: string): { testCase: EvalCase; note: string } | undefined {
  const interaction = interactions.find((candidate) => candidate.id === id);
  if (interaction === undefined) return undefined;

  return {
    testCase: {
      id: `prod-${interaction.id}`,
      category: "edge",
      input: interaction.input,
      expected: {},                                             // ← deliberately empty
      evaluators: [{ kind: "code", checks: ["json-valid", "schema-valid"] }],
    },
    note: "Captured from production. Fill in `expected` (mustMention / mustNotClaim / expectedDocs) " +
          "and add the judge evaluators you want, then bump the dataset revision — an unasserted case " +
          "cannot gate anything.",
  };
}
```

This is §9.5's *"production failures become future regression tests"*, and the block is short because
of a decision worth defending:

**Promotion captures the input and refuses to invent the expectation.** `expected` is empty on
purpose. Deciding what the system *should* have said is a human judgement — Chapter 07 §7.7's whole
subject — and the tempting shortcut (asserting the answer you wish you had got) produces a test that
encodes a guess. An unasserted case cannot gate anything; a case that asserts a guess gates the wrong
thing.

Three smaller choices:

- **The id is `prod-<interactionId>`**, so the promoted case is traceable back to the interaction it
  came from. That link is what lets you go and read the original answer.
- **The category is `"edge"`**, because a production failure is by definition a case the dataset's
  author did not imagine. It is a starting guess, and it is editable.
- **The evaluators are the two free ones.** `json-valid` and `schema-valid` need no expectation, cost
  nothing, and are still worth asserting on a captured case.

**Why this returns a candidate rather than editing the dataset.** Chapter 03 §3.1: *a dataset you
regenerate is not a baseline.* A dataset mutated by production traffic would change between runs, and
every score comparison would become meaningless. So promotion stops at a proposal — a human reviews
it, fills in `expected`, and commits it with a bumped `revision`. The `note` says all of this, because
the response *is* the documentation for whoever picks the case up.

**Block 6 — `OnlineMonitor`, the derived type.**

```ts
export type OnlineMonitor = ReturnType<typeof createOnlineMonitor>;
```

One line, and it is the idiom for "the thing that factory returns" without writing a second interface
that could drift from the implementation. The controller takes an `OnlineMonitor`, so the shape is
named at the boundary even though it is inferred.

---

## Checkpoint

1. **Why is `repeated` set on the *earlier* interaction rather than the new one?**
   Because the earlier answer is the one that failed. Marking the second interaction would point the
   promotion queue at the user's good-faith question instead of at the answer that sent them back.

2. **Why is `explicitCoverage` reported next to the thumbs-down count?**
   Because §9.3 says most users never click anything. A count without its denominator looks alarming at
   any volume; the coverage number is what makes the rate interpretable.

3. **Why does `promote` return a case with an empty `expected`?**
   Because deciding the expected behaviour is a human judgement (Chapter 07 §7.7). Asserting the answer
   you wish you had got would encode a guess, and an unasserted case cannot gate anything.

4. **Why does promotion not add the case to the dataset directly?**
   Because §3.1 says a dataset you regenerate is not a baseline. A dataset mutated by production traffic
   changes between runs, and every comparison of scores becomes meaningless.

5. **Why is this module a factory rather than a set of exported functions?**
   Because it is the only stateful module in the project. Making the owner of that state explicit is
   what keeps every other service a pure function that can be called twice without surprise.

---

**[Chapter 10: The Surfaces — Controller, Routes, Entry, CLI →](./10_The_Surfaces_Controller_Routes_CLI.md)**