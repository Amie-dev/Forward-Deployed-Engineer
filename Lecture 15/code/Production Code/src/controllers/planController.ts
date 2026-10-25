import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import { PromptError } from "../core/errors.js";
import { textOf } from "../host/client.js";
import { assembleContext, type AssembledContext } from "../host/context.js";
import type { HostDeps } from "../host/deps.js";
import { askModel, type ModelReply } from "../host/model.js";
import { query } from "../middleware/requestContext.js";
import type { PromptMessage } from "../services/promptService.js";

/**
 * Notes Ch08 §8.2 — **the request the whole lecture builds towards:**
 *
 * ```text
 * GET /plan?hours=4
 * ```
 *
 * One request, three primitives, three owners. The lecture walks it in three
 * steps and this file performs them in the same order, which is why the response
 * carries an explicit `steps` array: the flow is the lesson, so the flow is what
 * the endpoint reports.
 *
 *   1. **User controls the Prompt.**            `prompts/get plan_day { availableHours }`
 *   2. **Application controls the Resource.**   select → authorise → read → budget
 *   3. **Model controls the Tool.**             the prompt *asks*; the model decides
 *
 * The third step is the one this file cannot perform for the model, and that is
 * the point of the design rather than a gap in it: `plan_day` names `list_tasks`
 * because the model has to choose to call it. Notes Ch07 §7.2 — *"the prompt is a
 * nudge, not a command."*
 */

/** One step of the flow, reported so the response explains itself. */
interface Step {
  step: number;
  controlledBy: "user" | "application" | "model";
  primitive: "prompt" | "resource" | "tool";
  detail: string;
}

interface PipelineResult {
  steps: Step[];
  context: AssembledContext;
  reply: ModelReply;
  promptName?: string;
  promptMessages: PromptMessage[];
  promptDurationMs: number;
}

/**
 * The shared pipeline behind `/plan` and `/ask`.
 *
 * Both routes run the same three steps; they differ only in whether step 1 is a
 * *prompt the user selected* or *a message the user typed*. Writing it once is
 * what makes that difference visible instead of buried in two near-identical
 * handlers.
 */
async function runPipeline(
  deps: HostDeps,
  input: {
    message: string;
    session: { actor: string; projects: readonly string[]; isAdmin: boolean };
    prompt?: { name: string; args: Record<string, string> };
  },
): Promise<PipelineResult> {
  const steps: Step[] = [];
  let promptMessages: PromptMessage[] = [];
  let promptDurationMs = 0;

  /* ── Step 1 — the USER controls the prompt (Notes Ch08 §8.2) ───────────── */

  if (input.prompt !== undefined) {
    const { name, args } = input.prompt;
    const decision = deps.policy.mayUsePrompt(name, input.session);

    if (!decision.allowed) {
      throw new PromptError(
        "FORBIDDEN",
        `Refused to render ${name} — ${decision.reason}.`,
        "Use a workflow this deployment offers, or ask an administrator to enable it.",
      );
    }

    const startedAt = performance.now();
    const rendered = await deps.client.getPrompt(name, args);
    promptDurationMs = performance.now() - startedAt;

    promptMessages = rendered.messages.map((message) => ({
      role: message.role as PromptMessage["role"],
      text: textOf({ content: [message.content] }),
    }));

    deps.audit.record({
      actor: input.session.actor,
      action: "prompt",
      target: name,
      decision: "allowed",
      outcome: "ok",
      args,
      durationMs: promptDurationMs,
      note: `${promptMessages.length} message(s)`,
    });

    steps.push({
      step: 1,
      controlledBy: "user",
      primitive: "prompt",
      detail:
        `prompts/get ${name} ${JSON.stringify(args)} → ${promptMessages.length} message(s) in ` +
        `${Math.round(promptDurationMs)} ms. The prompt supplies instructions, never facts.`,
    });
  } else {
    steps.push({
      step: 1,
      controlledBy: "user",
      primitive: "prompt",
      detail: "No prompt selected — the user typed the message directly. The rest of the pipeline is unchanged.",
    });
  }

  /* ── Step 2 — the APPLICATION controls the resources (Notes Ch05) ──────── */

  const context = await assembleContext(
    {
      message: input.message,
      session: input.session,
      promptMessages,
    },
    {
      client: deps.client,
      policy: deps.policy,
      selection: deps.selection,
      budget: deps.budget,
      logger: deps.logger,
      metrics: deps.metrics,
      maxResourcesPerRequest: deps.limits.maxResourcesPerRequest,
    },
  );

  const strategies = context.selection.strategies.join(", ") || "none";
  const chosen = context.selection.chosen
    .map((selection) => `${selection.uri} ← ${selection.strategy}`)
    .join("; ");

  steps.push({
    step: 2,
    controlledBy: "application",
    primitive: "resource",
    detail:
      context.selection.chosen.length === 0
        ? `No Resource selected (strategies consulted: ${strategies}; ${context.selection.candidates} candidates).`
        : `Selected ${context.selection.chosen.length} of ${context.selection.candidates} candidates via ` +
          `[${strategies}]: ${chosen}. Read ${context.included.length}, budgeted to ${context.chars} chars` +
          `${context.truncated.length > 0 ? `, truncated ${context.truncated.length}` : ""}` +
          `${context.dropped.length > 0 ? `, dropped ${context.dropped.length}` : ""}.`,
  });

  /* ── Step 3 — the MODEL controls any tool call (Notes Ch07 §7.1) ───────── */

  const reply = await askModel({
    system: context.system,
    messages: context.messages,
    logger: deps.logger,
    metrics: deps.metrics,
  });

  steps.push({
    step: 3,
    controlledBy: "model",
    primitive: "tool",
    detail:
      reply.source === "model"
        ? `${reply.model} answered. Any tool call it made — list_tasks, most likely — was its own decision, ` +
          `taken because the prompt named the capability and the model judged it necessary.`
        : "No model configured, so the assembled request is echoed instead. The prompt still names list_tasks " +
          "and the tool is still registered — the model's decision is the only step missing.",
  });

  return {
    steps,
    context,
    reply,
    ...(input.prompt === undefined ? {} : { promptName: input.prompt.name }),
    promptMessages,
    promptDurationMs,
  };
}

