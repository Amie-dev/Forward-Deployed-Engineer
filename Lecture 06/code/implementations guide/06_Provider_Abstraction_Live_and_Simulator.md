# Chapter 06: The Provider Layer: Live OpenAI, Deterministic Simulator & Error Taxonomy

> **Chapter Goal:** Return a STREAM type instead of a String, classify failures so retries stay safe, and make every temporal failure mode (stall, mid-stream error, TTFT breach) reproducible offline.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/providers/provider.errors.ts` | 64 lines |
| `src/providers/openai.provider.ts` | 123 lines |
| `src/providers/simulator.provider.ts` | 204 lines |
| `src/providers/index.ts` | 37 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/providers/provider.errors.ts` (63 lines)

```typescript
import type { StreamErrorCode } from '../types/stream.types.js';

/**
 * A failure raised by a provider *during* generation.
 *
 * The distinction that matters for streaming (§7.7):
 *
 *  - `retryable === true` and NO bytes written yet  ⇒ retry with jitter, or
 *    answer with a real HTTP error status.
 *  - anything raised after the first byte            ⇒ the HTTP status is frozen
 *    at `200 OK`, so the failure must be signalled in-band and the partial text
 *    preserved (Anti-pattern #10: "the mid-stream retry" duplicates text).
 */
export class ProviderStreamError extends Error {
  constructor(
    public readonly code: StreamErrorCode,
    message: string,
    /** Safe to retry only *before* the first token reaches the client. */
    public readonly retryable: boolean = false,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderStreamError';
  }
}

/** Raised when the provider never produced a first delta inside the TTFT budget. */
export class ProviderTimeoutError extends ProviderStreamError {
  constructor(message: string) {
    super('provider_timeout', message, true);
    this.name = 'ProviderTimeoutError';
  }
}

/** Raised when the provider went silent after the first delta. */
export class UpstreamStallError extends ProviderStreamError {
  constructor(message: string) {
    super('upstream_stall', message, false);
    this.name = 'UpstreamStallError';
  }
}

/**
 * Classify an unknown thrown value into our in-band error taxonomy so that the
 * client always receives a machine-readable `code`.
 *
 * NOTE: `429`, `5xx` and connection resets are retryable *before* the first
 * token; after it they are terminal for this request.
 */
export function classifyProviderError(error: unknown): ProviderStreamError {
  if (error instanceof ProviderStreamError) return error;

  const status = (error as { status?: number } | undefined)?.status;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return new ProviderStreamError('provider_error', `Provider rate limit: ${message}`, true, error);
  }
  if (typeof status === 'number' && status >= 500) {
    return new ProviderStreamError('provider_error', `Provider ${status}: ${message}`, true, error);
  }
  return new ProviderStreamError('provider_error', message, false, error);
}
```


### 📄 `src/providers/openai.provider.ts` (122 lines)

```typescript
import OpenAI from 'openai';
import { env } from '../config/env.js';
import { classifyProviderError } from './provider.errors.js';
import type {
  FinishReason,
  ProviderDelta,
  ProviderStream,
  ProviderStreamRequest,
  StreamProvider,
  TokenUsage,
} from '../types/stream.types.js';

/**
 * Live provider implementation (OpenAI Chat Completions with `stream: true`).
 *
 * This is the concrete equivalent of `.call() ➔ .stream()` in Chapter 07.2: the
 * return type is an AsyncIterable — "zero, one or many values over time" — not a
 * `Promise<string>`. Because the type is a stream, nothing above this layer is
 * able to accidentally buffer the answer.
 *
 * Two production decisions worth calling out:
 *
 *  1. `maxRetries: 0` on the SDK. The SDK's own retry would restart a stream
 *     that has already emitted text, duplicating fragments in the user's bubble
 *     (Anti-pattern #10). Retries are therefore owned by the streaming service,
 *     which knows whether the first byte has been written yet.
 *  2. `stream_options.include_usage: true`, because usage is otherwise missing
 *     in streaming mode — the "billing blind spot" of §7.9.
 */
export class OpenAIProvider implements StreamProvider {
  public readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(apiKey: string = env.OPENAI_API_KEY) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: env.STREAM_TOTAL_TIMEOUT_MS,
    });
  }

  public async stream(request: ProviderStreamRequest): Promise<ProviderStream> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages as OpenAI.Chat.ChatCompletionMessageParam[],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: request.abortSignal }
      );

      return this.iterate(stream, request.abortSignal);
    } catch (error) {
      // Failure BEFORE the first byte ⇒ the service may still answer with a real
      // HTTP status, or retry with jitter if `retryable` is true.
      throw classifyProviderError(error);
    }
  }

  /**
   * Translate OpenAI SSE chunks into the provider contract.
   *
   * `await this.client...create()` resolves as soon as the response headers
   * arrive, so iterating here is what actually consumes the token deltas.
   */
  private async *iterate(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    abortSignal: AbortSignal
  ): AsyncGenerator<ProviderDelta> {
    let index = 0;
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;

    try {
      for await (const chunk of stream) {
        // The usage carrier chunk has an EMPTY `choices` array — reading
        // `chunk.choices[0]` unconditionally is a common runtime crash.
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        const text = choice?.delta?.content ?? '';
        if (text.length === 0) continue;

        yield { text, index };
        index += 1;
      }
    } catch (error) {
      if (abortSignal.aborted) return; // expected on client cancellation
      throw classifyProviderError(error);
    }

    // Terminal, text-less carrier: the pump records usage/finish reason without
    // writing anything to the socket.
    yield { text: '', index, usage, finishReason };
  }
}

/** Map provider finish reasons onto the service's terminal-state taxonomy. */
export function mapProviderFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}
```


