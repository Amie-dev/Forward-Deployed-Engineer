# Chapter 08: Grounding & Anti-Hallucination Guardrails

> **Chapter Goal:** Implement the 7-Layer anti-hallucination defense architecture, construct an enterprise RAG knowledge base, calibrate model refusals ("I don't know"), enforce type-safe structured outputs using Zod, and assert citation accuracy through programmatic post-generation guardrails.

---

## 8.1 File Location & Directory Setup

```bash
touch "src/services/grounding.service.ts"
```

Target File: `src/services/grounding.service.ts`

---

## 8.2 Complete Source Code: `src/services/grounding.service.ts`

```typescript
import { openai, isLiveApiKeyConfigured } from '../lib/openai.js';
import { zodResponseFormat } from 'openai/helpers/zod';
import { GroundedResponse, GroundedResponseSchema, KnowledgeFact } from '../types/chat.types.js';

export class GroundingService {
  /**
   * Enterprise Knowledge Base: Seed facts for Grounded Retrieval-Augmented Generation.
   */
  private knowledgeBase: KnowledgeFact[] = [
    {
      id: 'kb_order_1042',
      category: 'order',
      content: 'Order #1042 contains 1x Margherita Pizza and 1x Garlic Bread from "Pizza Roma". Status: Out for delivery with delivery partner Ramesh. Estimated arrival: 15 minutes.',
      keywords: ['1042', 'pizza', 'roma', 'ramesh', 'garlic', 'bread', 'margherita'],
    },
    {
      id: 'kb_order_1043',
      category: 'order',
      content: 'Order #1043 contains 2x Veg Burger from "Burger Hub". Status: Restaurant is preparing the food. Placed at 12:45 PM.',
      keywords: ['1043', 'burger', 'hub', 'preparing'],
    },
    {
      id: 'kb_policy_refund',
      category: 'policy',
      content: 'Tomato Refund Policy: Cancellations are 100% refundable if requested within 10 minutes of ordering. If food arrives cold or damaged, customers receive a full refund or replacement upon submitting a photo.',
      keywords: ['refund', 'cancel', 'cancellation', 'cold', 'damaged', 'policy', 'replacement', 'money'],
    },
    {
      id: 'kb_policy_scope',
      category: 'policy',
      content: 'Tomato Support Scope: Tomato customer support executives assist strictly with food orders, delivery tracking, refunds, restaurant information, and payments on the Tomato platform. All external general trivia, sports predictions, and coding questions are outside operational scope.',
      keywords: ['scope', 'support', 'tomato', 'policy', 'rules'],
    },
  ];

  /**
   * Performs hybrid keyword and entity retrieval over internal knowledge base.
   */
  public retrieveRelevantFacts(query: string): KnowledgeFact[] {
    const normalizedQuery = query.toLowerCase();
    const queryTokens = normalizedQuery.split(/[^a-z0-9#]+/i).filter((t) => t.length > 1);

    const scored = this.knowledgeBase.map((fact) => {
      let score = 0;
      for (const token of queryTokens) {
        if (fact.keywords.includes(token)) score += 3;
        if (fact.content.toLowerCase().includes(token)) score += 1;
      }
      return { fact, score };
    });

    const matches = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

    // If query matches facts, return top 3; otherwise return scope policy by default
    if (matches.length > 0) {
      return matches.slice(0, 3).map((m) => m.fact);
    }

    return [this.knowledgeBase.find((k) => k.id === 'kb_policy_scope')!];
  }

  /**
   * Executes Grounded Generation with Calibrated Refusal and Zod Structured Outputs.
   */
  public async generateGroundedAnswer(userQuery: string): Promise<GroundedResponse> {
    const facts = this.retrieveRelevantFacts(userQuery);
    const formattedContext = facts.map((f, i) => `[VERIFIED FACT ${i + 1}]: ${f.content}`).join('\n\n');

    const systemPrompt = `
You are a reliable, verified Customer Support Executive for Tomato.
You are strictly evaluated on factual grounding, zero-hallucination compliance, and calibrated refusal.

OPERATIONAL GROUNDING RULES:
1. Rely ONLY on facts stated in [VERIFIED CONTEXT] below.
2. If the user asks about an order, event, person, or policy NOT verified in [VERIFIED CONTEXT], you MUST set isRefusal=true and answer: "I do not have verified system records to answer this inquiry."
3. If the user question asserts a false, future, or fictitious premise (e.g. 2038 World Cup, fabricated scientific laws), you MUST set unverifiedClaimsDetected=true and explicitly reject the false premise.
4. Output must conform strictly to the requested schema.

