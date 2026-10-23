import type { Config } from "../config/config.js";
import type { Chunk, Document } from "../models/types.js";
import { contentHash } from "../utils/hash.js";

/**
 * Chapters 02 and 03 — chunking.
 *
 * A chunk is a promise that this text can be found, cited and reasoned about on
 * its own. Two strategies from the notes:
 *
 *   fixed       cut every `chunkSize` tokens, step by `chunkSize - chunkOverlap`
 *   structural  cut on the document's own headings (structure beats statistics)
 *
 * Both attach a **breadcrumb** (`Title → Section`) to the embedded text, because
 * "Electronic products can be returned within 7 days" is ambiguous without it.
 *
 * The `Chunk` contract lives in `models/types.ts` (Chapter 02) and the content
 * hash in `utils/hash.ts` (Chapter 03); this file owns *where* the cuts happen.
 */

function toChunk(doc: Document, index: number, breadcrumb: string, body: string): Chunk {
  const text = `${breadcrumb}\n${body}`.trim();
  return {
    id: `${doc.id}#${index}#${contentHash(text)}`,
    docId: doc.id,
    text,
    body: body.trim(),
    breadcrumb,
    category: doc.category,
    tenant: doc.tenant,
    acl: doc.acl,
    effectiveFrom: doc.effectiveFrom,
    supersededOn: doc.supersededOn,
  };
}

/**
 * Chapter 02 — fixed-size chunking with overlap.
 *
 *   step        = S - O
 *   chunk i     = tokens [i*step, i*step + S)
 *   chunk count = ceil((N - O) / (S - O))
 *
 * Overlap is insurance against a sentence straddling a cut. It does **not** fix
 * a rule separated from its exception — that is what Chapter 03 is for.
 */
export function fixedChunks(doc: Document, cfg: Config): Chunk[] {
  const size = Math.max(cfg.chunkSize, 1);
  const overlap = Math.min(Math.max(cfg.chunkOverlap, 0), size - 1);
  const step = size - overlap;
  const tokens = doc.text.split(/\s+/).filter(Boolean);
  const chunks: Chunk[] = [];

  for (let start = 0, index = 0; start < tokens.length; index++) {
    const window = tokens.slice(start, start + size);
    chunks.push(toChunk(doc, index, doc.title, window.join(" ")));
    if (start + size >= tokens.length) break;
    start += step;
  }
  return chunks;
}

/**
 * Chapter 03 — structural chunking.
 *
 * Cut where the document says to cut: on `##` headings. The heading path becomes
 * the breadcrumb, so the rule and its scope travel together.
 *
 * Note the Chapter 02 "parameter trap": Spring AI's `withMinChunkSizeChars(150)`
 * is the minimum length considered *while seeking a boundary*, not a strict
 * minimum chunk length — so this function does not merge small sections either.
 */
export function structuralChunks(doc: Document): Chunk[] {
  const sections: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } = { heading: doc.title, lines: [] };

  for (const line of doc.text.split("\n")) {
    if (line.startsWith("## ")) {
      sections.push(current);
      current = { heading: line.slice(3).trim(), lines: [] };
    } else if (line.startsWith("# ")) {
      continue; // the document title already owns the breadcrumb
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const kept = sections.filter((s) => s.lines.join(" ").trim().length > 0);
  return kept.map((section, index) =>
    toChunk(doc, index, `${doc.title} → ${section.heading}`, section.lines.join("\n")),
  );
}

/** Chapter 02 — the strategy is a switch, not a rewrite. */
export function chunkDocument(doc: Document, cfg: Config): Chunk[] {
  return cfg.chunkStrategy === "fixed" ? fixedChunks(doc, cfg) : structuralChunks(doc);
}

export function chunkCorpus(docs: Document[], cfg: Config): Chunk[] {
  return docs.flatMap((doc) => chunkDocument(doc, cfg));
}
