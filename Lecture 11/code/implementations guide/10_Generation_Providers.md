# Chapter 10: Generation Providers

> **Chapter Goal:** Turn a grounded prompt into text through one interface — with a real model for production and an offline generator that quotes the evidence, so citations and refusals can be tested without a key.

> **Lecture mapping:** Notes Chapter 06, sections on generation, refusal and the citation contract; Chapter 09 on provider failure and fallbacks.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/generation/provider.ts` | 50 | Request/response types and the factory. |
| `src/generation/openai.provider.ts` | 55 | Responses API adapter, retried. |
| `src/generation/extractive.provider.ts` | 92 | Offline quoter that exercises the same contract. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run ask -- "How much does express delivery cost?"
# A: - Standard delivery: 3 to 5 business days, 4.99 USD, free for orders over 75 USD.
#    - Express delivery: 1 to 2 business days, 12.99 USD. [1] …

LLM_PROVIDER=openai npm run ask -- "anything"     # without a key:
# Error: OPENAI_API_KEY is required when LLM_PROVIDER=openai.
```

---

## 2. The Interface — `src/generation/provider.ts`

#### 📄 `src/generation/provider.ts`

```ts
import type { ChatMessage } from '../types/rag.types.js';
import { ExtractiveProvider } from './extractive.provider.js';
import { OpenAiGenerationProvider } from './openai.provider.js';

export interface GenerationRequest {
  /** System-level rules. Never contains retrieved text. */
  instructions: string;
  /** Conversation turns, ending with the evidence + question. */
  messages: readonly ChatMessage[];
}

export interface GeneratedText {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerationProvider {
  readonly name: string;
  readonly model: string;
  generate(request: GenerationRequest): Promise<GeneratedText>;
}

export interface GenerationProviderConfig {
  provider: 'openai' | 'extractive';
  model: string;
  apiKey?: string;
}

export function createGenerationProvider(config: GenerationProviderConfig): GenerationProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAiGenerationProvider(config);
    case 'extractive':
      return new ExtractiveProvider();
  }
}
```

**Block by block:**

- **`GenerationRequest`** — `instructions` (rules) and `messages` (evidence + conversation). Two fields, and the split is the security boundary from chapter 09.
- **`GeneratedText`** — `text` plus optional `inputTokens` / `outputTokens`. Optional because a stub has no usage; the trace tolerates `undefined` rather than faking zeros.
- **`GenerationProvider`** — `name`, `model`, `generate`. `model` is surfaced in `/health` and the trace, because "which model said this?" is the first question in any incident review.
- **`createGenerationProvider`** — exhaustive switch. `extractive` takes no config on purpose: it must not silently accept an API key it cannot use.

---

## 3. The Real Provider — `src/generation/openai.provider.ts`

#### 📄 `src/generation/openai.provider.ts`

```ts
import OpenAI from 'openai';

import { withRetry } from '../lib/retry.js';
import type { GeneratedText, GenerationProvider, GenerationRequest } from './provider.js';

/**
 * OpenAI chat generation via the Responses API.
 *
 * No temperature is sent: reasoning models reject it, and the default is already
 * conservative. Sampling knobs belong in config once the evaluation harness can
 * prove a change helps.
 */
export class OpenAiGenerationProvider implements GenerationProvider {
  readonly name = 'openai';
  readonly model: string;

  private readonly client: OpenAI;

  constructor(config: { apiKey?: string; model: string }) {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is required for the openai generation provider.');
    }

    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async generate(request: GenerationRequest): Promise<GeneratedText> {
    const response = await withRetry(
      () =>
        this.client.responses.create({
          model: this.model,
          instructions: request.instructions,
          input: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          max_output_tokens: 600,
        }),
      {
        attempts: 3,
        onRetry: (error, attempt) =>
          console.warn(
            `[generation] attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      },
    );

    return {
      text: response.output_text.trim(),
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  }
}
```

**Block by block:**

- **`responses.create`** — the current API surface. `instructions` is the system-level channel; `input` is the conversation.
- **`input: request.messages.map(...)`** — the interface's `ChatMessage[]` maps one-to-one onto `{ role, content }` items. That is why the provider interface uses a message array instead of a single string: it keeps history support free.
- **`max_output_tokens: 600`** — a hard ceiling. Without it, one verbose answer can cost more than the entire retrieval stage.
- **No `temperature`** — reasoning-class models reject it, and the default is already conservative. Sampling knobs belong in config only once the evaluation harness can prove a change helps.
- **`withRetry`** — same policy as embeddings: 429 and 5xx only.
- **`response.usage?.input_tokens`** — captured for cost accounting. The trace is where a per-question budget becomes visible.
- **`.trim()`** — providers occasionally return leading newlines; trimming keeps citation regexes and refusal matching predictable.

---

## 4. The Offline Provider — `src/generation/extractive.provider.ts`

#### 📄 `src/generation/extractive.provider.ts`

```ts
import { parseContextBlocks } from '../grounding/context.js';
import { clip, contentWords, words } from '../lib/text.js';
import { REFUSAL_MESSAGE } from './prompt.js';
import type { GeneratedText, GenerationProvider, GenerationRequest } from './provider.js';

const MAX_SENTENCES = 3;
const MAX_SENTENCE_CHARS = 320;

/**
 * An offline stand-in for the model: it quotes the best-matching sentences out
 * of the evidence block and attaches their `[n]` labels.
 *
 * It cannot paraphrase, so it is not a real generator — but it exercises every
 * other part of the pipeline honestly: the prompt format, the label map, the
 * citation linker and the refusal path all behave exactly as they do with a
 * real model. Use it for demos, tests and CI. Use OpenAI for answers.
 */
