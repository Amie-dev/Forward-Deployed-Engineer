import dotenv from 'dotenv';
import { z } from 'zod';

// Load variables from .env file
dotenv.config();

/**
 * Enterprise Environment Schema.
 * Validates critical settings at boot time to prevent mid-flight runtime crashes.
 */
const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  OPENAI_API_KEY: z.string({
    required_error: 'OPENAI_API_KEY is missing from environment. Please define it in your .env file.',
  }).min(1, 'OPENAI_API_KEY cannot be empty.'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
});

// Parse and validate environment variables
const parseResult = envSchema.safeParse({
  PORT: process.env.PORT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  AI_MODEL: process.env.AI_MODEL,
  AI_TEMPERATURE: process.env.AI_TEMPERATURE,
});

if (!parseResult.success) {
  console.error('❌ Environment Configuration Validation Failed:');
  console.error(JSON.stringify(parseResult.error.format(), null, 2));
  console.error('👉 Make sure you have created a valid .env file (see .env.example)');
  // We throw a descriptive error on boot
  throw new Error('Invalid environment configuration. Fix .env file before starting the service.');
}

export const config = parseResult.data;
