/**
 * From data to action — Chapters 07 and 08, whole.
 *
 * The lecture's closing sequence, in order, with nothing skipped:
 *
 *   1 EXTRACT    the model produces a `MeetingRequest`
 *   2 VALIDATE   shape and meaning (already done inside `extractMeeting`)
 *   3 AUTHORISE  may *this actor* do *this* to *that attendee*? — in code, never in a prompt
 *   4 CONFIRM    tier 3 or flagged → a human decides
 *   5 EXECUTE    adapter + idempotency key
 *   6 REPORT     the external id, or a typed failure
 *
 * The single most important line in this file is the comment on step 3. The model's job
 * ended at step 1. Everything after is ordinary, testable, deterministic software — and
 * that boundary is what makes the whole system auditable.
 */

import { config } from '../config/env.js';
import { matchesPerson, shortHash } from '../lib/text.js';
import type {
  ActionOutcome,
  ActionProposal,
  Extraction,
  MeetingRequest,
  TaggedIssue,
} from '../types.js';
import { idempotencyKeyFor, type CalendarPort } from '../action/calendar.js';

export interface ScheduleOptions {
  /** Who is asking. Authorisation is per-actor, and it is not the model's decision. */
  actor?: string;
  /** Set by the API when a human has approved a tier-3 proposal. */
  approved?: boolean;
}

export interface ScheduleResult {
  outcome: ActionOutcome;
  proposal: ActionProposal | null;
  /** The validated object, when one exists. `null` for refused / invalid extractions. */
  meeting: MeetingRequest | null;
  /** `review`-severity flags that travelled with the object. */
  flags: TaggedIssue[];
}

/**
 * The whole pipeline.
 *
 * Note that a *refusal* and an *invalid extraction* both stop before any side effect,
 * and both are returned as ordinary values. There is no code path in which an
 * unvalidated object reaches the calendar — that is the boundary rule of Chapter 06 §6.1,
 * expressed as control flow.
 */
export async function scheduleMeeting(
  extraction: Extraction,
  calendar: CalendarPort,
  options: ScheduleOptions = {},
): Promise<ScheduleResult> {
  const actor = options.actor ?? config.actorId;

  // ── Steps 1-2 are already done. Anything that is not a usable object stops here. ──
  if (extraction.kind === 'refused') {
    return {
      outcome: {
        kind: 'rejected',
        code: 'invalid',
        message: 'The model declined to interpret this request.',
      },
      proposal: null,
      meeting: null,
      flags: [],
    };
  }

  if (
    extraction.kind === 'truncated' ||
    extraction.kind === 'invalid' ||
    extraction.kind === 'failed'
  ) {
    return {
      outcome: {
        kind: 'rejected',
        code: 'invalid',
        message: 'The request could not be turned into a valid meeting object.',
      },
      proposal: null,
      meeting: null,
      flags: [],
    };
  }

  const meeting = extraction.value;
  const flags = extraction.flags;

  // ── Step 3: authorise. In code. Never delegated to the model. ──
  //
  // A system prompt that says "only schedule for the requesting user" is not a control;
  // it is a preference, and preferences do not survive adversarial input.
  const authorised = await canBook(actor, meeting);
  if (!authorised.allowed) {
    return {
      outcome: { kind: 'rejected', code: 'forbidden', message: authorised.reason },
      proposal: null,
      meeting,
      flags,
    };
  }

  // ── Step 4: build the proposal, and decide whether a human must confirm. ──
  //
  // Two independent reasons to confirm: the action is high-impact (a long meeting, a
  // write to someone else's calendar), or the object carries `review` flags. Either one
  // is enough; the reason is recorded so the approval UI can explain itself.
  const proposal = buildProposal(meeting, actor, flags);

  if (proposal.requiresApproval && !options.approved) {
    return { outcome: { kind: 'awaiting_approval', proposal }, proposal, meeting, flags };
  }

  // ── Step 5: execute. The idempotency key makes this safe to retry. ──
  const result = await calendar.createEvent(meeting, proposal.idempotencyKey, actor);

  if (result.ok) {
    return {
      outcome: {
        kind: 'created',
        externalId: result.event.id,
        url: `https://calendar.example.com/events/${result.event.id}`,
        duplicate: result.duplicate,
      },
      proposal,
      meeting,
      flags,
    };
  }

  return {
    outcome: {
      kind: 'failed',
      code: result.code,
      message: result.message,
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
    },
    proposal,
    meeting,
    flags,
  };
}

/**
 * Builds the boundary object.
 *
 * `requiresApproval` is the tiering decision from Chapter 07 §7.12, and it is
 * deliberately conservative: it fires on duration, on booking for someone else, and on
 * any `review` flag. A false positive costs one click; a false negative books a
 * four-hour meeting in someone else's calendar.
 */
export function buildProposal(
  meeting: MeetingRequest,
  actor: string,
  flags: TaggedIssue[],
): ActionProposal {
  const reasons: string[] = [];

  if (meeting.durationMinutes > config.autoApproveMaxDuration) {
    reasons.push(`duration ${meeting.durationMinutes} min exceeds the auto-approve limit`);
  }
  // The shared identity rule, not a string comparison: the model extracted a name and
  // the request carried an email, and they are the same person.
  if (!matchesPerson(actor, meeting.attendee)) {
    reasons.push('the event is created for someone else');
  }
  if (flags.length > 0) {
    reasons.push(`flagged: ${flags.map((flag) => flag.path).join(', ')}`);
  }

  return {
    proposalId: `prop_${shortHash(`${actor}:${meeting.startIso}:${meeting.title}`)}`,
    meeting,
    actor,
    idempotencyKey: idempotencyKeyFor(meeting, actor),
    requiresApproval: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join('; ') : 'within the auto-approve policy',
  };
}

/** The authorisation decision. Deliberately a separate, awaitable step. */
async function canBook(
  actor: string,
  meeting: MeetingRequest,
): Promise<{ allowed: boolean; reason: string }> {
  if (actor.trim().length === 0) {
    return { allowed: false, reason: 'No actor on the request.' };
  }

  // Booking for yourself is always allowed. Note the shared identity rule: the actor is
  // an email and the attendee is a name, and they are the same person.
  if (matchesPerson(actor, meeting.attendee)) {
    return { allowed: true, reason: 'self-booking' };
  }

  // Booking for a colleague requires them to be a known person.
  if (config.directory.some((entry) => matchesPerson(meeting.attendee, entry))) {
    return { allowed: true, reason: 'internal colleague' };
  }

  return {
    allowed: false,
    reason: `"${meeting.attendee}" is not in the directory, so this actor may not book for them.`,
  };
}
