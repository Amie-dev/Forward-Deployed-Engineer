# Chapter 11: Domain Services and Website Builder Orchestrator

## 1. Overview & File Metadata
- **Target File Paths**:
  - `Lecture 05/code/src/services/hitl-approval.service.ts`
  - `Lecture 05/code/src/services/website-builder.service.ts`
- **TypeScript Module**: NodeNext ES Module
- **Key Responsibilities**:
  1. Implements `HITLApprovalService`: an in-memory managerial ticket authority that stores suspended agent states, facilitates audit trails, and transitions ticket lifecycles (`pending` $\rightarrow$ `approved` / `rejected`).
  2. Implements `WebsiteBuilderService`: a domain orchestrator that demonstrates the **Least Privilege Tool Isolation Pattern** by equipping its underlying `AgentExecutionEngine` strictly with filesystem workspace tools, denying unnecessary conversational tools like weather or calculator.
  3. Prepares sandbox directories prior to agent dispatch to guarantee atomic execution.

---

## 2. Complete Source Code

### File 1: `src/services/hitl-approval.service.ts`
```typescript
import { PendingApprovalTicket, ApprovalStatus } from '../types/hitl.types.js';

export class HITLApprovalService {
  private tickets: Map<string, PendingApprovalTicket> = new Map();

  public createTicket(ticket: Omit<PendingApprovalTicket, 'status' | 'createdAt'>): PendingApprovalTicket {
    const fullTicket: PendingApprovalTicket = {
      ...ticket,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    this.tickets.set(fullTicket.ticketId, fullTicket);
    console.log(
      `🔒 [HITL Gate] Created Approval Ticket #${fullTicket.ticketId} for tool '${fullTicket.toolName}' (Session: ${fullTicket.sessionId})`
    );
    return fullTicket;
  }

  public getTicket(ticketId: string): PendingApprovalTicket | undefined {
    return this.tickets.get(ticketId);
  }

  public listPending(): PendingApprovalTicket[] {
    return Array.from(this.tickets.values()).filter((t) => t.status === 'pending');
  }

  public resolveTicket(
    ticketId: string,
    action: 'approve' | 'reject',
    reviewedBy: string,
    rejectionReason?: string
  ): PendingApprovalTicket {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Approval Ticket #${ticketId} not found.`);
    }

    if (ticket.status !== 'pending') {
      throw new Error(`Approval Ticket #${ticketId} is already marked as ${ticket.status}.`);
    }

    ticket.status = action === 'approve' ? 'approved' : 'rejected';
    ticket.reviewedBy = reviewedBy;
    ticket.reviewedAt = new Date().toISOString();
    ticket.rejectionReason = rejectionReason;

    console.log(
      `⚖️ [HITL Gate] Ticket #${ticketId} was ${ticket.status.toUpperCase()} by ${reviewedBy}`
    );

    return ticket;
  }

  public clear(): void {
    this.tickets.clear();
  }
}

export const defaultHITLService = new HITLApprovalService();
```

---

### File 2: `src/services/website-builder.service.ts`
```typescript
import { ToolRegistry, defaultWorkspaceTools } from '../tools/registry.js';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { WEBSITE_BUILDER_SYSTEM_PROMPT } from '../prompts/website-builder.prompt.js';
import { AgentExecutionResult } from '../types/agent.types.js';

export class WebsiteBuilderService {
  private engine: AgentExecutionEngine;

  constructor() {
    // Isolated registry with only WorkspaceTools for strict least privilege
    const workspaceRegistry = new ToolRegistry(defaultWorkspaceTools.getAllTools());
    this.engine = new AgentExecutionEngine(workspaceRegistry, {
      systemPrompt: WEBSITE_BUILDER_SYSTEM_PROMPT,
      temperature: 0.2
    });
  }

  public async buildSite(prompt: string): Promise<AgentExecutionResult> {
    await defaultWorkspaceTools.init();
    console.log(`[WebsiteBuilderService] Dispatched site generation for prompt: "${prompt}"`);
    return this.engine.execute(prompt);
  }
}

export const defaultWebsiteBuilderService = new WebsiteBuilderService();
```

---

## 3. Block-by-Block Code Explanation

### Part A: Human-in-the-Loop Approval Service (`hitl-approval.service.ts`)

#### Block 1: State Store & Ticket Creation
```typescript
import { PendingApprovalTicket, ApprovalStatus } from '../types/hitl.types.js';

export class HITLApprovalService {
  private tickets: Map<string, PendingApprovalTicket> = new Map();

