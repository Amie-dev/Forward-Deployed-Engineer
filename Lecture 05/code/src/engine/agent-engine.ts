import OpenAI from 'openai';
import { env, isLiveOpenAIEnabled } from '../config/env.js';
import { ToolRegistry } from '../tools/registry.js';
import { TokenLedger } from './token-ledger.js';
import {
  AgentEngineConfig,
  AgentExecutionResult,
  AgentStepTrace,
  AgentStatus
} from '../types/agent.types.js';
import { defaultHITLService, HITLApprovalService } from '../services/hitl-approval.service.js';
import { PendingApprovalTicket } from '../types/hitl.types.js';

export class AgentExecutionEngine {
  private openai: OpenAI | null = null;
  private registry: ToolRegistry;
  private hitlService: HITLApprovalService;
  private ledger: TokenLedger;
  private config: Required<AgentEngineConfig>;

  constructor(
    registry: ToolRegistry,
    config: AgentEngineConfig = {},
    hitlService: HITLApprovalService = defaultHITLService
  ) {
    this.registry = registry;
    this.hitlService = hitlService;
    this.ledger = new TokenLedger();

    this.config = {
      model: config.model || env.AI_MODEL,
      maxSteps: config.maxSteps || env.AGENT_MAX_STEPS,
      timeoutMs: config.timeoutMs || env.AGENT_TIMEOUT_MS,
      temperature: config.temperature ?? env.AI_TEMPERATURE,
      systemPrompt: config.systemPrompt || 'You are an autonomous AI agent equipped with tools.'
    };

    if (isLiveOpenAIEnabled()) {
      this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  /**
   * Primary entry point: Executes a user goal through the autonomous ReAct loop
   */
  public async execute(userGoal: string, sessionId?: string): Promise<AgentExecutionResult> {
    const activeSessionId = sessionId || `sess_${Math.random().toString(36).substring(2, 9)}`;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.config.systemPrompt },
      { role: 'user', content: userGoal }
    ];

    return this.runLoop(activeSessionId, messages, 0, []);
  }

  /**
   * Resumes an execution loop that was paused for Human-in-the-Loop review
   */
  public async resume(
    ticketId: string,
    action: 'approve' | 'reject',
    reviewedBy: string,
    rejectionReason?: string
  ): Promise<AgentExecutionResult> {
    const ticket = this.hitlService.resolveTicket(ticketId, action, reviewedBy, rejectionReason);
    const messages = [...ticket.savedMessages];

    let toolOutputContent: string;

    if (action === 'approve') {
      const tool = this.registry.get(ticket.toolName);
      if (!tool) {
        toolOutputContent = JSON.stringify({ error: `Tool ${ticket.toolName} not found during resumption.` });
      } else {
        try {
          const result = await tool.execute(ticket.arguments);
          toolOutputContent = JSON.stringify({ status: 'approved_and_executed', result });
        } catch (err: any) {
          toolOutputContent = JSON.stringify({ error: `Tool execution failed: ${err.message}` });
        }
      }
    } else {
      toolOutputContent = JSON.stringify({
        status: 'rejected_by_human_supervisor',
        reviewedBy,
        rejectionReason: rejectionReason || 'Action declined by organizational safety policy.'
      });
    }

    // Append resolved tool output message to message history
    messages.push({
      role: 'tool',
      tool_call_id: ticket.toolCallId,
      content: toolOutputContent
    });

    return this.runLoop(ticket.sessionId, messages, 1, []);
  }

