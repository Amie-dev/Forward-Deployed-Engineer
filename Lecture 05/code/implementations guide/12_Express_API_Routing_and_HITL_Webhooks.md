# Chapter 12: Express API Routing and HITL Webhooks

## 1. Overview & File Metadata
- **Target File Paths**:
  - `Lecture 05/code/src/routes/chat.routes.ts`
  - `Lecture 05/code/src/routes/website.routes.ts`
  - `Lecture 05/code/src/routes/hitl.routes.ts`
- **TypeScript Module**: NodeNext ES Module
- **Key Responsibilities**:
  1. Exposes standard RESTful HTTP endpoints for multi-tool conversational queries, autonomous website synthesis, and Human-in-the-Loop review gates.
  2. Enforces strict runtime request payload validation using Zod schemas (`ChatRequestSchema`, `GenerateSiteRequestSchema`, `ResumeRequestSchema`).
  3. Connects the asynchronous Express request-response lifecycle with long-running agent loops.
  4. Implements the managerial resumption webhook (`POST /api/agent/resume`) allowing supervisory systems (such as Slack buttons, Admin Portals, or SMS integrations) to approve or reject actions.

---

## 2. Complete Source Code

### File 1: `src/routes/chat.routes.ts`
```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { defaultToolRegistry } from '../tools/registry.js';
import { GENERAL_AGENT_SYSTEM_PROMPT } from '../prompts/general-agent.prompt.js';

export const chatRouter = Router();

const engine = new AgentExecutionEngine(defaultToolRegistry, {
  systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
});

const ChatRequestSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
  sessionId: z.string().optional()
});

/**
 * POST /api/chat
 * Multi-tool conversational endpoint capable of executing parallel and sequential tools
 */
chatRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = ChatRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { message, sessionId } = parseResult.data;
    const result = await engine.execute(message, sessionId);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[ChatRoute Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error processing agent request'
    });
  }
});
```

---

### File 2: `src/routes/website.routes.ts`
```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { defaultWebsiteBuilderService } from '../services/website-builder.service.js';

export const websiteRouter = Router();

const GenerateSiteRequestSchema = z.object({
  prompt: z.string().min(5, 'Prompt must be at least 5 characters long')
});

/**
 * POST /api/generate-site
 * Autonomous website generation endpoint invoking workspace tools
 */
websiteRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = GenerateSiteRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request payload',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { prompt } = parseResult.data;
    const result = await defaultWebsiteBuilderService.buildSite(prompt);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[WebsiteRoute Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error generating website'
    });
  }
});
```

---

### File 3: `src/routes/hitl.routes.ts`
```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { defaultHITLService } from '../services/hitl-approval.service.js';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { defaultToolRegistry } from '../tools/registry.js';
import { GENERAL_AGENT_SYSTEM_PROMPT } from '../prompts/general-agent.prompt.js';

export const hitlRouter = Router();

const engine = new AgentExecutionEngine(defaultToolRegistry, {
  systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
});

const ResumeRequestSchema = z.object({
  ticketId: z.string().min(1, 'ticketId is required'),
  action: z.enum(['approve', 'reject']),
  reviewedBy: z.string().min(1, 'reviewedBy is required'),
  rejectionReason: z.string().optional()
});

/**
 * GET /api/approvals
 * Lists all pending approval tickets awaiting human sign-off
 */
hitlRouter.get('/', (req: Request, res: Response): void => {
  const pending = defaultHITLService.listPending();
  res.status(200).json({
    success: true,
    totalPending: pending.length,
    data: pending
  });
});

/**
 * POST /api/agent/resume
 * Webhook endpoint invoked by human reviewer (Slack / Admin Dashboard) to resume execution
 */
hitlRouter.post('/resume', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = ResumeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request payload',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { ticketId, action, reviewedBy, rejectionReason } = parseResult.data;

    const result = await engine.resume(ticketId, action, reviewedBy, rejectionReason);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[HITLResume Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal error resuming agent execution'
    });
  }
});
```

---

## 3. Block-by-Block Code Explanation

### Part A: Conversational Multi-Tool Router (`chat.routes.ts`)

