# Chapter 04: Token Economics & Ledger Tracking

> **Chapter Goal:** Implement the economic ledger accounting layer, understand quadratic token accumulation dynamics ($O(N^2)$) in multi-turn agent loops, and estimate monetary costs per goal execution.

---

## 4.1 File Details & Purpose

| File | Target Path | Operational Purpose |
| :--- | :--- | :--- |
| **`token-ledger.ts`** | `Lecture 05/code/src/engine/token-ledger.ts` | Records prompt and completion tokens across turns, computes cumulative USD expenditure, and returns structured metrics. |

---

## 4.2 Full Code File: `src/engine/token-ledger.ts`

```typescript
import { TokenUsageMetrics } from '../types/agent.types.js';

export class TokenLedger {
  private promptTokensTotal = 0;
  private completionTokensTotal = 0;

  // Standard pricing reference (e.g. gpt-4o approx $2.50 / 1M prompt, $10.00 / 1M completion)
  private readonly promptCostPer1k = 0.0025;
  private readonly completionCostPer1k = 0.01;

  public recordUsage(prompt: number = 0, completion: number = 0): void {
    this.promptTokensTotal += prompt;
    this.completionTokensTotal += completion;
  }

  public getMetrics(): TokenUsageMetrics {
    const total = this.promptTokensTotal + this.completionTokensTotal;
    const cost =
      (this.promptTokensTotal / 1000) * this.promptCostPer1k +
      (this.completionTokensTotal / 1000) * this.completionCostPer1k;

    return {
      promptTokens: this.promptTokensTotal,
      completionTokens: this.completionTokensTotal,
      totalTokens: total,
      estimatedCostUSD: Math.round(cost * 100000) / 100000
    };
  }

  public reset(): void {
    this.promptTokensTotal = 0;
    this.completionTokensTotal = 0;
  }
}
```

---

## 4.3 Block-by-Block Explanation: `src/engine/token-ledger.ts`

### Block 1: Accumulator State and Pricing Weights
```typescript
export class TokenLedger {
  private promptTokensTotal = 0;
  private completionTokensTotal = 0;

  private readonly promptCostPer1k = 0.0025;
  private readonly completionCostPer1k = 0.01;
```
- **What this does:** Tracks aggregate input and output tokens consumed across all turns of an agent session.
- **How it works:** Input (prompt) tokens and output (completion) tokens are priced asymmetrically by LLM cloud providers. For `gpt-4o`, prompt tokens cost approximately $2.50 per million ($0.0025 per 1,000), while generated tokens cost $10.00 per million ($0.01 per 1,000).

### Block 2: Incremental Turn Recording
```typescript
  public recordUsage(prompt: number = 0, completion: number = 0): void {
    this.promptTokensTotal += prompt;
    this.completionTokensTotal += completion;
  }
```
- **What this does:** Ingests the `usage` object returned by each OpenAI ChatCompletion API response.
- **The Quadratic Accumulation Reality:**
  In a multi-turn agent execution, the conversation history grows monotonically:
  $$\text{Input Tokens at Turn } k = L_{\text{system}} + L_{\text{user}} + \sum_{j=1}^{k-1} (L_{\text{assistant}_j} + L_{\text{tool}_j})$$
  Because previous tool calls and assistant thoughts are re-sent in every subsequent request, cumulative input tokens scale quadratically: $\sum_{k=1}^N L_k \in O(N^2)$.

### Block 3: Metrics Calculation & Formatting
```typescript
  public getMetrics(): TokenUsageMetrics {
    const total = this.promptTokensTotal + this.completionTokensTotal;
    const cost =
      (this.promptTokensTotal / 1000) * this.promptCostPer1k +
      (this.completionTokensTotal / 1000) * this.completionCostPer1k;

    return {
      promptTokens: this.promptTokensTotal,
      completionTokens: this.completionTokensTotal,
      totalTokens: total,
      estimatedCostUSD: Math.round(cost * 100000) / 100000
    };
  }
```
- **What this does:** Computes the total token burn and dollar cost, rounding to 5 decimal places. Returned as part of the `AgentExecutionResult` payload for production cost observability.
