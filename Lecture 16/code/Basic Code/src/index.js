// Lecture 16 · Chapter 07 — the application entry point.
//
// It wires three things and nothing else: config -> service -> HTTP. Everything the
// lecture calls "the plumbing" is assembled here; everything it calls "the vision"
// lives behind the provider's API.
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config } from './config/config.js';
import { errorHandler } from './middleware/upload.js';
import { createRouter } from './routes/index.js';
import { ChatService } from './services/chatService.js';

// Exported so tests can build the app without opening a port.
export function createApp(chatService) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(chatService));
  app.use(errorHandler); // Chapter 08.4 — last stop, so it can catch everything above
  return app;
}

export function startServer() {
  const chatService = new ChatService();
  const app = createApp(chatService);
  return app.listen(config.port, config.host, () => {
    console.log(`Vision Chat is running at http://${config.host}:${config.port}`);
    console.log(
      process.env.OPENAI_API_KEY
        ? `Model: ${config.model}`
        : 'No OPENAI_API_KEY — POST /chat answers offline. Run `npm run demo` for the pipeline.',
    );
  });
}

// Only listen when this file is the entry point, so `import { createApp }` in the
// tests never opens a socket.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
