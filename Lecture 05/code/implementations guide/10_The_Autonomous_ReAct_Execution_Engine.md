# Chapter 10: The Autonomous ReAct Execution Engine

## 1. Overview & File Metadata
- **Target File Path**: `Lecture 05/code/src/engine/agent-engine.ts`
- **TypeScript Module**: NodeNext ES Module
- **Key Responsibilities**:
  1. Implements the core **Reason + Act (ReAct)** autonomous control loop.
  2. Orchestrates multi-step tool chaining, parallel tool invocations, and dynamic error recovery.
  3. Integrates enterprise circuit breakers: `maxSteps` iteration boundary, `timeoutMs` AbortSignal timer, and argument parse error catches.
  4. Manages Human-in-the-Loop (HITL) state persistence: halting loop execution upon Tier 3 actions and cleanly rehydrating state upon supervisor approval/rejection.
  5. Provides a deterministic offline simulator fallback so developers can run, test, and verify full lecture scenarios without incurring external API costs.

### Terminal Verification
To compile and test the execution engine:
```bash
npx tsc --noEmit
```

---

## 2. Complete Source Code

```typescript
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
```

---

## 3. Block-by-Block Code Explanation

### Block 1: Imports and Dependencies
```typescript
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
```
- **What this block does**:
  - Pulls in the OpenAI official client.
  - Imports validated environment settings and detection helper `isLiveOpenAIEnabled()`.
  - Imports `ToolRegistry`, `TokenLedger`, and domain types for traces, results, and HITL tickets.
- **How it works**:
  - Provides all components needed to govern agent lifecycle, telemetry, tool resolution, and safety authorization.

---

### Block 2: Engine State and Constructor
```typescript
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
```
- **What this block does**:
  - Declares private state: OpenAI client reference, tool registry, HITL service, token ledger, and engine configuration.
  - Merges caller-supplied `AgentEngineConfig` overrides with default environment variables (`AGENT_MAX_STEPS = 10`, `AGENT_TIMEOUT_MS = 60000`, `AI_TEMPERATURE = 0.2`).
  - Conditionally instantiates `new OpenAI({ apiKey: env.OPENAI_API_KEY })` only when a valid live API key is configured.
- **How it works**:
  - If `isLiveOpenAIEnabled()` returns false (e.g. running in offline test mode), `this.openai` remains `null`. The engine will cleanly branch to the internal simulator without crashing on startup.

---

### Block 3: Primary Entry Point (`execute`)
```typescript
  public async execute(userGoal: string, sessionId?: string): Promise<AgentExecutionResult> {
    const activeSessionId = sessionId || `sess_${Math.random().toString(36).substring(2, 9)}`;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.config.systemPrompt },
      { role: 'user', content: userGoal }
    ];

    return this.runLoop(activeSessionId, messages, 0, []);
  }
```
- **What this block does**:
  - Creates or adopts a persistent `sessionId`.
  - Initializes the dialogue conversation array with the system prompt and the user's initial goal prompt.
  - Launches `runLoop` starting at iteration 0 with an empty trace history.
- **How it works**:
  - Encapsulates clean conversational setup. Callers only need to pass `userGoal`.

---

### Block 4: Resumption Entry Point (`resume`)
```typescript
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

    messages.push({
      role: 'tool',
      tool_call_id: ticket.toolCallId,
      content: toolOutputContent
    });

    return this.runLoop(ticket.sessionId, messages, 1, []);
  }
```
- **What this block does**:
  - Resumes a paused execution when a human reviewer approves or rejects an action ticket.
  - Rehydrates the full message history saved in `ticket.savedMessages`.
  - If approved: fetches the tool from `this.registry` and executes it with `ticket.arguments`.
  - If rejected: formats an explicit supervisor rejection JSON message.
  - Appends the resulting `tool` observation message back onto the transcript with `ticket.toolCallId`.
  - Calls `runLoop` to let the LLM observe the approval/rejection and finalize its response.
- **How it works**:
  - Implements the complete enterprise Human-in-the-Loop authorization lifecycle. The LLM is never restarted from scratch; it resumes execution right where it paused.

---

