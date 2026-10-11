# Chapter 03: Data Contracts & Strongly-Typed Domain Schemas

> **Chapter Goal:** Establish the domain type contracts and validation schemas for conversational roles, messages, session states, context budget metrics, and OpenAI Structured Output responses using TypeScript and Zod.

---

## 3.1 File Location & Directory Setup

```bash
mkdir -p "src/types"
touch "src/types/chat.types.ts"
```

Target File: `src/types/chat.types.ts`

---

## 3.2 Complete Source Code: `src/types/chat.types.ts`

```typescript
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
```

---

## 3.3 Block-by-Block Technical Explanation

### Block 1: Role Decoupling & Message Contracts
```typescript
export const ChatRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().min(1, 'Message content cannot be empty'),
  timestamp: z.number().default(() => Date.now()),
  tokens: z.number().optional(),
});
```
- **What it does:** Enforces the strict three-role taxonomy (`system`, `user`, `assistant`).
- **Why this is critical:** Eliminates the vulnerability of prompt contamination by preventing user content from masquerading as system-level directives. Every message carries an immutable timestamp and estimated token footprint.

### Block 2: Application Memory & Session State Interfaces
```typescript
export interface UserProfileMemory {
  userId: string;
  name?: string;
  dietaryPreferences?: string[];
  loyaltyTier?: 'STANDARD' | 'GOLD' | 'VIP';
  notes?: string[];
}

export interface ChatSession {
  sessionId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  runningSummary: string;
  cumulativeTurns: number;
}
```
- **What it does:** Implements the **Application Memory Pattern**. Separates dynamic customer facts (e.g., dietary restrictions, VIP tier) from neural weights.
- **How it works:** `ChatSession` stores the raw conversational turns, while `runningSummary` retains the synthesized background context created during rolling compaction.

### Block 3: Context Budget Metrics
```typescript
export interface ContextBudgetMetrics {
  totalEstimatedTokens: number;
  systemTokens: number;
  summaryTokens: number;
  historyTokens: number;
  includedTurns: number;
  discardedTurns: number;
  savingsRatioPercent: number;
}
```
- **What it does:** Provides detailed telemetry regarding the instantaneous state of the context window.
- **Why this matters for FDEs:** Allows API responses and logging dashboards to prove how many tokens were saved through sliding window truncation compared to naive $O(N^2)$ accumulation.

### Block 4: Grounded Response Schema (OpenAI Structured Outputs)
```typescript
export const GroundedResponseSchema = z.object({
  answer: z.string().describe('The direct, empathetic answer to the user query.'),
  confidenceScore: z.number().min(0).max(1),
  citedFacts: z.array(z.string()),
  isRefusal: z.boolean(),
  unverifiedClaimsDetected: z.boolean(),
});
```
- **What it does:** Defines the JSON Schema contract passed to OpenAI's constrained decoding engine (`response_format: zodResponseFormat(GroundedResponseSchema, ...)`).
- **How it works:** Forces the foundation model's sampling logits to emit valid JSON matching this schema, completely eliminating JSON parse errors and guaranteeing that `isRefusal` and `unverifiedClaimsDetected` flags are strictly emitted.