#### Block 1: Module Setup and Engine Binding
```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { defaultToolRegistry } from '../tools/registry.js';
import { GENERAL_AGENT_SYSTEM_PROMPT } from '../prompts/general-agent.prompt.js';

export const chatRouter = Router();

const engine = new AgentExecutionEngine(defaultToolRegistry, {
  systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT
});
```
- **What this block does**:
  - Creates an Express `Router` instance.
  - Instantiates a dedicated `AgentExecutionEngine` bound to `defaultToolRegistry` (all 8 tools) and configured with `GENERAL_AGENT_SYSTEM_PROMPT`.
- **How it works**:
  - Decouples routing logic from engine initialization. Reusing a persistent engine instance preserves configuration while allowing stateless, concurrent user interactions.

#### Block 2: Request Validation and Execution Handler
```typescript
const ChatRequestSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
  sessionId: z.string().optional()
});

chatRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = ChatRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { message, sessionId } = parseResult.data;
    const result = await engine.execute(message, sessionId);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[ChatRoute Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error processing agent request'
    });
  }
});
```
- **What this block does**:
  - Enforces that `message` is a non-empty string; accepts optional `sessionId`.
  - If validation fails, immediately returns HTTP 400 Bad Request with mapped error messages.
  - Calls `await engine.execute(message, sessionId)`.
  - Serializes the complete `AgentExecutionResult` (traces, tokens, final answer, status) with HTTP 200 OK.
  - Global `catch` block traps unexpected runtime exceptions and returns HTTP 500 without crashing the Express server.

---

### Part B: Website Generation Router (`website.routes.ts`)

#### Block 1: Zod Schema and Route Handler
```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { defaultWebsiteBuilderService } from '../services/website-builder.service.js';

export const websiteRouter = Router();

const GenerateSiteRequestSchema = z.object({
  prompt: z.string().min(5, 'Prompt must be at least 5 characters long')
});

websiteRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = GenerateSiteRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request payload',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { prompt } = parseResult.data;
    const result = await defaultWebsiteBuilderService.buildSite(prompt);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[WebsiteRoute Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error generating website'
    });
  }
});
```
- **What this block does**:
  - Imposes a minimum prompt length of 5 characters to avoid trivial, ambiguous build requests.
  - Delegates execution to `defaultWebsiteBuilderService.buildSite(prompt)`.
  - Responds with the traces and files generated in `./generated-sites`.
- **How it works**:
  - Shields callers from the internal multi-step tool chaining mechanics. From the client's perspective, this is a clean single-endpoint API call that orchestrates full static website synthesis.

---

### Part C: Human-in-the-Loop Webhook Router (`hitl.routes.ts`)

#### Block 1: Ticket Listing Endpoint (`GET /api/approvals`)
```typescript
/**
 * GET /api/approvals
 * Lists all pending approval tickets awaiting human sign-off
 */
hitlRouter.get('/', (req: Request, res: Response): void => {
  const pending = defaultHITLService.listPending();
  res.status(200).json({
    success: true,
    totalPending: pending.length,
    data: pending
  });
});
```
- **What this block does**:
  - Synchronously queries `defaultHITLService.listPending()`.
  - Returns the list of pending approval tickets, their tool names, arguments, risk levels, and reason messages.
- **How it works**:
  - Serves as the polling endpoint for supervisor dashboards or Slack notification workers.

#### Block 2: Resumption Webhook Endpoint (`POST /api/agent/resume`)
```typescript
const ResumeRequestSchema = z.object({
  ticketId: z.string().min(1, 'ticketId is required'),
  action: z.enum(['approve', 'reject']),
  reviewedBy: z.string().min(1, 'reviewedBy is required'),
  rejectionReason: z.string().optional()
});

hitlRouter.post('/resume', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = ResumeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request payload',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { ticketId, action, reviewedBy, rejectionReason } = parseResult.data;
    const result = await engine.resume(ticketId, action, reviewedBy, rejectionReason);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[HITLResume Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal error resuming agent execution'
    });
  }
});
```
- **What this block does**:
  - Validates that `action` is strictly `'approve'` or `'reject'`, and that `reviewedBy` is specified for security audit compliance.
  - Calls `await engine.resume(ticketId, action, reviewedBy, rejectionReason)`.
  - If approved, the agent executes the high-risk tool and completes its reasoning loop.
  - If rejected, the agent receives the rejection notice and politely informs the user of the management decision.
- **How it works**:
  - Completes the durable Human-in-the-Loop architectural cycle. Enables secure human intervention without aborting or losing conversation state.