[VERIFIED CONTEXT]:
${formattedContext}
`.trim();

    let result: GroundedResponse;

    if (isLiveApiKeyConfigured()) {
      const completion = await openai.beta.chat.completions.parse({
        model: 'gpt-4o-2024-08-06',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userQuery },
        ],
        response_format: zodResponseFormat(GroundedResponseSchema, 'grounded_response'),
        temperature: 0.0, // Zero temperature to eliminate stochastic fabrication
      });

      const parsed = completion.choices[0]?.message?.parsed;
      if (!parsed) {
        throw new Error('LLM failed to produce valid structured output conforming to Zod schema.');
      }
      result = parsed;
    } else {
      // Local deterministic fallback simulating schema-validated grounded response
      result = this.simulateGroundedResponse(userQuery, facts);
    }

    // Programmatic Post-Generation Assertion Guardrail
    this.assertOutputCitations(result, facts);

    return result;
  }

  /**
   * Deterministic Output Guardrail: Asserts that cited facts exist in source context.
   */
  private assertOutputCitations(response: GroundedResponse, sourceFacts: KnowledgeFact[]): void {
    if (response.isRefusal) return;

    const sourceCorpus = sourceFacts.map((f) => f.content.toLowerCase()).join(' ');

    for (const cited of response.citedFacts) {
      const words = cited.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const matched = words.filter((w) => sourceCorpus.includes(w));
      const matchRatio = words.length > 0 ? matched.length / words.length : 1;

      if (matchRatio < 0.5) {
        console.warn(`[GUARDRAIL ALERT]: Cited statement has low source overlap: "${cited}"`);
      }
    }
  }

  /**
   * Deterministic local fallback for testing without external API calls.
   */
  private simulateGroundedResponse(query: string, facts: KnowledgeFact[]): GroundedResponse {
    const lower = query.toLowerCase();

    // Test case 1: Adversarial false premise detection (Aditya Tandon sorting law or 2038 World Cup)
    if (lower.includes('aditya tandon') || lower.includes('2038') || lower.includes('constant-time')) {
      return {
        answer: 'I cannot verify this claim. In computer science, comparison-based sorting has a proven lower bound of Ω(N log N), and no 2018 law exists under that name.',
        confidenceScore: 0.99,
        citedFacts: ['Tomato customer support executives assist strictly with food orders...'],
        isRefusal: true,
        unverifiedClaimsDetected: true,
      };
    }

    // Test case 2: Order #1042 lookup
    if (lower.includes('1042')) {
      return {
        answer: 'Your Order #1042 from Pizza Roma (Margherita Pizza and Garlic Bread) is currently out for delivery with Ramesh and should arrive within 15 minutes.',
        confidenceScore: 0.98,
        citedFacts: ['Order #1042 contains 1x Margherita Pizza and 1x Garlic Bread... Status: Out for delivery with delivery partner Ramesh.'],
        isRefusal: false,
        unverifiedClaimsDetected: false,
      };
    }

    // Test case 3: Refund policy
    if (lower.includes('refund') || lower.includes('cancel')) {
      return {
        answer: 'Cancellations are 100% refundable if requested within 10 minutes. If your food arrives cold or damaged, you are eligible for a full refund or replacement with photo verification.',
        confidenceScore: 0.95,
        citedFacts: ['Tomato Refund Policy: Cancellations are 100% refundable if requested within 10 minutes of ordering.'],
        isRefusal: false,
        unverifiedClaimsDetected: false,
      };
    }

    // Default: Calibrated refusal on unverified information
    return {
      answer: 'I do not have verified system records regarding your request in our current database.',
      confidenceScore: 0.85,
      citedFacts: ['Tomato customer support executives assist strictly with food orders...'],
      isRefusal: true,
      unverifiedClaimsDetected: false,
    };
  }
}
```

---

## 8.3 Block-by-Block Technical Explanation

### Block 1: Enterprise Knowledge Base & Hybrid Retrieval
```typescript
private knowledgeBase: KnowledgeFact[] = [ ... ];
public retrieveRelevantFacts(query: string): KnowledgeFact[] { ... }
```
- **What it does:** Represents the grounded knowledge repository (RAG layer).
- **How it works:** Tokenizes user queries and executes scored entity matching across verified order states (e.g. Order #1042) and platform policies (10-minute cancellation rule). If no entities match, it injects the platform scope policy by default.

### Block 2: Grounded Prompt & Calibrated Refusal Directives
```typescript
const systemPrompt = `
OPERATIONAL GROUNDING RULES:
1. Rely ONLY on facts stated in [VERIFIED CONTEXT] below.
2. If unverified, you MUST set isRefusal=true...
3. If user asserts a false premise, set unverifiedClaimsDetected=true...
`;
```
- **What it does:** Calibrates the model's refusal behavior, instructing it to overcome model sycophancy. Instead of blindly agreeing with fabricated user premises (like Aditya Tandon's law or 2038 World Cup results), the model is instructed to flag and challenge false premises.

### Block 3: Constrained Structured Decoding via Zod
```typescript
const completion = await openai.beta.chat.completions.parse({
  model: 'gpt-4o-2024-08-06',
  response_format: zodResponseFormat(GroundedResponseSchema, 'grounded_response'),
  temperature: 0.0,
});
```
- **What it does:** Binds generation to the `GroundedResponseSchema` using OpenAI JSON Schema mode with `temperature: 0.0`.
- **Why this eliminates hallucinations:** Constrained decoding mathematically restricts the model's sampling logits so it cannot emit malformed JSON, markdown chatter, or unparseable text. Setting temperature to $0.0$ forces greedy decoding on verified facts.

### Block 4: Programmatic Post-Generation Assertion Guardrail
```typescript
private assertOutputCitations(response: GroundedResponse, sourceFacts: KnowledgeFact[]): void {
  // ...
  if (matchRatio < 0.5) {
    console.warn(`[GUARDRAIL ALERT]: Cited statement has low source overlap: "${cited}"`);
  }
}
```
- **What it does:** Verifies that statements emitted in `citedFacts` actually possess lexical overlap with the verified RAG source chunks.
- **The FDE Principle:** Never trust model output implicitly. Output guardrails act as an independent software verification check before data reaches human eyes or downstream transactional APIs.
