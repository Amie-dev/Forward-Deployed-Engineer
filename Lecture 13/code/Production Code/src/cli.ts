#!/usr/bin/env node
/**
 * One CLI, one subcommand per chapter.
 *
 * Every command exists to make one claim in the notes checkable:
 *
 *   naive      "Return JSON" in a prompt is not a guarantee            (Chapter 03)
 *   layers     what each enforcement rung actually promises            (Chapters 03, 05)
 *   schema     the contract, its descriptions and the strict subset     (Chapters 02, 04)
 *   extract    the whole reliability loop, with a per-attempt trace     (Chapter 06)
 *   validate   structural versus semantic validation, side by side      (Chapter 06)
 *   repair     what a targeted repair prompt contains, and what it fixes (Chapter 06)
 *   tool       structured output versus tool calling                    (Chapter 07)
 *   mcp        the MCP shape: tools, resources, prompts, and the gate   (Chapter 08)
 *   eval       the golden set, the metric card, and all four rungs      (Chapter 09)
 *   all        the whole story in one run
 *
 * Nothing here needs an API key. Set `OPENAI_API_KEY` and the same commands call a real
 * model — the enforcement table, the schema, the validator and the metrics do not change.
 */

import { config } from './config/env.js';
import { ENFORCEMENT_TABLE, createModel, guaranteeFor, wireSchema } from './llm/enforcement.js';
import { clamp } from './lib/text.js';
import { MEETING_FIELDS, SAMPLE_MEETING, meetingSchema, meetingStrictJsonSchema } from './schema/meeting.js';
import { extractMeeting } from './pipeline/extract.js';
import { scheduleMeeting } from './pipeline/action.js';
import { buildRepairPrompt } from './pipeline/repair.js';
import { defaultSemanticContext, partition, semanticChecks } from './pipeline/semantic.js';
import { InMemoryCalendar } from './action/calendar.js';
import { CalendarCapabilityServer, MeetingToolHost } from './action/mcp-lite.js';
import { compareEnforcements, runSuite } from './eval/run.js';
import { GOLDEN_CASES } from './eval/golden.js';
import { ENFORCEMENT_LEVELS, type EnforcementLevel, type Extraction } from './types.js';
import { heading, ms, pad, rule } from './lib/text.js';

/** The lecture's own sentence, used whenever no argument is given. */
const DEFAULT_INPUT = 'Schedule a project review with Aditya tomorrow at 3 PM for 45 minutes.';

const commands = [
  'naive',
  'layers',
  'schema',
  'extract',
  'validate',
  'repair',
  'tool',
  'mcp',
  'eval',
  'all',
] as const;
type Command = (typeof commands)[number];

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const input = rest.join(' ').trim() || DEFAULT_INPUT;

  if (!command || !commands.includes(command as Command)) {
    console.log(`Usage: npm run cli -- <${commands.join('|')}> ["sentence"]`);
    console.log('');
    console.log('  naive      the prompt-only path, and why a parser rejects it');
    console.log('  layers     the same sentence through all four enforcement rungs');
    console.log('  schema     the contract, the field table and the strict-mode variant');
    console.log('  extract    the full reliability loop with a per-attempt trace');
    console.log('  validate   structural vs semantic validation on one object');
    console.log('  repair     the repair prompt, and which failures it can and cannot fix');
    console.log('  tool       structured output vs tool calling, side by side');
    console.log('  mcp        the MCP shape: initialize, tools, resources, prompts, gate');
    console.log('  eval       the golden set, the metric card and all four rungs');
    console.log('  all        everything above, in order');
    console.log('');
    console.log(`  provider: ${config.provider} (${config.model})   enforcement: ${config.enforcement}`);
    return;
  }

  switch (command as Command) {
    case 'naive':
      return naive(input);
    case 'layers':
      return layers(input);
    case 'schema':
      return schemaReport();
    case 'extract':
      return extractCommand(input);
    case 'validate':
      return validateCommand(input);
    case 'repair':
      return repairCommand(input);
    case 'tool':
      return toolCommand(input);
    case 'mcp':
      return mcpCommand(input);
    case 'eval':
      return evalCommand();
    case 'all': {
      await naive(input);
      await layers(input);
      schemaReport();
      await extractCommand(input);
      await validateCommand(input);
      await repairCommand(input);
      await toolCommand(input);
      await mcpCommand(input);
      await evalCommand();
      return;
    }
  }
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 03 — why "just ask for JSON" fails
 * ───────────────────────────────────────────────────────────── */

