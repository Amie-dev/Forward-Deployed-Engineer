import OpenAI from 'openai';
import { Tool } from '../types/tool.types.js';
import { calculatorTool } from './calculator.tool.js';
import { weatherTool } from './weather.tool.js';
import { currencyTool } from './currency.tool.js';
import { refundTool } from './refund.tool.js';
import { WorkspaceTools } from './workspace.tools.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(initialTools: Tool[] = []) {
    for (const tool of initialTools) {
      this.register(tool);
    }
  }

  public register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public list(): Tool[] {
    return Array.from(this.tools.values());
  }

  public getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Formats tools into standard OpenAI ChatCompletionTool JSON Schema wire payload
   */
  public getWireDefinitions(): OpenAI.Chat.ChatCompletionTool[] {
    return this.list().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }
}

// Global default workspace tools instance
export const defaultWorkspaceTools = new WorkspaceTools();

// Global default tool registry containing conversational + workspace tools
export const defaultToolRegistry = new ToolRegistry([
  calculatorTool,
  weatherTool,
  currencyTool,
  refundTool,
  ...defaultWorkspaceTools.getAllTools()
]);
