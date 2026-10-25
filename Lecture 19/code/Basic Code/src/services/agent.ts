import { config } from "../config/config.js";
import type { ChatResult, GuardrailLayer, SecurityEvent, Session, ToolCall, Trace } from "../domain/types.js";
import { createTrace, record, remember } from "./audit.js";
import { actionGuardrails, inputGuardrails, instructionGuardrails, outputGuardrails } from "./guardrails.js";
import { retrieve } from "./knowledgeBase.js";
import type { ModelClient } from "./model.js";
import { authorize, confirm, requestConfirmation, requiresConfirmation, validateArguments } from "./policy.js";
import { route } from "./router.js";
import { findTool } from "./tools.js";

/**
 * Chapters 06–09 — the agent: the whole lecture in one method.
 *
 * The shape of `chat()` is the argument of the lecture. Read the numbered steps
 * and notice where the model sits: **fifth**. Before it runs, the request has
 * already been filtered and its privileges have already been decided. After it
 * runs, everything it produced is treated as a claim by an untrusted party —
 * which is exactly what Chapter 01 §1.4 says it is.
 *
 * ```
 *   1  input guardrails      (Ch 09 §9.4)
 *   2  capability routing    (Ch 07 §7.4)   ← privileges are granted here, once
 *   3  retrieval             (Ch 04 §4.3)   ← the untrusted channel
 *   4  instruction guardrails(Ch 09 §9.5)
 *   5  the model             (Ch 01 §1.3)   ← it proposes
 *   6  per-proposal checks   (Ch 08)        ← the code decides
 *   7  output guardrails     (Ch 09 §9.7)
 * ```
 *
 * If you delete everything except steps 2 and 6, you still have a system that
 * survives prompt injection. If you delete steps 2 and 6 and keep the rest, you
 * have a system with a lot of safety features and no safety.
 */
export class Agent {
  constructor(private readonly model: ModelClient) {}

  async chat(
    question: string,
    session: Session,
    confirmation?: { id: string; args?: Record<string, unknown> },
  ): Promise<ChatResult> {
    const trace = createTrace(session.user, question);

    // A confirmation is a second request on the same decision, and the only path
    // where a human is the authority. It never calls the model.
    if (confirmation !== undefined) {
      return this.resume(trace, session, confirmation);
    }

    // 1 — Layer 1. Note the fail-closed handling: if the layer itself throws, the
    //     request is refused (Chapter 09 §9.10).
    const input = this.runLayer("input", () => inputGuardrails(question), trace);

    if (!input.ok || input.value.blocked) {
      return this.finish(trace, "I cannot help with that request.", true);
    }

    // 2 — Chapter 07 §7.4: one intent, one capability set, decided *before* the
    //     model runs. This is the only place privileges are granted, and nothing
    //     the model says afterwards can widen them.
    const { capabilities } = route(question);
    trace.capabilities = capabilities;

    // 3 — Chapter 04 §4.3: retrieval, which is a delivery channel.
    const documents = retrieve(question);
    trace.retrieved = documents.map((document) => document.id);

    // 4 — Layer 2: label the trust boundary, and strip obvious directives.
    const prepared = this.runLayer("instructions", () => instructionGuardrails(documents), trace);

    if (!prepared.ok) {
      return this.finish(trace, "I cannot answer that safely right now.", true);
    }

    // 5 + 6 — the bounded loop. `step <= maxToolCalls` gives the model one turn
    //         more than the tool budget, because the extra turn is the one where
    //         it writes the answer.
    let context = prepared.value.context;
    let answer = "";

    for (let step = 0; step <= config.maxToolCalls && answer === ""; step++) {
      const turn = await this.model.answer({ question, context, toolNames: capabilities });

      if (turn.kind === "answer") {
        answer = turn.content;
        break;
      }

      const outcome = this.handle(turn.name, turn.args, session, trace);
      context += `\n\n${outcome.context}`;

      if (outcome.stop !== undefined) {
        answer = outcome.stop;
      }
    }

    if (answer === "") {
      answer = "I could not complete that request within its tool budget.";
    }

    return this.finish(trace, answer);
  }

  /**
   * Chapter 08 §8.6 — the human's decision, applied.
   *
   * This request has no capabilities and retrieved nothing, and that is correct:
   * it is not a new question, it is the execution of a decision that was already
   * checked. The output layer still runs, because "already checked" is not a
   * reason to stop checking.
   */
  private resume(
    trace: Trace,
    session: Session,
    confirmation: { id: string; args?: Record<string, unknown> },
  ): ChatResult {
    const outcome = confirm(confirmation.id, session, confirmation.args);

    if (!outcome.ok) {
      record(trace, { layer: "actions", rule: "confirmation", outcome: "block", detail: outcome.reason });
      return this.finish(trace, `Refused: ${outcome.reason}`);
    }

    const tool = findTool(outcome.tool);

    if (tool === undefined) {
      return this.finish(trace, `Refused: unknown tool ${outcome.tool}.`);
    }

    const call: ToolCall = {
      name: outcome.tool,
      tier: tool.tier,
      args: outcome.args,
      status: "executed",
      reason: `Confirmed by ${session.user}; fingerprint ${outcome.confirmation.fingerprint} matched.`,
    };

    trace.toolCalls.push(call);
    return this.finish(trace, tool.run(outcome.args, session));
  }

