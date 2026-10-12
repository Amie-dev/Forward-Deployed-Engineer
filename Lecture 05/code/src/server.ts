import { createApp } from './app.js';
import { env, isLiveOpenAIEnabled } from './config/env.js';
import { defaultWorkspaceTools } from './tools/registry.js';

async function bootstrap() {
  // Ensure workspace directory exists on startup
  await defaultWorkspaceTools.init();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`
========================================================================
🚀 LECTURE 05: AUTONOMOUS AI AGENT MICROSERVICE RUNNING
========================================================================
📡 Server URL:         http://localhost:${env.PORT}
🏥 Health Check:       http://localhost:${env.PORT}/health
💬 Multi-Tool Chat:    POST http://localhost:${env.PORT}/api/chat
🌐 Website Generator:  POST http://localhost:${env.PORT}/api/generate-site
🔒 Approvals Queue:    GET  http://localhost:${env.PORT}/api/approvals
⚖️ Webhook Resume:     POST http://localhost:${env.PORT}/api/agent/resume
📂 Generated Sites:    http://localhost:${env.PORT}/sites/<site-name>/index.html
🧠 Active Model:       ${env.AI_MODEL}
🔑 Live OpenAI Mode:   ${isLiveOpenAIEnabled() ? 'ENABLED (Live API)' : 'MOCK / SIMULATOR MODE'}
📁 Workspace Dir:      ${defaultWorkspaceTools.getWorkspaceRoot()}
========================================================================
`);
  });

  // Graceful shutdown handling
  const shutdown = () => {
    console.log('\n[Server] Gracefully terminating HTTP listener...');
    server.close(() => {
      console.log('[Server] Service terminated successfully.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap failure:', err);
  process.exit(1);
});
