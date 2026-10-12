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
