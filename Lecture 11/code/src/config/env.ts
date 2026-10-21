import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * Boot-time configuration.
 *
 * Fail fast and loudly: a missing key or an impossible chunk size should stop
 * the process, not surface as a 500 on the first customer question.
 *
 * Both provider pairs default to "auto": if an OpenAI key exists you get real
 * embeddings and a real model, otherwise the deterministic offline pair. That
 * keeps `npm run demo` and `npm run eval` runnable with no account.
 */
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    EMBEDDING_PROVIDER: z.enum(['openai', 'mock']).optional(),
    EMBEDDING_MODEL: z.string().trim().optional(),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(1024),

    LLM_PROVIDER: z.enum(['openai', 'extractive']).optional(),
    CHAT_MODEL: z.string().trim().default('gpt-4o-mini'),
    OPENAI_API_KEY: z.string().trim().optional(),

    KNOWLEDGE_DIR: z.string().default('knowledge'),
    CHUNK_SIZE: z.coerce.number().int().min(50).max(2000).default(300),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).max(1000).default(50),
    AUTO_INGEST: booleanString.default('true'),

    TOP_K: z.coerce.number().int().min(1).max(20).default(4),
    CANDIDATE_MULTIPLIER: z.coerce.number().int().min(1).max(10).default(3),
    MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.15),
    HYBRID_LEXICAL_WEIGHT: z.coerce.number().min(0).max(1).default(0.35),
    MAX_CONTEXT_TOKENS: z.coerce.number().int().min(100).max(16000).default(1200),

    HISTORY_TURNS: z.coerce.number().int().min(0).max(50).default(6),
    SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),

    VECTOR_STORE: z.enum(['memory', 'pinecone']).default('memory'),
    INDEX_PATH: z.string().default('data/index.json'),
    PINECONE_API_KEY: z.string().trim().optional(),
    PINECONE_INDEX_NAME: z.string().default('shop-support'),
    PINECONE_NAMESPACE: z.string().default('policies'),
  })
  .superRefine((value, context) => {
    const embeddingProvider = value.EMBEDDING_PROVIDER ?? (value.OPENAI_API_KEY ? 'openai' : 'mock');
    const llmProvider = value.LLM_PROVIDER ?? (value.OPENAI_API_KEY ? 'openai' : 'extractive');

    if (embeddingProvider === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.',
      });
    }
    if (llmProvider === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai.',
      });
    }
    if (value.VECTOR_STORE === 'pinecone' && !value.PINECONE_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PINECONE_API_KEY'],
        message: 'PINECONE_API_KEY is required when VECTOR_STORE=pinecone.',
      });
    }
    if (value.CHUNK_OVERLAP >= value.CHUNK_SIZE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP'],
        message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE, or the window never advances.',
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
const embeddingProvider = raw.EMBEDDING_PROVIDER ?? (raw.OPENAI_API_KEY ? 'openai' : 'mock');
const llmProvider = raw.LLM_PROVIDER ?? (raw.OPENAI_API_KEY ? 'openai' : 'extractive');

export const env = {
  ...raw,
  EMBEDDING_PROVIDER: embeddingProvider,
  EMBEDDING_MODEL:
    raw.EMBEDDING_MODEL || (embeddingProvider === 'mock' ? 'mock-hash-v1' : 'text-embedding-3-small'),
  LLM_PROVIDER: llmProvider,
  KNOWLEDGE_DIR: path.resolve(CODE_ROOT, raw.KNOWLEDGE_DIR),
  INDEX_PATH: path.resolve(CODE_ROOT, raw.INDEX_PATH),
} as const;

export type Env = typeof env;
