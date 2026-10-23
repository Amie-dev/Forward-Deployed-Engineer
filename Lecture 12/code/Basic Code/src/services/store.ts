import type { Config } from "../config/config.js";
import type { Document, Filter, IndexedChunk } from "../models/types.js";
import { chunkCorpus } from "./chunking.js";
import { DOCUMENTS } from "./documents.js";
import { embed } from "./embeddings.js";

/**
 * Chapters 04 and 05 — the index and the eligibility filter.
 *
 * The store is in memory on purpose: it is big enough to demonstrate
 * pre-filtering, access control and time travel, and small enough to read.
 *
 * `IndexedChunk` and `Filter` are contracts (Chapter 02); this file owns the
 * ingest and the predicate.
 */

/**
 * Chapter 05 — the four production requirements, in one predicate.
 *
 *   server-derived scope  the caller never passes `tenantId` in the request
 *   fail closed           a missing tenant matches nothing, not everything
 *   same filter on both   the caller applies this before dense *and* lexical
 *   temporal predicate    `asOf` stops a superseded policy winning on similarity
 */
export function isEligible(chunk: IndexedChunk, filter: Filter): boolean {
  if (!filter.tenant) return false; // fail closed
  if (chunk.tenant !== filter.tenant) return false;
  if (!chunk.acl.some((role) => filter.acl.includes(role))) return false;
  if (!filter.categories.includes(chunk.category)) return false;
  if (chunk.effectiveFrom > filter.asOf) return false; // not yet in force
  if (chunk.supersededOn && chunk.supersededOn <= filter.asOf) return false; // replaced
  return true;
}

export function filterFrom(cfg: Config): Filter {
  return {
    tenant: cfg.tenantId,
    acl: cfg.acl,
    asOf: cfg.asOf,
    categories: cfg.categories,
  };
}

/**
 * Chapters 03–05 — ingest: chunk, validate, embed.
 *
 * The missing-field trap: a chunk without a category matches neither
 * `category == 'electronics'` nor `category != 'electronics'`, so we fail loudly
 * at ingest instead of defaulting silently.
 */
export function buildIndex(docs: Document[] = DOCUMENTS, cfg: Config): IndexedChunk[] {
  return chunkCorpus(docs, cfg).map((chunk) => {
    if (!chunk.category || !chunk.tenant || chunk.acl.length === 0) {
      throw new Error(`Ingest error: chunk ${chunk.id} is missing category/tenant/acl metadata.`);
    }
    return { ...chunk, vector: embed(chunk.text) };
  });
}

/** How many chunks the corpus produced — the Chapter 02/03 measurement. */
export function chunkStats(cfg: Config): { total: number; perDoc: Map<string, number> } {
  const chunks = chunkCorpus(DOCUMENTS, cfg);
  const perDoc = new Map<string, number>();
  for (const chunk of chunks) perDoc.set(chunk.docId, (perDoc.get(chunk.docId) ?? 0) + 1);
  return { total: chunks.length, perDoc };
}
