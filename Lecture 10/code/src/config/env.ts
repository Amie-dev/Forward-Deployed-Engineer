import 'dotenv/config';
import { z } from 'zod';

/**
 * Boot-time environment validation.
 *
 * Fail fast and loudly: a missing API key or an invalid metric should stop the
 * process, not surface as a 500 on the first request.
 */
const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    EMBEDDING_PROVIDER: z.enum(['mock', 'openai', 'gemini']).default('mock'),
    EMBEDDING_MODEL: z.string().trim().optional(),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(8).max(3072).optional(),
    OPENAI_API_KEY: z.string().trim().optional(),
    GEMINI_API_KEY: z.string().trim().optional(),

    VECTOR_METRIC: z.enum(['cosine', 'dot', 'euclid', 'manhattan']).default('cosine'),
    DEFAULT_INDEX: z.enum(['flat', 'ivf', 'hnsw', 'pq']).default('flat'),
    AUTO_SEED: booleanString.default('true'),

    QDRANT_URL: z.string().url().default('http://localhost:6333'),
    QDRANT_API_KEY: z.string().trim().optional(),
    QDRANT_COLLECTION: z.string().default('lecture10_documents'),

    DATABASE_URL: z.string().optional(),
    PGVECTOR_TABLE: z.string().default('lecture10_documents'),
  })
  .superRefine((value, context) => {
    if (value.EMBEDDING_PROVIDER === 'openai' && !value.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.',
      });
    }
    if (value.EMBEDDING_PROVIDER === 'gemini' && !value.GEMINI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GEMINI_API_KEY'],
        message: 'GEMINI_API_KEY is required when EMBEDDING_PROVIDER=gemini.',
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
const defaultModel =
  raw.EMBEDDING_PROVIDER === 'mock'
    ? 'mock-hash-v1'
    : raw.EMBEDDING_PROVIDER === 'gemini'
      ? 'gemini-embedding-001'
      : 'text-embedding-3-small';
const model = raw.EMBEDDING_MODEL || defaultModel;
const defaultDimensions =
  raw.EMBEDDING_PROVIDER === 'mock' ? 128 : raw.EMBEDDING_PROVIDER === 'gemini' ? 3072 : 1536;

export const env = {
  ...raw,
  EMBEDDING_MODEL: model,
  EMBEDDING_DIMENSIONS: raw.EMBEDDING_DIMENSIONS ?? defaultDimensions,
};

export type Env = typeof env;
