# Chapter 03 — The Application Under Test

> **What the agent can know, and what it can do.** This chapter builds the three
> capabilities Chapter 02 §2.2 describes: a policy corpus it can retrieve from
> (Category A), three order tools it can call (Category B), and the refusal path that
> handles everything else (Category C).
>
> The *routing* between those paths is the part that gets tested, so it is worth
> understanding exactly where the decision is made — and why the dataset can fail the
> agent for retrieving the wrong thing.

---

## File details

| | `src/domain/dataset.ts` (corpus half) | `src/services/knowledgeBase.ts` | `src/services/tools.ts` |
|---|---|---|---|
| **Lines** | 52 (of 154) | 57 | 77 |
| **Layer** | domain | services | services |
| **Purpose** | the three policy documents | question in → ranked documents out | the three order tools, and their fixtures |
| **Exports** | `PolicyDocument`, `policyDocuments` | `KnowledgeBase` | `ToolDefinition`, `toolDefinitions`, `runTool()`, `toolNames` |
| **Imports** | `./types.js` (types only) | `config`, `dataset`, `types`, `text` | **nothing** |
| **Notes sections** | Ch02 §2.2 | Ch02 §2.2, Ch03 §3.7, Ch05 §5.3.4 | Ch02 §2.3, Ch05 §5.2 |

**`tools.ts` imports nothing at all.** It is a pure function over a fixture table, which
is what makes "order not found" a *result* you can assert on rather than an exception you
have to catch.

---

## Commands

```bash
npm run typecheck

# Chapter 02 §2.2 — the routing decision, visible from outside.
npm start
curl -s -X POST http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"message":"How many days do I have to return a product?"}' | python3 -m json.tool | head -8
#   "retrievedDocuments": ["return-policy"],   "toolsUsed": []

curl -s -X POST http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"message":"Where is ORD-101?"}' | python3 -m json.tool | head -8
#   "retrievedDocuments": [],                  "toolsUsed": ["getOrderStatus"]

# and the case a fixture table makes possible: an unknown order is a *result*.
curl -s -X POST http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"message":"Where is ORD-999?"}'
#   "answer": "Order not found: ORD-999."
```

---

## `src/domain/dataset.ts` — the corpus (the first half of the file)

```ts
import type { GoldenDataset } from "./types.js";

/**
 * Chapter 02 §2.2 — the knowledge base, and Chapter 04 §4.3 — the golden dataset.
 *
 * They live in one file because they are two halves of the same specification:
 * the documents say what the agent *can* know, the cases say what it *must* do.
 */

/** Chapter 02 §2.2 — one policy document. */
export interface PolicyDocument {
  id: string;
  title: string;
  text: string;
}

/**
 * The corpus. Three documents, one sentence per line.
 *
 * A real system would embed these and search a vector index. This project compares
 * **content terms** instead, for one reason: the evaluation must be reproducible
 * with no API key (Chapter 05 §5.2), and an embedding call is the one step that
 * cannot be. The retrieval contract is identical either way — question in,
 * ranked documents out — which is what the trace records.
 */
export const policyDocuments: PolicyDocument[] = [
  {
    id: "return-policy",
    title: "Returns",
    text: `Products can be returned within 30 days of delivery.
The return window is counted from the delivery date.
Items must be unused and in their original packaging.
Start a return from the order page and we will email a label.`,
  },
  {
    id: "refund-policy",
    title: "Refunds",
    text: `Refunds are issued to the original payment method.
A refund is processed within 5 to 7 business days after the returned item reaches our warehouse.
Shipping charges are not refunded.`,
  },
  {
    id: "shipping-policy",
    title: "Shipping",
    text: `Standard shipping takes 3 to 5 business days.
Express shipping takes 1 to 2 business days.
Tracking details are emailed once the order is dispatched.`,
  },
];
```

### Block-by-block

**Block 1 — `PolicyDocument`.**

```ts
export interface PolicyDocument {
  id: string;
  title: string;
  text: string;
}
```

`id` is the field that matters. Chapter 05 §5.3.4: *"compare on a stable document id, not
the file name — file names change; ids should not."* Every check, every `expectedSource`
in the dataset and every `SOURCE:` line in the context refers to this `id`. Renaming a
file would break nothing; changing an `id` breaks the dataset loudly, which is what you
want.

