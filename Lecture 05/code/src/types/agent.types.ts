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
