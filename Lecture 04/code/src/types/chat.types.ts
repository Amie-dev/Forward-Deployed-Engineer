import { z } from 'zod';

/**
 * Valid semantic message roles in LLM conversational architectures.
 */
export const ChatRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/**
 * Individual chat message with creation timestamp and optional metadata.
 */
export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().min(1, 'Message content cannot be empty'),
  timestamp: z.number().default(() => Date.now()),
  tokens: z.number().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Persistent user profile attributes (Application Memory pattern).
 */
export interface UserProfileMemory {
  userId: string;
  name?: string;
  dietaryPreferences?: string[];
  loyaltyTier?: 'STANDARD' | 'GOLD' | 'VIP';
  notes?: string[];
}

/**
 * Active conversational session state with running summary and memory tracking.
 */
export interface ChatSession {
  sessionId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  runningSummary: string;
  cumulativeTurns: number;
}

/**
 * Token budget metrics for context window management.
 */
export interface ContextBudgetMetrics {
  totalEstimatedTokens: number;
  systemTokens: number;
  summaryTokens: number;
  historyTokens: number;
  includedTurns: number;
  discardedTurns: number;
  savingsRatioPercent: number;
}

/**
 * Grounded Q&A response schema enforced via OpenAI Structured Outputs.
 */
export const GroundedResponseSchema = z.object({
  answer: z.string().describe('The direct, empathetic answer to the user query.'),
  confidenceScore: z.number().min(0).max(1).describe('Confidence score based strictly on provided context (0.0 to 1.0).'),
  citedFacts: z.array(z.string()).describe('Exact factual statements from context backing this answer.'),
  isRefusal: z.boolean().describe('True if the model refused due to missing or unverified context.'),
  unverifiedClaimsDetected: z.boolean().describe('True if the user made false or unverified premises in their question.'),
});
export type GroundedResponse = z.infer<typeof GroundedResponseSchema>;

/**
 * Knowledge chunk for RAG grounding.
 */
export interface KnowledgeFact {
  id: string;
  category: 'policy' | 'order' | 'restaurant' | 'menu';
  content: string;
  keywords: string[];
}

/**
 * Real-time SSE payload emitted to connected clients.
 */
export interface StreamChunkPayload {
  token?: string;
  done?: boolean;
  error?: string;
  finishReason?: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}
