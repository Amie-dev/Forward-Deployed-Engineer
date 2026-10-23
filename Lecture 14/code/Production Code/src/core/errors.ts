/**
 * Chapter 05 §5.7 — the two error mechanisms, kept deliberately separate.
 *
 *  · A **protocol error** means the call never happened — an unknown tool, a
 *    malformed frame, a missing capability. Nothing executed, and the host may
 *    retry safely.
 *
 *  · A **tool execution error** means the call *ran* and the operation failed.
 *    It travels back as an ordinary result with `isError: true`, and its text
 *    is appended to the model's context — which makes it an instruction
 *    channel, not a stack trace.
 *
 * That second point is why every error below carries a `recovery` sentence.
 * The model reads `content`, so a message that says only `Error` teaches it
 * nothing and it will hallucinate success on the next turn.
 */

/** Business failure classes. Deliberately small — a taxonomy nobody reads is a taxonomy nobody uses. */
export type ToolFailureCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "UNAVAILABLE";

export class ToolError extends Error {
  readonly code: ToolFailureCode;

  /** Written *for the model*: the next thing to try. */
  readonly recovery: string;

  /**
   * True only when a retry cannot duplicate a side effect.
   * A destructive, non-idempotent operation is never retryable, however
   * transient the fault looks.
   */
  readonly retryable: boolean;

  constructor(code: ToolFailureCode, message: string, recovery: string, retryable = false) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.recovery = recovery;
    this.retryable = retryable;
  }
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

export function toolFailure(error: ToolError): ToolResult<never> {
  return {
    content: [{ type: "text", text: `${error.message} ${error.recovery}` }],
    isError: true,
  };
}
