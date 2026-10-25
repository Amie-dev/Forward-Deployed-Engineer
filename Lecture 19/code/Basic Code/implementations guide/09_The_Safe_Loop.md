# Chapter 09 — The Safe Loop

> **This is the file the whole lecture is about.** Everything before it was a
> component; this is the order the components run in, and the order is the
> argument.
>
> Read the numbered steps of `chat()` and notice where the model sits: **fifth**.
> Before it runs, the request has already been filtered and its privileges have
> already been decided. After it runs, everything it produced is treated as a claim
> by an untrusted party — which is exactly what Chapter 01 §1.4 says it is.
>
> ```
>   1  input guardrails      (Ch 09 §9.4)
>   2  capability routing    (Ch 07 §7.4)   ← privileges are granted here, once
>   3  retrieval             (Ch 04 §4.3)   ← the untrusted channel
>   4  instruction guardrails(Ch 09 §9.5)
>   5  the model             (Ch 01 §1.3)   ← it proposes
>   6  per-proposal checks   (Ch 08)        ← the code decides
>   7  output guardrails     (Ch 09 §9.7)
> ```
>
> If you delete everything except steps 2 and 6, you still have a system that
> survives prompt injection. If you delete steps 2 and 6 and keep the rest, you have
> a system with a lot of safety features and no safety.

---

## File details

| | `src/services/agent.ts` |
|---|---|
| **Lines** | 289 |
| **Layer** | services |
| **Purpose** | the safe loop: assemble the layers in order, and never let the model decide |
| **Exports** | `Agent` (class, `chat()` and three private methods) |
| **Imports** | `config`, `domain/types`, and six service modules |
| **Notes sections** | Ch 06 §6.2, §6.3, Ch 07 §7.4, §7.5, Ch 08 §8.3–8.6, Ch 09 §9.4–9.10 |

**The dependency shape.** `agent.ts` is the only file in the project that imports
all six of the others. That is not a smell — it is the design. Someone has to own
the order, and that someone should be the file whose name says so.

---

## Commands

```bash
cd "Lecture 19/code/Basic Code"
npm run typecheck
```

```bash
# The whole loop, on a request that gets attacked and still succeeds.
npm run demo 2>&1 | sed -n '/indirect-no-filter/,/verdict/p'

# The seam, in order: capability, then the action layer, then policy.
npm run demo 2>&1 | grep -E 'TOOL REFUSED|capability set|belongs to another'
```

```bash
# Fail closed: a layer that throws refuses the request.
grep -n 'layer-error' src/services/agent.ts
```

---

## `src/services/agent.ts` — the full file (part 1 of 4)

```ts
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
```

**How it works, block by block — `chat()`, the seven steps**

