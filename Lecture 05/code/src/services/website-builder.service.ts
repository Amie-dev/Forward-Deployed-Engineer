import { ToolRegistry, defaultWorkspaceTools } from '../tools/registry.js';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { WEBSITE_BUILDER_SYSTEM_PROMPT } from '../prompts/website-builder.prompt.js';
import { AgentExecutionResult } from '../types/agent.types.js';

export class WebsiteBuilderService {
  private engine: AgentExecutionEngine;

  constructor() {
    // Isolated registry with only WorkspaceTools for strict least privilege
    const workspaceRegistry = new ToolRegistry(defaultWorkspaceTools.getAllTools());
    this.engine = new AgentExecutionEngine(workspaceRegistry, {
      systemPrompt: WEBSITE_BUILDER_SYSTEM_PROMPT,
      temperature: 0.2
    });
  }

  public async buildSite(prompt: string): Promise<AgentExecutionResult> {
    await defaultWorkspaceTools.init();
    console.log(`[WebsiteBuilderService] Dispatched site generation for prompt: "${prompt}"`);
    return this.engine.execute(prompt);
  }
}

export const defaultWebsiteBuilderService = new WebsiteBuilderService();
