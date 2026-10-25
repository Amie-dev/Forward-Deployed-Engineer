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
