import { createHash } from "node:crypto";
import type { Logger } from "../core/logger.js";
import type { TrustTier } from "./policy.js";

/**
 * *"Who is allowed to run this, on whose authority, and how do I prove it after
 * the fact?"*
 *
 * The third clause is the one teams skip, and the one an incident review asks for
 * first. Lecture 15 widens the record: there are now **three** primitives to
 * account for, and a resource read is exactly as interesting as a tool call when
 * the question is *"why did the model know that?"*
 *
 * An audit record answers *who asked for what, what the host decided, and how it
 * ended* — **without storing the arguments or the content.**
 *
 * Both omissions are deliberate and they are different omissions:
 *
 *  · **Arguments are hashed.** They routinely carry a name, an email or a token.
 *    The digest is enough to correlate a retry, spot a replay and prove that two
 *    calls were identical; it is useless for reconstructing the data, and useless
 *    to anyone who steals the log.
 *
 *  · **Resource content is never recorded at all.** A resource body can be a
 *    policy document or a person's workload, and the audit trail's job is to
 *    record *which* URI was read and *why* — the URI and the reason are the
 *    accountable facts; the bytes are not.
 */

/** Which primitive produced the record. */
export type AuditAction = "tool" | "resource" | "prompt";

export type AuditOutcome = "ok" | "error" | "denied";

export type AuditDecision = TrustTier | "allowed" | "blocked";

/**
 * Declared as a type alias rather than an interface on purpose: an object type
 * alias gets an implicit index signature, which is what lets the whole record be
 * handed to the logger's `Record<string, unknown>` fields without a cast.
 */
export type AuditRecord = {
  at: string;
  actor: string;
  action: AuditAction;
  /** Tool name, resource URI, or prompt name. */
  target: string;
  /** What the host decided, before anything ran. */
  decision: AuditDecision;
  outcome: AuditOutcome;
  /** Truncated SHA-256 of the canonicalised arguments — never the arguments. */
  argsHash: string;
  durationMs: number;
  /**
   * The accountable detail: a selection strategy, a byte count, an error code,
   * a refusal reason. Short by construction — this is a record, not a report.
   */
  note?: string;
}

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  target: string;
  decision: AuditDecision;
  outcome: AuditOutcome;
  /** Hashed before it is stored. Never the raw values. */
  args: Record<string, unknown>;
  durationMs: number;
  note?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): AuditRecord;
  entries(): AuditRecord[];
}

/**
 * Canonicalises before hashing, so `{a:1,b:2}` and `{b:2,a:1}` produce the same
 * digest.
 *
 * Without this, *"were these two calls identical?"* — the only question the hash
 * exists to answer — has a wrong answer half the time, because two clients will
 * serialize the same arguments in different key orders.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}

export function createAuditLog(logger: Logger): AuditLog {
  const records: AuditRecord[] = [];

  return {
    record(entry) {
      const record: AuditRecord = {
        at: new Date().toISOString(),
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        decision: entry.decision,
        outcome: entry.outcome,
        argsHash: hashArgs(entry.args),
        durationMs: Math.round(entry.durationMs),
        ...(entry.note === undefined ? {} : { note: entry.note }),
      };

      records.push(record);

      // The same line goes to the audit trail *and* the log stream: one is the
      // queryable record, the other is what an operator sees live.
      logger.info("audit", record);

      return record;
    },

    entries() {
      return [...records];
    },
  };
}
