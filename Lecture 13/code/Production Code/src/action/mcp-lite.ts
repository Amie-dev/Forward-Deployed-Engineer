/**
 * The MCP shape — Chapter 08 §8.6–§8.10, in miniature.
 *
 * **This is not an MCP implementation.** There is no transport, no JSON-RPC framing and
 * no session. What it reproduces is the *shape*, because the shape is what changes how
 * you design the system:
 *
 *   host      the application (here: `MeetingToolHost`)
 *   server    a capability provider exposing tools, resources and prompts
 *   primitives
 *     tools     the **model** decides to call them        → `do this`
 *     resources the **application** decides to inject      → `read this`
 *     prompts   the **user** chooses to invoke             → `use this workflow`
 *
 * Two consequences of adopting this shape are visible immediately in the code:
 *
 *  1. **The schema is a contract you may not own.** A tool's `inputSchema` arrives from
 *     the server. Validation and authorisation still happen on the host side, because
 *     "the server said so" is not a security control (Chapter 08 §8.10).
 *  2. **Tool lists can change at runtime.** They are cached per session and the cache
 *     can be invalidated, because a tool may disappear between listing and calling.
 */

import { z } from 'zod';

import type {
  MeetingRequest,
  PromptDefinition,
  ResourceDefinition,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
} from '../types.js';
import { idempotencyKeyFor, type CalendarPort } from './calendar.js';

/** The server's advertised capabilities, after the `initialize` handshake. */
export interface ServerCapabilities {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: { tools: boolean; resources: boolean; prompts: boolean };
}

/**
 * The **session** context. Identity and consent travel here, never in the arguments.
 *
 * This mirrors how a real MCP server is deployed: the actor is established by the host
 * during the handshake (or by the transport's authentication), not supplied by whatever
 * wrote the tool arguments. An `actor` field inside `arguments` would be spoofable by
 * the model — which is reading text an attacker may control.
 */
export interface ToolSession {
  actor: string;
  /** Recorded for the audit trail: who approved a tier-3 call, and when. */
  approvedBy?: string;
}

/** Arguments of the calendar tool, as JSON Schema — the same contract style as Chapter 04. */
const createEventArgsSchema = z
  .object({
    title: z.string().min(1).max(120),
    attendee: z.string().min(1),
    startIso: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    durationMinutes: z.number().int().min(1).max(480),
    location: z.string().nullable(),
  })
  .strict();

/**
 * A capability provider.
 *
 * Note that the handler is a thin wrapper over the **same** `CalendarPort` the action
 * pipeline uses. That is the point: MCP standardises the *connection*, not the business
 * logic. The adapter is still the only place that knows the vendor.
 */
export class CalendarCapabilityServer {
  constructor(private readonly calendar: CalendarPort) {}

