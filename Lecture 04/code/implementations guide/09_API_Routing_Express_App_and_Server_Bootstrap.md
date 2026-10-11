# Chapter 09: API Routing, Express Application Assembly & Server Bootstrap

> **Chapter Goal:** Construct the Express REST and Server-Sent Events routing layer, assemble middleware for CORS and request observability, implement global error-handling guards, and bootstrap the server with graceful shutdown handling.

---

## 9.1 File Locations & Directory Setup

```bash
mkdir -p "src/routes"
touch "src/routes/health.routes.ts"
touch "src/routes/chat.routes.ts"
touch "src/app.ts"
touch "src/server.ts"
```

Target Files:
1. `src/routes/health.routes.ts`
2. `src/routes/chat.routes.ts`
3. `src/app.ts`
4. `src/server.ts`

---

## 9.2 Complete Source Code: `src/routes/health.routes.ts`

```typescript
import { Router, Request, Response } from 'express';
import { SessionStore } from '../services/session.store.js';
import { config } from '../config/env.js';
import { isLiveApiKeyConfigured } from '../lib/openai.js';

const router = Router();
const sessionStore = SessionStore.getInstance();

/**
 * GET /health
 * Enterprise Health Check Endpoint
 */
router.get('/', (_req: Request, res: Response): void => {
  const memoryUsage = process.memoryUsage();

  res.status(200).json({
    status: 'UP',
    service: 'lecture-04-production-chatbot',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    ai: {
      model: config.AI_MODEL,
      liveKeyConfigured: isLiveApiKeyConfigured(),
      temperature: config.AI_TEMPERATURE,
      maxContextTokens: config.MAX_CONTEXT_TOKENS,
    },
    sessions: {
      activeSessionCount: sessionStore.getSessionCount(),
    },
    memory: {
      rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
      heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
    },
  });
});

export default router;
```

---

## 9.3 Complete Source Code: `src/routes/chat.routes.ts`

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { openai, isLiveApiKeyConfigured } from '../lib/openai.js';
import { config } from '../config/env.js';
import { SessionStore } from '../services/session.store.js';
import { ContextManagerService } from '../services/context-manager.service.js';
import { StreamingService } from '../services/streaming.service.js';
import { GroundingService } from '../services/grounding.service.js';

const router = Router();
const sessionStore = SessionStore.getInstance();
const contextManager = new ContextManagerService();
const streamingService = new StreamingService();
const groundingService = new GroundingService();

// ============================================================================
// Input Validation Schemas
// ============================================================================

