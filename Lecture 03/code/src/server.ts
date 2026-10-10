import { app } from './app.js';
import { config } from './config/env.js';

app.listen(config.PORT, () => {
  console.log('================================================================');
  console.log(`🚀 Support Ticket Summarizer Microservice Started Successfully`);
  console.log(`📡 Server listening on: http://localhost:${config.PORT}`);
  console.log(`🤖 Configured AI Model: ${config.AI_MODEL}`);
  console.log(`🌡️  Configured Temperature: ${config.AI_TEMPERATURE}`);
  console.log(`🔍 Health Check: http://localhost:${config.PORT}/health`);
  console.log(`📝 Summarize API: http://localhost:${config.PORT}/api/summarize`);
  console.log('================================================================');
});