  initialize(): ServerCapabilities {
    return {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'calendar-server', version: '1.0.0' },
      capabilities: { tools: true, resources: true, prompts: true },
    };
  }

  listTools(): ToolDefinition[] {
    return [
      {
        name: 'calendar.create_event',
        // The description is the routing signal, not documentation. It says *when* to
        // use the tool, which is what the model actually needs (Chapter 07 §7.6).
        description:
          'Create a calendar event. Use only after the meeting details have been extracted and validated.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'attendee', 'startIso', 'durationMinutes', 'location'],
          properties: {
            title: { type: 'string', description: 'Short event title' },
            attendee: { type: 'string', description: 'Participant name or email' },
            startIso: { type: 'string', description: 'ISO 8601 local date-time, YYYY-MM-DDTHH:mm' },
            durationMinutes: { type: 'integer', minimum: 1, maximum: 480 },
            location: { type: ['string', 'null'], description: 'null when not mentioned' },
          },
        },
        // Tier 3: a write to a shared resource. The host must gate it.
        tier: 3,
      },
      {
        name: 'calendar.find_conflicts',
        description:
          'List existing events that overlap a proposed slot. Read-only; safe to call freely.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['startIso', 'durationMinutes'],
          properties: {
            startIso: { type: 'string' },
            durationMinutes: { type: 'integer', minimum: 1, maximum: 480 },
          },
        },
        tier: 1,
      },
    ];
  }

  listResources(): ResourceDefinition[] {
    return [
      { uri: 'calendar://timezone/account', name: 'Account timezone', mimeType: 'application/json' },
      { uri: 'calendar://directory/people', name: 'Known participants', mimeType: 'application/json' },
    ];
  }

  listPrompts(): PromptDefinition[] {
    return [
      {
        name: 'schedule_meeting',
        description: 'Extract a meeting request from a sentence, then create the event.',
        arguments: [{ name: 'request', description: 'The sentence to interpret', required: true }],
      },
    ];
  }

  /** Reads a resource. The *application* decides when to call this, not the model. */
  readResource(uri: string): string {
    if (uri === 'calendar://directory/people') {
      return JSON.stringify({ people: ['aditya@northwind.test', 'ravi@northwind.test'] });
    }
    if (uri === 'calendar://timezone/account') {
      return JSON.stringify({ timeZone: 'UTC' });
    }
    throw new Error(`Unknown resource: ${uri}`);
  }

  /** Dispatches a call. Every argument is validated *here*, on the host side. */
  async callTool(request: ToolCallRequest, session: ToolSession): Promise<ToolCallResult> {
    const tool = this.listTools().find((entry) => entry.name === request.name);
    if (!tool) {
      return error(`Unknown tool "${request.name}". The server may have changed its tool list.`);
    }

    if (request.name === 'calendar.find_conflicts') {
      const parsed = z
        .object({ startIso: z.string(), durationMinutes: z.number().int().min(1).max(480) })
        .strict()
        .safeParse(request.arguments);
      if (!parsed.success) return error(describeZod(parsed.error));

      const conflicts = this.calendar.findConflicts({
        ...emptyMeeting(),
        startIso: parsed.data.startIso,
        durationMinutes: parsed.data.durationMinutes,
      });
      return text(JSON.stringify({ conflicts: conflicts.map((event) => event.summary) }));
    }

    const parsed = createEventArgsSchema.safeParse(request.arguments);
    if (!parsed.success) {
      // An invalid argument set is a tool error, returned as content — not a thrown
      // exception. Chapter 06 §6.10: failures are data, so the caller can route them.
      return error(describeZod(parsed.error));
    }

    const meeting: MeetingRequest = {
      ...emptyMeeting(),
      ...parsed.data,
      reasoning: 'Supplied as tool arguments.',
    };

    // The identity comes from the **session**, never from the arguments. An actor in the
    // argument list would be spoofable by whatever wrote the arguments — which is the
    // model, which is reading untrusted text.
    const result = await this.calendar.createEvent(
      meeting,
      idempotencyKeyFor(meeting, session.actor),
      session.actor,
    );

    return result.ok
      ? text(
          JSON.stringify({
            id: result.event.id,
            duplicate: result.duplicate,
            start: result.event.start,
          }),
        )
      : error(`${result.code}: ${result.message}`);
  }
}

function text(value: string): ToolCallResult {
  return { content: [{ type: 'text', text: value }], isError: false };
}

function error(value: string): ToolCallResult {
  return { content: [{ type: 'text', text: value }], isError: true };
}

function describeZod(zodError: z.ZodError): string {
  return zodError.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`).join('; ');
}

/** A shape-complete placeholder, so `find_conflicts` does not need a whole meeting. */
function emptyMeeting(): MeetingRequest {
  return {
    reasoning: '',
    title: '',
    attendee: '',
    startIso: '',
    durationMinutes: 30,
    type: 'OTHER',
    location: null,
    schemaVersion: 'meeting.v2',
  };
}

/**
 * The **host**. It owns the tool list, the cache and the policy.
 *
 * Three host-side responsibilities the notes insist on:
 *
 *  1. **Validate every argument**, including arguments from a server you trust.
 *  2. **Gate by tier.** A tier-3 tool is not executed without approval, no matter how
 *     confident the model is.
 *  3. **Keep the tool list cacheable but invalidatable**, because a server's tools can
 *     change mid-session.
 */
export class MeetingToolHost {
  private cache: ToolDefinition[] | null = null;

  constructor(
    private readonly server: CalendarCapabilityServer,
    /** The host's approval policy: may this tier-3 call proceed without a human? */
    private readonly approve: (tool: ToolDefinition, args: Record<string, unknown>) => boolean,
  ) {}

  /** Cached, because listing tools on every call is a round trip nobody needs. */
  tools(): ToolDefinition[] {
    this.cache ??= this.server.listTools();
    return this.cache;
  }

  /** Called when the server announces a change. */
  invalidate(): void {
    this.cache = null;
  }

  async call(request: ToolCallRequest, session: ToolSession): Promise<ToolCallResult> {
    const tool = this.tools().find((entry) => entry.name === request.name);
    if (!tool) return error(`Unknown tool "${request.name}".`);

    if (tool.tier === 3 && !this.approve(tool, request.arguments)) {
      return error('Rejected: this action requires human approval before it can be executed.');
    }

    return this.server.callTool(request, session);
  }
}
