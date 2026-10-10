/**
 * Direct Prototype Script (Chapter 02 & 04).
 * Equivalent to executing the raw request in Postman or curl.
 * Run via: npm run prototype
 */
import { openai } from '../lib/openai.js';
import { config } from '../config/env.js';

const sampleTicket = `
Hi team,
Our production deployment has failed three times since yesterday.
It looks like the payment-service container keeps restarting.
Customers are occasionally getting 502 errors during checkout.
We already tried restarting the deployment manually but the issue returned after approximately twenty minutes.
Can someone investigate urgently?
`.trim();

async function runDirectPrototype() {
  console.log('--- DIRECT API CALL PROTOTYPE ---');
  console.log(`Model: ${config.AI_MODEL}`);
  console.log(`Endpoint: https://api.openai.com/v1/chat/completions`);
  console.log('\n[Input Ticket]:\n', sampleTicket);

  const startTime = Date.now();

  const completion = await openai.chat.completions.create({
    model: config.AI_MODEL,
    messages: [
      {
        role: 'user',
        content: `Summarize this support ticket in two sentences:\n\n${sampleTicket}`,
      },
    ],
    temperature: config.AI_TEMPERATURE,
  });

  const durationMs = Date.now() - startTime;

  console.log('\n[Generated Summary]:');
  console.log(completion.choices[0]?.message?.content);

  console.log('\n[Execution Telemetry]:');
  console.log(`Response ID: ${completion.id}`);
  console.log(`Finish Reason: ${completion.choices[0]?.finish_reason}`);
  console.log(`Input Tokens: ${completion.usage?.prompt_tokens}`);
  console.log(`Output Tokens: ${completion.usage?.completion_tokens}`);
  console.log(`Total Tokens: ${completion.usage?.total_tokens}`);
  console.log(`Total Latency: ${durationMs} ms`);
}

runDirectPrototype().catch((err) => {
  console.error('Prototype failed:', err);
  process.exit(1);
});
