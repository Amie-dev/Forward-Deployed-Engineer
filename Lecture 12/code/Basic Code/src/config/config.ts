import "dotenv/config";

/**
 * Chapters 02, 04, 05, 06, 07, 08 — every control of the lecture in one object.
 *
 * One key per knob in the notes, each with a default, so a chapter can be
 * switched off from `.env` and the Chapter 09 ablation becomes one line.
 */
export const config = {
  // ── Chapter 02/03 — chunking ──────────────────────────────
  // `structural` cuts on headings; `fixed` cuts every `chunkSize` tokens and
  // steps by `chunkSize - chunkOverlap`.
  chunkStrategy: (process.env.CHUNK_STRATEGY ?? "structural") as "fixed" | "structural",
  // Scaled down from the lecture's 400–600 so the tiny corpus has visible cuts.
  chunkSize: Number(process.env.CHUNK_SIZE ?? 40),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP ?? 8),

  // ── Chapter 04 — how many, and how good ───────────────────
  // K is a budget: retrieve generously, present sparingly.
  kRetrieve: Number(process.env.K_RETRIEVE ?? 10),
  kContext: Number(process.env.K_CONTEXT ?? 4),
  // The floor is the only mechanism that lets the pipeline come back empty.
  minScore: Number(process.env.MIN_SCORE ?? 0.15),

  // ── Chapter 05 — eligibility, not preference ──────────────
  tenantId: process.env.TENANT_ID ?? "northwind",
  acl: (process.env.ACL ?? "support,customer").split(",").map((s) => s.trim()),
  asOf: process.env.AS_OF ?? "2026-06-01",
  categories: (process.env.CATEGORIES ?? "electronics,damaged,product,general")
    .split(",")
    .map((s) => s.trim()),

  // ── Chapter 06 — meaning + exact terms ────────────────────
  hybrid: (process.env.HYBRID ?? "rrf") as "off" | "rrf",
  rrfK: Number(process.env.RRF_K ?? 60),
  bm25K1: Number(process.env.BM25_K1 ?? 1.2),
  bm25B: Number(process.env.BM25_B ?? 0.75),

  // ── Chapter 07 — rerank a small candidate set ─────────────
  rerank: (process.env.RERANK ?? "on") as "off" | "on",
  // The gate: if the best candidate cannot reach this, refuse. Calibrated on
  // this corpus — a legitimate question scores ~0.27+, an off-topic one ~0.
  rerankMinBest: Number(process.env.RERANK_MIN_BEST ?? 0.2),

  // ── Chapter 08 — what reaches the prompt ──────────────────
  maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS ?? 900),
};

/** The shape every service accepts, so a preset can be `{ ...config, ... }`. */
export type Config = typeof config;
