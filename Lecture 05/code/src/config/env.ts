import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  OPENAI_API_KEY: z.string().default('mock-key-for-development'),
  AI_MODEL: z.string().default('gpt-4o'),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(30).default(12),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60000),
  WORKSPACE_DIR: z.string().default('generated-sites'),
  HITL_FINANCIAL_THRESHOLD: z.coerce.number().default(5000)
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export const isLiveOpenAIEnabled = (): boolean => {
  return Boolean(
    env.OPENAI_API_KEY &&
    env.OPENAI_API_KEY !== 'your_openai_api_key_here' &&
    env.OPENAI_API_KEY !== 'mock-key-for-development'
  );
};
