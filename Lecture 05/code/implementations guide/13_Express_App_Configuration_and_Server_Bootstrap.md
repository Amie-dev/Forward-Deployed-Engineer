# Chapter 13: Express App Configuration and Server Bootstrap

## 1. Overview & File Metadata
- **Target File Paths**:
  - `Lecture 05/code/src/app.ts`
  - `Lecture 05/code/src/server.ts`
- **TypeScript Module**: NodeNext ES Module
- **Key Responsibilities**:
  1. Implements the Express application factory pattern (`createApp`) to decouple server creation from port binding (essential for automated integration testing).
  2. Configures production middleware: CORS, body parsers with 10MB limits (supporting large HTML/CSS/JS payloads), and latency logging.
  3. Exposes live static asset serving via `express.static` at `/sites`, allowing immediate in-browser inspection of websites synthesized by the agent.
  4. Provides graceful shutdown orchestration listening for `SIGTERM` and `SIGINT` signals.

### Terminal Commands
To build and start the Express microservice:
```bash
# Build TypeScript
npm run build

# Start production server
npm start

# Or run in live watch development mode
npm run dev
```

---

## 2. Complete Source Code

### File 1: `src/app.ts`
```typescript
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as path from 'path';
import { env } from './config/env.js';
import { chatRouter } from './routes/chat.routes.js';
import { websiteRouter } from './routes/website.routes.js';
import { hitlRouter } from './routes/hitl.routes.js';
import { defaultWorkspaceTools } from './tools/registry.js';

export function createApp(): Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  // Serve generated websites statically for live browser viewing
  const workspacePath = defaultWorkspaceTools.getWorkspaceRoot();
  app.use('/sites', express.static(workspacePath));

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'Lecture 05 Autonomous AI Agent Service',
      model: env.AI_MODEL,
      workspace: env.WORKSPACE_DIR
    });
  });

  // Mount API Routers
  app.use('/api/chat', chatRouter);
  app.use('/api/generate-site', websiteRouter);
  app.use('/api/approvals', hitlRouter);
  app.use('/api/agent', hitlRouter);

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: `The requested route '${req.method} ${req.originalUrl}' does not exist.`
    });
  });

  // Global Error Handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled Server Exception:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: err.message || 'An unexpected error occurred.'
    });
  });

  return app;
}
```

---

### File 2: `src/server.ts`
```typescript
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
```

---

## 3. Block-by-Block Code Explanation

### Part A: Application Factory (`app.ts`)

#### Block 1: Factory Declaration and Middleware Pipeline
```typescript
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as path from 'path';
import { env } from './config/env.js';
import { chatRouter } from './routes/chat.routes.js';
import { websiteRouter } from './routes/website.routes.js';
import { hitlRouter } from './routes/hitl.routes.js';
import { defaultWorkspaceTools } from './tools/registry.js';

export function createApp(): Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
```
- **What this block does**:
  - Exposes `createApp(): Express` as a factory function.
  - Applies `cors()` enabling cross-origin browser fetch requests.
  - Applies `express.json({ limit: '10mb' })` to safely receive complex multi-turn tool traces and complete webpage code structures without triggering HTTP 413 Payload Too Large.
- **How it works**:
  - Encapsulating setup in a factory function avoids side-effects when importing the app into Supertest or automated test runners.

#### Block 2: Request Telemetry Middleware
```typescript
  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    });
    next();
  });
```
- **What this block does**:
  - Tracks the exact elapsed execution time of every HTTP request.
  - Hooks into the `finish` event of Node's HTTP response stream.
- **How it works**:
  - Vital for LLM agent microservices: agent execution loops take anywhere from 800ms to 8,000ms. Logging the duration provides immediate latency visibility.

#### Block 3: Static Asset Serving for Generated Websites
```typescript
  // Serve generated websites statically for live browser viewing
  const workspacePath = defaultWorkspaceTools.getWorkspaceRoot();
  app.use('/sites', express.static(workspacePath));
```
- **What this block does**:
  - Mounts `express.static` pointed directly at the workspace root directory (e.g. `./generated-sites`).
- **How it works**:
  - When the agent builds a website in `generated-sites/brewlab`, users or frontend developers can immediately open `http://localhost:3000/sites/brewlab/index.html` in any web browser to view, click, and interact with the live rendered website.

#### Block 4: Routes, 404, and Central Error Boundaries
```typescript
  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'Lecture 05 Autonomous AI Agent Service',
      model: env.AI_MODEL,
      workspace: env.WORKSPACE_DIR
    });
  });

  // Mount API Routers
  app.use('/api/chat', chatRouter);
  app.use('/api/generate-site', websiteRouter);
  app.use('/api/approvals', hitlRouter);
  app.use('/api/agent', hitlRouter);

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: `The requested route '${req.method} ${req.originalUrl}' does not exist.`
    });
  });

  // Global Error Handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled Server Exception:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: err.message || 'An unexpected error occurred.'
    });
  });

  return app;
}
```
- **What this block does**:
  - Mounts `/health` for uptime monitors and Kubernetes liveness probes.
  - Mounts domain routers at `/api/chat`, `/api/generate-site`, `/api/approvals`, and `/api/agent`.
  - Captures unmatched paths with an explicit JSON 404 handler.
  - Catches unhandled runtime exceptions with a 4-argument Express error handler, preventing process crashes and masking internal stack traces from untrusted callers.

---

### Part B: Server Bootstrap and Lifecycle Management (`server.ts`)

#### Block 1: Sandbox Initialization and Port Binding
```typescript
async function bootstrap() {
  // Ensure workspace directory exists on startup
  await defaultWorkspaceTools.init();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`... banner ...`);
  });
```
- **What this block does**:
  - Asynchronously initializes the workspace directory (`defaultWorkspaceTools.init()`) before binding the socket.
  - Creates the Express application and binds to `env.PORT` (default 3000).
  - Emits an ASCII architecture banner summarizing server URLs, health check, endpoints, model, API mode, and active workspace path.
- **How it works**:
  - Guarantees fail-fast startup: if the workspace path is not writeable or permissions are invalid, the service halts before accepting inbound requests.

#### Block 2: Graceful Termination and Process Traps
```typescript
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
```
- **What this block does**:
  - Traps POSIX `SIGTERM` (sent by Docker/Kubernetes) and `SIGINT` (Ctrl+C from local developer terminal).
  - Stops accepting new TCP connections and flushes active HTTP responses before exiting with status code 0.
  - Catches bootstrap promise rejections and exits with status 1.
- **How it works**:
  - Prevents socket hangs and un-flushed filesystem buffers during server deploys or local restarts.
