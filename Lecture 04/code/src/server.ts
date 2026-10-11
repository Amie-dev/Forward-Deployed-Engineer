import { app } from './app.js';
import { config } from './config/env.js';
import { isLiveApiKeyConfigured } from './lib/openai.js';

const server = app.listen(config.PORT, () => {
  console.log('================================================================');
  console.log('🚀 LECTURE 04: ENTERPRISE CONVERSATIONAL AI MICROSERVICE');
  console.log('================================================================');
  console.log(`📡 Server Port:        ${config.PORT}`);
  console.log(`🤖 Target Model:       ${config.AI_MODEL}`);
  console.log(`🌡️  Temperature:        ${config.AI_TEMPERATURE}`);
  console.log(`🧮 Max Context Tokens: ${config.MAX_CONTEXT_TOKENS}`);
  console.log(`🔑 Live OpenAI Key:    ${isLiveApiKeyConfigured() ? '✅ Configured' : '⚠️ Offline / Mock Mode'}`);
  console.log('----------------------------------------------------------------');
  console.log('Available Endpoints:');
  console.log(`  GET    http://localhost:${config.PORT}/health`);
  console.log(`  POST   http://localhost:${config.PORT}/api/chat         (Sync Multi-Turn)`);
  console.log(`  POST   http://localhost:${config.PORT}/api/chat/stream  (Real-Time SSE Stream)`);
  console.log(`  POST   http://localhost:${config.PORT}/api/chat/grounded (Zod Structured Output)`);
  console.log(`  GET    http://localhost:${config.PORT}/api/chat/sessions/:id (Session Inspection)`);
  console.log(`  DELETE http://localhost:${config.PORT}/api/chat/sessions/:id (Session Eviction)`);
  console.log('================================================================');
});

// ============================================================================
// Graceful Process Termination Handlers
// ============================================================================

const shutdown = (signal: string) => {
  console.log(`\nReceived ${signal}. Initiating graceful shutdown...`);
  server.close(() => {
    console.log('✅ HTTP server closed cleanly. Process exiting.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
