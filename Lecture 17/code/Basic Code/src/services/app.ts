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
