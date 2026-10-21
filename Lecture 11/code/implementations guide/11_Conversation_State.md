# Chapter 11: Conversation State

> **Chapter Goal:** Give a stateless model the illusion of memory — safely, cheaply, and without letting a follow-up question destroy retrieval. History is a budget you spend on every turn.

> **Lecture mapping:** Notes Chapter 07 — statelessness, history as a retrieval problem, query condensation, memory strategies, TTL, session security and history poisoning.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/session/store.ts` | 73 | TTL-bounded, turn-capped conversation store. |
| `src/session/rewrite.ts` | 65 | Follow-up detection and query condensation. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run demo | sed -n '68,76p'
# Q: And for shoes?
# rewritten searchQuery: refund window apparel And for shoes?
# A: … - Footwear (shoes, boots, sandals): 7 days. [1]

curl -s -X POST localhost:3000/api/query -H 'content-type: application/json' \
  -d '{"question":"What is the refund window for apparel?","sessionId":"s1"}' | jq -r .sessionId

curl -s -X DELETE localhost:3000/api/sessions/s1
# {"deleted":true}
```

---

## 2. The Store — `src/session/store.ts`

#### 📄 `src/session/store.ts`

```ts
import type { Turn } from '../types/rag.types.js';

interface Session {
  turns: Turn[];
  updatedAt: number;
}

/**
 * Server-side conversation state.
 *
 * The model is stateless: this store is the only reason a follow-up question
 * makes sense. Two limits keep it honest — `maxTurns` bounds what is re-sent on
 * every request (token cost grows with the square of the turn count), and the TTL
 * bounds how long a customer's questions sit in memory.
 *
 * Sessions are keyed by an id the client holds but never controls: the server
 * must check that the session belongs to the authenticated user before loading it.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxTurns: number,
  ) {}

  /** Oldest first. Expired sessions are dropped on read, not by a timer. */
  get(sessionId: string): Turn[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      return [];
    }

    // A copy: callers build prompts from this, and a prompt must not be able to
    // mutate stored history by accident.
    return [...session.turns];
  }

  append(sessionId: string, turn: Turn): void {
    this.prune();

    const session = this.sessions.get(sessionId) ?? { turns: [], updatedAt: Date.now() };
    session.turns.push(turn);

    if (session.turns.length > this.maxTurns) {
      session.turns.splice(0, session.turns.length - this.maxTurns);
    }

    session.updatedAt = Date.now();
    this.sessions.set(sessionId, session);
  }

  reset(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  private isExpired(session: Session): boolean {
    return Date.now() - session.updatedAt > this.ttlMs;
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) this.sessions.delete(id);
    }
  }
}
```

**Block by block:**

- **`Session`** — `turns` plus `updatedAt`. The timestamp is the TTL clock; there is no timer, no cron, no background sweep.
- **`ttlMs` and `maxTurns` in the constructor** — both are policy, both come from config (`SESSION_TTL_MINUTES`, `HISTORY_TURNS`), and neither is a magic number buried in the class.
- **`get()`** — returns `[]` for an unknown id, and **deletes** a session that has expired. Lazy expiry is the right trade here: an idle process does no work, and a session can never be returned after its TTL.
- **`return [...session.turns]`** — a copy. The prompt builder slices history and would otherwise hold a live reference into stored state; a caller mutating it could silently rewrite the conversation.
- **`append()`** — `prune()` first (so dead sessions do not accumulate), then push and trim from the front: `splice(0, length - maxTurns)`. The newest turns are the ones that matter.
- **`reset()`** — one call deletes everything about a conversation. Deletion must be a single operation, not a scavenger hunt across caches.
- **`prune()`** — O(n) over live sessions, called on write rather than on read, so a read never pays for other sessions' expiry.

### Why the cap matters

Every turn is re-sent on the next request. Token cost grows with the *square* of the turn count:

| Turns kept | User tokens sent (turn n) | Effect |
| ---: | :--- | :--- |
| 4 | ~1.2k | constant, cheap |
| 20 | ~6k | noticeable |
| 100 | ~30k | context window pressure, dilution, cost |

Six turns is the default. Long sessions need a rolling summary, not a longer buffer.

---

## 3. Rewriting Follow-ups — `src/session/rewrite.ts`

#### 📄 `src/session/rewrite.ts`

