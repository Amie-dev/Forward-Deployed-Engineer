# Chapter 10: History Assembly, Context Budget & Interrupted-Turn Annotation

> **Chapter Goal:** Assemble the next prompt from stored history under a hard token budget, and make partial answers explicit so the model never reads a truncated turn as complete.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/services/history.service.ts` | 129 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/services/history.service.ts` (128 lines)

```typescript
import { env } from '../config/env.js';
import type { Conversation, ProviderMessage } from '../types/stream.types.js';

/**
 * History assembly + context budgeting (Chapter 08.6).
 *
 * Context management is a *streaming* concern, not just a cost concern: prompt
 * length drives prefill time, which drives TTFT (§3.4). An unbounded transcript
 * therefore degrades the exact metric the user feels.
 *
 * The system prompt is also where the streaming contract is stated to the model:
 * it writes ONE message, not fragments, and it must not imitate the transport.
 */

export const STREAMING_SYSTEM_PROMPT = [
  'You are the assistant for a production AI chat product.',
  '',
  'Rules:',
  '1. Answer in ONE coherent message. Your output is delivered to the user incrementally as it is generated, but it must read as a single finished answer.',
  '2. Never emit transport artefacts: no "chunk", "delta", "[DONE]", JSON envelopes, or progress narration.',
  '3. Use markdown, but keep structures small: a partial code fence or table may be rendered before it is complete.',
  '4. If you do not know something, say so plainly rather than inventing detail.',
].join('\n');

export interface HistoryBudgetMetrics {
  systemTokens: number;
  historyTokens: number;
  estimatedPromptTokens: number;
  budgetTokens: number;
  includedMessages: number;
  discardedMessages: number;
  interruptedTurnsIncluded: number;
  /** `true` when even the newest message alone blows the budget (fail fast). */
  overBudget: boolean;
}

export interface HistoryBuildResult {
  messages: ProviderMessage[];
  metrics: HistoryBudgetMetrics;
}

/**
 * ≈4 chars/token. A real deployment uses the provider tokeniser; the point
 * enforced here is that SOME deterministic budget exists before dispatch, so the
 * system fails fast with `invalid_request` instead of surfacing a provider error
 * (hardening checklist #16).
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Mark a partial answer so the next turn does not read it as a complete one. */
export function annotateInterrupted(content: string): string {
  return `${content}\n\n[Note: this previous answer was interrupted before it finished.]`;
}

export class HistoryService {
  constructor(private readonly budgetTokens: number = env.HISTORY_TOKEN_BUDGET) {}

  public build(conversation: Conversation | undefined): HistoryBuildResult {
    const systemTokens = estimateTokens(STREAMING_SYSTEM_PROMPT);
    const messages: ProviderMessage[] = [{ role: 'system', content: STREAMING_SYSTEM_PROMPT }];

    if (!conversation) {
      return {
        messages,
        metrics: {
          systemTokens,
          historyTokens: 0,
          estimatedPromptTokens: systemTokens,
          budgetTokens: this.budgetTokens,
          includedMessages: 0,
          discardedMessages: 0,
          interruptedTurnsIncluded: 0,
          overBudget: false,
        },
      };
    }

    const remaining = Math.max(0, this.budgetTokens - systemTokens);
    const history: ProviderMessage[] = [];
    let historyTokens = 0;
    let interruptedTurnsIncluded = 0;
    let discarded = 0;

    // Walk BACKWARDS: recent turns matter most, and dropping the oldest keeps
    // the conversation coherent (the "lost in the middle" trade-off).
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (!message) continue;

      const content = message.status === 'interrupted' ? annotateInterrupted(message.content) : message.content;
      const cost = estimateTokens(content);

      if (historyTokens + cost > remaining) {
        discarded += 1;
        continue;
      }

      historyTokens += cost;
      if (message.status === 'interrupted') interruptedTurnsIncluded += 1;
      history.push({ role: message.role, content });
    }

    history.reverse();
    messages.push(...history);

    // The newest user message alone exceeding the budget is a request-level
    // failure, not something to be silently truncated.
    const newestUserTokens = history.length ? estimateTokens(history[history.length - 1]?.content ?? '') : 0;

    return {
      messages,
      metrics: {
        systemTokens,
        historyTokens,
        estimatedPromptTokens: systemTokens + historyTokens,
        budgetTokens: this.budgetTokens,
        includedMessages: history.length,
        discardedMessages: discarded,
        interruptedTurnsIncluded,
        overBudget: newestUserTokens > remaining,
      },
    };
  }
}

export const historyService = new HistoryService();
```


