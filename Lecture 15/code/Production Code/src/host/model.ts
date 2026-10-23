import { env, hasModelKey } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { PromptMessage } from "../services/promptService.js";

/**
 * Notes Ch07 §7.3 — **the one place in the project where a model is involved.**
 *
 * This file is deliberately the *last* one in the build order, and deliberately
 * the only one that mentions a model at all. Everything upstream of it —
 * discovery, selection, authorisation, the budget, `prompts/get` — is ordinary,
 * deterministic, testable software. That is the lecture's central claim, and the
 * file layout is the evidence: if the model call can be deleted and the rest
 * still runs, the claim holds.
 *
 * ## Why the key is allowed to be empty
 *
 * `hasModelKey` is false when `OPENAI_API_KEY` is unset, and then this function
 * **echoes the assembled prompt instead of calling anything**. That is not a
 * stub: it is what makes the Resource and Prompt half of the protocol fully
 * visible on a machine with no credentials, and it is the same property the
 * production checklist asks for — *"the server starts and serves without an LLM
 * or an API key — that property is worth defending."*
 *
 * The offline path is also the *honest* one to read: it prints exactly what the
 * model would have received, which is the single most useful thing to see when a
 * grounded answer turns out to be wrong.
 */

export interface ModelReply {
  text: string;
  /** `model` when a model answered; `offline` when the prompt was echoed instead. */
  source: "model" | "offline";
  model: string;
}

export interface ModelInput {
  /** The assembled system message — the preamble plus the fenced resources. */
  system: string;
  /** The prompt's messages, in order. */
  messages: readonly PromptMessage[];
  logger: Logger;
  metrics: Metrics;
}

/** Renders the request as text, for the offline path and for the audit trail. */
export function renderPrompt(system: string, messages: readonly PromptMessage[]): string {
  const body = messages.map((message) => `${message.role.toUpperCase()}:\n${message.text}`).join("\n\n");

  return `SYSTEM:\n${system}\n\n${body}`;
}

export async function askModel(input: ModelInput): Promise<ModelReply> {
  const { system, messages, logger, metrics } = input;

  if (!hasModelKey) {
    const text = `(offline — no OPENAI_API_KEY, so no model was called)\n\n${renderPrompt(system, messages)}`;

    metrics.count("model.skipped");
    logger.info("model.skipped", { reason: "no API key", messages: messages.length, chars: system.length });

    return { text, source: "offline", model: "none" };
  }

  /**
   * Imported lazily so the module graph of the whole Resource + Prompt path
   * never touches the OpenAI SDK. A server that cannot import a model client
   * cannot accidentally call one.
   */
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI();

  const startedAt = performance.now();

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        ...messages.map((message) => ({ role: message.role, content: message.text })),
      ],
    });

    const text = response.choices[0]?.message.content ?? "";

    metrics.count("model.ok");
    metrics.observe("model.latency_ms", performance.now() - startedAt);
    logger.info("model.call", {
      model: env.OPENAI_MODEL,
      ms: Math.round(performance.now() - startedAt),
      chars: text.length,
      // Token counts when the provider reports them — the number that turns
      // "the context budget felt right" into a measurement.
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    });

    return { text, source: "model", model: env.OPENAI_MODEL };
  } catch (error) {
    /**
     * The model call is the one step that is *expected* to fail transiently, so
     * it is also the one step that degrades rather than throws: a rate limit or a
     * timeout should leave the caller holding the assembled prompt, which is
     * still useful, instead of a stack trace.
     */
    const message = error instanceof Error ? error.message : String(error);

    metrics.count("model.error");
    logger.warn("model.failure", { model: env.OPENAI_MODEL, message });

    return {
      text: `(the model call failed: ${message})\n\nThe prompt that was sent:\n\n${renderPrompt(system, messages)}`,
      source: "offline",
      model: env.OPENAI_MODEL,
    };
  }
}
