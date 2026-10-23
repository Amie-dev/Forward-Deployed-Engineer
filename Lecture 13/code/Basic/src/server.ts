import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { config, serverConfig } from './config/env.js';
import { createModel, guaranteeFor } from './llm/enforcement.js';
import { extractMeeting } from './pipeline/extract.js';
import { scheduleMeeting } from './pipeline/action.js';
import { InMemoryCalendar } from './action/calendar.js';
import { CalendarCapabilityServer, MeetingToolHost } from './action/mcp-lite.js';
import { meetingJsonSchema } from './schema/meeting.js';
import type { Model } from './llm/model.js';

/**
 * A thin HTTP surface over the same pipeline the CLI uses.
 *
 * Four rules, all of them production rules rather than demo rules:
 *
 *  1. **The trace is returned with the answer.** Debuggability is a feature, not a log
 *     file — and for structured output the trace is where the *reason* for a failure
 *     lives.
 *  2. **The schema is a documented part of the API.** `GET /schema` returns the exact
 *     contract the model is held to, so a consumer can generate a client from it.
 *  3. **A failed extraction is a typed response, not a 500.** `422` with the issues,
 *     because "the model could not produce a valid object" is a client-visible outcome.
 *  4. **The calendar lives in memory at boot.** Infrastructure setup is not on the
 *     request path.
 */

const extractRequest = z.object({
  input: z.string().min(3).max(1000),
  /** Optional per-request override, so one deployment can expose all four rungs. */
  enforcement: z.enum(['instruction', 'json_mode', 'schema', 'validate']).optional(),
});

const scheduleRequest = extractRequest.extend({
  actor: z.string().min(3).max(200).optional(),
  approved: z.boolean().optional(),
});

async function main(): Promise<void> {
  const model: Model = await createModel();
  const calendar = new InMemoryCalendar();
  const server = new CalendarCapabilityServer(calendar);
  const host = new MeetingToolHost(server, () => true);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      ok: true,
      provider: model.provider,
      model: model.model,
      enforcement: config.enforcement,
      guarantee: guaranteeFor(config.enforcement),
      schemaVersion: config.schemaVersion,
      limits: {
        maxDurationMinutes: config.maxDurationMinutes,
        maxRepairs: config.maxRepairs,
        autoApproveMaxDuration: config.autoApproveMaxDuration,
      },
      calendar: { events: calendar.listEvents().length },
    });
  });

  /** The contract, published. A consumer can generate a client from this. */
  app.get('/schema', (_request: Request, response: Response) => {
    response.json({
      schemaVersion: config.schemaVersion,
      jsonSchema: meetingJsonSchema(),
      enforcement: config.enforcement,
    });
  });

  /** The MCP-shaped capability list, exposed over HTTP so it can be inspected. */
  app.get('/tools', (_request: Request, response: Response) => {
    response.json({
      capabilities: server.initialize(),
      tools: host.tools(),
      resources: server.listResources(),
      prompts: server.listPrompts(),
    });
  });

  app.post('/extract', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const parsed = extractRequest.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
        return;
      }

      const { extraction, trace } = await extractMeeting(model, parsed.data.input, {
        ...(parsed.data.enforcement ? { enforcement: parsed.data.enforcement } : {}),
      });

      // `200` when an object exists, `422` when the input could not be turned into one.
      const status = extraction.kind === 'ok' || extraction.kind === 'degraded' ? 200 : 422;
      response.status(status).json({
        outcome: extraction.kind,
        ...(extraction.kind === 'ok' || extraction.kind === 'degraded'
          ? { meeting: extraction.value, flags: extraction.flags }
          : {}),
        ...(extraction.kind === 'invalid' ? { issues: extraction.issues } : {}),
        ...(extraction.kind === 'refused' ? { refusal: extraction.raw } : {}),
        trace: {
          enforcement: trace.enforcement,
          attempts: trace.attempts.length,
          stages: trace.stages,
          issueDistribution: trace.issueDistribution,
          latencyMs: trace.latencyMs,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/schedule', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const parsed = scheduleRequest.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
        return;
      }

      const { extraction, trace } = await extractMeeting(model, parsed.data.input, {
        ...(parsed.data.enforcement ? { enforcement: parsed.data.enforcement } : {}),
      });

      const result = await scheduleMeeting(extraction, calendar, {
        ...(parsed.data.actor ? { actor: parsed.data.actor } : {}),
        ...(parsed.data.approved !== undefined ? { approved: parsed.data.approved } : {}),
      });

      // The status code follows the *action* outcome, not the extraction.
      const status =
        result.outcome.kind === 'created'
          ? 201
          : result.outcome.kind === 'awaiting_approval'
            ? 202
            : result.outcome.kind === 'rejected'
              ? 403
              : 502;

      response.status(status).json({
        extraction: extraction.kind,
        action: result.outcome,
        ...(result.proposal ? { proposal: result.proposal } : {}),
        trace: { attempts: trace.attempts.length, latencyMs: trace.latencyMs },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/events', (_request: Request, response: Response) => {
    response.json({ events: calendar.listEvents() });
  });

  /** One error shape for every failure, so a client never has to parse prose. */
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    response.status(500).json({ error: 'internal_error', message });
  });

  app.listen(serverConfig.port, () => {
    console.log(`Lecture 13 · structured outputs — listening on :${serverConfig.port}`);
    console.log(`provider=${model.provider} model=${model.model} enforcement=${config.enforcement}`);
    console.log('');
    console.log('  GET  /health');
    console.log('  GET  /schema     the JSON Schema the model is held to');
    console.log('  GET  /tools      the MCP-shaped capability list');
    console.log('  POST /extract    { input, enforcement? }');
    console.log('  POST /schedule   { input, actor?, approved? }');
    console.log('  GET  /events');
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