`title` is included because retrieval searches `title + text` — a document's title is
often the single most informative term in it ("Returns", "Refunds", "Shipping").

**Block 2 — the corpus, and the choice of *no embeddings*.**

```ts
export const policyDocuments: PolicyDocument[] = [
  { id: "return-policy", title: "Returns", text: `…` },
  { id: "refund-policy", title: "Refunds", text: `…` },
  { id: "shipping-policy", title: "Shipping", text: `…` },
];
```

Three documents, deliberately small, and **no vector store**. That is a testing decision
rather than a simplification:

| Option | Effect on the evaluation |
| :--- | :--- |
| Embeddings + a vector index | every run depends on an API call, a model version and a distance metric — three things that can move the numbers |
| Content-term overlap | the same input produces the same ranked list, every time |

Chapter 05 §5.2's instruction is to *"freeze what you can before running the dataset"*. A
retrieval step that costs an API call is the one part of the pipeline you cannot freeze —
so in this project it is frozen by construction.

**What is *not* simplified is the contract.** `KnowledgeBase.search()` still returns
ranked documents with ids, ranks and scores, so every check written against it (Chapter
06) would work unchanged against a real vector store. The interface is the lesson; the
implementation is the compromise.

**Block 3 — one sentence per line.**

```ts
text: `Products can be returned within 30 days of delivery.
The return window is counted from the delivery date.
…`,
```

A formatting convention with a functional consequence: the offline model in Chapter 07
answers with the retrieved text, and the judge scores it. Keeping sentences on their own
lines means the retrieved text is *readable in a trace* — a wall of one-line prose makes
the `context` field unreadable exactly when you need to read it.

**Block 4 — the documents are written to be discriminable.**

Look at what each document *avoids*:

| Document | Deliberately avoids | Why |
| :--- | :--- | :--- |
| `return-policy` | the word "refund" | so a refund question does not retrieve it first |
| `refund-policy` | the words "product", "send", "back" | so a return question does not tie with it |
| `shipping-policy` | the word "return" | so a returns question cannot pull it in |

That last point is not hypothetical. In the `RETRIEVAL_TOPK=2` run, `refund-policy` *does*
appear alongside the expected document for three cases — because it contains "the
returned item". That is a real lexical overlap, and it is exactly what the "No unexpected
source" check exists to catch.

---

## `src/services/knowledgeBase.ts` — the full file

```ts
import { config } from "../config/config.js";
import { policyDocuments, type PolicyDocument } from "../domain/dataset.js";
import type { RetrievedDocument } from "../domain/types.js";
import { terms } from "./text.js";

/**
 * Chapter 02 §2.2 — retrieval, and the reason the trace exists.
 *
 * A real system embeds the documents and searches a vector index. This one scores
 * a document by the fraction of the question's content terms it contains. The
 * *contract* is what matters and it is identical either way:
 *
 *     question in  ->  ranked documents out, each with an id, a rank and a score
 *
 * Chapter 05 §5.3.4 then checks that contract with set membership — no judge, no
 * tokens, no variance. That is why the retrieval half of RAG evaluation is the
 * cheapest evaluation you will ever write, and why it can run on every commit.
 */
export class KnowledgeBase {
  constructor(private readonly corpus: PolicyDocument[] = policyDocuments) {}

  /**
   * Chapter 03 §3.7 — retrieval returning `[]` is a **valid, recorded state**,
   * not an exception. If "no evidence" were an error, the "no evidence" path
   * could never be tested — and Chapter 04 §4.2.2's `expectedSource: null` is a
   * test of exactly that path.
   */
  search(question: string, topK: number = config.topK): RetrievedDocument[] {
    const query = terms(question);

    if (query.length === 0) {
      return [];
    }

    return this.corpus
      .map((document) => {
        const body = new Set(terms(`${document.title} ${document.text}`));
        const matched = query.filter((term) => body.has(term)).length;

        return { id: document.id, score: matched / query.length, text: document.text };
      })
      // A document that shares nothing with the question is not weak evidence —
      // it is not evidence. Keeping it would make every answer's context longer
      // and every faithfulness score worse.
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      // Chapter 03 §3.4.1 — the rank is recorded because "retrieved" is not the
      // same as "used": a document at position 9 is barely used.
      .map((hit, index) => ({
        id: hit.id,
        rank: index + 1,
        score: Number(hit.score.toFixed(3)),
        text: hit.text,
      }));
  }
}
```