async function naive(input: string): Promise<void> {
  const model = await createModel('simulate');

  heading('Chapter 03 · the prompt-only path');

  const { raw } = await model.complete({
    system: 'Extract the meeting. Return JSON.',
    user: input,
    enforcement: 'instruction',
    jsonSchema: {},
    temperature: config.temperature,
  });

  console.log(`input        ${clamp(input, 78)}`);
  console.log('');
  console.log('raw response (exactly what came back):');
  console.log(indent(clamp(raw, 400), '  '));
  console.log('');

  // The naive bridge from Chapter 01 §1.9: one JSON.parse, no defence.
  try {
    JSON.parse(raw);
    console.log('JSON.parse(raw)        → succeeded (this run got lucky)');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`JSON.parse(raw)        → THREW: ${message}`);
  }

  // The tolerant reader: what the heuristics would salvage, and why they are a liability.
  const { extractBraceSpan, stripFences } = await import('./lib/json.js');
  const span = extractBraceSpan(stripFences(raw));
  console.log(
    `extractBraceSpan(...)  → ${
      span === null
        ? 'nothing to salvage'
        : 'salvaged a span — at the cost of a regex that fails on other inputs'
    }`,
  );
  console.log('');
  console.log('Read it as: the instruction shifted the probability of "{" — it did not remove');
  console.log('the possibility of "Sure!". That is the difference between a preference and a');
  console.log('contract, and it is why Chapter 05 exists.');
}

/* ─────────────────────────────────────────────────────────────
 * Chapters 03 + 05 — the enforcement ladder
 * ───────────────────────────────────────────────────────────── */

async function layers(input: string): Promise<void> {
  const model = await createModel('simulate');

  heading('Chapters 03 + 05 · the enforcement ladder');
  console.log(`${pad('level', 12)} ${pad('syntax', 11)} ${pad('shape', 11)} ${pad('values', 10)} removes`);
  rule();
  for (const entry of ENFORCEMENT_TABLE) {
    console.log(
      `${pad(entry.level, 12)} ${pad(entry.syntax, 11)} ${pad(entry.shape, 11)} ${pad(entry.values, 10)} ${clamp(entry.removes, 44)}`,
    );
  }

  heading(`The same sentence, four rungs: "${clamp(input, 60)}"`);
  console.log(`${pad('level', 12)} ${pad('outcome', 11)} ${pad('attempts', 9)} ${pad('first pass', 11)} note`);
  rule();

  for (const level of ENFORCEMENT_LEVELS) {
    const { extraction, trace } = await extractMeeting(model, input, { enforcement: level });
    const firstPass = trace.attempts.length === 1 && extraction.kind === 'ok' ? 'yes' : 'no';
    console.log(
      `${pad(level, 12)} ${pad(extraction.kind, 11)} ${pad(String(trace.attempts.length), 9)} ${pad(firstPass, 11)} ${clamp(noteFor(extraction), 40)}`,
    );
  }

  console.log('');
  console.log('Read it as: `instruction` and `json_mode` fail on the *first* call and are rescued');
  console.log('by the repair loop — at the cost of an extra request. `schema` gets it right first');
  console.log('time. The guarantee is not about quality; it is about how many calls it takes to');
  console.log('reach a usable object.');
}

/** One line explaining what the outcome means for this rung. */
function noteFor(extraction: Extraction): string {
  switch (extraction.kind) {
    case 'ok':
      return extraction.attempts === 1 ? 'accepted, no repair needed' : 'accepted after repair';
    case 'degraded':
      return 'accepted as a degraded object, flagged';
    case 'refused':
      return 'model declined — terminal, never retried';
    case 'truncated':
      return 'cut off by the token budget';
    case 'invalid':
      return `repair exhausted (${extraction.reason})`;
    case 'failed':
      return extraction.reason;
  }
}

/* ─────────────────────────────────────────────────────────────
 * Chapters 02 + 04 — the contract
 * ───────────────────────────────────────────────────────────── */

