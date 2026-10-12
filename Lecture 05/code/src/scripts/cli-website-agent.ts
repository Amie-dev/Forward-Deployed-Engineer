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