### Block-by-block

**Block 1 — the class, and the injected corpus.**

```ts
export class KnowledgeBase {
  constructor(private readonly corpus: PolicyDocument[] = policyDocuments) {}
```

The corpus is a constructor parameter *with a default* — the smallest possible form of
dependency injection. Production code gets the real corpus for free; a test or an
experiment can pass two documents and see exactly what happens when retrieval has less to
work with. No configuration flag, no mocking framework.

`private readonly` means the corpus is captured at construction and cannot be
reassigned, so "the knowledge base changed mid-run" is not a bug this project can have.

**Block 2 — the query terms, and the early return.**

```ts
const query = terms(question);

if (query.length === 0) {
  return [];
}
```

A question made entirely of stop words ("what is it?") has no content terms, and the
fraction-of-query-terms score would be `0/0`. Returning `[]` explicitly avoids a `NaN`
score — which would sort unpredictably and make the trace lie about *why* nothing was
retrieved.

**Block 3 — scoring: the fraction of the question the document covers.**

```ts
const body = new Set(terms(`${document.title} ${document.text}`));
const matched = query.filter((term) => body.has(term)).length;
return { id: document.id, score: matched / query.length, text: document.text };
```

Three decisions:

| Decision | Reason |
| :--- | :--- |
| `title + text` | the title is often the most discriminative term in the document |
| a `Set`, not an array | membership testing is the only operation, and a `Set` makes it O(1) — this runs on every request |
| **normalised by `query.length`** | so scores are comparable across questions of different lengths, which matters because `topK` slices on this number |

`score` is a *coverage fraction*, not a similarity: `1.0` means every content term in the
question appears in the document. That is a crude measure — it says nothing about word
order or meaning — but it is honest, and it is exactly the kind of number a deterministic
check can reason about.

**Block 4 — the filter that matters most.**

```ts
.filter((hit) => hit.score > 0)
```

A document that shares *nothing* with the question is not weak evidence — it is not
evidence. Dropping it has three consequences:

1. the context stays short, so faithfulness scores stay meaningful;
2. "no evidence" becomes a reachable state, which is what makes the refusal path testable;
3. it is the reason `expectedSource: null` can be *satisfied* rather than always violated.

Without this line, `"What is the weather in Paris?"` would retrieve a policy document on
the word "the", and the dataset's out-of-scope case would fail for a reason that has
nothing to do with the agent. That is the single most common way an eval suite starts
lying.

**Block 5 — sort, slice, and stamp the rank.**

```ts
.sort((a, b) => b.score - a.score)
.slice(0, topK)
.map((hit, index) => ({ id: hit.id, rank: index + 1, score: Number(hit.score.toFixed(3)), text: hit.text }));
```

- **`.sort()` before `.slice()`** — obviously. The order of these two lines is the
  difference between `topK` and "the first K documents in the file".
- **`topK` comes from `config`, as a default parameter** — so the regression demo is one
  environment variable away, with no code change.
- **`rank` is assigned *after* slicing** (`index + 1`), so it is the rank in the result set
  the agent actually saw. A rank computed before the slice would be a rank in a list
  nobody ever received.
- **`score` is rounded to 3 decimals at the boundary.** Scores are compared and displayed
  by humans; `0.6666666666666666` in a trace is noise, and noise in a trace is what makes
  people stop reading traces.

Note what `search()` does **not** do: it never decides *whether* to retrieve. That
decision belongs to the agent (Chapter 04), because it is a *behaviour* the dataset
asserts — `expectedSource: null` says "on an order question, do not retrieve". Putting
the router inside `search()` would hide the behaviour being tested.

---

## `src/services/tools.ts` — the full file

