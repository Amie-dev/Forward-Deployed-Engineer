import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

/**
 * Zod validation schema for boot-time environment variables.
 * Enforces fail-fast principles if critical infrastructure configuration is missing.
 */
const envSchema = z.object({
  PORT: z
    .string()
    .default('8080')
    .transform((val) => parseInt(val, 10))
    .refine((port) => port > 0 && port < 65536, {
      message: 'PORT must be a valid port number (1-65535)',
    }),

  OPENAI_API_KEY: z
    .string()
    .min(1, 'OPENAI_API_KEY must not be empty')
    .default('your_openai_api_key_here'),

  AI_MODEL: z.string().default('gpt-4o-mini'),

  AI_TEMPERATURE: z
    .string()
    .default('0.3')
    .transform((val) => parseFloat(val))
    .refine((temp) => temp >= 0.0 && temp <= 2.0, {
      message: 'AI_TEMPERATURE must be between 0.0 (deterministic) and 2.0 (creative)',
    }),

  MAX_CONTEXT_TOKENS: z
    .string()
    .default('3000')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val >= 500, {
      message: 'MAX_CONTEXT_TOKENS must be at least 500',
    }),

  SUMMARIZATION_THRESHOLD_TURNS: z
    .string()
    .default('6')
    .transform((val) => parseInt(val, 10))
    .refine((val) => val >= 2, {
      message: 'SUMMARIZATION_THRESHOLD_TURNS must be at least 2 turns',
    }),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Critical Error: Invalid environment configuration:');
  console.error(parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;