| Step | What it does and why |
| :--- | :--- |
| `const trace = createTrace(session.user, question)` | The trace is created **first**, before anything can fail, so every request — including one blocked in the first line — leaves a record. `session.user` is on it from the start; the trace is built from the server's view, never from the request body. |
| `if (confirmation !== undefined) return this.resume(...)` | The confirmation path, and note where it branches: **before the input layer**. A confirmation is not a question; it is a decision that was already checked. Sending it back through the input filter would be theatre. |
| **1** `this.runLayer("input", …)` | Layer 1, wrapped in the fail-closed helper. The wrapper is what turns "the layer threw an exception" into "the request was refused" — see `runLayer` below. |
| `if (!input.ok \|\| input.value.blocked)` | Two failure modes, one response: the layer *errored*, or the layer *blocked*. Both refuse, both mark the trace `refused: true`. There is deliberately no third branch where an errored layer is treated as a pass. |
| **2** `const { capabilities } = route(question); trace.capabilities = capabilities;` | **The privilege grant.** One call, one array, recorded on the trace immediately. Every later check compares against this array — including `handle`'s capability check — so the trace and the enforcement can never disagree about what was allowed. |
| **3** `retrieve(question)` / `trace.retrieved` | The untrusted channel, opened deliberately. The ids go on the trace so a reviewer can see *which* documents entered the context — the first question in any injection investigation. |
| **4** `this.runLayer("instructions", …)` | Layer 2, fail-closed. Its output is not just events: it is the **context string** the model will receive, already labelled and stripped. |
| **5** `this.model.answer({ question, context, toolNames: capabilities })` | The model. Note the third argument: the capability set is passed *in*, so `OpenAIModel` can filter its tool list and `OfflineModel` can filter its proposals. The model is told what it may reach, and it has no way to ask for more. |
| `for (let step = 0; step <= config.maxToolCalls && answer === ""; step++)` | The bounded loop. `<=` rather than `<` because the tool budget counts *tool calls*, not turns — the extra turn is the one where the model writes the final answer after its last action. A loop without this ceiling is a denial-of-service waiting to happen. |
| `if (turn.kind === "answer") { answer = turn.content; break; }` | The normal exit: the model decided it was done. `break` rather than a flag, so there is no way to fall through into another iteration. |
| `const outcome = this.handle(turn.name, turn.args, session, trace)` | **The seam.** Every proposal goes through one method, and that method is where the code — not the model — decides. |
| `context += \`\n\n${outcome.context}\`` | The result or refusal is appended to the context, so the next turn's model call sees what happened. This is how the loop terminates: the model learns what was refused and what already ran. |
| `if (outcome.stop !== undefined) answer = outcome.stop` | The third exit: a proposal that needs a human, or one that ends the conversation. `stop` carries the sentence the user will read. |
| `if (answer === "") answer = "I could not complete…"` | The budget exit. Reaching it means the loop ran out of turns without an answer — which is a *refusal*, not a crash, and it says so. |
| `return this.finish(trace, answer)` | **Every** exit funnels through `finish`, which runs Layer 4 and records the trace. There is no return path that skips the output guardrail, which is what makes "nothing leaves the application without passing Layer 4" true rather than aspirational. |

**The single most important structural fact about this method:** `this.handle` is
the only place in the project that can reach `tool.run()`. Grep for `run(` and you
will find exactly one call site. That is the property to protect in review — a
second call site anywhere, however well-intentioned, is the whole architecture
gone.

---

## `src/services/agent.ts` — the full file (part 2 of 4)

```ts
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
```

**How it works, block by block — `resume()` and `runLayer()`**

| Block | What it does and why |
| :--- | :--- |
| `resume`'s doc comment | It says the two things that look wrong and are right: the request has **no capabilities** and **retrieved nothing**. That is correct because it is not a question — it is the execution of a decision. A reader who expects a full pipeline here would think the code is broken; the comment is there to stop that. |
| `const outcome = confirm(confirmation.id, session, confirmation.args)` | All four confirmation checks (exists, pending, same user, same arguments) happen in `policy.ts`. `resume` adds nothing and decides nothing — it reports the result. |
| `record(trace, { rule: "confirmation", outcome: "block", … })` | A refused confirmation is a *security event*, not a 400. It is recorded on the actions layer with the reason, so a burst of failed confirmation attempts is visible in `GET /audit` — which is exactly the signal you want if somebody is enumerating ids. |
| `findTool(outcome.tool)` and the `undefined` branch | The stored tool name is looked up again. It cannot be missing in practice, but the branch exists because `strict` requires it and because "unknown tool" should be a refusal with a reason rather than a crash. |
| `args: outcome.args` | **The stored arguments, not the submitted ones.** `confirm()` returns what was approved, so even a successful confirmation cannot be used to execute different arguments. |
| `reason: \`Confirmed by ${session.user}; fingerprint … matched.\`` | The trace line that makes the flow auditable end-to-end: who approved it, and which fingerprint they matched. Reading that line, you can tell that a human decided and that the decision was the same one. |
| `trace.toolCalls.push(call)` then `tool.run(...)` | The effect, reached through the human path. Note it is still a `ToolCall` on the trace with `status: "executed"` — so `executedEffects()` sees it and the demo's gate covers it. A confirmation path that bypassed the trace would be a hole in the only evidence you have. |
| `runLayer`'s generic `T extends { events: SecurityEvent[] }` | One helper for four layers with three different return shapes. The constraint is exactly what it needs: anything with `events` can be recorded. Layer 2's `{ context, events }` satisfies it, and `value.context` is available to the caller through `T`. |
| `try { const value = layer(); … } catch { … }` | **Fail closed.** The catch branch records `outcome: "block"` and returns `{ ok: false }`. A guardrail that throws has an *unknown* answer, and unknown must never be treated as safe. This is the difference between a defence that degrades under load and one that opens under load. |
| `rule: "layer-error"` and the detail | The error message is put on the trace. When a layer fails in production, the first question is *which layer and why*, and this line answers both without a debugger. |
| `value.events.forEach((event) => record(trace, event))` | The single write path. Layers never touch the trace themselves — they return events, and this records them. That is what keeps the four layers unit-testable and side-effect-free. |

