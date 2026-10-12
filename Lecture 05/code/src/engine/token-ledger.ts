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
