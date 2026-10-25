# Chapter 04 — The System Under Test

> **We evaluate the entire AI system, not the model call.** This file *is* that system: a
> retriever, a tool decision and a generation step, each a deterministic stand-in so the
> whole thing runs with no API key.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/services/app.ts` (144 lines) |
| **Layer** | services |
| **Purpose** | the application being evaluated: query → retrieve → decide → answer, returning a **trace** |
| **Exports** | `tokens()`, `retrieve()`, `runApp()` |
| **Imports** | `node:perf_hooks`, `config`, `domain/dataset`, `domain/types` |
| **Notes sections** | Ch02 §2.6 (evaluate the whole system), Ch04 §4.3.2/§4.3.7, Ch08 §8.2 (the retriever) |

**Why the model is a stand-in.** Chapter 09 §9.1 wants offline evaluation to be *controlled*
and *reproducible*. A stand-in is perfectly reproducible, which means every number in this
guide can be reproduced by you. The eval harness does not know the model is fake, and it
should not: it evaluates **behaviour**, and behaviour is what it measures either way.

---

## Commands

```bash
npm start &
curl -s 'http://127.0.0.1:8080/ask?q=What+is+the+return+period%3F' | python3 -m json.tool

# the topK lever, seen directly — the same question, two retrieval settings
Q='What+is+the+return+policy+and+what+does+the+warranty+cover%3F'
curl -s "http://127.0.0.1:8080/ask?q=$Q&topk=3" | python3 -c 'import json,sys; print(json.load(sys.stdin)["retrieved"])'
curl -s "http://127.0.0.1:8080/ask?q=$Q&topk=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["retrieved"])'
```

```text
topk=3 -> [{'id': 'return-policy', 'rank': 1, 'score': 2}, {'id': 'warranty', 'rank': 2, 'score': 2}, {'id': 'shipping-policy', 'rank': 3, 'score': 1}]
topk=1 -> [{'id': 'return-policy', 'rank': 1, 'score': 2}]
```

That difference is the whole regression demo, visible in one line each.

---

## `src/services/app.ts` — the full file

```ts
import { performance } from "node:perf_hooks";
import { appVersion, config } from "../config/config.js";
import { DOCUMENTS, searchText, type Document } from "../domain/dataset.js";
import type { AppEnvelope, AppRun, Retrieved } from "../domain/types.js";

/**
 * Chapter 02 §2.6 — we evaluate the **entire AI system**, not the model call.
 *
 * So this file is not "the model". It is the system: a retriever, a tool
 * decision and a generation step — each replaced by a deterministic stand-in so
 * the whole thing runs with no API key.
 *
 * That is a feature of the demo, not a shortcut. Chapter 09 §9.1 wants offline
 * evaluation to be *controlled* and *reproducible*, and a stand-in is perfectly
 * reproducible. The eval harness does not know the model is fake, and it should
 * not: it evaluates behaviour, and behaviour is what it measures either way.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "do", "does", "did", "i", "my", "me",
  "you", "your", "we", "to", "of", "in", "on", "for", "and", "or", "what", "how",
  "can", "could", "it", "that", "this", "be", "am", "have", "has", "at", "by",
  "with", "from", "there", "after", "before", "much", "many", "please",
]);

/** Lowercase, punctuation-stripped, stopword-free. Shared with the retriever and the judge. */
export function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9.]+/g) ?? [];

  return words.filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Chapter 04 §4.3.5 — the queries this application is allowed to refuse. */
const OUT_OF_SCOPE = ["weather", "joke", "president", "stock price", "recipe", "song"];

/**
 * Chapter 08 §8.2 — the retriever.
 *
 * Keyword overlap with a **relevance floor**: only documents with at least one
 * matching token are returned, capped at `topK`. The floor is what makes the
 * `topK` lever observable — a case whose expected document ranks *second* is
 * retrieved at topK=3 and silently missing at topK=1.
 */
