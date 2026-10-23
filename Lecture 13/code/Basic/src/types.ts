/**
 * Every data contract in Lecture 13, in one file.
 *
 * The lecture has exactly one thesis, and this file is it in type form:
 *
 *   A model produces *text*. An application needs a *typed object*. Between the two
 *   there is a boundary, and the boundary has four things on it — a schema, a
 *   validator, a repair path and a typed outcome.
 *
 * Read the file top to bottom and you walk the pipeline:
 *
 *   MeetingRequest    what the model must produce         (Chapters 02, 04)
 *   EnforcementLevel  which guarantee the call carries    (Chapters 03, 05)
 *   Issue             a machine-readable validation error (Chapter 06)
 *   Extraction        the typed outcome of one extraction (Chapter 06)
 *   ExtractionTrace   the per-call record a reviewer reads (Chapter 09)
 *   ActionOutcome     the typed outcome of a side effect   (Chapters 07, 08)
 *
 * `MeetingRequest` is deliberately the same shape as the board's `MeetingDetails`
 * form. That is not a coincidence: a schema is a form, and the model fills the slots.
 */

/* ─────────────────────────────────────────────────────────────
 * Chapters 02 + 04 — the contract the application owns
 * ───────────────────────────────────────────────────────────── */

/** Closed set, so it is an enum and not a free-text string (Chapter 04 §4.4). */
export const MEETING_TYPES = ['ONE_ON_ONE', 'INTERVIEW', 'TEAM', 'OTHER'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

/**
 * The typed object the whole lecture exists to produce.
 *
 * Note the four decisions Chapter 04 says every field forces:
 *   kind        — `durationMinutes` is an integer, not "30 minutes"
 *   presence    — every field is required; unknown values are `null`, never absent
 *   constraints — bounds on duration and lengths
 *   meaning     — units in the name, descriptions in the schema
 */
export interface MeetingRequest {
  /** Short meeting title derived from the topic. */
  title: string;
  /** Full name or email of the other participant. */
  attendee: string;
  /** ISO 8601 local date-time, e.g. `2026-10-02T16:00`. Normalised, never "tomorrow". */
  startIso: string;
  /** Integer minutes. `minimum: 1`, `maximum: 480`. */
  durationMinutes: number;
  /** Closed set — the reason a downstream `switch` can be exhaustive. */
  type: MeetingType;
  /** `null` when the input did not mention a place. Not `""`, not `"N/A"`. */
  location: string | null;
  /** One or two sentences of rationale, generated *before* the labels (Chapter 04 §4.11). */
  reasoning: string;
  /** `const` in the schema: stored objects declare which contract they satisfy. */
  schemaVersion: string;
}

/* ─────────────────────────────────────────────────────────────
 * Chapters 03 + 05 — the enforcement ladder
 * ───────────────────────────────────────────────────────────── */

/**
 * The four rungs from the notes. Each is a strictly stronger guarantee than the one
 * before it, and each is only available where the provider or runtime supports it.
 */
export type EnforcementLevel =
  /** "Return JSON" in the prompt. A preference over a token distribution. */
  | 'instruction'
  /** `response_format: { type: "json_object" }`. A *parser* guarantee. */
  | 'json_mode'
  /** `response_format: { type: "json_schema", strict: true }`. A *shape* guarantee. */
  | 'schema'
  /** Everything above, plus runtime validation. Nothing invalid passes. */
  | 'validate';

export const ENFORCEMENT_LEVELS: readonly EnforcementLevel[] = [
  'instruction',
  'json_mode',
  'schema',
  'validate',
] as const;

/** What a level actually promises. Printed by `npm run layers`. */
export interface EnforcementGuarantee {
  level: EnforcementLevel;
  syntax: 'none' | 'guaranteed';
  shape: 'none' | 'likely' | 'guaranteed';
  values: 'none' | 'validated';
  /** Provider API surface this maps to. */
  wire: string;
  /** The failure class this level removes. */
  removes: string;
}

/* ─────────────────────────────────────────────────────────────
 * Chapter 06 — validation, repair and typed outcomes
 * ───────────────────────────────────────────────────────────── */

/**
 * One validation problem, in the shape a repair prompt needs and a metric can count.
 *
 * `path` + `message` is deliberately the shape Zod and JSON Schema validators
 * produce, because that list is what gets pasted into the repair prompt.
 */
export interface Issue {
  /** Dot path into the object, e.g. `durationMinutes`. */
  path: string;
  /** Machine-readable class, used for the issue-distribution metric. */
  code: IssueCode;
  /** Human-readable detail, safe to send back to the model. */
  message: string;
  /**
   * `block` means the object is unusable or unsafe: repair, then fall back.
   * `review` means it is plausible but needs a human: accept and flag.
   *
   * Collapsing both into "invalid" is the mistake Chapter 06 §6.6 warns about —
   * it either over-rejects good data or under-rejects bad data.
   */
  severity: 'block' | 'review';
}

export type IssueCode =
  | 'parse_error'
  | 'missing_field'
  | 'wrong_type'
  | 'enum_drift'
  | 'out_of_range'
  | 'unexpected_key'
  | 'not_a_date'
  | 'not_in_future'
  | 'unknown_attendee'
  | 'policy_violation';

/** Which stage produced the issue: shape or meaning. */
export type IssueOrigin = 'structural' | 'semantic';

export interface TaggedIssue extends Issue {
  origin: IssueOrigin;
}

/** Why an extraction produced nothing usable. Drives routing, not just logging. */
export type FailureReason =
  | 'refused'
  | 'truncated'
  | 'empty'
  | 'parse_error'
  | 'shape_error'
  | 'semantic_error'
  | 'timeout'
  | 'provider_error';

/** One attempt at producing a valid object. */
export interface Attempt {
  /** 1-based. `attempt === 1` is what "first-pass validity" measures. */
  n: number;
  enforcement: EnforcementLevel;
  /** Exactly what the provider returned — logged on failure, never trusted. */
  raw: string;
  /** True when the raw text parsed as JSON at all. */
  parsed: boolean;
  /** Validation issues found, if any. */
  issues: TaggedIssue[];
  ms: number;
}

/**
 * The outcome of an extraction, as a discriminated union.
 *
 * A system that only has "success" and "exception" cannot report *why* it failed,
 * cannot route failures differently, and cannot measure anything except one error
 * rate. Chapter 06 §6.10.
 */
export type Extraction =
  | {
      kind: 'ok';
      value: MeetingRequest;
      /** 1 = clean first pass. Greater than 1 means a repair succeeded. */
      attempts: number;
      /** `review`-severity issues that were accepted anyway. */
      flags: TaggedIssue[];
    }
  | {
      kind: 'degraded';
      /** Unknowns filled with `null`; only produced when fallback allows it. */
      value: MeetingRequest;
      attempts: number;
      flags: TaggedIssue[];
      reason: string;
    }
  | { kind: 'refused'; attempts: number; raw: string }
  | { kind: 'truncated'; attempts: number; raw: string }
  | { kind: 'invalid'; attempts: number; issues: TaggedIssue[]; reason: FailureReason }
  | { kind: 'failed'; attempts: number; reason: FailureReason; message: string };

/** Every `Extraction` variant, so metrics can count them without a default branch. */
export const EXTRACTION_KINDS = ['ok', 'degraded', 'refused', 'truncated', 'invalid', 'failed'] as const;

/* ─────────────────────────────────────────────────────────────
 * Chapter 09 — the trace
 * ───────────────────────────────────────────────────────────── */

/** One timed stage. `detail` is the number a reviewer will ask about. */
export interface TraceStage {
  name: string;
  ms: number;
  detail: string;
}

/**
 * Everything needed to explain one extraction without opening a debugger.
 *
 * Note what is *absent*: the raw model output on the success path. Raw output is
 * kept per-attempt for failures only, because it frequently contains personal data
 * and general logs are the wrong place for it (Chapter 09 §9.6).
 */
export interface ExtractionTrace {
  task: string;
  schemaVersion: string;
  provider: string;
  model: string;
  enforcement: EnforcementLevel;
  stages: TraceStage[];
  attempts: Attempt[];
  /** `ok` | `degraded` | `refused` | ... — the outcome, not an exception. */
  outcome: Extraction['kind'];
  issueDistribution: Record<string, number>;
  latencyMs: number;
}

/* ─────────────────────────────────────────────────────────────
 * Chapters 07 + 08 — from data to action
 * ───────────────────────────────────────────────────────────── */

/**
 * A proposed action. This is the *boundary object*: the model produced the
 * `MeetingRequest`, and the application wrapped it in something it can authorise,
 * key and execute. **Nothing has happened yet.**
 */
export interface ActionProposal {
  proposalId: string;
  meeting: MeetingRequest;
  /** Who asked. Authorisation is per-actor and happens in code, never in a prompt. */
  actor: string;
  /** Derived from the object's semantics so a retry cannot duplicate the action. */
  idempotencyKey: string;
  /** True when a human must confirm before execution (tier 3). */
  requiresApproval: boolean;
  reason: string;
}

/** Typed domain errors. Vendor HTTP codes must not leak upward (Chapter 08 §8.4). */
export type ActionErrorCode =
  | 'forbidden'
  | 'conflict'
  | 'unauthorised'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid';

export type ActionOutcome =
  | { kind: 'created'; externalId: string; url: string; duplicate: boolean }
  | { kind: 'awaiting_approval'; proposal: ActionProposal }
  | { kind: 'rejected'; code: ActionErrorCode; message: string }
  | { kind: 'failed'; code: ActionErrorCode; message: string; retryAfterMs?: number };

/* ─────────────────────────────────────────────────────────────
 * Chapter 08 — the MCP shape (tools / resources / prompts)
 * ───────────────────────────────────────────────────────────── */

/** A tool definition: the same JSON Schema contract as Chapter 04, for arguments. */
export interface ToolDefinition {
  name: string;
  /** The routing signal. Describes *when* to use the tool, not what it is. */
  description: string;
  /** JSON Schema for the arguments. Enforced by the provider on the arguments. */
  inputSchema: Record<string, unknown>;
  /** Risk tier. Tier 3 requires human approval before execution. */
  tier: 1 | 2 | 3;
}

/** A resource: context the *application* decides to inject. */
export interface ResourceDefinition {
  uri: string;
  name: string;
  mimeType: string;
}

/** A prompt: a template the *user* chooses to invoke. */
export interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  /** JSON-RPC-shaped: `content` blocks plus an `isError` flag. */
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}
