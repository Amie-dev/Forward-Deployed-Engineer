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
