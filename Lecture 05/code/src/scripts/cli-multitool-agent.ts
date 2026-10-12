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
