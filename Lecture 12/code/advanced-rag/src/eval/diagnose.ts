import type { GoldenCase } from './metrics.js';

/**
 * The failure tree from Chapter 01, as code.
 *
 * When an answer is wrong there are exactly four places to look, and they are
 * ordered: evidence that was never retrieved cannot be assembled, and evidence
 * that never reached the prompt cannot be quoted. Walking the tree in order
 * prevents the most expensive mistake in RAG debugging — rewriting the prompt to
 * fix a chunking problem.
 *
 *   retrieved bad?        → retrieval   (chunking, embedding, filter, top-K)
 *   retrieved, not in prompt? → context (budget, dedupe, parent expansion)
 *   in prompt, not in answer? → generation (prompt contract, model, citations)
 *   everything present?   → ok
 */

export type Verdict =
  | 'ok'
  | 'retrieval-miss'
  | 'context-miss'
  | 'generation-miss'
  | 'refusal-ok'
  | 'answered-unanswerable';

export interface Diagnosis {
  verdict: Verdict;
  step: 'retrieval' | 'context' | 'generation' | 'refusal' | 'none';
  reason: string;
}

export function diagnose(input: {
  testCase: GoldenCase;
  refused: boolean;
  answer: string;
  contextText: string;
  retrievedSources: readonly string[];
}): Diagnosis {
  const { testCase } = input;

  if (!testCase.answerable) {
    return input.refused
      ? { verdict: 'refusal-ok', step: 'refusal', reason: 'no evidence cleared the gate; refused' }
      : { verdict: 'answered-unanswerable', step: 'retrieval', reason: 'evidence was weak but the floor let it through' };
  }

  const retrieved = new Set(input.retrievedSources);
  const missingSources = testCase.expectedSources.filter((source) => !retrieved.has(source));
  if (missingSources.length > 0) {
    return {
      verdict: 'retrieval-miss',
      step: 'retrieval',
      reason: `never retrieved: ${missingSources.join(', ')}`,
    };
  }

  const context = input.contextText.toLowerCase();
  const missingInContext = testCase.mustInclude.filter((phrase) => !context.includes(phrase.toLowerCase()));
  if (missingInContext.length > 0) {
    return {
      verdict: 'context-miss',
      step: 'context',
      reason: `dropped before the prompt: ${missingInContext.join(', ')}`,
    };
  }

  const answer = input.answer.toLowerCase();
  const missingInAnswer = testCase.mustInclude.filter((phrase) => !answer.includes(phrase.toLowerCase()));
  if (missingInAnswer.length > 0) {
    return {
      verdict: 'generation-miss',
      step: 'generation',
      reason: `evidence was present, answer omitted: ${missingInAnswer.join(', ')}`,
    };
  }

  return { verdict: 'ok', step: 'none', reason: 'correct evidence, correct answer' };
}
