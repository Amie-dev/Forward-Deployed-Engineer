import path from 'node:path';

import 'dotenv/config';
import { z } from 'zod';

import type { AccessContext } from '../types.js';

/**
 * Boot-time configuration.
 *
 * Everything is validated once, here, then passed down as a plain object. That
 * matters more than it looks: the ablation matrix in Chapter 10 re-runs the same
 * pipeline with *different* configs in one process, so config cannot be a global
 * that providers read at import time. It is a value, and values can be copied.
 */

/** The full knob set. `Partial<RagConfig>` is exactly what an ablation preset overrides. */
export interface RagConfig {
  // ── Chapter 02: chunking ──
  chunkStrategy: 'fixed' | 'structural';
  chunkSize: number;
  chunkOverlap: number;
  chunkUnit: 'tokens' | 'chars';
  parentMaxTokens: number;
  /** Structural chunking: merge sibling sections until a chunk reaches this size. */
  minChunkTokens: number;

  // ── Chapter 03: contextual retrieval ──
  contextualize: 'none' | 'template' | 'llm';
  /** 0 = child vector only, 1 = child vector fully replaced by its document context. */
  lateChunkAlpha: number;

  // ── Chapters 04-05: recall width ──
  kRetrieve: number;
  kContext: number;
  minScore: number;
  mmrLambda: number;

  // ── Chapter 07: hybrid ──
  hybrid: 'off' | 'rrf';
  rrfK: number;
  bm25K1: number;
  bm25B: number;

  // ── Chapter 08: reranking ──
  rerank: 'none' | 'heuristic' | 'cohere';
  rerankModel: string;
  /** Minimum score the best reranked candidate must reach, or the answer refuses. */
  rerankMinBest: number;
  rerankMaxDrop: number;

  // ── Chapter 09: context assembly ──
  maxContextTokens: number;
  expandParents: boolean;
  bookendOrder: boolean;

  // ── Providers ──
  embedding: { provider: 'hash' | 'openai'; model: string; dimensions: number };
  generation: { provider: 'extractive' | 'openai'; model: string };
  openaiApiKey?: string;
  cohereApiKey?: string;
}

const optionalKey = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const schema = z
  .object({
    EMBEDDING_PROVIDER: z.enum(['auto', 'hash', 'openai']).default('auto'),
    EMBEDDING_MODEL: z.string().trim().optional(),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(1024),
    OPENAI_API_KEY: optionalKey,
    LLM_PROVIDER: z.enum(['auto', 'extractive', 'openai']).default('auto'),
    CHAT_MODEL: z.string().trim().default('gpt-4o-mini'),

    CHUNK_STRATEGY: z.enum(['fixed', 'structural']).default('structural'),
    CHUNK_SIZE: z.coerce.number().int().min(40).max(4000).default(400),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2000).default(80),
    CHUNK_UNIT: z.enum(['tokens', 'chars']).default('tokens'),
    PARENT_MAX_TOKENS: z.coerce.number().int().min(0).max(4000).default(700),
    MIN_CHUNK_TOKENS: z.coerce.number().int().min(0).max(2000).default(150),

    CONTEXTUALIZE: z.enum(['none', 'template', 'llm']).default('template'),
    LATE_CHUNK_ALPHA: z.coerce.number().min(0).max(1).default(0.25),

    K_RETRIEVE: z.coerce.number().int().min(1).max(200).default(25),
    K_CONTEXT: z.coerce.number().int().min(1).max(50).default(5),
    MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.15),
    MMR_LAMBDA: z.coerce.number().min(0).max(1).default(0),

    TENANT_ID: z.string().trim().default('northwind-eu'),
    ACL: z.string().default('support,customer'),
    AS_OF: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-06-01'),

    HYBRID: z.enum(['off', 'rrf']).default('rrf'),
    RRF_K: z.coerce.number().int().min(1).max(1000).default(60),
    BM25_K1: z.coerce.number().min(0).max(5).default(1.2),
    BM25_B: z.coerce.number().min(0).max(1).default(0.75),

    RERANK: z.enum(['none', 'heuristic', 'cohere']).default('heuristic'),
    RERANK_MODEL: z.string().trim().default('rerank-v3.5'),
    RERANK_MIN_BEST: z.coerce.number().min(0).max(1).default(0.25),
    RERANK_MAX_DROP: z.coerce.number().min(0).max(1).default(0.25),
    COHERE_API_KEY: optionalKey,

    MAX_CONTEXT_TOKENS: z.coerce.number().int().min(100).max(32000).default(1400),
    EXPAND_PARENTS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    BOOKEND_ORDER: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

    PORT: z.coerce.number().int().positive().default(3100),
  })
  .superRefine((value, context) => {
    // The single most common chunking bug: the window never advances.
    if (value.CHUNK_OVERLAP >= value.CHUNK_SIZE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP'],
        message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE.',
      });
    }
    if (value.K_CONTEXT > value.K_RETRIEVE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['K_CONTEXT'],
        message: 'K_CONTEXT cannot exceed K_RETRIEVE: you cannot use more chunks than you fetched.',
      });
    }
    if (value.EMBEDDING_PROVIDER === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.',
      });
    }
    if (value.RERANK === 'cohere' && !value.COHERE_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COHERE_API_KEY'],
        message: 'COHERE_API_KEY is required when RERANK=cohere.',
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] Invalid configuration:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  throw new Error('Environment validation failed. Copy .env.example to .env and fill it in.');
}

