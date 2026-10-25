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