  /**
   * Chapter 09 §9.10 — every layer runs through here, and every layer fails closed.
   *
   * A guardrail that throws is a guardrail whose answer is unknown, and "unknown"
   * must never be treated as "safe". That single decision is the difference
   * between a defence that degrades under load and a defence that opens.
   */
  private runLayer<T extends { events: SecurityEvent[] }>(
    name: GuardrailLayer,
    layer: () => T,
    trace: Trace,
  ): { ok: true; value: T } | { ok: false } {
    try {
      const value = layer();
      value.events.forEach((event) => record(trace, event));
      return { ok: true, value };
    } catch (error) {
      record(trace, {
        layer: name,
        rule: "layer-error",
        outcome: "block",
        detail: `the ${name} layer failed, so the request was refused: ${(error as Error).message}`,
      });
      return { ok: false };
    }
  }

  /**
   * Chapters 06 §6.3 + 08 — everything between "the model proposed it" and "it
   * happened". **This is the security seam of the application**, and the order of
   * the checks below is the design:
   *
   *   1. capability      was this tool offered on this request?   (Ch 07 §7.5)
   *   2. action layer    deterministic rules about the call       (Ch 09 §9.6)
   *   3. validation      is the argument well-formed?             (Ch 08 §8.4)
   *   4. authorization   may this caller touch this row?          (Ch 08 §8.3)
   *   5. confirmation    does a human have to decide?             (Ch 08 §8.6)
   *   6. the effect      and only now
   *
   * Steps 1–5 never look at the text that caused the request. That is why they
   * hold even when the model has been completely persuaded — the attacker's
   * sentence is not an input to any of them.
   */
  private handle(
    name: string,
    args: Record<string, unknown>,
    session: Session,
    trace: Trace,
  ): { context: string; stop?: string } {
    const tool = findTool(name);
    const call: ToolCall = { name, tier: tool?.tier ?? "write", args, status: "blocked", reason: "" };
    trace.toolCalls.push(call);

    const refuse = (reason: string, rule: string, alreadyRecorded = false): { context: string } => {
      call.reason = reason;

      if (!alreadyRecorded) {
        record(trace, { layer: "actions", rule, outcome: "block", detail: reason });
      }

      // The refusal goes back into the context **with the exact call it refused**,
      // so the model can stop asking for that call — and only that call. It is told
      // *that* it was refused; it is never told that the refusal is negotiable,
      // because it is not.
      return { context: `TOOL REFUSED: ${name}(${JSON.stringify(args)}). ${reason}` };
    };

    // 1 — Chapter 07 §7.5. The model cannot call what it was not offered, so this
    //     branch is the capability router doing its job a second time, in code.
    if (tool === undefined || !trace.capabilities.includes(name)) {
      return refuse(
        `${name} is not in this request's capability set (${trace.capabilities.join(", ") || "none"})`,
        "capability",
      );
    }

    // 2 — Layer 3, Chapter 09 §9.6. Deterministic: it judges the *call*.
    const executed = trace.toolCalls.filter((entry) => entry.status === "executed").length;
    const actions = this.runLayer("actions", () => actionGuardrails(tool, args, executed), trace);

    if (!actions.ok) {
      return refuse("the action layer failed and the call was refused", "layer-error");
    }

    const blocked = actions.value.events.find((event) => event.outcome === "block");

    if (blocked !== undefined) {
      // `alreadyRecorded`: the layer has already put this event on the trace, and
      // recording it twice would make the audit log read as two separate blocks.
      return refuse(blocked.detail, blocked.rule, true);
    }

    // 3 — Chapter 08 §8.4.
    const valid = validateArguments(tool, args);

    if (!valid.ok) {
      return refuse(valid.reason, "validation");
    }

    call.args = valid.args;

    // 4 — Chapter 08 §8.3. The session decides, never an argument.
    const allowed = authorize(tool, valid.args, session);

    if (!allowed.ok) {
      return refuse(allowed.reason, "authorization");
    }

    // 5 — Chapter 08 §8.6. The request stops here, with a decision outstanding.
    if (requiresConfirmation(tool, valid.args)) {
      const confirmation = requestConfirmation(tool, valid.args, session);
      call.status = "pending-confirmation";
      call.reason = `Confirmation ${confirmation.id} required (fingerprint ${confirmation.fingerprint}).`;
      record(trace, { layer: "actions", rule: "confirmation-required", outcome: "flag", detail: call.reason });

      return {
        context: "",
        stop:
          `This ${tool.name} of INR ${String(valid.args.amount)} needs confirmation. ` +
          `Confirmation id: ${confirmation.id}.`,
      };
    }

    // 6 — the effect. Only here, and only after every check above has passed.
    const result = tool.run(valid.args, session);
    call.status = "executed";
    call.reason = `Validated, authorized, and within the auto-approve limit of INR ${config.autoApproveLimit}.`;

    return { context: `TOOL RESULT (${name}): ${result}` };
  }

  /**
   * Chapter 09 §9.7 — nothing leaves the application without passing Layer 4.
   *
   * This is also where the trace is remembered, and the ordering is deliberate:
   * the answer is recorded *after* the output layer has had its say, so the log
   * contains what the user actually saw. A trace that records the pre-redaction
   * answer is a trace that cannot tell you whether the redaction happened.
   */
  private finish(trace: Trace, answer: string, refused = false): ChatResult {
    const output = this.runLayer("output", () => outputGuardrails(answer, trace), trace);

    if (!output.ok) {
      trace.answer = "I cannot answer that safely right now.";
      trace.refused = true;
    } else {
      trace.answer = output.value.answer;
      trace.canaryLeaked = output.value.canaryLeaked;
    }

    trace.refused = trace.refused || refused;
    remember(trace);

    return { answer: trace.answer, trace };
  }
}