function schemaReport(): void {
  heading('Chapters 02 + 04 · the contract the application owns');

  console.log('the form the model fills (every field required; unknown values are null):');
  console.log(`${pad('field', 18)} ${pad('kind', 14)} ${pad('req', 4)} note`);
  rule();
  for (const field of MEETING_FIELDS) {
    console.log(
      `${pad(field.name, 18)} ${pad(field.kind, 14)} ${pad(field.required ? 'yes' : 'no', 4)} ${field.note}`,
    );
  }

  console.log('');
  console.log(`declared fields in the Zod contract: ${Object.keys(meetingSchema.shape).length}`);

  // Demonstrate closure behaviourally rather than asserting it: add a key nobody asked
  // for and show the validator rejecting the object. That is the claim, tested.
  const wire = wireSchema();
  const withExtraKey = meetingSchema.safeParse({ ...SAMPLE_MEETING, confidence: 0.87 });
  console.log(`wire schema additionalProperties: ${String(wire.additionalProperties)}`);
  console.log(
    `probe: a valid object plus "confidence" → ${
      withExtraKey.success ? 'ACCEPTED (the object is open)' : 'REJECTED (the object is closed)'
    }`,
  );
  if (!withExtraKey.success) {
    const issue = withExtraKey.error.issues.find((entry) => entry.code === 'unrecognized_keys');
    console.log(`  reason: ${issue ? issue.message : 'unexpected key'}`);
  }

  heading('The wire schema sent to the provider');
  console.log(JSON.stringify(wireSchema(), null, 2).split('\n').slice(0, 30).join('\n'));
  console.log('  … (truncated for display)');

  heading('The strict-mode variant: what a grammar can actually enforce');
  const strict = meetingStrictJsonSchema();
  const strictProperties = (strict.properties ?? {}) as Record<string, Record<string, unknown>>;
  console.log('the same schema, with the predicates a decoder may silently ignore removed:');
  for (const name of ['title', 'startIso', 'durationMinutes', 'schemaVersion']) {
    const kept = Object.keys(strictProperties[name] ?? {}).join(', ') || '(none)';
    console.log(`  ${pad(name, 18)} kept: ${kept}`);
  }
  console.log('');
  console.log('Read it as: `pattern`, `format`, `minimum` and `minLength` are gone from the wire');
  console.log('schema, because a grammar enforces *structure*, not value predicates. The runtime');
  console.log('validator is therefore the only guarantee for them — which is Chapter 06.');
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 06 — the reliability loop
 * ───────────────────────────────────────────────────────────── */

async function extractCommand(input: string): Promise<void> {
  const model = await createModel();

  heading(`Chapter 06 · the reliability loop (${config.enforcement})`);
  console.log(`input  ${clamp(input, 80)}`);
  console.log('');

  const { extraction, trace } = await extractMeeting(model, input);

  console.log(`${pad('attempt', 9)} ${pad('enforcement', 12)} ${pad('parsed', 8)} ${pad('ms', 9)} issues`);
  rule();
  for (const attempt of trace.attempts) {
    const issues = attempt.issues.map((entry) => `${entry.path}(${entry.code})`).join(', ') || '—';
    console.log(
      `${pad(String(attempt.n), 9)} ${pad(attempt.enforcement, 12)} ${pad(attempt.parsed ? 'yes' : 'no', 8)} ${pad(ms(attempt.ms), 9)} ${clamp(issues, 40)}`,
    );
  }

  console.log('');
  console.log(`${pad('outcome', 14)} ${extraction.kind}`);
  console.log(`${pad('attempts', 14)} ${trace.attempts.length}`);
  console.log(`${pad('latency', 14)} ${ms(trace.latencyMs)}`);
  console.log(`${pad('provider', 14)} ${trace.provider} · ${trace.model}`);

  if (extraction.kind === 'ok' || extraction.kind === 'degraded') {
    console.log('');
    console.log('the object that crossed the boundary:');
    console.log(indent(JSON.stringify(extraction.value, null, 2), '  '));
    if (extraction.kind === 'degraded') {
      console.log('');
      console.log(`degraded because: ${extraction.reason}`);
      console.log('the caller must treat this as partial, not as truth.');
    }
    if (extraction.flags.length > 0) {
      console.log('');
      console.log('review flags that travelled with it:');
      for (const flag of extraction.flags) console.log(`  · ${flag.path}: ${flag.message}`);
    }
  } else {
    console.log('');
    console.log('nothing crossed the boundary. That is the correct behaviour.');
    if (extraction.kind === 'invalid') {
      console.log('blocking issues:');
      for (const issue of extraction.issues) console.log(`  · ${issue.path}: ${issue.message}`);
    }
    if (extraction.kind === 'refused') {
      console.log(`model said: ${clamp(extraction.raw, 70)}`);
    }
  }

  console.log('');
  console.log(`stages: ${trace.stages.map((stage) => stage.name).join(' → ')}`);
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 06 — validation, two kinds
 * ───────────────────────────────────────────────────────────── */

async function validateCommand(input: string): Promise<void> {
  const model = await createModel('simulate');

  heading('Chapter 06 · structural vs semantic validation');

  // Take the object the model produced at the *weakest* rung, so there is something to
  // validate. This is deliberate: a schema-valid object is the boring case.
  const { raw } = await model.complete({
    system: 'Extract the meeting. Return JSON.',
    user: input,
    enforcement: 'json_mode',
    jsonSchema: {},
    temperature: config.temperature,
  });

  console.log('candidate (json_mode output — parses fine, shape not guaranteed):');
  console.log(indent(clamp(raw, 320), '  '));
  console.log('');

  const { parseJsonStrict, toTaggedIssues } = await import('./lib/json.js');
  const { parseCandidate } = await import('./schema/meeting.js');

  const parsed = parseJsonStrict(raw);
  if (!parsed.ok) {
    console.log(`structural: PARSE FAILED — ${parsed.issue.message}`);
    return;
  }
  console.log('structural: parsed as JSON ✓  (syntax is not shape)');

  const candidate = parseCandidate(parsed.value);
  if (!candidate.ok) {
    console.log('');
    console.log('shape: REJECTED. These are the issues a repair prompt would carry:');
    for (const issue of toTaggedIssues(candidate.error, 'structural')) {
      console.log(`  · ${pad(issue.path, 18)} ${pad(issue.code, 16)} ${issue.message}`);
    }
    console.log('');
    console.log('Note the vocabulary: `wrong_type`, `enum_drift`, `unexpected_key`. That is what');
    console.log('makes the issue distribution metric possible.');
    return;
  }

  console.log('shape: ACCEPTED ✓');
  console.log('');
  console.log('now the second kind of validation — the one a schema cannot express:');
  const issues = semanticChecks(candidate.value, defaultSemanticContext());
  const { blocking, review } = partition(issues);

  if (issues.length === 0) {
    console.log('  no semantic issues. The object is well-shaped *and* plausible.');
  }
  for (const issue of issues) {
    console.log(
      `  · ${pad(issue.severity, 7)} ${pad(issue.path, 18)} ${pad(issue.code, 18)} ${issue.message}`,
    );
  }

  console.log('');
  console.log(`blocking: ${blocking.length}   review: ${review.length}`);
  console.log('Read it as: `block` stops the pipeline and asks for a repair. `review` lets the');
  console.log('object through and flags it for a human. Collapsing both into "invalid" is the');
  console.log('mistake the notes warn about.');
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 06 — the repair prompt
 * ───────────────────────────────────────────────────────────── */

async function repairCommand(input: string): Promise<void> {
  const model = await createModel('simulate');

  heading('Chapter 06 · what a repair prompt contains, and what it can fix');

  // Run at json_mode so the first attempt is genuinely broken, then show the prompt the
  // loop would send on attempt 2.
  const { extraction, trace } = await extractMeeting(model, input, { enforcement: 'json_mode' });

  const firstFailure = trace.attempts.find((attempt) => attempt.issues.length > 0);
  if (!firstFailure) {
    console.log('this input produced no validation issues, so there is nothing to repair.');
    console.log('try an ambiguous one, e.g. "Schedule a meeting with Ravi tomorrow."');
    return;
  }

  console.log('attempt 1 failed with:');
  for (const issue of firstFailure.issues) {
    console.log(`  · ${pad(issue.path, 18)} ${pad(issue.code, 16)} ${issue.message}`);
  }

  heading('The repair prompt the loop actually sends');
  console.log(
    buildRepairPrompt({
      previous: firstFailure.raw,
      issues: firstFailure.issues,
      attempt: 1,
    }),
  );

  heading('What the loop can and cannot fix');
  console.log(`${pad('failure', 18)} fixable?  why`);
  rule();
  const rows: Array<[string, string, string]> = [
    ['wrong_type', 'yes', 'a string "45" becomes the number 45 — a mechanical edit'],
    ['enum_drift', 'yes', 'the schema lists the allowed values, so the model can pick one'],
    ['unexpected_key', 'yes', 'the instruction says "do not add fields"; deletion is safe'],
    ['missing nullable', 'yes', 'null is a stated, valid value for an absent fact'],
    ['missing attendee', 'NO', 'inventing a name would be worse than failing'],
    ['missing date/time', 'NO', 'same reason — and this field is not defaultable'],
    ['out_of_range', 'NO', 'the model cannot know the true duration, so it must not guess'],
    ['refusal', 'NO', 'a refusal is an answer; retrying it wastes money'],
  ];
  for (const [failure, fixable, why] of rows) {
    console.log(`${pad(failure, 18)} ${pad(fixable, 9)}  ${why}`);
  }

  console.log('');
  console.log(`this run: outcome=${extraction.kind} attempts=${trace.attempts.length} in ${ms(trace.latencyMs)}`);
  console.log('Read it as: the repair loop fixes *mechanical* errors and refuses to invent facts.');
  console.log('That asymmetry is the whole design — and the reason `degraded` exists as a');
  console.log('separate outcome rather than a silent default.');
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 07 — structured output vs tool calling
 * ───────────────────────────────────────────────────────────── */

async function toolCommand(input: string): Promise<void> {
  const model = await createModel();
  const calendar = new InMemoryCalendar();

  heading('Chapter 07 · structured output vs tool calling');

  const { extraction } = await extractMeeting(model, input);
  console.log('STRUCTURED OUTPUT — the model produced a result:');
  console.log(`  ${pad('kind', 12)} ${extraction.kind}`);
  console.log(`  ${pad('object', 12)} ${extraction.kind === 'ok' || extraction.kind === 'degraded' ? 'MeetingRequest' : 'none'}`);
  console.log(`  ${pad('executed', 12)} nothing. No side effect has happened.`);
  console.log(`  ${pad('calendar', 12)} ${calendar.listEvents().length} events`);

  if (extraction.kind !== 'ok' && extraction.kind !== 'degraded') {
    console.log('');
    console.log('This input did not produce an object, so there is nothing to act on.');
    return;
  }

  // Now the same information as an *action*: a tool whose arguments are the schema.
  heading('TOOL CALLING — the model produces arguments, and the runtime acts');
  const definition = {
    type: 'function',
    function: {
      name: 'calendar.create_event',
      description: 'Create a calendar event. Use only after the details have been validated.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'attendee', 'startIso', 'durationMinutes'],
        properties: {
          title: { type: 'string' },
          attendee: { type: 'string' },
          startIso: { type: 'string' },
          durationMinutes: { type: 'integer', minimum: 1, maximum: 480 },
        },
      },
    },
  };
  console.log('tool definition sent to the model:');
  console.log(indent(clamp(JSON.stringify(definition, null, 2), 620), '  '));

  // The pipeline: authorise, confirm, execute, report.
  const { outcome, proposal } = await scheduleMeeting(extraction, calendar);

  console.log('');
  console.log(`${pad('proposal', 12)} ${proposal === null ? 'none' : proposal.proposalId}`);
  console.log(`${pad('actor', 12)} ${proposal === null ? '—' : proposal.actor}`);
  console.log(`${pad('idem key', 12)} ${proposal === null ? '—' : proposal.idempotencyKey}`);
  console.log(`${pad('approval', 12)} ${proposal === null ? '—' : proposal.requiresApproval ? `REQUIRED (${proposal.reason})` : 'not required'}`);
  console.log(`${pad('outcome', 12)} ${outcome.kind}`);

  if (outcome.kind === 'awaiting_approval') {
    console.log('');
    console.log('the action is parked. Re-running with approval:');
    const approved = await scheduleMeeting(extraction, calendar, { approved: true });
    console.log(`  outcome: ${approved.outcome.kind}`);
    if (approved.outcome.kind === 'created') {
      console.log(`  event:   ${approved.outcome.externalId}`);
    }
  }

  if (outcome.kind === 'created') {
    console.log(`  event:   ${outcome.externalId}  (duplicate: ${outcome.duplicate})`);
  }

  // The idempotency demonstration: run it again, unchanged.
  heading('Idempotency — the same request, twice');
  const again = await scheduleMeeting(extraction, calendar, { approved: true });
  console.log(`second run outcome: ${again.outcome.kind}`);
  if (again.outcome.kind === 'created') {
    console.log(`duplicate flag:     ${again.outcome.duplicate}`);
    console.log(`same event id:      ${again.outcome.externalId}`);
  }
  console.log(`events in calendar: ${calendar.listEvents().length}  ← not two`);
  console.log('');
  console.log('Read it as: the key is derived from the meeting\'s semantics, so a retry is a');
  console.log('no-op. A random UUID would have created a second event, and nobody would have');
  console.log('noticed until the attendee complained.');
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 08 — the MCP shape
 * ───────────────────────────────────────────────────────────── */

async function mcpCommand(input: string): Promise<void> {
  const calendar = new InMemoryCalendar();
  const server = new CalendarCapabilityServer(calendar);

  /** A deliberately naive approval policy, so the gate is visible in the output. */
  const host = new MeetingToolHost(server, (tool, args) => {
    const duration = typeof args.durationMinutes === 'number' ? args.durationMinutes : 0;
    return tool.tier < 3 || duration <= config.autoApproveMaxDuration;
  });

  heading('Chapter 08 · the MCP shape (not a transport — a contract shape)');

  const capabilities = server.initialize();
  console.log('initialize →');
  console.log(indent(JSON.stringify(capabilities, null, 2), '  '));

  heading('tools/list');
  console.log(`${pad('name', 26)} ${pad('tier', 6)} description`);
  rule();
  for (const tool of host.tools()) {
    console.log(`${pad(tool.name, 26)} ${pad(String(tool.tier), 6)} ${clamp(tool.description, 52)}`);
  }
  console.log('');
  console.log('The tier is a host-side policy. The server advertises capability; the host decides');
  console.log('whether it may be used. A server that says "safe" is not a security control.');

  heading('resources/list — context the *application* injects');
  for (const resource of server.listResources()) {
    console.log(`  ${pad(resource.uri, 34)} ${resource.name}`);
  }
  console.log(`  read calendar://directory/people → ${server.readResource('calendar://directory/people')}`);

  heading('prompts/list — templates the *user* invokes');
  for (const prompt of server.listPrompts()) {
    console.log(`  ${pad(prompt.name, 20)} ${prompt.description}`);
    for (const argument of prompt.arguments) {
      console.log(`    · ${argument.name}${argument.required ? ' (required)' : ''}: ${argument.description}`);
    }
  }

  // The model proposes arguments; the host validates and gates them.
  const { extraction } = await extractMeeting(await createModel(), input);
  const meeting = extraction.kind === 'ok' || extraction.kind === 'degraded' ? extraction.value : null;

  heading('tools/call — the host validates, then gates, then executes');
  if (meeting === null) {
    console.log(`this input produced ${extraction.kind}, so no tool call is possible.`);
    console.log('That is the correct ordering: no object, no action.');
    return;
  }

  const args = {
    title: meeting.title,
    attendee: meeting.attendee,
    startIso: meeting.startIso,
    durationMinutes: meeting.durationMinutes,
    location: meeting.location,
  };

  console.log('arguments (as the model would emit them):');
  console.log(indent(JSON.stringify(args, null, 2), '  '));

  // Identity travels in the session, not in the arguments.
  const session = { actor: config.actorId };

  const readOnly = await host.call(
    {
      name: 'calendar.find_conflicts',
      arguments: { startIso: args.startIso, durationMinutes: args.durationMinutes },
    },
    session,
  );
  console.log('');
  console.log(`tier 1 read  → ${readOnly.content[0].text}`);

  const write = await host.call({ name: 'calendar.create_event', arguments: args }, session);
  console.log(`tier 3 write → isError=${write.isError}  ${clamp(write.content[0].text, 60)}`);

  // Now show a bad argument set: the same call with a schema violation.
  const malformed = await host.call(
    {
      name: 'calendar.create_event',
      arguments: { ...args, durationMinutes: '45' as unknown as number },
    },
    session,
  );
  console.log('');
  console.log('the same call with a drifted argument type:');
  console.log(`  isError=${malformed.isError}  ${clamp(malformed.content[0].text, 70)}`);
  console.log('');
  console.log('Read it as: tool arguments are untrusted input. They are validated on the host,');
  console.log('not on the server; identity comes from the session, not the arguments; and the');
  console.log('host decides whether a tier-3 action runs at all.');
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 09 — the metric card
 * ───────────────────────────────────────────────────────────── */

async function evalCommand(): Promise<void> {
  const model = await createModel('simulate');

  heading('Chapter 09 · the golden set, scored');

  const report = await runSuite(model, config.enforcement);

  console.log(
    `${pad('case', 22)} ${pad('outcome', 10)} ${pad('attempts', 9)} ${pad('fields', 8)} ${pad('ms', 8)} violations`,
  );
  rule();
  for (const score of report.scores) {
    const fields = score.fieldsScored === 0 ? '—' : `${score.fieldsMatched}/${score.fieldsScored}`;
    console.log(
      `${pad(score.id, 22)} ${pad(score.outcome, 10)} ${pad(String(score.attempts), 9)} ${pad(fields, 8)} ${pad(ms(score.latencyMs), 8)} ${clamp(score.violations.join('; ') || '—', 34)}`,
    );
  }

  heading('Metric card');
  const metrics: Array<[string, string]> = [
    ['enforcement', report.enforcement],
    ['cases', String(report.cases)],
    ['first-pass validity (clean)', pct(report.firstPassValidity)],
    ['repair rate (clean)', pct(report.repairRate)],
    ['final failure rate (clean)', pct(report.finalFailureRate)],
    ['outcome kind accuracy', pct(report.kindAccuracy)],
    ['must-reject accuracy', pct(report.negativeAccuracy)],
    ['per-field accuracy', pct(report.fieldAccuracy)],
    ['latency p50 / p95', `${ms(report.p50Ms)} / ${ms(report.p95Ms)}`],
  ];
  for (const [name, value] of metrics) console.log(`${pad(name, 30)} ${value}`);

  console.log('');
  console.log('outcome counts:');
  for (const [kind, count] of Object.entries(report.outcomeCounts)) {
    console.log(`  ${pad(kind, 12)} ${count}`);
  }

  if (Object.keys(report.issueDistribution).length > 0) {
    console.log('');
    console.log('issue distribution (the most useful chart in Chapter 09):');
    for (const [issue, count] of Object.entries(report.issueDistribution).sort(
      (left, right) => right[1] - left[1],
    )) {
      console.log(`  ${pad(issue, 34)} ${count}`);
    }
  }

  heading('The same suite, all four enforcement rungs');
  const comparison = await compareEnforcements(model, [...ENFORCEMENT_LEVELS]);
  console.log(
    `${pad('level', 12)} ${pad('1st-pass', 10)} ${pad('repair', 9)} ${pad('fail', 9)} ${pad('fields', 9)} ${pad('p95', 9)} gate`,
  );
  rule();
  for (const entry of comparison) {
    console.log(
      `${pad(entry.enforcement, 12)} ${pad(pct(entry.firstPassValidity), 10)} ${pad(pct(entry.repairRate), 9)} ${pad(pct(entry.finalFailureRate), 9)} ${pad(pct(entry.fieldAccuracy), 9)} ${pad(ms(entry.p95Ms), 9)} ${entry.gateFailures.length === 0 ? 'pass' : `FAIL (${entry.gateFailures.length})`}`,
    );
  }

  const configured = comparison.find((entry) => entry.enforcement === config.enforcement);
  console.log('');
  if (configured && configured.gateFailures.length === 0) {
    console.log(`release gate: PASS at ENFORCEMENT=${config.enforcement}`);
  } else if (configured) {
    console.log(`release gate: FAIL at ENFORCEMENT=${config.enforcement}`);
    for (const failure of configured.gateFailures) console.log(`  · ${failure}`);
  }
  console.log('');
  console.log('Read it as: the weakest rung fails first-pass validity and leans on repair; the');
  console.log('strongest rung is right the first time. Same schema, same cases, same model.');
}

/* ─────────────────────────────────────────────────────────────
 * Small console helpers
 * ───────────────────────────────────────────────────────────── */

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Never let an unhandled rejection look like a crash. */
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