/**
 * The two flows.
 *
 * `/plan` is the lecture's request: a **prompt** starts it, so the user chose the
 * workflow. `/ask` is the same pipeline with no prompt, so the user typed a
 * question directly — and the contrast is the demonstration: the Resource
 * selection and the model step are *identical* in both, which is what it means
 * for the primitives to compose rather than to be alternatives.
 */
export function planController(deps: HostDeps) {
  return {
    /** `GET /plan?hours=4` — Notes Ch08 §8.2, end to end. */
    plan: async (request: Request, response: Response): Promise<void> => {
      const hours = query(request, "hours")?.trim() || "4";
      const session = request.session;
      const startedAt = performance.now();

      const result = await runPipeline(deps, {
        // The message is *derived from the prompt's arguments*, because in this
        // flow the prompt is the message. `/ask` is where the user supplies one.
        message: `Plan my day with ${hours} hours available.`,
        session,
        prompt: { name: "plan_day", args: { availableHours: hours } },
      });

      const durationMs = performance.now() - startedAt;

      deps.metrics.count("plan.ok");
      deps.metrics.observe("plan.latency_ms", durationMs);

      response.json({
        request: { hours, actor: session.actor, projects: session.projects, admin: session.isAdmin },
        steps: result.steps,
        context: {
          system: result.context.system,
          included: result.context.included,
          dropped: result.context.dropped,
          refused: result.context.refused,
          failed: result.context.failed,
          truncated: result.context.truncated,
          chars: result.context.chars,
          selections: result.context.selection.chosen,
        },
        prompt: { name: result.promptName, messages: result.promptMessages },
        answer: { source: result.reply.source, model: result.reply.model, text: result.reply.text },
        ms: Math.round(durationMs),
      });
    },

    /** `GET /ask?message=...` — the same pipeline, with the user's own words. */
    ask: async (request: Request, response: Response): Promise<void> => {
      const message = query(request, "message")?.trim();

      if (message === undefined || message === "") {
        throw new PromptError(
          "INVALID_INPUT",
          "Query parameter 'message' is required.",
          "Try GET /ask?message=what+is+on+my+plate.",
        );
      }

      const session = request.session;
      const startedAt = performance.now();

      const result = await runPipeline(deps, { message, session });
      const durationMs = performance.now() - startedAt;

      deps.metrics.count("ask.ok");
      deps.metrics.observe("ask.latency_ms", durationMs);

      response.json({
        request: { message, actor: session.actor, projects: session.projects },
        steps: result.steps,
        context: {
          system: result.context.system,
          included: result.context.included,
          dropped: result.context.dropped,
          refused: result.context.refused,
          failed: result.context.failed,
          chars: result.context.chars,
          selections: result.context.selection.chosen,
        },
        answer: { source: result.reply.source, model: result.reply.model, text: result.reply.text },
        ms: Math.round(durationMs),
      });
    },
  };
}
