/**
 * The repair prompt — Chapter 06 §6.8.
 *
 * A repair is **a second call that includes what went wrong.** It is not a blind retry,
 * and the difference between the two is entirely in this string.
 *
 * Compare what the notes call weak and strong:
 *
 *   weak    "That was not valid JSON. Try again."
 *           → same input, same distribution, same failure.
 *
 *   strong  the machine-readable issues, the previous output, a scoping instruction
 *           and a format instruction.
 *           → a targeted edit, which succeeds on the first attempt most of the time.
 *
 * One anti-pattern is deliberately avoided: the original request is **not** repeated.
 * It is already in the conversation, and restating it dilutes attention and doubles
 * the cost.
 */

import type { TaggedIssue } from '../types.js';

export interface RepairInput {
  /** The exact text the previous attempt produced. */
  previous: string;
  /** The issues the validator found, in the order they were reported. */
  issues: TaggedIssue[];
  /** 1-based attempt number, used only for the header line. */
  attempt: number;
}

/**
 * Builds the repair instruction.
 *
 * The four ingredients, in the order the notes list them:
 *  1. the machine-readable issues (path + expected versus received);
 *  2. the previous output, so the model edits rather than regenerates;
 *  3. a scoping instruction ("fix only these fields");
 *  4. a format instruction ("return the object only").
 */
export function buildRepairPrompt(input: RepairInput): string {
  const { previous, issues, attempt } = input;

  const lines: string[] = [
    `Your previous answer (attempt ${attempt}) failed validation against the required schema.`,
    '',
    'Validation errors:',
  ];

  for (const issue of issues) {
    // `path` first, because that is what the model needs to locate the field. The
    // message carries expected-versus-received, which is what makes the edit targeted.
    lines.push(`- ${issue.path}: ${issue.message}`);
  }

  lines.push('');
  lines.push('Previous answer:');
  lines.push(clamp(previous));
  lines.push('');
  lines.push(
    [
      'Fix ONLY the fields listed above.',
      'Keep every other value exactly as it was.',
      'Do not add, remove or rename any field.',
      'Use null for a value the request does not state. Never use an empty string.',
      'Return the corrected object only, with no commentary.',
    ].join('\n'),
  );

  return lines.join('\n');
}

/**
 * Caps the previous answer so a runaway generation cannot inflate the repair call.
 *
 * A truncation notice is included rather than a silent cut, because a silently
 * truncated "previous answer" is itself a source of confusing failures.
 */
function clamp(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [previous answer truncated for the repair prompt]`;
}

/** A short, one-line summary of the issues, for logs and console output. */
export function summariseIssues(issues: TaggedIssue[]): string {
  if (issues.length === 0) return 'none';
  return issues.map((issue) => `${issue.path}(${issue.code})`).join(', ');
}