### Block 5: The ReAct While-Loop and Circuit Breakers
```typescript
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
```
- **What this block does**:
  - Prepares the wire tool definitions via `registry.getWireDefinitions()`.
  - Sets up an `AbortController` and starts a `timeoutTimer` configured to `this.config.timeoutMs`.
  - Starts the ReAct `while (currentStep < this.config.maxSteps)` execution loop.
- **How it works**:
  - Protects production services against infinite loops and hung network sockets using strict step and time budgets.

---

### Block 6: Inference Dispatch & Token Ledger Accounting
```typescript
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
```
- **What this block does**:
  - Calls `openai.chat.completions.create` if live API access is active; otherwise routes to `this.simulateStep()`.
  - Intercepts token usage metrics from `response.usage` and records them into `this.ledger`.
  - Immediately appends `assistantMessage` into `messages` to preserve the conversational transcript.
- **How it works**:
  - Adheres strictly to the OpenAI wire protocol. In the multi-step ReAct pattern, the assistant message containing `tool_calls` **must** precede tool observation messages in the next turn.

---

### Block 7: Natural Termination Check
```typescript
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
```
- **What this block does**:
  - Checks if the model returned content *without* emitting any tool calls (`!assistantMessage.tool_calls || length === 0`).
  - If true, the agent has arrived at its final answer. The engine returns immediately with `status: 'completed'`.
- **How it works**:
  - Signals natural task termination. Once all tools have run and the model has synthesized the results, it speaks directly to the user.

---

### Block 8: Tool Call Processing, JSON Error Catching, and Parallel Execution
```typescript
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
            ...
            continue;
          }

          // Check argument parse error
          if (parseError) {
            ...
            continue;
          }
```
- **What this block does**:
  - Iterates over each tool call emitted by the assistant (supporting parallel tool invocations in a single turn).
  - Attempts to parse `toolCall.function.arguments` JSON.
  - If the model hallucinated an unknown tool name or produced invalid JSON, the engine captures the error into a tool error observation instead of throwing an unhandled exception.
- **How it works**:
  - This allows the agent to self-correct on the next iteration: the model sees the error string and repairs its JSON syntax or selects an available tool.

---

### Block 9: HITL Gate Check & Execution Boundary
```typescript
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
            ...
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
```
- **What this block does**:
  - Tests `tool.requiresApproval(parsedArgs)`. If true, constructs a pending approval ticket and immediately breaks out of the loop.
  - If approval is not required, executes `await tool.execute(parsedArgs)` inside a `try / catch` boundary.
- **How it works**:
  - Enforces the principle of least privilege and strict managerial oversight on high-impact tools (e.g. refunds > $100).

---

### Block 10: HITL Pause Handling and Turn Advancement
```typescript
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
```
- **What this block does**:
  - If `pausedTicket` exists, returns `{ status: 'paused_for_approval', pendingApprovalTicketId }`.
  - Otherwise, pushes all `toolResultsForNextTurn` onto the transcript and proceeds to turn $N+1$.
- **How it works**:
  - Completes the Observation phase of the ReAct triplet (Thought $\rightarrow$ Action $\rightarrow$ Observation).

---

### Block 11: Circuit Breaker and Timeout Error Handling
```typescript
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
```
- **What this block does**:
  - Catches runaway loops if `currentStep >= maxSteps`.
  - Catches `controller.signal.aborted` timeouts and returns a clean `timeout` status.
  - Clears `timeoutTimer` in a `finally` block to prevent resource leaks.

---

### Block 12: Offline Simulation Engine (`simulateStep`)
```typescript
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

  private async simulateStep(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    step: number
  ): Promise<OpenAI.Chat.ChatCompletionMessage> {
    ...
```
- **What this block does**:
  - Provides a deterministic state machine mimicking OpenAI API responses for the course's 4 core scenarios:
    1. **Website Generation**: Sequential creation of directory, `index.html`, `style.css`, `script.js`, and `listFiles` verification.
    2. **Parallel Tool Calling**: Concurrently invoking weather and currency conversion tools.
    3. **Multi-Step Tool Chaining**: Sequential currency conversion followed by division arithmetic.
    4. **HITL Refund**: Emitting a high-value `$50,000` refund tool call that triggers managerial pause.
- **How it works**:
  - The `createSimulatedMessage` helper explicitly sets `refusal: null` to conform strictly to OpenAI v4 TypeScript types.
  - Guarantees 100% reproducible tests across CI/CD and developer environments without requiring live API credentials.
