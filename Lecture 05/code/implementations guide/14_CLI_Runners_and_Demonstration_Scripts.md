# Chapter 14: CLI Runners and Demonstration Scripts

## 1. Overview & File Metadata
- **Target File Paths**:
  - `Lecture 05/code/src/scripts/cli-multitool-agent.ts`
  - `Lecture 05/code/src/scripts/cli-website-agent.ts`
  - `Lecture 05/code/src/scripts/test-hitl-flow.ts`
- **TypeScript Module**: NodeNext ES Module
- **Key Responsibilities**:
  1. Provides standalone executable CLI runners that test and demonstrate all core concepts taught in Lecture 05 without requiring an HTTP client or Postman.
  2. `cli-multitool-agent.ts`: Demonstrates both sequential tool chaining (USD $\rightarrow$ INR $\rightarrow$ division by 6) and parallel tool dispatch (Delhi weather + USD $\rightarrow$ INR).
  3. `cli-website-agent.ts`: Demonstrates the autonomous website builder agent creating a complete production-grade landing page (`index.html`, `style.css`, `script.js`) in `./generated-sites/brewlab`.
  4. `test-hitl-flow.ts`: Demonstrates the complete Human-in-the-Loop lifecycle (initial request $\rightarrow$ pause $\rightarrow$ ticket generation $\rightarrow$ manager review $\rightarrow$ async resumption).

### Terminal Commands
Run each script using `npm` scripts defined in `package.json`:
```bash
# 1. Run Multi-Tool Chaining & Parallel Dispatch
npm run agent:multitool

# 2. Run Autonomous Website Builder Agent
npm run agent:website

# 3. Run Human-in-the-Loop Governance Flow
npm run test:hitl
```

---

## 2. Complete Source Code

### File 1: `src/scripts/cli-multitool-agent.ts`
```typescript
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { defaultToolRegistry } from '../tools/registry.js';
import { GENERAL_AGENT_SYSTEM_PROMPT } from '../prompts/general-agent.prompt.js';

async function main() {
  console.log('========================================================================');
  console.log('🤖 CLI MULTI-TOOL AGENT RUNNER');
  console.log('Demonstrating Sequential Dependency Chaining and Parallel Tool Dispatch');
  console.log('========================================================================\n');

  const engine = new AgentExecutionEngine(defaultToolRegistry, {
    systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
  });

  // TEST 1: Sequential Chaining (Currency -> Calculator)
  console.log('------------------------------------------------------------------------');
  console.log('TEST 1: Sequential Chaining (USD to INR then Divide Among 6 People)');
  console.log('------------------------------------------------------------------------');
  const query1 = 'Convert $120 into Indian rupees and then divide that amount equally among 6 people.';
  console.log(`User Goal: "${query1}"\n`);

  const result1 = await engine.execute(query1);

  console.log('\n--- EXECUTION TRACE ---');
  for (const trace of result1.traces) {
    console.log(`[Step ${trace.step}] ${trace.thoughtOrText ? `Thought: ${trace.thoughtOrText}` : ''}`);
    if (trace.toolCalls && trace.toolCalls.length > 0) {
      for (const tc of trace.toolCalls) {
        console.log(`   🛠️  Invoked Tool: ${tc.name}(${JSON.stringify(tc.args)}) -> ${JSON.stringify(tc.output)}`);
      }
    }
  }

  console.log(`\n🎉 Final Answer: ${result1.finalAnswer}`);
  console.log(`📊 Total Steps: ${result1.totalSteps} | Estimated Cost: $${result1.tokenMetrics.estimatedCostUSD}\n`);

  // TEST 2: Parallel Dispatch (Weather + Currency Conversion)
  console.log('------------------------------------------------------------------------');
  console.log('TEST 2: Parallel Tool Execution (Delhi Weather + USD Currency Conversion)');
  console.log('------------------------------------------------------------------------');
  const query2 = 'I am travelling to Delhi. What is the current weather there, and how much is $500 in Indian rupees?';
  console.log(`User Goal: "${query2}"\n`);

  const result2 = await engine.execute(query2);

  console.log('\n--- EXECUTION TRACE ---');
  for (const trace of result2.traces) {
    console.log(`[Step ${trace.step}] ${trace.thoughtOrText ? `Thought: ${trace.thoughtOrText}` : ''}`);
    if (trace.toolCalls && trace.toolCalls.length > 0) {
      for (const tc of trace.toolCalls) {
        console.log(`   🛠️  Invoked Tool: ${tc.name}(${JSON.stringify(tc.args)}) -> ${JSON.stringify(tc.output)}`);
      }
    }
  }

  console.log(`\n🎉 Final Answer: ${result2.finalAnswer}`);
  console.log(`📊 Total Steps: ${result2.totalSteps} | Estimated Cost: $${result2.tokenMetrics.estimatedCostUSD}`);
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
```

---