```ts
/**
 * Chapter 02 §2.3 — the three tools, and the fixture data behind them.
 *
 * The fixtures are hard-coded on purpose. Chapter 05 §5.2 says "freeze what you
 * can before running the dataset"; a tool that reads a live database turns every
 * eval run into a different experiment, and a different experiment cannot be
 * compared with yesterday's score.
 */

/** What the model is offered. Every tool takes one argument: an order id. */
export interface ToolDefinition {
  name: string;
  description: string;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "getOrderStatus",
    description: "Look up the shipping status of an order. Argument: the order id, for example ORD-101.",
  },
  {
    name: "getDeliveryEstimate",
    description: "Look up when an order will arrive, or when it arrived. Argument: the order id.",
  },
  {
    name: "getRefundAmount",
    description: "Look up the refund amount for an order. Argument: the order id.",
  },
];

interface OrderFixture {
  status: string;
  /** `null` means the order has not arrived yet. */
  arrivedDaysAgo: number | null;
  refundable: number;
}

const ORDERS: Record<string, OrderFixture> = {
  "ORD-101": { status: "shipped", arrivedDaysAgo: null, refundable: 0 },
  "ORD-102": { status: "delivered", arrivedDaysAgo: 20, refundable: 4999 },
  "ORD-103": { status: "delivered", arrivedDaysAgo: 31, refundable: 4999 },
};

/**
 * Chapter 02 §2.3 — run one tool.
 *
 * A missing order is a **result**, not an exception. "Order not found" is a
 * perfectly valid thing to tell the agent, and Chapter 05 wants to be able to
 * assert that the agent *said so* rather than inventing a status for ORD-999 —
 * which is exactly the hallucination the judge in Chapter 06 exists to catch.
 */
export function runTool(name: string, argument: string): string {
  const orderId = argument.trim().toUpperCase();
  const order = ORDERS[orderId];

  if (order === undefined) {
    return `Order not found: ${orderId}.`;
  }

  switch (name) {
    case "getOrderStatus":
      return order.arrivedDaysAgo === null
        ? `Order ${orderId} has been shipped and is on the way.`
        : `Order ${orderId} was delivered ${order.arrivedDaysAgo} days ago.`;
    case "getDeliveryEstimate":
      return order.arrivedDaysAgo === null
        ? `Order ${orderId} should arrive on 15 October 2026.`
        : `Order ${orderId} arrived ${order.arrivedDaysAgo} days ago.`;
    case "getRefundAmount":
      return `Order ${orderId} is eligible for a refund of INR ${order.refundable}.`;
    default:
      return `Unknown tool: ${name}.`;
  }
}

/** The tool names, in the order they are offered to the model. */
export const toolNames: string[] = toolDefinitions.map((tool) => tool.name);
```

### Block-by-block

**Block 1 — `ToolDefinition`, and why the description matters.**

```ts
export interface ToolDefinition {
  name: string;
  description: string;
}
```