export class ExtractiveProvider implements GenerationProvider {
  readonly name = 'extractive';
  readonly model = 'extractive-v1';

  async generate(request: GenerationRequest): Promise<GeneratedText> {
    const prompt = request.messages.at(-1)?.content ?? '';
    const question = extractTag(prompt, 'question');
    const blocks = parseContextBlocks(extractTag(prompt, 'documents'));

    const questionTerms = new Set(contentWords(question));
    const candidates = blocks
      .flatMap((block) =>
        answerUnits(block.text).map((unit) => ({
          sentence: unit,
          label: block.label,
          score: overlap(questionTerms, unit),
        })),
      )
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    if (candidates.length === 0) return { text: REFUSAL_MESSAGE };

    // One sentence per source keeps the answer readable and the citations honest.
    const chosen: typeof candidates = [];
    const usedLabels = new Set<number>();

    for (const candidate of candidates) {
      if (usedLabels.has(candidate.label)) continue;
      usedLabels.add(candidate.label);
      chosen.push(candidate);
      if (chosen.length === MAX_SENTENCES) break;
    }

    return {
      text: chosen.map((candidate) => `${clip(candidate.sentence, MAX_SENTENCE_CHARS)} [${candidate.label}]`).join(' '),
    };
  }
}

/** Shared terms, normalised so a long rambling sentence cannot win on length alone. */
function overlap(questionTerms: ReadonlySet<string>, sentence: string): number {
  if (questionTerms.size === 0) return 0;

  let shared = 0;
  for (const word of new Set(words(sentence))) {
    if (questionTerms.has(word)) shared++;
  }

  return shared / Math.sqrt(questionTerms.size);
}

/**
 * Paragraph units, with a list glued to the line that introduces it.
 *
 * "Refund window:" followed by "• Apparel 3 days • Footwear 7 days" is one
 * answer. Quoting only the introducing paragraph would drop every number from
 * the reply, which is exactly the failure this stub exists to expose.
 */
function answerUnits(text: string): string[] {
  const units: string[] = [];

  for (const paragraph of text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
    const previous = units.at(-1);
    const startsList = /^([-*•]|\d+\.)\s/.test(paragraph);

    if (previous !== undefined && previous.endsWith(':') && startsList) {
      units[units.length - 1] = `${previous}\n${paragraph}`;
      continue;
    }

    units.push(paragraph);
  }

  return units;
}

function extractTag(text: string, tag: 'documents' | 'question'): string {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return match?.[1]?.trim() ?? '';
}
```

**Block by block:**

- **`extractTag(prompt, 'question' | 'documents')`** — reads the two delimiters the prompt builder wrote. The stub parses the prompt because it *is* a generator: it receives text and must produce text, exactly like a model.
- **`parseContextBlocks(...)`** — reconstructs `[n] source · section` plus body, from chapter 08.
- **`contentWords(question)`** — the same stopword-filtered vocabulary used for lexical scoring, so the stub and the retriever agree on what a "term" is.
- **`answerUnits(paragraph)`** — the important detail. It splits on blank lines, then **glues a bullet list to the line that introduces it**:

```text
Customers may request a refund within the following windows, measured from the delivery date:
- Apparel (shirts, jackets, dresses): 3 days.
- Footwear (shoes, boots, sandals): 7 days.
```

Quoting only the introducing line would drop every number — the exact failure mode a naive extractive baseline has. Gluing the list keeps the answer complete.

- **`overlap(questionTerms, unit)`** — `shared / sqrt(|questionTerms|)`. Dividing by the square root of the query length dampens long questions without letting long units win on length alone.
- **`.filter(candidate => candidate.score > 0)`** — zero overlap is not evidence. If nothing shares a single content word with the question, the stub refuses.
- **One unit per label** — `usedLabels` prevents three sentences from the same chunk crowding out a second source.
- **`MAX_SENTENCES = 3`** — at most three labels, so the answer shows multi-source citation without turning into a transcript.
- **`clip(..., MAX_SENTENCE_CHARS)`** — 320 characters per quoted unit, which fits the window list but not a whole section.
- **`if (candidates.length === 0) return { text: REFUSAL_MESSAGE }`** — the same constant the prompt uses. The refusal path is therefore exercised on every offline run.

### What the stub is, and is not

| | `extractive` | `openai` |
| :--- | :--- | :--- |
| Reads the prompt | yes (parses tags) | yes (as text) |
| Produces | verbatim quotes + `[n]` | paraphrase + `[n]` |
| Can refuse | yes, when overlap is zero | yes, per instructions |
| Can follow "120 words" | no | yes |
| Can merge two chunks | no | yes |
| Cost | 0 | per token |
| Use it for | demos, tests, CI, citation plumbing | real answers |

Because the stub shares the prompt format, the label map, the citation linker and the refusal constant with the real provider, everything except answer *fluency* is exercised offline. That is the trade: a weak generator, but a fully tested pipeline.

---

## 5. Verify the Chapter

```bash
npm run demo | sed -n '52,66p'
```

Expected shape:

```text
Q: What is the refund window for apparel?
   0.6422  refund-policy.md · Refund window
   …
A: Customers may request a refund within the following windows, measured from the delivery date:
- Apparel (shirts, jackets, dresses): 3 days.
…
context=203 tokens  citations=3  invalid=0  2ms
```

Three things to check in that output:

1. **`citations=3`** — the answer cites three distinct labels, all resolved.
2. **`invalid=0`** — nothing invented.
3. **`generate` latency** — the stub is sub-millisecond, which is why chapter 14's budget table treats generation as the dominant cost in production and not here.

**Next:** [Chapter 11 — Conversation State](./11_Conversation_State.md)