---

## 3. Block-by-Block Explanation

### Part A: The system prompt — stating the streaming contract to the model

#### Block 1: One message, not fragments

```typescript
export const STREAMING_SYSTEM_PROMPT = [
  'You are the assistant for a production AI chat product.',
  '',
  'Rules:',
  '1. Answer in ONE coherent message. Your output is delivered to the user incrementally as it is generated, but it must read as a single finished answer.',
  '2. Never emit transport artefacts: no "chunk", "delta", "[DONE]", JSON envelopes, or progress narration.',
  '3. Use markdown, but keep structures small: a partial code fence or table may be rendered before it is complete.',
  '4. If you do not know something, say so plainly rather than inventing detail.',
].join('\n');
```

- **What it does:** tells the model about the *delivery mechanism* it is unaware of, in the terms that affect its output.
- **How it works:** rule 2 is the important one: a model that has seen transport artefacts in its context (or was told it is "streaming") may start narrating progress or emitting `[DONE]`-like tokens, which then appear in the user's bubble. Rule 3 anticipates that partial markdown renders — a half-written code fence is normal, not a bug.

---

### Part B: The context budget

#### Block 2: The budget metrics contract

```typescript
export interface HistoryBudgetMetrics {
  systemTokens: number;
  historyTokens: number;
  estimatedPromptTokens: number;
  budgetTokens: number;
  includedMessages: number;
  discardedMessages: number;
  interruptedTurnsIncluded: number;
  /** `true` when even the newest message alone blows the budget (fail fast). */
  overBudget: boolean;
}
```

- **What it does:** makes the assembly decision *observable* — you can always ask "what will the next prompt contain, and what was dropped?"
- **How it works:** `discardedMessages` and `interruptedTurnsIncluded` are the two numbers that explain behaviour changes over a long session. `overBudget` is the fail-fast flag that becomes an HTTP `413` before any provider call happens (hardening item #16).

#### Block 3: Token estimation

```typescript
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
```

- **What it does:** gives a deterministic, dependency-free token estimate (~4 characters per token).
- **How it works:** the point is not precision — it is that *some* deterministic budget exists before dispatch. A real deployment swaps in the provider tokeniser here; everything else (the walk, the budget, the metrics) is unchanged. `Math.max(1, …)` ensures an empty string still costs something, so the accounting never divides by zero.

#### Block 4: Walking history backwards

```typescript
const remaining = Math.max(0, this.budgetTokens - systemTokens);
for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
  const message = conversation.messages[index];
  const content = message.status === 'interrupted' ? annotateInterrupted(message.content) : message.content;
  const cost = estimateTokens(content);
  if (historyTokens + cost > remaining) { discarded += 1; continue; }
  historyTokens += cost;
  if (message.status === 'interrupted') interruptedTurnsIncluded += 1;
  history.push({ role: message.role, content });
}
history.reverse();
```

- **What it does:** fills the context window newest-first, dropping the oldest turns when the budget runs out.
- **How it works:** recency is what matters for coherence, and the walk direction also means the system prompt and the newest user turn always survive — the two things a request cannot work without. `continue` (rather than `break`) lets a short old message still fit after a long one is skipped.

#### Block 5: Interrupted turns are annotated, not hidden

```typescript
export function annotateInterrupted(content: string): string {
  return `${content}\n\n[Note: this previous answer was interrupted before it finished.]`;
}

// …
overBudget: newestUserTokens > remaining,
```

- **What it does:** makes a partial answer explicit in the prompt.
- **How it works:** §8.5 asks "include partial in the next prompt?" — the answer is *yes, with a flag*. Without the annotation the model sees a truncated sentence and may continue it, repeat it, or apologise for a gap it cannot see. The flag costs a handful of tokens and removes an entire class of confusing behaviour. `overBudget` compares the **newest user message alone** against the remaining budget, which is the one condition that cannot be fixed by dropping history.

---

### ✅ Chapter 10 verification

```bash
curl -s localhost:8090/api/conversations/<id>/budget | python3 -m json.tool
npm run test:cancel      # asserts the annotation reaches the next prompt
```


---

**Previous:**  · **Next:** 