`description` is not documentation — it is the **prompt**. When a real model is used
(Chapter 07's `OpenAIModel`), these descriptions are sent as the function schema, and
they are the only thing telling the model which tool to pick. A vague description is a
tool-selection bug waiting to happen, which is why each one names the argument *and*
gives an example of its shape.

**Block 2 — the fixture table.**

```ts
const ORDERS: Record<string, OrderFixture> = {
  "ORD-101": { status: "shipped", arrivedDaysAgo: null, refundable: 0 },
  "ORD-102": { status: "delivered", arrivedDaysAgo: 20, refundable: 4999 },
  "ORD-103": { status: "delivered", arrivedDaysAgo: 31, refundable: 4999 },
};
```

Three orders, chosen so the *same* fixture supports several different tests:

| Order | `arrivedDaysAgo` | What it makes testable |
| :--- | :--- | :--- |
| `ORD-101` | `null` (not arrived) | the delivery-estimate branch, and "shipped" |
| `ORD-102` | `20` | inside the 30-day return window |
| `ORD-103` | `31` | outside the 30-day return window — the boundary case |

`ORD-102` and `ORD-103` differ by exactly one day, straddling the policy's 30-day window.
That is Chapter 04 §4.4's "edge: boundary values, 29 days vs 31 days" written into the
fixtures — the boundary is where an agent that *guesses* about policy gets it wrong, and
it costs three lines to include.

There is deliberately **no `ORD-999`**. An order that is not in the table is what makes
the not-found branch reachable, and a reachable not-found branch is what lets you assert
that the agent reports the miss instead of inventing a status.

**Block 3 — `runTool` returns a `string`, never throws.**

```ts
const orderId = argument.trim().toUpperCase();
const order = ORDERS[orderId];

if (order === undefined) {
  return `Order not found: ${orderId}.`;
}
```

The most important line in the file is the one that does **not** throw. Compare:

| Behaviour | Effect on the evaluation |
| :--- | :--- |
| `throw new Error("order not found")` | the case crashes; the pipeline reports an *error*, not a *failure*; there is nothing to score |
| `return "Order not found: ORD-999."` | the agent is *told* the order is missing; the answer either says so (correct) or invents a status (a hallucination the judge catches) |

The second row is the whole point. **A tool failure is evidence about the agent's
behaviour**, and an exception destroys that evidence. Chapter 05's "Response exists" check
exists to catch genuine breakage; a legitimate "not found" must not be confused with it.

`argument.trim().toUpperCase()` normalises the order id at the boundary. The model may
send `"ord-101"`; the fixture table is keyed on `"ORD-101"`. Normalising in *one* place
is what lets the checks in Chapter 06 compare arguments case-insensitively without each
check re-implementing the rule.

**Block 4 — the switch, and why the results are sentences.**

```ts
case "getOrderStatus":
  return order.arrivedDaysAgo === null
    ? `Order ${orderId} has been shipped and is on the way.`
    : `Order ${orderId} was delivered ${order.arrivedDaysAgo} days ago.`;
```

Two things to notice.

**The results are full sentences, not field dumps.** `{ status: "shipped" }` would be
truer to a real API and worse for this project: the tool result *becomes* the agent's
answer (Chapter 07), and it is also the evidence the judge compares that answer against.
A JSON blob would make both harder to read in a trace — and a trace nobody reads is a
trace that does not exist.

**The `default` branch returns rather than throws.** `runTool("notAllowed", …)` returns
`"Unknown tool: notAllowed."` — which is what a real system should do, since a model can
only call tools it was offered. In the offline path this branch is unreachable, and that
is honest: it exists for the real model, where "the model invented a tool name" is a
failure mode worth surviving rather than crashing on.

**Block 5 — `toolNames`.**

```ts
export const toolNames: string[] = toolDefinitions.map((tool) => tool.name);
```

A derived constant, so the agent can offer "all tools" without restating the list. The
loop in Chapter 04 then passes `toolNames` on the first turn and `[]` on the second —
which is how the tool-call budget is enforced. Deriving rather than duplicating means
adding a fourth tool cannot leave a stale list behind.

---

## Checkpoint

1. **Why is there no vector store?**
   Because an embedding call is the one step in the pipeline that cannot be frozen. The
   evaluation must be reproducible with no API key (Chapter 05 §5.2), so retrieval scores
   documents by content-term overlap. The *contract* — ranked documents with ids and
   ranks — is unchanged, so every check would work against a real index.

2. **Why does `runTool` return "Order not found" instead of throwing?**
   Because a tool failure is evidence about the agent. If the tool throws, the case crashes
   and there is nothing to score; if it returns, the agent either reports the miss
   (correct) or invents a status — and the second is exactly what `hallucinationFree` is
   for.

3. **Why is `ORD-103` in the fixtures?**
   It is the boundary the return policy turns on: `31` days, just outside the 30-day
   window. Boundary fixtures are how an agent that *guesses* about policy gets caught.

4. **Why is the corpus in `domain/` but retrieval in `services/`?**
   The corpus is part of the *specification* of correct behaviour — a document's `id` is
   referenced by the dataset. Retrieval is machinery, and nothing in the dataset refers to
   the scoring function.

5. **What would break if `search()` decided whether to retrieve?**
   The dataset's `expectedSource: null` assertions. "On an order question, do not
   retrieve" is a behaviour the agent is graded on; hiding it inside `search()` would make
   the check untestable.

---

**[Chapter 04: Observability — `AgentResponse` and Traces →](./04_Observability_AgentResponse_And_Traces.md)**
