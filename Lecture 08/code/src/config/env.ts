import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3008),
  OPENAI_API_KEY: z.string().default('mock-key-for-development'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  DEFAULT_TOP_N: z.coerce.number().int().min(1).max(20).default(5),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export const isLiveOpenAIEnabled = (): boolean =>
  Boolean(
    env.OPENAI_API_KEY &&
    env.OPENAI_API_KEY !== 'your_openai_api_key_here' &&
    env.OPENAI_API_KEY !== 'mock-key-for-development'
  );
