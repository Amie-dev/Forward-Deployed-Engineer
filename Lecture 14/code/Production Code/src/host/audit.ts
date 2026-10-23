import { createHash } from "node:crypto";
import type { Logger } from "../core/logger.js";
import type { TrustTier } from "./policy.js";

/**
 * Chapter 08 — *"who is allowed to run this tool, on whose authority, and how do
 * I prove it after the fact?"*
 *
 * The third clause is the one teams skip, and the one an incident review asks
 * for first. An audit record answers *who asked for what, what the host decided,
 * and how it ended* — **without storing the arguments.**
 *
 * Arguments are hashed instead, because they routinely carry a name, an email or
 * a token. The digest is enough to correlate a retry, spot a replay and prove
 * that two calls were identical; it is useless for reconstructing the data, and
 * useless to anyone who steals the log.
 */

export type AuditRecord = {
  at: string;
  actor: string;
  tool: string;
  /** What the host decided, before anything ran. */
  decision: TrustTier | "blocked";
  outcome: "ok" | "error" | "denied";
  /** Truncated SHA-256 of the canonicalised arguments — never the arguments. */
  argsHash: string;
  durationMs: number;
};

export interface AuditEntry {
  actor: string;
  tool: string;
  decision: AuditRecord["decision"];
  outcome: AuditRecord["outcome"];
  args: Record<string, unknown>;
  durationMs: number;
}

export interface AuditLog {
  record(entry: AuditEntry): AuditRecord;
  entries(): AuditRecord[];
}

/**
 * Canonicalises before hashing, so `{a:1,b:2}` and `{b:2,a:1}` produce the same
 * digest. Without this, "were these two calls identical?" — the only question
 * the hash exists to answer — has a wrong answer half the time.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
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
        tool: entry.tool,
        decision: entry.decision,
        outcome: entry.outcome,
        argsHash: hashArgs(entry.args),
        durationMs: Math.round(entry.durationMs),
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