export function retrieve(query: string, topK: number): Retrieved[] {
  const queryTokens = tokens(query);

  return DOCUMENTS.map((doc) => ({
    doc,
    score: queryTokens.filter((token) => searchText(doc).toLowerCase().includes(token)).length,
  }))
    .filter((scored) => scored.score > 0)
    // `Array.prototype.sort` is stable, so equal scores keep corpus order. That
    // determinism is what lets a rank be asserted in a test.
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((scored, index) => ({ id: scored.doc.id, rank: index + 1, score: scored.score }));
}

/** Chapter 04 §4.3.2 — the tool decision, made before generation. */
function decideTool(query: string): { name: string; args: Record<string, unknown> }[] {
  const orderId = /\b(\d{3,})\b/.exec(query)?.[1];

  return orderId === undefined ? [] : [{ name: "lookup_order", args: { orderId } }];
}

/** The one sentence of a document that best answers the query — or nothing. */
function bestSentence(query: string, doc: Document): string {
  const queryTokens = tokens(query);

  const best = doc.text
    .split(/(?<=\.)\s+/)
    .map((sentence) => ({
      sentence,
      score: queryTokens.filter((token) => sentence.toLowerCase().includes(token)).length,
    }))
    .sort((a, b) => b.score - a.score)[0];

  return best === undefined || best.score === 0 ? "" : best.sentence;
}

/**
 * One run of the system. Returns the **trace**, not just the answer, because
 * Chapter 08 §8.4 cannot attribute a failure without knowing what was retrieved
 * and what was actually sent to the model.
 */
export function runApp(query: string, topK: number = config.topK): AppRun {
  const startedAt = performance.now();

  const calls = decideTool(query);
  const retrieved = retrieve(query, topK);
  const docs = retrieved
    .map((hit) => DOCUMENTS.find((doc) => doc.id === hit.id))
    .filter((doc): doc is Document => doc !== undefined);
  const contextSent = docs.map((doc) => doc.text);

  let envelope: AppEnvelope;

  if (calls.length > 0) {
    // The tool path: the answer comes from the tool result, not the corpus.
    envelope = {
      status: "OK",
      answer: `Order ${String(calls[0]?.args.orderId)} is in transit and arrives on 2026-01-06.`,
    };
  } else if (docs.length === 0) {
    // Chapter 04 §4.3.7 — the board's fallback. Refuse if the query is
    // out-of-scope; otherwise admit the gap rather than hallucinate.
    envelope = OUT_OF_SCOPE.some((phrase) => query.toLowerCase().includes(phrase))
      ? {
          status: "REFUSED",
          answer: "I can only help with returns, shipping, warranty and loyalty questions.",
        }
      : { status: "NEEDS_INFO", answer: "I don't have that in my memory." };
  } else {
    envelope = {
      status: "OK",
      answer: docs
        .map((doc) => bestSentence(query, doc))
        .filter((sentence) => sentence !== "")
        .join(" "),
      recommendations: docs.slice(0, 3).map((doc) => doc.title),
    };
  }

  const raw = JSON.stringify(envelope);
  const ms = Math.round(performance.now() - startedAt);
  const usedTokens = Math.ceil((raw.length + contextSent.join(" ").length) / 4);

  return {
    version: appVersion(topK),
    raw,
    parsed: envelope,
    answer: envelope.answer,
    retrieved,
    contextSent,
    calls,
    usage: {
      ms,
      tokens: usedTokens,
      usd: Number((usedTokens * 0.00000015).toFixed(6)),
      toolCalls: calls.length,
      modelCalls: 1,
    },
  };
}
```

### Block-by-block

**Block 1 — the stand-in's contract, in the header comment.**

```ts
/**
 * Chapter 02 §2.6 — we evaluate the **entire AI system**, not the model call.
 * … The eval harness does not know the model is fake, and it should not:
 * it evaluates behaviour, and behaviour is what it measures either way.
 */