---

## `src/services/agent.ts` — the full file (part 3 of 4)

```ts
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
```

**How it works, block by block — `handle()`, the seam**

| Block | What it does and why |
| :--- | :--- |
| `const call: ToolCall = { …, status: "blocked", reason: "" }` | The call is recorded on the trace **before** any check runs, with `status: "blocked"` as the pessimistic default. If anything below throws or returns early, the trace already shows a blocked call rather than nothing at all. Fail-closed, in the data structure. |
| `tier: tool?.tier ?? "write"` | For an unknown tool there is no tier, and `"write"` is the conservative guess. `?.` plus `??` rather than a non-null assertion: the unknown-tool case is handled on the next line, not assumed away. |
| `refuse(reason, rule, alreadyRecorded = false)` | One closure for every refusal path, so the *shape* of a refusal is identical everywhere: `call.reason` set, an event recorded, and a context line returned. The `alreadyRecorded` flag exists because Layer 3 has already recorded its own block event, and double-recording would make one block look like two in the audit log. |
| `` `TOOL REFUSED: ${name}(${JSON.stringify(args)})` `` | **The refusal names the exact call.** This is the line that makes the `indirect-no-filter` scenario work: `refund ORD-202` is refused and stays refused, while `refund ORD-101` — the request the user actually made — is still open. Keying by tool name alone would have refused both. |
| `// never told that the refusal is negotiable` | The comment is a design statement. The refusal is *information* the model needs to stop looping, and it is not a prompt it can argue with. Nothing in the loop re-examines a refusal. |
| **1** `tool === undefined \|\| !trace.capabilities.includes(name)` | Chapter 07 §7.5, enforced a second time. The router already withheld the tool, so in practice this fires only when the model proposes something it was never given — which is exactly the `sendEmail` attempt in `indirect-no-filter`, and it is blocked here with the capability set printed in the reason. |
| **2** `const executed = trace.toolCalls.filter((entry) => entry.status === "executed").length` | The budget is computed from the **trace**, not from a counter the loop owns. The trace is the record of what actually happened, so the budget cannot drift from reality. |
| `this.runLayer("actions", () => actionGuardrails(tool, args, executed), trace)` | Layer 3 through the fail-closed wrapper, and note the arguments: the **tool and the args**, never the text that produced them. This is the layer that can say no without reading a sentence. |
| `const blocked = actions.value.events.find((event) => event.outcome === "block")` | Looks for a `block` among the events. A `flag` (the `high-impact-write` case) is ignored here and handled downstream by `policy.ts` — detection here, enforcement there. |
| `return refuse(blocked.detail, blocked.rule, true)` | `true` = already recorded by `runLayer`. The reason and the rule name come straight from the event, so the trace's event and the call's reason are the same sentence — no chance of the two drifting apart. |
| **3** `validateArguments(tool, args)` | Chapter 08 §8.4. Note that validation receives the *raw* args and returns a *cleaned* copy, and the very next line stores it: `call.args = valid.args`. From this point on, everything — authorization, confirmation, the effect, the trace — sees the normalised values. |
| **4** `authorize(tool, valid.args, session)` | Chapter 08 §8.3, and note the arguments: the **validated** args and the session. Not the model's output, not the question, not the documents. |
| **5** `requiresConfirmation(tool, valid.args)` | Chapter 08 §8.6. Two conditions, both from outside the model: the tier and the auto-approve limit. |
| `call.status = "pending-confirmation"` | Not `"blocked"` and not `"executed"`. A third state, because the honest answer to "did this happen?" is *not yet* — and because `executedEffects()` must not count it. |
| `return { context: "", stop: … }` | The only branch that returns an empty context and a `stop`. `stop` ends the loop and becomes the answer, because you cannot continue a conversation that is waiting on a human. |
| **6** `const result = tool.run(valid.args, session)` | **The effect. The one and only call site in the project.** Everything above it is a check; everything below it is bookkeeping. If you are reviewing this file, this is the line to look at, and then to look *up* from. |
| `call.status = "executed"` after `run` | The status is set *after* the effect, not before. If `run()` threw, the call stays `blocked` and the trace says so — the trace describes what happened, not what was intended. |
| `call.reason` on success | Even a successful call carries a reason, naming the limit it was within. A trace that only explains failures is a trace that cannot answer "why was this allowed?". |
| `return { context: \`TOOL RESULT (${name}): ${result}\` }` | The result goes back into the context, which is what lets the model produce a final answer — and, in the `refund` flow, what supplies the amount for the *next* turn. The loop is a conversation, and this is the loop's half of it. |

