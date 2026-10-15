import { env } from '../config/env.js';
import { jitter, sleep } from '../lib/timing.js';
import { ProviderStreamError } from './provider.errors.js';
import type {
  DeltaGranularity,
  ProviderDelta,
  ProviderStream,
  ProviderStreamRequest,
  SimulationOptions,
  StreamProvider,
  TokenUsage,
} from '../types/stream.types.js';

/**
 * Deterministic offline provider.
 *
 * Why does a production codebase ship a simulator? Because every streaming
 * property worth testing is TEMPORAL (§10.5): fragmentation, TTFT, stalls,
 * aborts and mid-stream failures. A simulator makes those conditions
 * reproducible, free, and available in CI — and it keeps the whole microservice
 * runnable with no API key.
 */

/** A deliberately awkward answer: emoji (4-byte UTF-8), CJK, markdown, long words. */
const CANONICAL_ANSWER = [
  'Streaming is not one feature — it is a **pipeline** that must stay unbroken from the model to the DOM.',
  '',
  'The chain is: `LLM tokens ➔ provider deltas ➔ backend chunks ➔ HTTP body ➔ browser buffer ➔ one growing bubble`.',
  '',
  'Two numbers describe the experience: **TTFT** (time to first token) and **ITL** (inter-token latency, a.k.a. TPOT).',
  'Below roughly 15–20 tokens per second the reader out-runs the model, and perceived speed collapses. ⚡',
  '',
  'Multi-byte text is where naive clients break: 日本語, émojis 🚀🌍, and symbols ∑ ∆ ≈ λ are each several bytes,',
  'so a network chunk can split a single character in half. One `TextDecoder` with `{ stream: true }` is the whole fix.',
  '',
  'Remember the contract: *whenever more text becomes available, append it to the current assistant message.*',
].join('\n');

export interface SimulatorProviderOptions extends SimulationOptions {
  /** Override the deterministic answer (fragmentation tests rely on this). */
  answer?: string;
}

export class SimulatorProvider implements StreamProvider {
  public readonly name = 'simulator';

  constructor(private readonly defaults: SimulatorProviderOptions = {}) {}

  public async stream(request: ProviderStreamRequest): Promise<ProviderStream> {
    const simulation: SimulatorProviderOptions = { ...this.defaults, ...request.simulation };
    const answer = simulation.answerOverride ?? simulation.answer ?? CANONICAL_ANSWER;
    const granularity = simulation.granularity ?? env.STREAM_GRANULARITY;

    return this.generate(answer, granularity, simulation, request.abortSignal, estimateTokens(request.messages));
  }

  /**
   * The generator IS the `Flux<String>` equivalent: zero, one or many values
   * over time (Chapter 07.3). Nothing here buffers, so nothing here can undo
   * streaming.
   */
  private async *generate(
    answer: string,
    granularity: DeltaGranularity,
    simulation: SimulatorProviderOptions,
    abortSignal: AbortSignal,
    promptTokens: number
  ): AsyncGenerator<ProviderDelta> {
    // 1. Simulated queue + prefill delay — the phase BEFORE the first token.
    const ttft = simulation.exceedTtftBudget
      ? env.STREAM_TTFT_BUDGET_MS + 5_000
      : simulation.ttftMs ?? jitter(320);
    await sleep(ttft, abortSignal);

    if (simulation.failAfterDeltas === 0) {
      throw new ProviderStreamError(
        (simulation.failCode as ProviderStreamError['code']) ?? 'provider_error',
        'Simulated provider failure before the first token.',
        true
      );
    }

    // 2. Turn the answer into pseudo-tokens and group them per granularity.
    const pseudoTokens = tokenise(answer);
    const deltas = coalesce(pseudoTokens, granularity);

    const itl = simulation.itlMs ?? jitter(26);
    let completionChars = 0;
    let emitted = 0;

    try {
      for (let index = 0; index < deltas.length; index += 1) {
        // 3. Chaos hooks: silence (idle watchdog) and mid-stream failure.
        if (simulation.stallAfterDeltas && index === simulation.stallAfterDeltas) {
          await sleep(simulation.stallMs ?? env.STREAM_IDLE_TIMEOUT_MS + 2_000, abortSignal);
        }
        if (simulation.failAfterDeltas && index === simulation.failAfterDeltas) {
          throw new ProviderStreamError(
            (simulation.failCode as ProviderStreamError['code']) ?? 'provider_error',
            `Simulated mid-stream failure after ${index} deltas.`,
            false
          );
        }

        const text = deltas[index] as string;
        completionChars += text.length;
        emitted += 1;

        const isLast = index === deltas.length - 1;
        yield {
          text,
          index,
          ...(isLast ? { usage: buildUsage(promptTokens, completionChars), finishReason: 'stop' } : {}),
        };

        if (!isLast) await sleep(itl, abortSignal);
      }
    } catch (error) {
      // A client abort is not a provider fault: it must never be reported as one.
      if (abortSignal.aborted) return;
      throw error;
    }

    // Guarantee a terminal delta carrying usage even for an empty completion.
    if (emitted === 0) {
      yield { text: '', index: 0, usage: buildUsage(promptTokens, 0), finishReason: 'stop' };
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Cheap deterministic tokeniser producing pseudo-tokens that keep their leading
 * whitespace, mirroring how BPE tokens carry spaces with them (" Boot").
 */
function tokenise(text: string): string[] {
  return text.match(/(\s+|[^\s]+)/g) ?? [];
}

/**
 * Group pseudo-tokens into provider deltas according to the requested
 * granularity. This is the first of the granularity transitions described in
 * §4.1: several LLM tokens may arrive inside ONE provider delta.
 */
function coalesce(pseudoTokens: string[], granularity: DeltaGranularity): string[] {
  switch (granularity) {
    case 'token':
      return pseudoTokens;

    case 'word': {
      const groups: string[] = [];
      for (let i = 0; i < pseudoTokens.length; i += 3) {
        groups.push(pseudoTokens.slice(i, i + 3).join(''));
      }
      return groups;
    }

    case 'random': {
      // Hostile fragmentation: 1–3 characters per delta, splitting emoji and
      // multi-byte characters across deltas on purpose.
      const characters = [...pseudoTokens.join('')];
      const groups: string[] = [];
      let cursor = 0;
      while (cursor < characters.length) {
        const size = 1 + Math.floor(Math.random() * 3);
        groups.push(characters.slice(cursor, cursor + size).join(''));
        cursor += size;
      }
      return groups;
    }

    case 'sentence':
    default: {
      const groups: string[] = [];
      let buffer = '';
      for (const token of pseudoTokens) {
        buffer += token;
        // Flush on sentence terminators or newlines: natural bubble boundaries.
        if (/[.!?…]\s*$/.test(buffer) || buffer.endsWith('\n')) {
          groups.push(buffer);
          buffer = '';
        }
      }
      if (buffer.length > 0) groups.push(buffer);
      return groups;
    }
  }
}

function buildUsage(promptTokens: number, completionChars: number): TokenUsage {
  // ≈4 characters per token, the standard approximation used ONLY for local
  // budgeting — never presented to clients as authoritative (§8.6).
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4));
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function estimateTokens(messages: { content: string }[]): number {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.max(1, Math.ceil(characters / 4));
}