```ts
import type { GenerationProvider } from '../generation/provider.js';
import { clip, keywords, words } from '../lib/text.js';
import type { Turn } from '../types/rag.types.js';

export interface QueryRewriter {
  /** Turn a conversational follow-up into a standalone search query. */
  rewrite(question: string, history: readonly Turn[]): Promise<string>;
}

const FOLLOW_UP = /^(and|also|but|what about|how about|same|those|these|it|its|they|them|that)\b/i;

/**
 * A follow-up is semantically empty on its own: "And for shoes?" embeds to noise.
 * Cheap signals are enough to decide whether rewriting is needed at all.
 */
export function isFollowUp(question: string): boolean {
  return FOLLOW_UP.test(question.trim()) || words(question).length <= 2;
}

/**
 * With a real model, rewriting is one short call. Without one, carry the topic
 * of the previous *search query* — not the previous answer, which is longer and
 * noisier — into the new query. Neither is magic; both are testable.
 */
export function createQueryRewriter(generator?: GenerationProvider): QueryRewriter {
  return generator ? new LlmQueryRewriter(generator) : new HeuristicQueryRewriter();
}

class HeuristicQueryRewriter implements QueryRewriter {
  async rewrite(question: string, history: readonly Turn[]): Promise<string> {
    const previous = history.at(-1);
    if (!previous || !isFollowUp(question)) return question;

    const topic = keywords(previous.searchQuery, 4).join(' ');
    return topic ? `${topic} ${question}` : question;
  }
}

class LlmQueryRewriter implements QueryRewriter {
  constructor(private readonly generator: GenerationProvider) {}

  async rewrite(question: string, history: readonly Turn[]): Promise<string> {
    if (history.length === 0 || !isFollowUp(question)) return question;

    const transcript = history
      .slice(-4)
      .map((turn) => `Customer: ${turn.question}\nAssistant: ${clip(turn.answer, 240)}`)
      .join('\n');

    const result = await this.generator.generate({
      instructions:
        'Rewrite the customer follow-up as one standalone search query. ' +
        'Return only the query — no quotes, no explanation.',
      messages: [
        {
          role: 'user',
          content: `Conversation:\n${transcript}\n\nFollow-up: ${question}\n\nStandalone search query:`,
        },
      ],
    });

    const rewritten = result.text.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim();
    return rewritten.length >= 3 ? rewritten.slice(0, 200) : question;
  }
}
```

**Block by block:**

- **`FOLLOW_UP`** — a small regex for the ways people continue a conversation: "and…", "what about…", "same…", "it/they/them/that". Cheap, explainable, and wrong in known ways (it will treat "and what is the warranty?" as a follow-up, which is harmless).
- **`isFollowUp`** — also true for questions of two words or fewer. "Shoes?" is a continuation, not a topic.
- **`createQueryRewriter(generator?)`** — the factory *is* the policy: with a real model you get rewriting; without one you get the heuristic. There is no silent fallback that pretends to be a model.
- **`HeuristicQueryRewriter`** — carries the topic of the previous **search query** (not the previous answer) into the new one:

```text
previous searchQuery : refund window apparel And for shoes?
new question         : And for shoes?
rewritten            : refund window apparel And for shoes?
```

  Keywords come from `keywords(previous.searchQuery, 4)`, which is why the rewrite inherits "refund window" and not the whole answer.
- **`LlmQueryRewriter`** — one small call with an explicit instruction: *"Rewrite the customer follow-up as one standalone search query. Return only the query."* It **skips the call entirely** when the question is standalone or there is no history: paying a model to return your own question unchanged is the most common waste in agentic RAG.
- **The cleanup** — first line only, quotes and backticks stripped, length capped at 200 characters. A model that adds "Sure! Here's the query:" must not poison the embedding.
- **`rewritten.length >= 3 ? … : question`** — a guard against an empty or one-character rewrite.

### Why rewriting is a retrieval fix, not a chat fix

"And for shoes?" embeds to noise. Retrieve with it and you get nothing — or worse, something plausible. The failure looks like a *generation* bug ("the model ignored my follow-up") when it is a *search* bug. Rewriting happens **before** the embedding call for exactly that reason.

### Security, briefly

| Requirement | Where it lives |
| :--- | :--- |
| Session id ≠ authorisation | The API must check ownership on every load; a session id is a record key, not a credential |
| No client-supplied history | `POST /api/query` accepts a question and an id — never a transcript |
| TTL | constructor of `SessionStore` |
| Deletion | `resetSession`, exposed as `DELETE /api/sessions/:id` |

Chapter 14 covers the auth boundary; this chapter only guarantees that state *can* be deleted in one call.

**Next:** [Chapter 12 — The RAG Service](./12_The_RAG_Service.md)
