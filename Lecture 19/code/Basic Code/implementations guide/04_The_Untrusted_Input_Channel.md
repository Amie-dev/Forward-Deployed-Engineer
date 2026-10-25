# Chapter 04 — The Untrusted Input Channel

> **Chapter 04 §4.3: retrieval is a delivery channel, not a lookup.** These two
> files are the smallest possible version of that claim.
>
> `knowledgeBase.ts` is about ten lines of ranking. It contains no bug, no
> oversight and no unusual decision — and it is the reason a customer can write a
> sentence that the assistant will later treat as an instruction. The document
> that scores **highest** for the question *"I want a refund for my order
> ORD-101"* is the one an attacker wrote, and it scores highest because it is
> *about exactly that subject*.
>
> That is the uncomfortable part of indirect injection, and it is why this is a
> chapter of its own: the attacker does not have to make the assistant read their
> text. They only have to make it **relevant**.

---

## File details

| | `src/utils/text.ts` | `src/services/knowledgeBase.ts` |
|---|---|---|
| **Lines** | 68 | 26 |
| **Layer** | utils (shared) | services |
| **Purpose** | the one definition of "content terms" and "overlap" | question in, ranked documents out — with the untrusted flag intact |
| **Exports** | `terms()`, `overlap()` | `retrieve()` |
| **Imports** | **nothing** | `config`, `data`, `types`, `text` |
| **Notes sections** | Ch 04 §4.3 | Ch 04 §4.3, Ch 02 §2.4 |

**`text.ts` exists because two services need it.** Retrieval ranks documents by
shared content terms, and the offline model re-reads tool results with the same
idea of "which words matter". Two different definitions would make the demo
unreproducible — and a security demo you cannot reproduce is not evidence.

---

## Commands

```bash
cd "Lecture 19/code/Basic Code"
npm run typecheck
```

```bash
# Chapter 04 §4.3 — the untrusted document is retrieved FIRST, for a question
# about the user's own order. Look at the order of `retrieved`.
npm run demo 2>&1 | sed -n '/--- indirect-injection/,/verdict/p'
#   retrieved     customer-note-7781, return-policy

# Chapter 04 §4.3 — a retrieval setting is a security setting.
RETRIEVAL_TOPK=1 npm run demo 2>&1 | sed -n '/--- indirect-injection/,/retrieved/p'
```

---

## `src/utils/text.ts` — the full file

```ts
/**
 * Chapter 04 §4.3 — shared text helpers.
 *
 * Retrieval (`services/knowledgeBase.ts`) and the offline model both need
 * "which words matter". One definition, because two different ideas of "the
 * same words" would make the injection demo unreproducible — and a demo you
 * cannot reproduce is not evidence.
 */

/**
 * Words that carry no retrieval signal for an order or policy question.
 *
 * Without this list, every question would match every document on the word
 * "the", retrieval would always return the maximum number of documents, and the
 * *channel* the injection arrives through (Chapter 04 §4.3) would be impossible
 * to see. A stop list is not a list of unimportant words: it is a list of words
 * that do not discriminate between documents.
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

/** A deliberately crude stemmer, so "refunded" and "refund" are the same term. */
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
 * different lengths: a five-word question against a paragraph-long document.
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

**How it works, block by block**

| Block | What it does and why |
| :--- | :--- |
| `STOP_WORDS` | Not a list of unimportant words — a list of words that do not **discriminate** between documents. The comment gives the reason it matters here: without it, every question matches every document on "the", retrieval always returns the full corpus, and the *channel* becomes invisible because everything is in the context anyway. |
| The temporal words (`after`, `before`, `ago`, `later`) | A detail worth noticing: in "after 30 days" the discriminating signal is `30`, not `after`. Removing them is what lets the return-policy document be found by its *number* rather than its grammar. |
| `stem()` | `refunded` → `refund`, `orders` → `order`, `shipping` → `shipp`. It is crude and it is enough: a question about refunds must match a document that says "refunds". This is the "normalise before comparing" habit, in four words of regex. |
| `terms()` | Lower-case, split on anything that is not `a-z0-9`, drop short and stopped words, stem. Note `/[^a-z0-9]+/` — it splits `ORD-101` into `ord` and `101`, which is exactly why the injected note matches a question containing `ORD-101`. |
| `overlap(text, reference)` | A **fraction**, not a count: "how much of the question appears in the document". A fraction is what makes the numbers comparable across a five-word question and a paragraph-long document — and it is why the note scores 1.00 against a refund question while the policy documents score 0.25. |
| `if (wanted.length === 0) return 0` | The zero-division guard, and also a security-relevant default: a question with no content terms retrieves **nothing** rather than everything. |

**What this file is *not*.** It is not a retrieval algorithm and it is not trying
to be. It is the *contract* — ranked documents, scored, with an id — in its
smallest honest form. The chapter's point survives replacing it with embeddings
and a vector store: whatever ranks documents will rank the attacker's document
highly **when it is on-topic**, and being on-topic is all the attacker needs.

---

## `src/services/knowledgeBase.ts` — the full file

```ts
import { config } from "../config/config.js";
import { DOCUMENTS } from "../domain/data.js";
import type { RetrievedDocument } from "../domain/types.js";
import { overlap } from "../utils/text.js";

