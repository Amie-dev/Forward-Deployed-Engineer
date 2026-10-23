/**
 * Notes Ch03 §3.9 and Ch07 §7.4 — the error taxonomy, kept deliberately small.
 *
 * Lecture 15's three primitives fail in three genuinely different ways, and
 * conflating them is how a system ends up either lying to a model or leaking
 * internals to a user:
 *
 *  · A **tool** failure is a *result*. The call ran, the operation failed, and
 *    the text travels back as an ordinary reply with `isError: true` — which
 *    means it lands in the model's context and becomes an instruction channel,
 *    not a stack trace.
 *
 *  · A **resource** failure is a *protocol error*. Nothing executed, no model is
 *    waiting on a recovery sentence, and there is no `isError` channel on
 *    `resources/read` to put one in (Notes Ch03 §3.9).
 *
 *  · A **prompt** failure is a *programming error*. An unknown prompt name or a
 *    missing argument means the caller and the server disagree about the
 *    contract; failing loudly is the only honest response (Notes Ch07 §7.4).
 *
 * That is why every error below carries a `recovery` sentence **and** a status:
 * the first is for the model, the second is for the HTTP layer, and neither is
 * allowed to guess the other's audience.
 */

/**
 * Business failure classes. Deliberately small — a taxonomy nobody reads is a
 * taxonomy nobody uses.
 */
export type FailureCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "FORBIDDEN"
  | "UNAVAILABLE";

/** Which primitive produced the failure. Used for metrics labels and routing. */
export type FailureOrigin = "tool" | "resource" | "prompt";

/** The default HTTP mapping, overridable per call site when a code is context-specific. */
const DEFAULT_STATUS: Record<FailureCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 429,
  FORBIDDEN: 403,
  UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: FailureCode;
  readonly origin: FailureOrigin;

  /** Written *for the model* or the operator: the next thing to try. */
  readonly recovery: string;

  /**
   * True only when a retry cannot duplicate a side effect.
   * A destructive, non-idempotent operation is never retryable, however
   * transient the fault looks.
   */
  readonly retryable: boolean;

  /** The HTTP status the host answers with, when this crosses that boundary. */
  readonly httpStatus: number;

  constructor(
    origin: FailureOrigin,
    code: FailureCode,
    message: string,
    recovery: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.origin = origin;
    this.code = code;
    this.recovery = recovery;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[code];
  }
}

/** A tool execution error — reaches the model as `content` with `isError: true`. */
export class ToolError extends AppError {
  constructor(code: FailureCode, message: string, recovery: string, retryable = false) {
    super("tool", code, message, recovery, { retryable });
  }
}

/**
 * A resource failure — a **protocol error** on the wire (Notes Ch03 §3.9).
 *
 * `FORBIDDEN` is the interesting one: a URI outside the allow-listed schemes, or
 * a resource the session may not read, must be refused *before* a handler runs.
 * A template whose parameter is unchecked is an enumeration oracle (Notes Ch04
 * §"Authorisation and validation live in the handler"), so the refusal is a
 * first-class outcome rather than an afterthought.
 */
export class ResourceError extends AppError {
  constructor(
    code: FailureCode,
    message: string,
    recovery: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super("resource", code, message, recovery, options);
  }
}

/** A prompt failure — a contract violation between caller and server (Notes Ch07). */
export class PromptError extends AppError {
  constructor(
    code: FailureCode,
    message: string,
    recovery: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super("prompt", code, message, recovery, options);
  }
}

/**
 * The JSON-RPC error codes these failures travel as.
 *
 * Written as numbers rather than imported from the SDK on purpose: this module is
 * transport-agnostic, and these values are fixed by the JSON-RPC and MCP
 * specifications rather than by whichever library implements them.
 */
export const JSON_RPC = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  /** The argument is the problem. The caller can fix it, so it is never retryable. */
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP's own code for a resource that does not exist. */
  ResourceNotFound: -32002,
} as const;

/** Failure code → the JSON-RPC code that carries it across the wire. */
export function jsonRpcCodeFor(code: FailureCode): number {
  switch (code) {
    case "INVALID_INPUT":
    case "FORBIDDEN":
    case "CONFLICT":
      // All three are "the caller asked for something the server will not do",
      // and all three are fixed by changing the request rather than by retrying.
      return JSON_RPC.InvalidParams;
    case "NOT_FOUND":
      return JSON_RPC.ResourceNotFound;
    case "LIMIT_EXCEEDED":
    case "UNAVAILABLE":
      return JSON_RPC.InternalError;
  }
}

/**
 * JSON-RPC code → failure code. The inverse of `jsonRpcCodeFor`.
 *
 * Returns `undefined` for codes this taxonomy does not claim, so an unrecognised
 * wire error still falls through to the generic handling rather than being
 * mislabelled.
 */
export function failureCodeFor(wireCode: number): FailureCode | undefined {
  switch (wireCode) {
    case JSON_RPC.InvalidParams:
      return "INVALID_INPUT";
    case JSON_RPC.ResourceNotFound:
      return "NOT_FOUND";
    default:
      return undefined;
  }
}