```

Worth reading as a design statement rather than a disclaimer. §2.6 lists what the "AI system"
contains — embedding, retrieval, prompt, model, tools — and this file contains a retriever, a
prompt assembly step and a tool decision. The only thing replaced is the generation call, and
it is replaced *behind the same interface a real one would use*.

**Block 2 — `tokens`, the shared text primitive.**

```ts
const STOPWORDS = new Set([ … ]);
export function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9.]+/g) ?? [];
  return words.filter((word) => word.length > 1 && !STOPWORDS.has(word));
}
```

Three decisions, all of which matter to a test:

- **`[a-z0-9.]+` keeps decimal points**, so `12.99` is one token. That is what lets
  `mustMention: ["12.99"]` be an assertion about a *number* rather than a substring accident.
- **`toLowerCase()`** means `Return` and `return` match, so the reworded case works.
- **Stopwords are removed** so that `"what is the"` does not create spurious overlap between a
  question and every document in the corpus. Without this, `retrieve` would return all four
  documents for almost every query and `precision` would be meaningless.

`tokens` is exported and reused by the judge (Chapter 06) — deliberately the *same* function,
so the retriever and the judge agree on what a "term" is.

**Block 3 — `retrieve`: keyword overlap with a relevance floor (Chapter 08 §8.2).**

```ts
export function retrieve(query: string, topK: number): Retrieved[] {
  const queryTokens = tokens(query);
  return DOCUMENTS
    .map((doc) => ({ doc, score: queryTokens.filter((t) => searchText(doc).toLowerCase().includes(t)).length }))
    .filter((scored) => scored.score > 0)      // ← the relevance floor
    .sort((a, b) => b.score - a.score)         // ← stable, so ties keep corpus order
    .slice(0, topK)
    .map((scored, index) => ({ id: scored.doc.id, rank: index + 1, score: scored.score }));
}
```

Four steps, and each is doing something a test depends on:

| Step | Why it is there |
| :--- | :--- |
| `score` = count of matching query terms | a deterministic stand-in for cosine similarity |
| `.filter(score > 0)` — **the relevance floor** | a real vector search returns `topK` rows regardless; this one returns only *plausible* rows. That is what makes `precision` meaningful, and what makes `topK=1` bite only on cases that genuinely need a second document |
| `.sort()` — **stable** | equal scores keep corpus order, so `warranty` lands at rank 2 for the two-part question. A rank a test asserts has to be reproducible |
| `.slice(0, topK)` | the lever |

`rank` is 1-based because Chapter 08's MRR is `1 / firstRelevantRank`, and a rank of 0 would
make that division meaningless.

**Block 4 — `decideTool`: the tool decision, before generation (Chapter 04 §4.3.2).**

```ts
function decideTool(query: string): { name: string; args: Record<string, unknown> }[] {
  const orderId = /\b(\d{3,})\b/.exec(query)?.[1];
  return orderId === undefined ? [] : [{ name: "lookup_order", args: { orderId } }];
}
```

Two lines, and they exist so that `expected-tool` and `expected-args` have something real to
check. `"Where is my order 4471?"` produces `{ name: "lookup_order", args: { orderId: "4471" } }`
— and the argument is a **string**, which is exactly the kind of detail §4.3.2's "right tool,
wrong parameters" check is for.

Note the order of operations in `runApp`: the tool decision happens *before* retrieval, and if
a tool was called the tool result is the answer. That is not arbitrary — it mirrors how an
agent behaves, and it is why `order-status` declares no `expectedDocs`.

**Block 5 — `bestSentence`: grounding, made mechanical.**

```ts
function bestSentence(query: string, doc: Document): string {
  const queryTokens = tokens(query);
  const best = doc.text.split(/(?<=\.)\s+/)
    .map((sentence) => ({ sentence, score: queryTokens.filter((t) => sentence.toLowerCase().includes(t)).length }))
    .sort((a, b) => b.score - a.score)[0];
  return best === undefined || best.score === 0 ? "" : best.sentence;
}
```

This is the "generation" step, and it is deliberately the simplest thing that produces a
**grounded** answer: it picks the sentence of a retrieved document that best matches the query.
Because the answer is a subset of the context, faithfulness is high — which is exactly what the
regression demo needs, so the failure can be attributed to retrieval rather than to
hallucination.

The `score === 0 ? ""` branch matters: a document can be retrieved on its *title* while none of
its sentences match (that is what happens to `shipping-policy` in the two-part question), and
returning an empty string lets `runApp` skip it rather than pad the answer with an irrelevant
sentence.

**Block 6 — `runApp`: the three branches.**

```ts
if (calls.length > 0) {
  envelope = { status: "OK", answer: `Order ${…} is in transit and arrives on 2026-01-06.` };
} else if (docs.length === 0) {
  envelope = OUT_OF_SCOPE.some((p) => query.toLowerCase().includes(p))
    ? { status: "REFUSED",    answer: "I can only help with returns, shipping, warranty and loyalty questions." }
    : { status: "NEEDS_INFO", answer: "I don't have that in my memory." };
} else {
  envelope = { status: "OK",
               answer: docs.map((d) => bestSentence(query, d)).filter(Boolean).join(" "),
               recommendations: docs.slice(0, 3).map((d) => d.title) };
}
```

The middle branch is Chapter 04 §4.3.7's board example, and the split inside it is the
interesting part: **empty retrieval plus an out-of-scope query is a refusal; empty retrieval on
an in-scope query is an admission.** Those are different behaviours, asserted by different
cases, and collapsing them into one "I don't know" would make both untestable.

The last branch answers from **every** retrieved document, not just the top one — which is why
the two-part question works at `topK=3` and fails at `topK=1`. A "use the top document only"
design would have failed that case at every setting, and the regression demo would have had
nothing to show.

**Block 7 — the trace, and why the return type is `AppRun`.**

```ts
const raw = JSON.stringify(envelope);
const usedTokens = Math.ceil((raw.length + contextSent.join(" ").length) / 4);