### 📄 `src/providers/simulator.provider.ts` (203 lines)

```typescript
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
```


### 📄 `src/providers/index.ts` (36 lines)

```typescript
import { env, isLiveProviderConfigured } from '../config/env.js';
import { OpenAIProvider } from './openai.provider.js';
import { SimulatorProvider } from './simulator.provider.js';
import type { StreamProvider } from '../types/stream.types.js';

/**
 * Provider selection with a failover slot.
 *
 * Hardening checklist item #15 ("provider failover"): a single provider outage
 * must not take chat down. The wiring is therefore resolved in ONE place, so a
 * secondary provider can be dropped in behind a flag without touching any
 * streaming code.
 */

let cached: StreamProvider | null = null;

export function resolveProvider(): StreamProvider {
  if (cached) return cached;

  cached = isLiveProviderConfigured() ? new OpenAIProvider() : new SimulatorProvider();
  return cached;
}

/** Override the resolved provider (tests inject deterministic simulators). */
export function setProvider(provider: StreamProvider): void {
  cached = provider;
}

export function resetProvider(): void {
  cached = null;
}

export function describeProvider(): { name: string; live: boolean; model: string } {
  const provider = resolveProvider();
  return { name: provider.name, live: provider.name !== 'simulator', model: env.AI_MODEL };
}
```


---

## 3. Block-by-Block Explanation

### Part A: `provider.errors.ts` — the retry-safety taxonomy

#### Block 1: The error that knows whether retrying is safe

```typescript
export class ProviderStreamError extends Error {
  constructor(
    public readonly code: StreamErrorCode,
    message: string,
    /** Safe to retry only *before* the first token reaches the client. */
    public readonly retryable: boolean = false,
    public readonly cause?: unknown
  ) { super(message); this.name = 'ProviderStreamError'; }
}
```

- **What it does:** carries the three facts the streaming layer needs: a machine-readable code, a human message, and **whether a retry is safe**.
- **How it works:** the `retryable` flag *is* the retry policy. `retryable === true` combined with "no bytes written yet" means the caller may retry with jitter or answer with a real HTTP status; anything raised after the first byte is terminal for this request, because a retry would duplicate text into the user's bubble (anti-pattern #10).

#### Block 2: Named subclasses for the two timeouts

```typescript
export class ProviderTimeoutError extends ProviderStreamError {
  constructor(message: string) { super('provider_timeout', message, true); }
}
export class UpstreamStallError extends ProviderStreamError {
  constructor(message: string) { super('upstream_stall', message, false); }
}
```

- **What it does:** distinguishes "the provider never started" (retryable) from "the provider went silent mid-answer" (not retryable).
- **How it works:** the two failures need different client behaviour — a `provider_timeout` can be retried automatically, while an `upstream_stall` after partial text must be surfaced in-band with the partial answer preserved.

#### Block 3: Classification at the boundary

```typescript
export function classifyProviderError(error: unknown): ProviderStreamError {
  if (error instanceof ProviderStreamError) return error;
  const status = (error as { status?: number } | undefined)?.status;
  if (status === 429) return new ProviderStreamError('provider_error', `Provider rate limit: ${message}`, true, error);
  if (typeof status === 'number' && status >= 500) return new ProviderStreamError('provider_error', `Provider ${status}: ${message}`, true, error);
  return new ProviderStreamError('provider_error', message, false, error);
}
```

- **What it does:** turns *any* thrown value — SDK error, socket error, even a string — into the service's own taxonomy, exactly once.
- **How it works:** HTTP 429 and 5xx are classified retryable (transient capacity problems); everything else is terminal. Because classification happens at the provider boundary, no other module ever inspects SDK-specific error shapes.

---

### Part B: `openai.provider.ts` — the live provider

#### Block 4: Client configuration (two deliberate choices)

```typescript
this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: env.STREAM_TOTAL_TIMEOUT_MS });
```

- **What it does:** creates one reusable SDK client with retries **disabled** and a hard timeout.
- **How it works:** `maxRetries: 0` is critical. The SDK's built-in retry would restart a stream that has already emitted text, duplicating fragments in the user's bubble. Retries are therefore owned by `ChatService`, which knows whether the first byte has been written. Creating the client once also gives connection pooling and TLS reuse.

#### Block 5: The streaming call

```typescript
const stream = await this.client.chat.completions.create(
  { model, messages, temperature, max_tokens, stream: true, stream_options: { include_usage: true } },
  { signal: request.abortSignal }
);
return this.iterate(stream, request.abortSignal);
```

