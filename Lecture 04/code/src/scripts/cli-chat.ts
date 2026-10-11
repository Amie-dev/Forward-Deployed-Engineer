import readline from 'readline';
import { ContextManagerService } from '../services/context-manager.service.js';
import { SessionStore } from '../services/session.store.js';
import { openai, isLiveApiKeyConfigured } from '../lib/openai.js';
import { config } from '../config/env.js';

/**
 * Interactive Terminal Chatbot CLI with Real-Time Streaming
 *
 * Demonstrates:
 * - Multi-turn conversational memory hydration.
 * - Application Memory user profile integration.
 * - Progressive autoregressive token streaming to stdout.
 * - Dynamic context window budgeting.
 */
async function runInteractiveCli() {
  const sessionId = `cli_session_${Date.now()}`;
  const userId = 'user_vip_001'; // Uses preloaded VIP vegetarian profile
  const sessionStore = SessionStore.getInstance();
  const contextManager = new ContextManagerService();

  sessionStore.getOrCreateSession(sessionId, userId);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('================================================================');
  console.log('💬 TOMATO FOOD DELIVERY: INTERACTIVE TERMINAL CHATBOT');
  console.log('================================================================');
  console.log(`Session ID: ${sessionId}`);
  console.log(`User Profile: Aditya Sharma (Loyalty: VIP, Dietary: Strict Vegetarian)`);
  console.log(`Live Key: ${isLiveApiKeyConfigured() ? '✅ Connected' : '⚠️ Offline Simulation'}`);
  console.log('Type your message below. Type "exit" or "quit" to end the session.\n');

  const promptUser = () => {
    rl.question('\n👤 Customer: ', async (userInput) => {
      const trimmed = userInput.trim();
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\n👋 Closing chat session. Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (!trimmed) {
        promptUser();
        return;
      }

      // 1. Record user turn
      sessionStore.appendUserMessage(sessionId, trimmed);

      // 2. Prepare hydrated context
      const { messages: hydratedMessages, metrics } = await contextManager.prepareHydratedPayload(sessionId);

      process.stdout.write(`\n🤖 Tomato Assistant: `);

      let fullAnswer = '';

      if (isLiveApiKeyConfigured()) {
        try {
          const stream = await openai.chat.completions.create({
            model: config.AI_MODEL,
            messages: hydratedMessages as any,
            temperature: config.AI_TEMPERATURE,
            stream: true,
          });

          for await (const chunk of stream) {
            const token = chunk.choices[0]?.delta?.content || '';
            if (token) {
              fullAnswer += token;
              process.stdout.write(token);
            }
          }
        } catch (err: any) {
          console.error(`\n❌ API Error: ${err.message}`);
          fullAnswer = 'I apologize, but an error occurred during generation.';
        }
      } else {
        // Deterministic terminal simulation
        const mockResponse = `I see you are inquiring about "${trimmed}". As a VIP customer with strict vegetarian preferences, I've noted this in your active session. How can I assist further?`;
        for (const word of mockResponse.split(' ')) {
          process.stdout.write(`${word} `);
          await new Promise((r) => setTimeout(r, 40));
        }
        fullAnswer = mockResponse;
      }

      // 3. Record assistant response for future turns
      sessionStore.appendAssistantMessage(sessionId, fullAnswer);

      console.log(`\n\n[Telemetry]: Context Tokens: ${metrics.totalEstimatedTokens} | Savings: ${metrics.savingsRatioPercent}% | History Turns: ${metrics.includedTurns}`);

      promptUser();
    });
  };

  promptUser();
}

runInteractiveCli();