const raw = parsed.data;

/** "auto" keeps every script runnable with no account. */
const embeddingProvider =
  raw.EMBEDDING_PROVIDER === 'auto' ? (raw.OPENAI_API_KEY ? 'openai' : 'hash') : raw.EMBEDDING_PROVIDER;
const generationProvider =
  raw.LLM_PROVIDER === 'auto' ? (raw.OPENAI_API_KEY ? 'openai' : 'extractive') : raw.LLM_PROVIDER;

export const config: RagConfig = {
  chunkStrategy: raw.CHUNK_STRATEGY,
  chunkSize: raw.CHUNK_SIZE,
  chunkOverlap: raw.CHUNK_OVERLAP,
  chunkUnit: raw.CHUNK_UNIT,
  parentMaxTokens: raw.PARENT_MAX_TOKENS,
  minChunkTokens: raw.MIN_CHUNK_TOKENS,

  contextualize: raw.CONTEXTUALIZE,
  lateChunkAlpha: raw.LATE_CHUNK_ALPHA,

  kRetrieve: raw.K_RETRIEVE,
  kContext: raw.K_CONTEXT,
  minScore: raw.MIN_SCORE,
  mmrLambda: raw.MMR_LAMBDA,

  hybrid: raw.HYBRID,
  rrfK: raw.RRF_K,
  bm25K1: raw.BM25_K1,
  bm25B: raw.BM25_B,

  rerank: raw.RERANK,
  rerankModel: raw.RERANK_MODEL,
  rerankMinBest: raw.RERANK_MIN_BEST,
  rerankMaxDrop: raw.RERANK_MAX_DROP,

  maxContextTokens: raw.MAX_CONTEXT_TOKENS,
  expandParents: raw.EXPAND_PARENTS,
  bookendOrder: raw.BOOKEND_ORDER,

  embedding: {
    provider: embeddingProvider,
    model:
      raw.EMBEDDING_MODEL ?? (embeddingProvider === 'hash' ? 'hash-1024-v1' : 'text-embedding-3-small'),
    dimensions: raw.EMBEDDING_DIMENSIONS,
  },
  generation: {
    provider: generationProvider,
    model: raw.CHAT_MODEL,
  },
  openaiApiKey: raw.OPENAI_API_KEY,
  cohereApiKey: raw.COHERE_API_KEY,
};

/** Paths are resolved once, relative to the project root (two levels above src/). */
export const paths = {
  root: path.resolve(import.meta.dirname, '../..'),
  policies: path.resolve(import.meta.dirname, '../../data/policies'),
  golden: path.resolve(import.meta.dirname, '../../data/eval/golden.json'),
} as const;

/** Who the demo asks as. The API takes these from the request, never from env. */
export function defaultAccess(): AccessContext {
  return {
    tenantId: raw.TENANT_ID,
    acl: raw.ACL.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    asOf: raw.AS_OF,
  };
}

export const serverConfig = { port: raw.PORT } as const;