/**
 * Chapter 04 §4.3 — retrieval is a delivery channel, not a lookup.
 *
 * This function is the whole of the indirect-injection problem in about ten
 * lines. It ranks documents by how well they match the *user's question* — and
 * the document that matches a refund question best is the one a customer wrote.
 * Nothing here is broken. That is the point: the attacker does not have to make
 * the assistant read their text, only make it *relevant*.
 */
export function retrieve(question: string, topK: number = config.topK): RetrievedDocument[] {
  return DOCUMENTS.map((document) => ({
    ...document,
    score: Number(overlap(question, `${document.title} ${document.content}`).toFixed(2)),
  }))
    // A similarity floor: no match means no document. Without it, every question
    // would retrieve the whole corpus and the channel would be indistinguishable
    // from noise.
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK);
}
```

**How it works, block by block**

| Block | What it does and why |
| :--- | :--- |
| `topK: number = config.topK` | Chapter 04 §4.3's "a retrieval setting is a security setting", visible in a signature. The default comes from the environment, so the channel's width is a reviewable configuration value rather than a literal. |
| `{ ...document, score: … }` | **The spread is the important part.** `DOCUMENTS` entries carry `trusted: boolean`, and spreading copies it forward, so every retrieved document arrives with its provenance attached. A retrieval function that returned only `{ id, content }` would erase the trust boundary at exactly the point where it matters. |
| `` `${document.title} ${document.content}` `` | Scores the title *and* the body. Titles are content too, and in a real system the metadata — filename, uploader, ticket number — is often the most attacker-controllable field of all. |
| `.filter((document) => document.score > 0)` | A similarity floor. Without it, a question about the weather would return the whole corpus, and "the untrusted document was in the context" would stop meaning anything, because every request would carry every document. |
| `.sort((a, b) => b.score - a.score \|\| a.id.localeCompare(b.id))` | Descending by score, **ties broken by id**. The tie-break is not cosmetic: without it, two documents at the same score would come back in `Array.sort` order, the demo output would differ between runs, and this guide could not quote it. Determinism is a feature of a security demo. |
| `.slice(0, topK)` | The cut. This is the line `RETRIEVAL_TOPK` controls, and it decides whether the untrusted note reaches the model at all. |
| **What is missing** | There is no `if (document.trusted)` here, no filtering of untrusted content, and no attempt to sanitise. That absence is deliberate and it is the design decision of the chapter: **retrieval's job is relevance, and defence is not its job.** A retrieval function that tried to filter injections would be a filter with no visibility into the request, no audit trail, and no way to be tested — whereas `instructionGuardrails` (Chapter 08) sees the whole set of documents at once, labels each one, and records what it did. Put the defence where you can see it. |

**Why the untrusted note is *first*.** With the question *"I want a refund for my
order ORD-101"*, the note's first line — `my refund for order ORD-101 is still
pending` — shares `refund`, `order`, `ord` and `101` with the question: four of
four content terms. The return policy shares one (`refund`). That is a score of
1.00 against 0.25, and no amount of prompt engineering changes the fact that the
attacker's text is the most on-topic document in the corpus.

That is Chapter 04 §4.3 in one number.

---

## Checkpoint

Before Chapter 05, you should be able to answer:

1. Which single property of a retrieved document is preserved by the spread in
   `retrieve()`, and why does losing it matter?
2. Why does the untrusted note score 1.00 for a refund question, and what does
   that say about "just rank better" as a defence?
3. Why does `retrieve()` not filter untrusted documents out?
4. What does `RETRIEVAL_TOPK=1` change, and why is that a security decision?
5. Why is the sort tie-broken by id?

---

**Back to:** [Guide index](./README.md) · [Basic Code README](../README.md)

**Next:** [Chapter 05 — The Tools and the Risk Model](./05_The_Tools_And_The_Risk_Model.md)