### File 2: `src/scripts/cli-website-agent.ts`
```typescript
import { defaultWebsiteBuilderService } from '../services/website-builder.service.js';
import * as path from 'path';

async function main() {
  console.log('========================================================================');
  console.log('🌐 CLI AUTONOMOUS WEBSITE BUILDER AGENT');
  console.log('Executing Closed-Loop Workspace File Creation & Verification');
  console.log('========================================================================\n');

  const goal =
    'Create a premium landing page for a coffee shop called BrewLab. Use a dark elegant design with a hero section, featured coffees, customer testimonials and a contact section.';

  console.log(`User Goal: "${goal}"\n`);

  const result = await defaultWebsiteBuilderService.buildSite(goal);

  console.log('\n--- AUTONOMOUS AGENT EXECUTION TRACE ---');
  for (const trace of result.traces) {
    console.log(`[Step ${trace.step}] ${trace.thoughtOrText ? `Agent Thought: ${trace.thoughtOrText}` : ''}`);
    if (trace.toolCalls && trace.toolCalls.length > 0) {
      for (const tc of trace.toolCalls) {
        console.log(`   📂 Action: ${tc.name}(${JSON.stringify(tc.args)})`);
        console.log(`      Observation: ${tc.output}`);
      }
    }
  }

  console.log('\n========================================================================');
  console.log(`✅ RESULT STATUS: ${result.status.toUpperCase()}`);
  console.log(`📝 AGENT SUMMARY: ${result.finalAnswer}`);
  console.log(`📊 TOTAL ITERATIONS: ${result.totalSteps}`);
  console.log(`💰 ESTIMATED TOKEN COST: $${result.tokenMetrics.estimatedCostUSD}`);
  console.log(
    `🌍 LOCAL SITE URL: http://localhost:8080/sites/brewlab/index.html`
  );
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
```

---

### File 3: `src/scripts/test-hitl-flow.ts`
```typescript
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { defaultToolRegistry } from '../tools/registry.js';
import { defaultHITLService } from '../services/hitl-approval.service.js';
import { GENERAL_AGENT_SYSTEM_PROMPT } from '../prompts/general-agent.prompt.js';

async function main() {
  console.log('========================================================================');
  console.log('🛡️ HUMAN-IN-THE-LOOP (HITL) GOVERNANCE FLOW TEST');
  console.log('Testing Pause, Ticket Creation, Managerial Review & Asynchronous Resumption');
  console.log('========================================================================\n');

  const engine = new AgentExecutionEngine(defaultToolRegistry, {
    systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
  });

  const goal = 'Please process a refund of ₹50,000 for customer order ORD-50001 due to non-delivery.';
  console.log(`Step 1: User issues critical high-impact request: "${goal}"\n`);

  // 1. Initial Execution -> Should trigger pause
  const initialResult = await engine.execute(goal);

  console.log(`Agent Execution Status: ${initialResult.status.toUpperCase()}`);
  console.log(`Agent Notification: ${initialResult.finalAnswer}`);
  console.log(`Pending Ticket ID: ${initialResult.pendingApprovalTicketId}\n`);

  if (initialResult.status !== 'paused_for_approval' || !initialResult.pendingApprovalTicketId) {
    throw new Error('Expected agent execution to pause with an approval ticket!');
  }

  // 2. Inspect Pending Approvals
  const pendingTickets = defaultHITLService.listPending();
  console.log(`Step 2: Checking Managerial Queue (${pendingTickets.length} pending tickets):`);
  const ticket = pendingTickets[0];
  console.log(`   Ticket ID:   ${ticket.ticketId}`);
  console.log(`   Tool Name:   ${ticket.toolName}`);
  console.log(`   Arguments:   ${JSON.stringify(ticket.arguments)}`);
  console.log(`   Risk Level:  ${ticket.riskLevel.toUpperCase()}`);
  console.log(`   Reason:      ${ticket.reason}\n`);

  // 3. Simulate Human Manager Approval
  console.log('Step 3: Human Support Manager reviews and APPROVES ticket...');
  const resumeResult = await engine.resume(
    ticket.ticketId,
    'approve',
    'Senior Manager Sarah Connor',
    'Verified non-delivery claim with logistics carrier.'
  );

  console.log('\n--- RESUMPTION TRACE ---');
  for (const trace of resumeResult.traces) {
    console.log(`[Step ${trace.step}] ${trace.thoughtOrText ? `Thought: ${trace.thoughtOrText}` : ''}`);
    if (trace.toolCalls) {
      for (const tc of trace.toolCalls) {
        console.log(`   ⚖️ Tool Output: ${tc.name} -> ${JSON.stringify(tc.output)}`);
      }
    }
  }

  console.log('\n========================================================================');
  console.log(`✅ FINAL STATUS: ${resumeResult.status.toUpperCase()}`);
  console.log(`📢 FINAL RESPONSE: ${resumeResult.finalAnswer}`);
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('Fatal HITL Test Error:', err);
  process.exit(1);
});
```

---

## 3. Block-by-Block Code Explanation

### Part A: Multi-Tool Chaining and Parallel Dispatch (`cli-multitool-agent.ts`)

#### Block 1: Initial Setup and Test 1 (Sequential Chaining)
```typescript
  const engine = new AgentExecutionEngine(defaultToolRegistry, {
    systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
  });

  const query1 = 'Convert $120 into Indian rupees and then divide that amount equally among 6 people.';
  const result1 = await engine.execute(query1);
