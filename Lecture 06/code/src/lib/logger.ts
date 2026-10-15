import { env } from '../config/env.js';

/**
 * Structured, single-line JSON logger.
 *
 * Why not `console.log("...")` strings? Because streaming failures are
 * *statistical* (p95 tails) and per-hop: §10.3 requires one machine-parsable
 * line per stream, carrying requestId, TTFT, chunk count, usage and finish
 * reason so that a log query can reconstruct the whole pipeline for one turn.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown>;

/**
 * Redaction at write time (§10.4.2): provider keys, bearer tokens and other
 * credentials must never appear in logs, and model output is truncated so that a
 * single log line never explodes in size.
 *
 * NOTE the deliberate precision: a naive /token/i match would also redact
 * `promptTokens` and `completionTokens` — the very fields the streaming telemetry
 * exists to record. Only credential-shaped keys are masked.
 */
const SECRET_KEY_EXACT = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'authorization',
  'auth',
  'apikey',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'cookie',
  'setcookie',
  'bearer',
  'credentials',
]);

const SECRET_KEY_PATTERN = /(secret|password|credential|api[_-]?key|authorization|bearer|cookie)/i;

const MAX_STRING_LENGTH = 512;

function isSecretKey(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  return SECRET_KEY_EXACT.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function sanitise(value: unknown, key: string, depth = 0): unknown {
  if (isSecretKey(key)) return '«redacted»';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…«truncated»` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  if (depth >= 3) return '«depth-limit»';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitise(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitise(v, k, depth + 1)])
    );
  }
  return String(value);
}

export class Logger {
  constructor(
    private readonly baseContext: LogContext = {},
    private readonly threshold: number = LEVEL_RANK[env.LOG_LEVEL]
  ) {}

  /** Derive a logger that always carries the given context (e.g. requestId). */
  public child(context: LogContext): Logger {
    return new Logger({ ...this.baseContext, ...context }, this.threshold);
  }

  public debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  /** Emit a whole record (used for the per-stream telemetry line). */
  public record(message: string, context: LogContext, level: LogLevel = 'info'): void {
    this.write(level, message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < this.threshold) return;

    const merged: LogContext = { ...this.baseContext, ...(context ?? {}) };
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...(sanitise(merged, 'root') as LogContext),
    });

    // Errors go to stderr so container platforms can split the two streams.
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

export const logger = new Logger();
export const createRequestLogger = (requestId: string, conversationId?: string): Logger =>
  logger.child(conversationId ? { requestId, conversationId } : { requestId });