return { version: appVersion(topK), raw, parsed: envelope, answer: envelope.answer,
         retrieved, contextSent, calls,
         usage: { ms, tokens: usedTokens, usd: …, toolCalls: calls.length, modelCalls: 1 } };
```

`runApp` returns the **trace**, not just the answer, and that is Chapter 08 §8.4's requirement:
you cannot attribute a failure without knowing what was retrieved and what was actually sent.
An `answer`-only interface would make attribution impossible to compute and the whole
system-level half of the lecture unbuildable.

`version: appVersion(topK)` is the §2.8 rule — the run carries the identity of the
configuration that produced it, and it takes the `topK` that was *used*, not the configured
default. That distinction is what makes the candidate and baseline runs distinguishable in a
report.

---

## Checkpoint

1. **Why does `retrieve` filter out score-0 documents instead of returning `topK` rows?**
   Because the floor is what makes `precision` meaningful, and what makes `topK=1` fail only on
   cases that genuinely need a second document. Returning irrelevant rows would make every
   `topK` setting fail and hide the lever.

2. **Why does `runApp` return a trace rather than an answer?**
   Because Chapter 08's attribution classifier needs `retrieved` and `contextSent` to decide
   whether a failure was retrieval or generation. An answer alone cannot be attributed.

3. **Why is the tool decision made before retrieval?**
   Because it mirrors an agent's behaviour, and it is why `order-status` declares no
   `expectedDocs` — that case never reaches the retriever.

4. **What makes the answer grounded, and why does that matter to the demo?**
   `bestSentence` returns a *sentence from a retrieved document*, so the answer is a subset of
   the context. Faithfulness therefore stays 5 in the failing run, which is what forces the
   failure to be attributed to retrieval rather than to generation.

---

**[Chapter 05: Deterministic Evaluation →](./05_Deterministic_Evaluation.md)**