const ChatRequestSchema = z.object({
  sessionId: z.string().default(() => `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
  userId: z.string().default('user_vip_001'),
  message: z.string().min(1, 'Message text is required'),
});

const GroundedQuerySchema = z.object({
  message: z.string().min(1, 'Query message is required'),
});

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * POST /api/chat
 * Synchronous Multi-Turn Chat Completion with Full Usage Telemetry
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { sessionId, userId, message } = ChatRequestSchema.parse(req.body);

    // 1. Associate session with user identity (Application Memory)
    sessionStore.getOrCreateSession(sessionId, userId);

    // 2. Append user turn to session history
    sessionStore.appendUserMessage(sessionId, message);

    // 3. Hydrate context with Token-Budgeted Sliding Window & Summary
    const { messages: hydratedMessages, metrics } = await contextManager.prepareHydratedPayload(sessionId);

    let reply = '';
    let tokenUsage: any = null;

    if (isLiveApiKeyConfigured()) {
      const completion = await openai.chat.completions.create({
        model: config.AI_MODEL,
        messages: hydratedMessages as any,
        temperature: config.AI_TEMPERATURE,
      });

      reply = completion.choices[0]?.message?.content || 'I could not generate a response.';
      tokenUsage = completion.usage;
    } else {
      // Offline local simulation
      reply = `[Tomato Support Executive]: Thank you for reaching out regarding "${message}". We are tracking your inquiry for session ${sessionId}.`;
      tokenUsage = {
        prompt_tokens: metrics.totalEstimatedTokens,
        completion_tokens: 35,
        total_tokens: metrics.totalEstimatedTokens + 35,
      };
    }

    // 4. Append assistant reply to session store
    sessionStore.appendAssistantMessage(sessionId, reply);

    res.status(200).json({
      success: true,
      sessionId,
      reply,
      metrics,
      usage: tokenUsage,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/chat/stream
 * Real-Time Server-Sent Events (SSE) Streaming Endpoint
 */
router.post('/stream', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { sessionId, userId, message } = ChatRequestSchema.parse(req.body);

    // Ensure session is initialized with correct user profile
    sessionStore.getOrCreateSession(sessionId, userId);

    // Delegate to dedicated streaming lifecycle engine
    await streamingService.handleStreamingChat(req, res, sessionId, message);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/chat/grounded
 * Zero-Hallucination RAG Grounded Q&A with Zod Constrained Decoding
 */
router.post('/grounded', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message } = GroundedQuerySchema.parse(req.body);

    const groundedResult = await groundingService.generateGroundedAnswer(message);

    res.status(200).json({
      success: true,
      result: groundedResult,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/chat/sessions/:sessionId
 * Session Telemetry, Message History, and Context Inspection
 */
router.get('/sessions/:sessionId', (req: Request, res: Response): void => {
  const sessionId = req.params.sessionId as string;
  const session = sessionStore.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: `Session "${sessionId}" not found.` });
    return;
  }

  res.status(200).json({
    sessionId: session.sessionId,
    userId: session.userId,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    cumulativeTurns: session.cumulativeTurns,
    currentHistoryTurns: session.messages.length,
    runningSummary: session.runningSummary || 'None',
    messages: session.messages,
  });
});

/**
 * DELETE /api/chat/sessions/:sessionId
 * Session Eviction (GDPR Right to be Forgotten Compliant)
 */
router.delete('/sessions/:sessionId', (req: Request, res: Response): void => {
  const sessionId = req.params.sessionId as string;
  const deleted = sessionStore.deleteSession(sessionId);

  if (!deleted) {
    res.status(404).json({ error: `Session "${sessionId}" not found.` });
    return;
  }

  res.status(200).json({
    success: true,
    message: `Session "${sessionId}" permanently purged from state store.`,
  });
});

export default router;
```

---

## 9.4 Complete Source Code: `src/app.ts`

```typescript
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import healthRouter from './routes/health.routes.js';
import chatRouter from './routes/chat.routes.js';

export const app: Express = express();

// ============================================================================
// Core Express Middleware
// ============================================================================

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request Observability Middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  next();
});

// ============================================================================
// REST Route Registration
// ============================================================================

app.use('/health', healthRouter);
app.use('/api/chat', chatRouter);

// 404 Catch-All Middleware
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

// ============================================================================
// Global Error Handling Middleware
// ============================================================================

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled Application Error:', err);

  // 1. Handle Zod Schema Validation Errors (HTTP 400 Bad Request)
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation Error',
      details: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // 2. Handle OpenAI SDK Specific API Errors (HTTP 401, 429, 500)
  if (err.status) {
    res.status(err.status).json({
      error: 'AI Provider Error',
      message: err.message,
      code: err.code,
    });
    return;
  }

  // 3. Fallback Internal Server Error (HTTP 500)
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.',
  });
});
```

---

## 9.5 Complete Source Code: `src/server.ts`

```typescript
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
```

---

## 9.6 Block-by-Block Technical Explanation

### Block 1: Decoupling Application Configuration (`app.ts`) from HTTP Listener (`server.ts`)
- **Why this design:** Separating Express app initialization from `server.listen()` allows test suites (like Supertest) to test routes in memory without binding network ports.

### Block 2: Zod Request Validation Middleware in Routes
- **What it does:** Every route handler parses incoming JSON bodies through Zod schemas (`ChatRequestSchema.parse(req.body)`).
- **How it works:** If a client passes invalid data (e.g., missing message string), Zod throws a `ZodError` that is caught by the global error-handling middleware, returning a clean HTTP 400 Bad Request with field-level error messages.

### Block 3: Multi-Turn Hydration & State Persistence in `POST /api/chat`
- **What it does:** Coordinates the entire multi-turn lifecycle: stores the user message, builds the token-budgeted prompt, executes inference, and records the assistant response.

### Block 4: Graceful Shutdown Handlers (`SIGTERM` & `SIGINT`)
- **What it does:** Catches process termination signals from Kubernetes or `Ctrl+C`.
- **How it works:** Calls `server.close()`, allowing active streaming HTTP requests to cleanly flush and complete before terminating the Node.js process with exit code `0`.
