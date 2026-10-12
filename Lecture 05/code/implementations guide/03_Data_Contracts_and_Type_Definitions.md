# Chapter 03: Data Contracts & Type Definitions

> **Chapter Goal:** Establish the architectural type system governing tool schemas, ReAct loop execution telemetry, token metrics, and Human-in-the-Loop governance state.

---

## 3.1 File Details & Purpose

| File | Target Path | Operational Purpose |
| :--- | :--- | :--- |
| **`tool.types.ts`** | `Lecture 05/code/src/types/tool.types.ts` | Defines the generic `Tool<TArgs, TResult>` interface, the 3-Tier Tool classification (`ToolTier`), JSON Schema contracts, and execution response payloads. |
| **`agent.types.ts`** | `Lecture 05/code/src/types/agent.types.ts` | Defines `AgentStatus`, step-by-step telemetry traces (`AgentStepTrace`), final execution results, and token accounting metrics. |
| **`hitl.types.ts`** | `Lecture 05/code/src/types/hitl.types.ts` | Defines approval statuses, durable pending tickets (`PendingApprovalTicket`), and webhook resumption payloads. |

---

## 3.2 Full Code File: `src/types/tool.types.ts`

```typescript
import { z } from 'zod';

export type ToolTier = 'informative' | 'scoped_mutate' | 'critical_action';

export interface JSONSchemaDefinition {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
  enum?: string[];
  [key: string]: any;
}

export interface Tool<TArgs = any, TResult = any> {
  name: string;
  description: string;
  tier: ToolTier;
  parameters: JSONSchemaDefinition;
  argsSchema?: z.ZodSchema<TArgs>;
  requiresApproval?: (args: TArgs) => boolean;
  execute: (args: TArgs) => Promise<TResult>;
}

export interface ToolCallProposal {
  id: string;
  name: string;
  argumentsString: string;
  parsedArguments: any;
  parseError?: string;
}

export interface ToolExecutionResponse {
  toolCallId: string;
  name: string;
  status: 'success' | 'error' | 'approval_required';
  result?: any;
  errorMessage?: string;
}
```

---

## 3.3 Block-by-Block Explanation: `src/types/tool.types.ts`

### Block 1: Tool Tier Classification
```typescript
export type ToolTier = 'informative' | 'scoped_mutate' | 'critical_action';
```
- **`informative`:** Read-only tools with zero side effects (e.g. `calculate`, `getCurrentWeather`, `readFile`). Safe for unrestricted autonomous execution.
- **`scoped_mutate`:** Modifies environment within a bounded sandbox (e.g. `createDirectory`, `writeFile` inside `generated-sites/`).
- **`critical_action`:** Irreversible, high-value, or external actions (e.g. `refundCustomer`). Intercepted by governance approval gates.

### Block 2: The Generic Tool Interface
```typescript
export interface Tool<TArgs = any, TResult = any> {
  name: string;
  description: string;
  tier: ToolTier;
  parameters: JSONSchemaDefinition;
  argsSchema?: z.ZodSchema<TArgs>;
  requiresApproval?: (args: TArgs) => boolean;
  execute: (args: TArgs) => Promise<TResult>;
}
```
- **`parameters`:** The declarative JSON Schema sent over the wire to the foundation model.
- **`argsSchema`:** Optional Zod schema used by the application kernel to validate arguments at runtime before execution.
- **`requiresApproval`:** Dynamic predicate evaluating if specific arguments (e.g. `amount > 5000`) require human sign-off.
- **`execute`:** The strongly-typed asynchronous function executed on the host runtime.

---

## 3.4 Full Code File: `src/types/agent.types.ts`

```typescript
import OpenAI from 'openai';

export type AgentStatus =
  | 'completed'
  | 'paused_for_approval'
  | 'max_steps_exceeded'
  | 'timeout'
  | 'error';

export interface AgentStepTrace {
  step: number;
  timestamp: string;
  thoughtOrText?: string | null;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: any;
    status: 'success' | 'error' | 'approval_required';
    output: any;
  }>;
}

export interface TokenUsageMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export interface AgentExecutionResult {
  sessionId: string;
  status: AgentStatus;
  finalAnswer?: string;
  totalSteps: number;
  traces: AgentStepTrace[];
  tokenMetrics: TokenUsageMetrics;
  pendingApprovalTicketId?: string;
  error?: string;
}

export interface AgentEngineConfig {
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
  temperature?: number;
  systemPrompt?: string;
}
```

---

## 3.5 Block-by-Block Explanation: `src/types/agent.types.ts`

### Block 1: Agent Status Lifecycle
```typescript
export type AgentStatus =
  | 'completed'
  | 'paused_for_approval'
  | 'max_steps_exceeded'
  | 'timeout'
  | 'error';
```
- Categorizes all possible terminal and intermediate states of an autonomous loop.
- Enables callers to differentiate between clean goal fulfillment (`completed`), human authorization holds (`paused_for_approval`), and safety circuit-breaker trips (`max_steps_exceeded`).

### Block 2: Step Tracing Telemetry
```typescript
export interface AgentStepTrace {
  step: number;
  timestamp: string;
  thoughtOrText?: string | null;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: any;
    status: 'success' | 'error' | 'approval_required';
    output: any;
  }>;
}
```
- Provides granular, step-by-step observability into the agent's internal reasoning, proposed tool calls, parsed parameters, and environmental observations.

---

## 3.6 Full Code File: `src/types/hitl.types.ts`

```typescript
import OpenAI from 'openai';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface PendingApprovalTicket {
  ticketId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
  riskLevel: 'critical' | 'high' | 'medium';
  reason: string;
  createdAt: string;
  status: ApprovalStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  // Preserved state for resumption
  savedMessages: OpenAI.Chat.ChatCompletionMessageParam[];
}

export interface HITLResumePayload {
  ticketId: string;
  action: 'approve' | 'reject';
  reviewedBy: string;
  rejectionReason?: string;
}
```

---

## 3.7 Block-by-Block Explanation: `src/types/hitl.types.ts`

### Block 1: Durable Approval Ticket Interface
```typescript
export interface PendingApprovalTicket {
  ticketId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
  // ...
  savedMessages: OpenAI.Chat.ChatCompletionMessageParam[];
}
```
- **`savedMessages`:** Crucial field for durable pause/resume architectures. Preserves the full conversational context, assistant thoughts, and intermediate tool results so the agent can be rehydrated and continued minutes or hours later upon human webhook callback.
