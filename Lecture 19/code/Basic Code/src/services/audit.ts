import { randomUUID } from "node:crypto";
import type { SecurityEvent, Trace } from "../domain/types.js";

/**
 * Chapter 02 §2.8 — the security trace.
 *
 * This is the same object Chapter 18 called an eval trace, read as a security
 * artefact instead of a quality one. Every field answers a security question:
 *
 *   capabilities  what this request was allowed to reach (Chapter 07)
 *   retrieved     which untrusted text entered the model (Chapter 04)
 *   guardrails    what each layer did, and whether it only *flagged* (Chapter 09)
 *   toolCalls     what was proposed, and what the code decided (Chapters 06, 08)
 *   canaryLeaked  whether the system prompt left the building (Chapter 02 §2.3)
 *
 * If a security incident happens and you cannot answer those five questions from
 * a log line, the incident is not investigable — and an incident you cannot
 * investigate is one you will have again.
 */

export function createTrace(user: string, question: string): Trace {
  return {
    requestId: randomUUID(),
    user,
    question,
    capabilities: [],
    retrieved: [],
    toolCalls: [],
    guardrails: [],
    answer: "",
    refused: false,
    canaryLeaked: false,
  };
}

export function record(trace: Trace, event: SecurityEvent): void {
  trace.guardrails.push(event);
}

/**
 * Chapter 06 §6.3 — the effects that actually happened, in one comparable form.
 *
 * The demo's gate is a comparison against this list, because "nothing bad was
 * executed" is the only claim worth asserting about a security test. An answer
 * that *says* the right thing while the refund went through is not a pass.
 */
export function executedEffects(trace: Trace): string[] {
  return trace.toolCalls
    .filter((call) => call.status === "executed")
    .map((call) => {
      const target = String(call.args.orderId ?? call.args.to ?? "");
      const amount = call.args.amount === undefined ? "" : `:${String(call.args.amount)}`;
      return `${call.name}:${target}${amount}`;
    });
}

/** Chapter 09 §9.13 — a bounded in-memory audit log. A real one is append-only. */
export const auditLog: Trace[] = [];

export function remember(trace: Trace): void {
  auditLog.unshift(trace);
  auditLog.length = Math.min(auditLog.length, 50);
}

/** One screen: what happened, and which layer did it. */
export function summarise(trace: Trace): string {
  const layers =
    trace.guardrails.length === 0
      ? "none"
      : trace.guardrails.map((event) => `${event.layer}:${event.rule}:${event.outcome}`).join(", ");

  const calls =
    trace.toolCalls.length === 0
      ? "none"
      : trace.toolCalls
          .map((call) => `${call.name}[${call.status}] ${call.reason}`)
          .join("\n                ");

  return [
    `  question      "${trace.question}"`,
    `  user          ${trace.user}`,
    `  capabilities  [${trace.capabilities.join(", ")}]`,
    `  retrieved     ${trace.retrieved.join(", ") || "none"}`,
    `  guardrails    ${layers}`,
    `  toolCalls     ${calls}`,
    `  canary        ${trace.canaryLeaked ? "LEAKED (redacted by Layer 4)" : "clean"}`,
    `  answer        "${trace.answer}"`,
  ].join("\n");
}
