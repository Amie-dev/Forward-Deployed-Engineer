/**
 * Chapter 08 — observability, and the one rule a stdio server cannot break.
 *
 * **stdout is the protocol channel.** The host spawned this process and is
 * reading JSON-RPC frames off `stdout`; a single `console.log` there corrupts
 * the stream and the connection dies. So every line this module writes goes to
 * `stderr`, and the host is free to pipe it anywhere.
 *
 * The second rule is quieter but just as load-bearing: **tool arguments are
 * user data.** They routinely carry a name, an email or a token, so values are
 * redacted and truncated before they are written — a log line is not a place
 * to discover you have been storing PII.
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
 * line becomes a 40 MB file, and how a context window gets filled by accident.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
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
 * The logger is a factory rather than a module-level singleton so a caller can
 * bind context once (`logger.child({ requestId })`) and so tests can inject a
 * quiet one.
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