  /**
   * Core ReAct loop runner
   */
  private async runLoop(
    sessionId: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    initialStep: number = 0,
    traces: AgentStepTrace[] = []
  ): Promise<AgentExecutionResult> {
    let currentStep = initialStep;
    const toolDefs = this.registry.getWireDefinitions();

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      while (currentStep < this.config.maxSteps) {
        currentStep++;

        let assistantMessage: OpenAI.Chat.ChatCompletionMessage;

        if (this.openai) {
          // Live OpenAI inference
          const response = await this.openai.chat.completions.create(
            {
              model: this.config.model,
              messages,
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              tool_choice: 'auto',
              temperature: this.config.temperature
            },
            { signal: controller.signal }
          );

          assistantMessage = response.choices[0].message;
          const usage = response.usage;
          if (usage) {
            this.ledger.recordUsage(usage.prompt_tokens, usage.completion_tokens);
          }
        } else {
          // Deterministic Offline Simulator for environments without live OpenAI API keys
          assistantMessage = await this.simulateStep(messages, currentStep);
          this.ledger.recordUsage(250 + currentStep * 80, 60);
        }

        // Add assistant message into history
        messages.push(assistantMessage);

        const stepTrace: AgentStepTrace = {
          step: currentStep,
          timestamp: new Date().toISOString(),
          thoughtOrText: assistantMessage.content,
          toolCalls: []
        };

        // 1. Check termination condition: Model concluded without invoking tools
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          traces.push(stepTrace);
          return {
            sessionId,
            status: 'completed',
            finalAnswer: assistantMessage.content || 'Goal executed successfully.',
            totalSteps: currentStep,
            traces,
            tokenMetrics: this.ledger.getMetrics()
          };
        }

        // 2. Process tool calls
        let pausedTicket: PendingApprovalTicket | null = null;
        const toolResultsForNextTurn: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const tool = this.registry.get(toolName);

          let parsedArgs: any = {};
          let parseError: string | null = null;

          try {
            parsedArgs = JSON.parse(toolCall.function.arguments);
          } catch (e: any) {
            parseError = `Failed to parse arguments JSON: ${e.message}`;
          }

          // Check if tool exists
          if (!tool) {
            const errString = JSON.stringify({
              error: `Tool '${toolName}' not found in registry. Available tools: ${this.registry.getNames().join(', ')}`
            });

            stepTrace.toolCalls?.push({
              id: toolCall.id,
              name: toolName,
              args: parsedArgs,
              status: 'error',
              output: errString
            });

            toolResultsForNextTurn.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: errString
            });
            continue;
          }

          // Check argument parse error
          if (parseError) {
            stepTrace.toolCalls?.push({
              id: toolCall.id,
              name: toolName,
              args: toolCall.function.arguments,
              status: 'error',
              output: parseError
            });

            toolResultsForNextTurn.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: parseError })
            });
            continue;
          }

          // Check Human-In-The-Loop Governance Policy
          if (tool.requiresApproval && tool.requiresApproval(parsedArgs)) {
            const ticket = this.hitlService.createTicket({
              ticketId: `TICK-${Math.random().toString(36).substring(2, 9).toUpperCase()}`,
              sessionId,
              toolCallId: toolCall.id,
              toolName,
              arguments: parsedArgs,
              riskLevel: 'critical',
              reason: `Tool '${toolName}' requested action requiring explicit managerial approval.`,
              savedMessages: [...messages]
            });

            pausedTicket = ticket;

            stepTrace.toolCalls?.push({
              id: toolCall.id,
              name: toolName,
              args: parsedArgs,
              status: 'approval_required',
              output: `Execution paused. Pending approval ticket #${ticket.ticketId}`
            });

            // Stop processing further parallel tools once a HITL gate triggers
            break;
          }

          // Execute tool with runtime error boundary
          let resultString: string;
          let executionStatus: 'success' | 'error' = 'success';

          try {
            const rawResult = await tool.execute(parsedArgs);
            resultString = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
          } catch (execErr: any) {
            executionStatus = 'error';
            resultString = JSON.stringify({
              status: 'error',
              error: `Tool execution failed: ${execErr.message || 'Unknown error'}`
            });
          }

          stepTrace.toolCalls?.push({
            id: toolCall.id,
            name: toolName,
            args: parsedArgs,
            status: executionStatus,
            output: resultString
          });

          toolResultsForNextTurn.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultString
          });
        }

        traces.push(stepTrace);

        // If a HITL gate was triggered, pause the engine immediately
        if (pausedTicket) {
          return {
            sessionId,
            status: 'paused_for_approval',
            totalSteps: currentStep,
            traces,
            tokenMetrics: this.ledger.getMetrics(),
            pendingApprovalTicketId: pausedTicket.ticketId,
            finalAnswer: `Action paused: Tool '${pausedTicket.toolName}' requires human authorization. Ticket #${pausedTicket.ticketId} created.`
          };
        }

        // Append all tool observations into message history for the next iteration
        messages.push(...toolResultsForNextTurn);
      }

      // Max steps circuit breaker reached
      return {
        sessionId,
        status: 'max_steps_exceeded',
        totalSteps: currentStep,
        traces,
        tokenMetrics: this.ledger.getMetrics(),
        error: `Agent reached maximum allowed iteration budget (${this.config.maxSteps} turns) without reaching a termination token.`
      };
    } catch (loopErr: any) {
      if (controller.signal.aborted) {
        return {
          sessionId,
          status: 'timeout',
          totalSteps: currentStep,
          traces,
          tokenMetrics: this.ledger.getMetrics(),
          error: `Agent exceeded timeout budget of ${this.config.timeoutMs}ms.`
        };
      }

      return {
        sessionId,
        status: 'error',
        totalSteps: currentStep,
        traces,
        tokenMetrics: this.ledger.getMetrics(),
        error: loopErr.message || 'Unexpected agent engine error'
      };
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * Deterministic Offline ReAct Simulator: Enables testing all lecture scenarios
   * (Multi-tool calculation, currency exchange, website generation, and HITL refund)
   * even without an external paid OpenAI API key.
   */
  /**
   * Helper to construct valid OpenAI ChatCompletionMessage objects for simulation
   */
  private createSimulatedMessage(
    content: string | null,
    tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[]
  ): OpenAI.Chat.ChatCompletionMessage {
    return {
      role: 'assistant',
      content,
      refusal: null,
      tool_calls
    };
  }

  /**
   * Deterministic Offline ReAct Simulator: Enables testing all lecture scenarios
   * (Multi-tool calculation, currency exchange, website generation, and HITL refund)
   * even without an external paid OpenAI API key.
   */
  private async simulateStep(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    step: number
  ): Promise<OpenAI.Chat.ChatCompletionMessage> {
    const userPrompt = messages.find((m) => m.role === 'user')?.content?.toString() || '';
    const lastMessage = messages[messages.length - 1];

    // Scenario A: Website Generation (e.g. BrewLab or NeuralForge)
    if (userPrompt.toLowerCase().includes('website') || userPrompt.toLowerCase().includes('landing page')) {
      const siteName = userPrompt.toLowerCase().includes('neuralforge') ? 'neuralforge' : 'brewlab';

      if (step === 1) {
        return this.createSimulatedMessage(null, [
          {
            id: 'call_dir_1',
            type: 'function',
            function: {
              name: 'createDirectory',
              arguments: JSON.stringify({ path: siteName })
            }
          }
        ]);
      }

      if (step === 2) {
        const title = siteName === 'neuralforge' ? 'NeuralForge — Next-Gen AI Robotics' : 'BrewLab Artisanal Coffee';
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="navbar">
    <div class="logo">${siteName.toUpperCase()}</div>
    <nav><a href="#about">About</a><a href="#featured">Featured</a><a href="#contact">Contact</a></nav>
  </header>
  <main>
    <section class="hero">
      <h1>${title}</h1>
      <p>Precision craftsmanship meets modern innovation.</p>
      <button id="cta-btn" class="btn">Explore Now</button>
    </section>
  </main>
  <script src="script.js"></script>
</body>
</html>`;
        return this.createSimulatedMessage(null, [
          {
            id: 'call_html_2',
            type: 'function',
            function: {
              name: 'writeFile',
              arguments: JSON.stringify({ path: `${siteName}/index.html`, content: html })
            }
          }
        ]);
      }

      if (step === 3) {
        const css = `:root {
  --bg: #0f172a;
  --text: #f8fafc;
  --accent: #d97706;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.navbar { display: flex; justify-content: space-between; padding: 1.5rem 2rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
.navbar nav a { color: var(--text); margin-left: 1.5rem; text-decoration: none; }
.hero { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 70vh; text-align: center; padding: 2rem; }
.hero h1 { font-size: 3rem; margin-bottom: 1rem; color: var(--accent); }
.btn { margin-top: 1.5rem; padding: 0.75rem 1.75rem; background: var(--accent); border: none; color: #fff; font-weight: 600; border-radius: 8px; cursor: pointer; }`;
        return this.createSimulatedMessage(null, [
          {
            id: 'call_css_3',
            type: 'function',
            function: {
              name: 'writeFile',
              arguments: JSON.stringify({ path: `${siteName}/style.css`, content: css })
            }
          }
        ]);
      }

      if (step === 4) {
        const js = `document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('cta-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      alert('Welcome to ${siteName}! Order placed successfully.');
    });
  }
});`;
        return this.createSimulatedMessage(null, [
          {
            id: 'call_js_4',
            type: 'function',
            function: {
              name: 'writeFile',
              arguments: JSON.stringify({ path: `${siteName}/script.js`, content: js })
            }
          }
        ]);
      }

      if (step === 5) {
        return this.createSimulatedMessage(null, [
          {
            id: 'call_verify_5',
            type: 'function',
            function: {
              name: 'listFiles',
              arguments: JSON.stringify({ path: siteName })
            }
          }
        ]);
      }

      return this.createSimulatedMessage(
        `I have completed creating the static website for ${siteName}. All files (index.html, style.css, script.js) have been created and verified inside generated-sites/${siteName}/.`
      );
    }

    // Scenario B: Parallel Tool Dispatch (Weather in Delhi + Currency Conversion)
    if (
      userPrompt.toLowerCase().includes('weather') ||
      (userPrompt.toLowerCase().includes('delhi') && userPrompt.toLowerCase().includes('rupees'))
    ) {
      if (step === 1) {
        return this.createSimulatedMessage(null, [
          {
            id: 'call_weather_1',
            type: 'function',
            function: {
              name: 'getCurrentWeather',
              arguments: JSON.stringify({ city: 'Delhi' })
            }
          },
          {
            id: 'call_curr_2',
            type: 'function',
            function: {
              name: 'convertCurrency',
              arguments: JSON.stringify({ amount: 500, from: 'USD', to: 'INR' })
            }
          }
        ]);
      }

      return this.createSimulatedMessage(
        'In Delhi, the current weather is 34°C with hazy sun (humidity 45%, wind 12 km/h). $500 USD converts to approximately ₹47,500 INR (at 1 USD = 95 INR).'
      );
    }

    // Scenario C: Multi-Tool Chaining (Convert Currency then Divide among 6 people)
    if (
      userPrompt.toLowerCase().includes('divide') ||
      (userPrompt.toLowerCase().includes('rupees') && userPrompt.toLowerCase().includes('convert'))
    ) {
      if (step === 1) {
        return this.createSimulatedMessage(null, [
          {
            id: 'call_curr_1',
            type: 'function',
            function: {
              name: 'convertCurrency',
              arguments: JSON.stringify({ amount: 120, from: 'USD', to: 'INR' })
            }
          }
        ]);
      }

      if (step === 2 && lastMessage.role === 'tool') {
        return this.createSimulatedMessage(null, [
          {
            id: 'call_calc_2',
            type: 'function',
            function: {
              name: 'calculate',
              arguments: JSON.stringify({ operation: 'divide', a: 11400, b: 6 })
            }
          }
        ]);
      }

      return this.createSimulatedMessage(
        '120 USD converts to approximately ₹11,400 INR (at 1 USD = 95 INR). Divided equally among 6 people, each person receives ₹1,900 INR.'
      );
    }

    // Scenario C: High-Value Refund (HITL Test)
    if (userPrompt.toLowerCase().includes('refund')) {
      if (step === 1) {
        return this.createSimulatedMessage(null, [
          {
            id: 'call_refund_1',
            type: 'function',
            function: {
              name: 'refundCustomer',
              arguments: JSON.stringify({
                orderId: 'ORD-50001',
                amount: 50000,
                reason: 'Item not delivered on time'
              })
            }
          }
        ]);
      }

      return this.createSimulatedMessage('Your refund request has been processed according to managerial review.');
    }

    // Default Fallback
    return this.createSimulatedMessage(
      'I have processed your request. Please specify which task or tool you would like to run.'
    );
  }
}