/** The recovery sentence used when a failure is reclassified from the wire. */
const DEFAULT_RECOVERY: Record<FailureCode, string> = {
  INVALID_INPUT: "Correct the request to match the advertised contract, then retry once.",
  NOT_FOUND: "List what exists before asking for it again.",
  CONFLICT: "Read the current state and report it instead of retrying.",
  LIMIT_EXCEEDED: "Wait for the limit to reset, or reduce the request.",
  FORBIDDEN: "Request access, or use something the session is entitled to.",
  UNAVAILABLE: "Retry once. If it fails again, treat the capability as temporarily unavailable.",
};

/** Builds the right `AppError` subclass for an origin. One place, so none is missed. */
export function createAppError(
  origin: FailureOrigin,
  code: FailureCode,
  message: string,
  recovery?: string,
  retryable = false,
): AppError {
  const text = recovery ?? DEFAULT_RECOVERY[code];

  if (origin === "resource") {
    return new ResourceError(code, message, text, { retryable });
  }

  if (origin === "prompt") {
    return new PromptError(code, message, text, { retryable });
  }

  return new ToolError(code, message, text, retryable);
}

/** Every failure class, as data — so a value that crossed the wire can be validated. */
export const FAILURE_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "LIMIT_EXCEEDED",
  "FORBIDDEN",
  "UNAVAILABLE",
] as const satisfies readonly FailureCode[];

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Anything unexpected becomes a retryable `UNAVAILABLE` — never a protocol error.
 *
 * The call reached a handler, so the caller is owed something it can reason
 * about rather than a connection that dies mid-turn.
 *
 * The reclassification branch is the one that matters in a two-process system. A
 * failure that crossed the wire keeps only what the protocol carries, so the
 * **named class** the server sent is read first and the **JSON-RPC code** second.
 * The name wins because the numeric code is coarser than the taxonomy —
 * `LIMIT_EXCEEDED` and `UNAVAILABLE` both travel as `InternalError`, and only the
 * name tells them apart.
 *
 * Without this, every server-side refusal — a missing argument, an unknown
 * prompt — would arrive as an undifferentiated internal error, and the host would
 * answer `503` and invite the caller to retry something no retry can fix.
 */
export function toAppError(origin: FailureOrigin, error: unknown, label: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  const wireCode = (error as { code?: unknown }).code;
  const data = (error as { data?: { recovery?: unknown; failureCode?: unknown; retryable?: unknown } }).data;

  const named = isFailureCode(data?.failureCode) ? data.failureCode : undefined;
  const mapped = named ?? (typeof wireCode === "number" ? failureCodeFor(wireCode) : undefined);

  if (mapped !== undefined) {
    const recovery = typeof data?.recovery === "string" ? data.recovery : undefined;
    const retryable = data?.retryable === true;

    return createAppError(origin, mapped, message, recovery, retryable);
  }

  if (origin === "tool") {
    return new ToolError(
      "UNAVAILABLE",
      `${label} failed: ${message}`,
      "Retry once. If it fails again, treat this capability as temporarily unavailable.",
      true,
    );
  }

  if (origin === "resource") {
    return new ResourceError(
      "UNAVAILABLE",
      `${label} failed: ${message}`,
      "Retry the read once. If it fails again, report the resource as temporarily unavailable rather than returning empty content.",
      { retryable: true },
    );
  }

  return new PromptError(
    "UNAVAILABLE",
    `${label} failed: ${message}`,
    "Retry once. If it fails again, the prompt catalogue is temporarily unavailable.",
    { retryable: true },
  );
}

export type TextBlock = {
  type: "text";
  text: string;
};

/**
 * The wire shape of a tool result: `content[]` blocks, never a bare value.
 * `structuredContent` is the machine-readable half and must satisfy the tool's
 * declared `outputSchema`.
 *
 * Declared as a type alias rather than an interface on purpose: an object type
 * alias gets an implicit index signature, which is what lets it satisfy the
 * SDK's `{ [x: string]: unknown; content: ... }` callback contract.
 */
export type ToolResult<Structured> = {
  content: TextBlock[];
  structuredContent?: Structured;
  isError?: boolean;
};

/**
 * What a handler computes, before any transport concern is applied.
 *
 * Separating the *outcome* (business meaning) from the *result* (wire shape) is
 * what lets one `guard` wrapper own rate limiting, timeouts, metrics and error
 * mapping for every tool.
 */
export type ToolOutcome<Structured> = {
  /** Prose for the model. Short — this is context, not a report. */
  text: string;
  /** The typed payload the client can validate. */
  structured: Structured;
};

export function toolSuccess<Structured>(outcome: ToolOutcome<Structured>): ToolResult<Structured> {
  return {
    content: [{ type: "text", text: outcome.text }],
    structuredContent: outcome.structured,
  };
}

export function toolFailure(error: AppError): ToolResult<never> {
  return {
    content: [{ type: "text", text: `${error.message} ${error.recovery}` }],
    isError: true,
  };
}