---

## `src/services/agent.ts` — the full file (part 4 of 4)

```ts
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
```

**How it works, block by block — `finish()`**

| Block | What it does and why |
| :--- | :--- |
| Every exit calls `finish` | Four exits exist in `chat` (blocked input, failed layer, a `stop`, a normal answer) and one in `resume`, and **all five** go through here. There is no return path that skips Layer 4 — that is what makes the claim "nothing leaves the application without passing Layer 4" structural rather than aspirational. |
| `this.runLayer("output", …)` | Layer 4 through the same fail-closed wrapper. A throwing output filter produces "I cannot answer that safely right now", not the raw answer. |
| `if (!output.ok)` | The fail-closed branch. Note it is a *different* message from the input refusal: an input refusal says "I cannot help with that request", a failed output layer says "I cannot answer that **safely** right now". The distinction is deliberate — one is about the request, the other is about the system. |
| `trace.answer = output.value.answer` | The **post-redaction** answer is what gets recorded. This is the ordering the comment is about: a trace holding the pre-redaction answer could not tell you whether the canary was redacted, which is the single most important fact about the `jailbreak` scenario. |
| `trace.canaryLeaked = output.value.canaryLeaked` | The leak flag, on the trace, where it can be alerted on. `canaryLeaked: true` on a real deployment is a paging event: it means the system prompt reached a user. |
| `trace.refused = trace.refused \|\| refused` | Merges the two sources of "refused": the parameter (an early refusal) and whatever the output layer may have set. `\|\|` rather than assignment, because a refusal recorded earlier must not be erased by a later non-refusal. |
| `remember(trace)` | Chapter 09 §9.13. The trace is stored **after** every field is final, so `GET /audit` shows a complete record rather than a partially-built object. Recording earlier would have produced entries with empty answers. |
| `return { answer: trace.answer, trace }` | Both the answer and the trace go back, so `chatController` can return them together. Chapter 02 §2.8's argument: the answer is a claim and the trace is the evidence, and this project always ships both. |

---

## Checkpoint

Before Chapter 10, you should be able to answer:

1. In what position does the model run in `chat()`, and what has already happened
   by then?
2. Why does the confirmation path branch *before* the input guardrail?
3. What are the four exits from `chat()`, and what do they all have in common?
4. In `handle()`, which five checks run before `tool.run()`, and why do none of
   them read the attacker's sentence?
5. Why is the `ToolCall` pushed onto the trace with `status: "blocked"` before any
   check runs?
6. Why does the refusal context line name the *exact call* rather than just the
   tool?
7. What does `runLayer` do when a layer throws, and why is that the right choice?
8. Why is the answer recorded on the trace *after* the output layer?

---

**Back to:** [Guide index](./README.md) · [Basic Code README](../README.md)

**Next:** [Chapter 10 — The Eight Attacks as Data](./10_The_Eight_Attacks_As_Data.md)