  public createTicket(ticket: Omit<PendingApprovalTicket, 'status' | 'createdAt'>): PendingApprovalTicket {
    const fullTicket: PendingApprovalTicket = {
      ...ticket,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    this.tickets.set(fullTicket.ticketId, fullTicket);
    console.log(
      `🔒 [HITL Gate] Created Approval Ticket #${fullTicket.ticketId} for tool '${fullTicket.toolName}' (Session: ${fullTicket.sessionId})`
    );
    return fullTicket;
  }
```
- **What this block does**:
  - Maintains ticket storage in an in-memory `Map<string, PendingApprovalTicket>`.
  - `createTicket` accepts ticket parameters omitting `status` and `createdAt` (which it sets automatically to `'pending'` and the ISO timestamp).
  - Persists the suspended conversation transcript (`savedMessages`) inside the ticket.
- **How it works**:
  - Encapsulates ticket creation with immediate audit logging. The ticket becomes an immutable record of what the agent intended to execute.

#### Block 2: Inspection and Filtering
```typescript
  public getTicket(ticketId: string): PendingApprovalTicket | undefined {
    return this.tickets.get(ticketId);
  }

  public listPending(): PendingApprovalTicket[] {
    return Array.from(this.tickets.values()).filter((t) => t.status === 'pending');
  }
```
- **What this block does**:
  - Provides fast lookup by `ticketId`.
  - Filters all tickets to return only those requiring urgent managerial action (`status === 'pending'`).
- **How it works**:
  - Powers administrative dashboards and REST endpoints (`GET /api/hitl/pending`) where security reviewers view outstanding actions.

#### Block 3: Ticket Resolution Invariants
```typescript
  public resolveTicket(
    ticketId: string,
    action: 'approve' | 'reject',
    reviewedBy: string,
    rejectionReason?: string
  ): PendingApprovalTicket {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Approval Ticket #${ticketId} not found.`);
    }

    if (ticket.status !== 'pending') {
      throw new Error(`Approval Ticket #${ticketId} is already marked as ${ticket.status}.`);
    }

    ticket.status = action === 'approve' ? 'approved' : 'rejected';
    ticket.reviewedBy = reviewedBy;
    ticket.reviewedAt = new Date().toISOString();
    ticket.rejectionReason = rejectionReason;

    console.log(
      `⚖️ [HITL Gate] Ticket #${ticketId} was ${ticket.status.toUpperCase()} by ${reviewedBy}`
    );

    return ticket;
  }
```
- **What this block does**:
  - Resolves a pending ticket.
  - Enforces two critical domain invariants:
    1. The ticket MUST exist in the registry.
    2. The ticket MUST be in `'pending'` state (preventing double-approval or race-condition replay attacks).
  - Stamps the reviewer identity (`reviewedBy`), timestamp (`reviewedAt`), and optional `rejectionReason`.
- **How it works**:
  - Guarantees strict authorization semantics before releasing execution back to `agentEngine.resume()`.

---

### Part B: Website Builder Domain Service (`website-builder.service.ts`)

#### Block 1: Least Privilege Registry Isolation
```typescript
import { ToolRegistry, defaultWorkspaceTools } from '../tools/registry.js';
import { AgentExecutionEngine } from '../engine/agent-engine.js';
import { WEBSITE_BUILDER_SYSTEM_PROMPT } from '../prompts/website-builder.prompt.js';
import { AgentExecutionResult } from '../types/agent.types.js';

export class WebsiteBuilderService {
  private engine: AgentExecutionEngine;

  constructor() {
    // Isolated registry with only WorkspaceTools for strict least privilege
    const workspaceRegistry = new ToolRegistry(defaultWorkspaceTools.getAllTools());
    this.engine = new AgentExecutionEngine(workspaceRegistry, {
      systemPrompt: WEBSITE_BUILDER_SYSTEM_PROMPT,
      temperature: 0.2
    });
  }
```
- **What this block does**:
  - Constructs a specialized `AgentExecutionEngine` tailored strictly for website authoring.
  - **Security Architecture**: Instead of passing the entire `defaultToolRegistry` (which contains weather, calculator, and refund tools), it creates an isolated `ToolRegistry` that includes ONLY `defaultWorkspaceTools.getAllTools()`.
- **How it works**:
  - Enforces the **Least Privilege Principle**: A website generator agent has zero business executing customer refunds or reading financial exchange rates. Reducing tool surface area also eliminates token bloat in the system context and prevents accidental hallucinated tool dispatches.

#### Block 2: Directory Initialization and Dispatch
```typescript
  public async buildSite(prompt: string): Promise<AgentExecutionResult> {
    await defaultWorkspaceTools.init();
    console.log(`[WebsiteBuilderService] Dispatched site generation for prompt: "${prompt}"`);
    return this.engine.execute(prompt);
  }
}

export const defaultWebsiteBuilderService = new WebsiteBuilderService();
```
- **What this block does**:
  - Calls `await defaultWorkspaceTools.init()` before executing the prompt to ensure the underlying filesystem sandbox directory exists and is writable.
  - Logs telemetry and delegates the user prompt directly to `this.engine.execute(prompt)`.
  - Exports a singleton instance `defaultWebsiteBuilderService`.
- **How it works**:
  - Provides a single async method `buildSite(prompt)` that REST controllers and CLI scripts can call with a single line of code.
