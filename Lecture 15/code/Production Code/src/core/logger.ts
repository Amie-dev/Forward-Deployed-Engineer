/**
 * Observability, and the two rules a server that talks a protocol must not break.
 *
 * **Rule 1 — the log stream is never the protocol stream.** On a stdio binding
 * stdout *is* the JSON-RPC channel, and a stray `console.log` there corrupts a
 * frame and kills the connection. On Streamable HTTP the same discipline still
 * pays: diagnostics go to stderr so an operator can pipe them without filtering
 * protocol traffic out first.
 *
 * **Rule 2 — arguments are user data.** Tool arguments and prompt arguments
 * routinely carry a name, an email or a token, so values are redacted and
 * truncated before they are written. A log line is not the place to discover you
 * have been storing PII.
 *
 * This module deliberately imports nothing from `config`, so `config/env.ts` can
 * import `LOG_LEVELS` from here without creating a cycle.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric severity, so `MCP_LOG_LEVEL=warn` can suppress the levels below it. */
const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Anything whose key looks like this is replaced, never logged. */
const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|cookie|credential)/i;

const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** A logger that stamps every subsequent line with `bindings`. */
  child(bindings: Fields): Logger;
}

/**
 * Recursively masks secrets and bounds the size of what gets written.
 *
 * Bounding matters as much as masking: an unbounded field is how a single log
 * line becomes a 40 MB file, and — in a system whose whole job is assembling
 * context — how a resource body accidentally ends up in the log instead of the
 * prompt.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)`
      : value;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…(+${value.length - MAX_ARRAY} more)`] : head;
  }

  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    masked[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return masked;
}

/**
 * One JSON object per line — greppable, parseable, and cheap to write.
 *
 * A factory rather than a module-level singleton, so a caller can bind context
 * once (`logger.child({ requestId })`) and so tests can inject a quiet one.
 */
export function createLogger(level: LogLevel, bindings: Fields = {}): Logger {
  const threshold = SEVERITY[level];

  const emit = (severity: LogLevel, event: string, fields?: Fields): void => {
    if (SEVERITY[severity] < threshold) {
      return;
    }

    const line = {
      ts: new Date().toISOString(),
      level: severity,
      event,
      ...(redact(bindings) as Fields),
      ...(fields === undefined ? {} : (redact(fields) as Fields)),
    };

    process.stderr.write(`${JSON.stringify(line)}\n`);
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
