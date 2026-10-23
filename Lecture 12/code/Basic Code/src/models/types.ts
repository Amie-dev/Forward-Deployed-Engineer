/**
 * Chapter 02 — every data contract in one place.
 *
 * This file has **no imports**: it is the bottom of the dependency graph, so any
 * layer can depend on it and nothing can create a cycle. A contract lives here
 * when more than one layer needs to speak about it.
 */

/* ── Corpus — Chapter 04 ─────────────────────────────────────────────────── */

export type Category = "general" | "electronics" | "damaged" | "product" | "internal";

export type Document = {
  id: string;
  title: string;
  category: Category;
  tenant: string;
  acl: string[];
  effectiveFrom: string;
  supersededOn?: string;
  text: string;
};

/* ── Chunking — Chapters 05 ──────────────────────────────────────────────── */

export type Chunk = {
  /** Chapter 05 — `source + index + contentHash`: same text → same id. */
  id: string;
  docId: string;
  /** What gets embedded: breadcrumb + body. */
  text: string;
  /** The body alone, for display. */
  body: string;
  breadcrumb: string;
  category: string;
  tenant: string;
  acl: string[];
  effectiveFrom: string;
  supersededOn?: string;
};

/* ── Store and eligibility — Chapters 07 ─────────────────────────────────── */

export type IndexedChunk = Chunk & { vector: number[] };

export type Filter = {
  tenant: string;
  acl: string[];
  asOf: string;
  categories: string[];
};

/* ── Retrieval — Chapter 08 ──────────────────────────────────────────────── */

/** One ranked chunk. The `score` is a cosine, a BM25 value or an RRF value —
 *  the pipeline only ever orders by it, never compares two different ones. */
export type Hit = { chunk: IndexedChunk; score: number };

/* ── Context — Chapter 10 ────────────────────────────────────────────────── */

export type ContextBlock = {
  label: number;
  chunkId: string;
  docId: string;
  heading: string;
  body: string;
  meta: string;
};

export type AssembledContext = {
  text: string;
  blocks: ContextBlock[];
  ids: string[];
  tokens: number;
};

/* ── Generation — Chapter 11 ─────────────────────────────────────────────── */

export type Answer = { text: string; citations: number[]; refused: boolean };

/* ── Pipeline — Chapter 12 ───────────────────────────────────────────────── */

export type Trace = {
  question: string;
  chunks: number;
  eligible: number;
  filter: Filter;
  dense: Hit[];
  lexical: Hit[];
  fused: Hit[];
  candidates: Hit[];
  reranked: Hit[];
  passed: boolean;
  context: AssembledContext;
  answer: Answer;
  timings: Record<string, number>;
};

/* ── Evaluation — Chapter 13 ─────────────────────────────────────────────── */

export type GoldenCase = {
  question: string;
  expectedDocs: string[];
  answerable: boolean;
};

export type CaseResult = {
  question: string;
  expected: string[];
  retrieved: string[];
  recall: number;
  precision: number;
  reciprocal: number;
  correct: number;
  tokens: number;
  refused: boolean;
};

export type Metrics = {
  chunks: number;
  recall: number;
  precision: number;
  mrr: number;
  refusal: number;
  contextTokens: number;
};

/* ── HTTP — Chapters 14–16 ───────────────────────────────────────────────── */

export type SearchRequest = { question: string };
export type AskRequest = { question: string };
export type ErrorResponse = { error: string };