```
- **What this block does**:
  - Initializes the engine with the general system prompt and the default tool registry.
  - Submits a query that has an inherent sequential dependency: the conversion rate must be resolved *first* before the division can be computed.
- **How it works**:
  - The agent first calls `convertCurrency({ amount: 120, from: 'USD', to: 'INR' })`.
  - Upon receiving `11400 INR`, the agent calls `calculate({ operation: 'divide', a: 11400, b: 6 })`.
  - Finally, the agent concludes with `1900 INR`.

#### Block 2: Test 2 (Parallel Tool Execution)
```typescript
  const query2 = 'I am travelling to Delhi. What is the current weather there, and how much is $500 in Indian rupees?';
  const result2 = await engine.execute(query2);
```
- **What this block does**:
  - Submits a query with two orthogonal, independent requirements.
- **How it works**:
  - In a single turn, the agent outputs two parallel tool calls: `getCurrentWeather({ city: 'Delhi' })` and `convertCurrency({ amount: 500, from: 'USD', to: 'INR' })`.
  - Both tool calls execute in the same turn, reducing round-trip latency by half.

---

### Part B: Website Builder CLI Runner (`cli-website-agent.ts`)

#### Block 1: Goal Submission and Dispatch
```typescript
  const goal =
    'Create a premium landing page for a coffee shop called BrewLab. Use a dark elegant design with a hero section, featured coffees, customer testimonials and a contact section.';

  const result = await defaultWebsiteBuilderService.buildSite(goal);
```
- **What this block does**:
  - Formulates a complete product prompt for an artisanal coffee shop landing page named "BrewLab".
  - Calls `defaultWebsiteBuilderService.buildSite(goal)`.
- **How it works**:
  - Dispatches the website builder agent through its 5-step loop:
    1. `createDirectory({ path: 'brewlab' })`
    2. `writeFile({ path: 'brewlab/index.html', content: '...' })`
    3. `writeFile({ path: 'brewlab/style.css', content: '...' })`
    4. `writeFile({ path: 'brewlab/script.js', content: '...' })`
    5. `listFiles({ path: 'brewlab' })`

#### Block 2: Telemetry and Inspection Logging
```typescript
  for (const trace of result.traces) {
    console.log(`[Step ${trace.step}] ${trace.thoughtOrText ? `Agent Thought: ${trace.thoughtOrText}` : ''}`);
    if (trace.toolCalls && trace.toolCalls.length > 0) {
      for (const tc of trace.toolCalls) {
        console.log(`   📂 Action: ${tc.name}(${JSON.stringify(tc.args)})`);
        console.log(`      Observation: ${tc.output}`);
      }
    }
  }
```
- **What this block does**:
  - Unrolls the ReAct trace tree and prints the step-by-step actions and observations to stdout.
  - Outputs the local browser preview URL: `http://localhost:8080/sites/brewlab/index.html`.

---

### Part C: Human-in-the-Loop Test Flow (`test-hitl-flow.ts`)

#### Block 1: High-Impact Request and Pause Invariant
```typescript
  const goal = 'Please process a refund of ₹50,000 for customer order ORD-50001 due to non-delivery.';
  const initialResult = await engine.execute(goal);

  if (initialResult.status !== 'paused_for_approval' || !initialResult.pendingApprovalTicketId) {
    throw new Error('Expected agent execution to pause with an approval ticket!');
  }
```
- **What this block does**:
  - Triggers a financial refund that exceeds the $100 (₹9,500) automatic approval threshold.
  - Asserts that the engine halted execution, returning `paused_for_approval` along with a valid ticket ID.

#### Block 2: Ticket Queue Inspection
```typescript
  const pendingTickets = defaultHITLService.listPending();
  const ticket = pendingTickets[0];
```
- **What this block does**:
  - Simulates an administrator querying the pending approvals queue.
  - Inspects the arguments, risk level (`CRITICAL`), and policy trigger reason.

#### Block 3: Supervisory Resolution and Resumption
```typescript
  const resumeResult = await engine.resume(
    ticket.ticketId,
    'approve',
    'Senior Manager Sarah Connor',
    'Verified non-delivery claim with logistics carrier.'
  );
```
- **What this block does**:
  - Resumes execution by supplying approval credentials and an audit trail rationale.
  - Verifies that the agent receives the approved tool result and synthesizes its final confirmation message.