- **What it does:** is the `.call()` → `.stream()` change from §7.2, plus the flag that fixes the "billing blind spot".
- **How it works:** `await …create()` resolves when the **response headers** arrive, not when generation finishes — the same semantics as browser `fetch()`. `include_usage: true` is what makes a final usage chunk exist at all in streaming mode. The `AbortSignal` passed as a request option is how a client disconnect cancels the provider call.

#### Block 6: Translating provider chunks

```typescript
for await (const chunk of stream) {
  if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens ?? 0, /* … */ };
  const choice = chunk.choices?.[0];
  if (choice?.finish_reason) finishReason = choice.finish_reason;
  const text = choice?.delta?.content ?? '';
  if (text.length === 0) continue;
  yield { text, index };
  index += 1;
}
yield { text: '', index, usage, finishReason };   // the usage carrier
```

- **What it does:** maps OpenAI's chunk shape onto `ProviderDelta` and terminates with a text-less carrier frame.
- **How it works:** the usage chunk has an **empty `choices` array**, so reading `chunk.choices[0].delta.content` unconditionally would throw — the guard is why this loop cannot crash on the final chunk. The terminal carrier frame lets the pump record usage and finish reason without writing anything to the socket, and it mirrors how the real API behaves.

---

### Part C: `simulator.provider.ts` — reproducible temporality

#### Block 7: The canonical answer is deliberately awkward

```typescript
const CANONICAL_ANSWER = [
  '… **TTFT** (time to first token) and **ITL** (inter-token latency, a.k.a. TPOT).',
  'Multi-byte text is where naive clients break: 日本語, émojis 🚀🌍, and symbols ∑ ∆ ≈ λ …',
].join('\n');
```

- **What it does:** guarantees every test exercises the hard cases.
- **How it works:** the answer contains 4-byte emoji, 3-byte CJK, combining marks, markdown fences and long words — so a decoding bug or a partial-fence rendering bug surfaces immediately instead of in production.

#### Block 8: The generator IS the stream contract

```typescript
private async *generate(answer, granularity, simulation, abortSignal, promptTokens): AsyncGenerator<ProviderDelta> {
  const ttft = simulation.exceedTtftBudget ? env.STREAM_TTFT_BUDGET_MS + 5_000 : simulation.ttftMs ?? jitter(320);
  await sleep(ttft, abortSignal);                        // 1. prefill phase
  const deltas = coalesce(tokenise(answer), granularity);
  for (let index = 0; index < deltas.length; index += 1) {
    if (simulation.stallAfterDeltas && index === simulation.stallAfterDeltas) await sleep(stallMs, abortSignal);
    if (simulation.failAfterDeltas && index === simulation.failAfterDeltas) throw new ProviderStreamError(…);
    yield { text, index, ...(isLast ? { usage, finishReason: 'stop' } : {}) };
    if (!isLast) await sleep(itl, abortSignal);
  }
}
```

- **What it does:** produces the same temporal behaviour as a real provider — a delay before the first token, a cadence between tokens, and optional chaos.
- **How it works:** because it is an `async function*`, values arrive over time exactly as a network stream would; nothing buffers. The chaos hooks sit *inside* the loop so a stall or failure happens mid-stream, which is the only interesting case. Note the abort-aware `sleep`: cancelling a simulated generation is as immediate as cancelling a real one.

#### Block 9: Granularity coalescing (the first transition)

```typescript
function coalesce(pseudoTokens: string[], granularity: DeltaGranularity): string[] {
  switch (granularity) {
    case 'token': return pseudoTokens;
    case 'word': /* groups of 3 tokens */;
    case 'random': /* 1–3 characters per delta, splitting emoji on purpose */;
    case 'sentence': default: /* flush on [.!?…] or newline */;
  }
}
```

- **What it does:** models "several LLM tokens may arrive inside ONE provider delta".
- **How it works:** `tokenise` keeps leading whitespace with each word, mirroring how BPE tokens carry spaces (`" Boot"`). `random` is the hostile case that proves the client contract; `sentence` produces the natural bubble cadence the UI shows by default.

---

### Part D: `providers/index.ts` — one place to choose a provider

```typescript
export function resolveProvider(): StreamProvider {
  if (cached) return cached;
  cached = isLiveProviderConfigured() ? new OpenAIProvider() : new SimulatorProvider();
  return cached;
}
export function setProvider(provider: StreamProvider): void { cached = provider; }
```

- **What it does:** resolves the provider once and provides the seam for tests and future failover.
- **How it works:** `isLiveProviderConfigured()` is the only switch; `setProvider` lets a test inject a simulator with a fixed answer. Hardening item #15 ("provider failover") plugs in here without touching a single line of streaming code.

---

### ✅ Chapter 06 verification

```bash
npm run test:invariants                     # exercises stall, mid-stream failure, TTFT breach
npm run stream:cli -- --granularity=token   # one delta per pseudo-token
```



---

**Previous:**  · **Next:** 
