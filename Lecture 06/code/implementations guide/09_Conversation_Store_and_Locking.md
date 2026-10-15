# Chapter 09: Conversation Store: Dual-Write Target & Per-Conversation Locking

> **Chapter Goal:** Persist ONE assistant message per turn idempotently, keep state conversation-scoped, serialise concurrent turns, and never leak a lock.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/services/conversation.store.ts` | 260 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/services/conversation.store.ts` (259 lines)

```typescript
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { Conversation, ConversationMessage, FinishReason, MessageStatus, TokenUsage } from '../types/stream.types.js';

/**
 * Conversation store (the "conversation store" layer of §8.7).
 *
 * This is in-memory by design — swapping in PostgreSQL/Redis means implementing
 * the same six methods and nothing else changes — but the *semantics* it
 * enforces are the production ones:
 *
 *  - **Conversation-scoped state.** There is no shared mutable `history` field
 *    anywhere in the service. The PDF's `ArrayList` example is a teaching aid;
 *    a shared list leaks one user's transcript into another's prompt (§8.4).
 *  - **Per-conversation serialisation.** Two tabs streaming into one conversation
 *    would interleave writes and permanently corrupt the transcript, so every
 *    turn runs inside `runExclusive`.
 *  - **Idempotent writes.** The assistant `messageId` is generated BEFORE the
 *    stream starts, so a retry upserts the same row instead of duplicating a turn.
 *  - **Partial turns are first-class.** Interrupted answers are stored with
 *    `status: 'interrupted'` and their finish reason (§8.5).
 */

export interface AssistantMessageInput {
  conversationId: string;
  messageId: string;
  content: string;
  status: MessageStatus;
  finishReason: FinishReason | null;
  usage: TokenUsage | null;
  firstTokenAt: number | null;
  completedAt: number | null;
}

export interface StoreStats {
  conversations: number;
  messages: number;
  lockedConversations: number;
  interruptedMessages: number;
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false; waitedMs: number };

export class ConversationStore {
  private conversations = new Map<string, Conversation>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ttlMs: number = env.CONVERSATION_TTL_MS) {
    // Lazy TTL sweep: long-running servers must not accumulate dead transcripts.
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(this.ttlMs, 60_000));
    this.sweepTimer.unref?.();
  }

  // --------------------------------------------------------------------------
  // Read paths
  // --------------------------------------------------------------------------

  public getOrCreate(conversationId: string, userId: string): Conversation {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;

    const conversation: Conversation = {
      id: conversationId,
      userId,
      title: 'New conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  public get(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  public list(): Conversation[] {
    return [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public isLocked(conversationId: string): boolean {
    return this.locks.has(conversationId);
  }

  // --------------------------------------------------------------------------
  // Write paths
  // --------------------------------------------------------------------------

  /** Record the user's turn — this is the ONLY message written on the hot path. */
  public appendUserMessage(conversationId: string, userId: string, content: string): ConversationMessage {
    const conversation = this.getOrCreate(conversationId, userId);
    const message: ConversationMessage = {
      id: `msg_${randomUUID()}`,
      conversationId,
      ordinal: conversation.messages.length,
      role: 'user',
      content,
      status: 'completed',
      finishReason: null,
      usage: null,
      createdAt: Date.now(),
      firstTokenAt: null,
      completedAt: Date.now(),
    };

    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;
    if (conversation.messages.length === 1) conversation.title = content.slice(0, 60);
    return message;
  }

  /**
   * Upsert ONE assistant message (dual-write step 2).
   *
   * Writing the reconstructed message here — never the fragments — is what keeps
   * prompt size linear instead of quadratic (§8.1) and stops the model from
   * imitating broken, fragmentary turns.
   */
  public upsertAssistantMessage(input: AssistantMessageInput): ConversationMessage {
    const conversation = this.getOrCreate(input.conversationId, 'unknown');
    const existingIndex = conversation.messages.findIndex((message) => message.id === input.messageId);

    const record: ConversationMessage = {
      id: input.messageId,
      conversationId: input.conversationId,
      // Preserve the original position on an upsert: ordering is part of history.
      ordinal: existingIndex >= 0 ? (conversation.messages[existingIndex] as ConversationMessage).ordinal : conversation.messages.length,
      role: 'assistant',
      content: input.content,
      status: input.status,
      finishReason: input.finishReason,
      usage: input.usage,
      createdAt:
        existingIndex >= 0
          ? (conversation.messages[existingIndex] as ConversationMessage).createdAt
          : (input.firstTokenAt ?? Date.now()),
      firstTokenAt: input.firstTokenAt,
      completedAt: input.completedAt,
    };

    if (existingIndex >= 0) conversation.messages[existingIndex] = record;
    else conversation.messages.push(record);

    conversation.updatedAt = Date.now();
    return record;
  }

  /** GDPR right-to-be-forgotten: drop the transcript completely. */
  public delete(conversationId: string): boolean {
    const removed = this.conversations.delete(conversationId);
    this.locks.delete(conversationId);
    return removed;
  }

  // --------------------------------------------------------------------------
  // Concurrency control (per conversation)
  // --------------------------------------------------------------------------

  /**
   * Run `task` with exclusive access to one conversation.
   *
   * `waitMs = 0` means "fail fast" — the caller answers `conversation_busy`
   * instead of queueing, which is what a chat UI wants (the user can retry or
   * open another conversation).
   *
   * The lock is released in a `finally` block, so a cancelled or crashed stream
   * can never leave a conversation permanently locked (§8.8 pitfall #10).
   */
  public async runExclusive<T>(
    conversationId: string,
    task: () => Promise<T>,
    waitMs = 0
  ): Promise<LockResult<T>> {
    const startedAt = Date.now();
    const previous = this.locks.get(conversationId) ?? Promise.resolve();

    if (this.locks.has(conversationId) && waitMs === 0) {
      return { acquired: false, waitedMs: 0 };
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.locks.set(conversationId, chained);

    if (this.locks.size > 1 && waitMs > 0) {
      const waited = await Promise.race([
        previous.then(() => 'free' as const).catch(() => 'free' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), waitMs)),
      ]);
      if (waited === 'timeout') {
        release();
        if (this.locks.get(conversationId) === chained) this.locks.delete(conversationId);
        return { acquired: false, waitedMs: Date.now() - startedAt };
      }
    }

    try {
      return { acquired: true, value: await task() };
    } finally {
      release();
      if (this.locks.get(conversationId) === chained) this.locks.delete(conversationId);
    }
  }

  // --------------------------------------------------------------------------
  // Housekeeping
  // --------------------------------------------------------------------------

  public stats(): StoreStats {
    let messages = 0;
    let interruptedMessages = 0;

    for (const conversation of this.conversations.values()) {
      messages += conversation.messages.length;
      interruptedMessages += conversation.messages.filter((message) => message.status === 'interrupted').length;
    }

    return {
      conversations: this.conversations.size,
      messages,
      lockedConversations: this.locks.size,
      interruptedMessages,
    };
  }

  /** Drop conversations untouched for longer than the TTL. */
  public sweep(now = Date.now()): number {
    let removed = 0;
    for (const [id, conversation] of this.conversations) {
      if (now - conversation.updatedAt > this.ttlMs) {
        this.conversations.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) logger.debug('Conversation TTL sweep removed idle transcripts.', { removed });
    return removed;
  }

  public destroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.conversations.clear();
    this.locks.clear();
  }

  public reset(): void {
    this.conversations.clear();
    this.locks.clear();
  }
}

/** Process-wide singleton (state is keyed by conversationId, never shared). */
export const conversationStore = new ConversationStore();
```


---

## 3. Block-by-Block Explanation

### Part A: Records, idempotency and TTL

#### Block 1: Constructor and the TTL sweep

```typescript
constructor(private readonly ttlMs: number = env.CONVERSATION_TTL_MS) {
  this.sweepTimer = setInterval(() => this.sweep(), Math.max(this.ttlMs, 60_000));
  this.sweepTimer.unref?.();
}
```

- **What it does:** schedules lazy eviction of idle transcripts.
- **How it works:** the interval is clamped to at least 60 s (sweeping more often than that is pointless) and `unref()` prevents the timer from keeping the process alive during tests. `sweep()` deletes conversations untouched for longer than the TTL — the same retention thinking §8.7 asks for.

#### Block 2: Create-on-read

```typescript
public getOrCreate(conversationId: string, userId: string): Conversation {
  const existing = this.conversations.get(conversationId);
  if (existing) return existing;
  const conversation: Conversation = { id: conversationId, userId, title: 'New conversation',
    createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  this.conversations.set(conversationId, conversation);
  return conversation;
}
```

- **What it does:** makes a conversation exist on first use, without a separate "create conversation" API call.
- **How it works:** the id is supplied by the caller (or generated by the route), so a client can start streaming immediately. Everything is keyed by `conversationId` — there is no global message list anywhere, which is the structural fix for the PDF's teaching-only `ArrayList` example.

#### Block 3: The user turn

```typescript
public appendUserMessage(conversationId: string, userId: string, content: string): ConversationMessage {
  const conversation = this.getOrCreate(conversationId, userId);
  const message: ConversationMessage = { id: `msg_${randomUUID()}`, conversationId,
    ordinal: conversation.messages.length, role: 'user', content, status: 'completed',
    finishReason: null, usage: null, createdAt: Date.now(), firstTokenAt: null, completedAt: Date.now() };
  conversation.messages.push(message);
  conversation.updatedAt = message.createdAt;
  if (conversation.messages.length === 1) conversation.title = content.slice(0, 60);
  return message;
}
```

- **What it does:** is the *only* write on the hot path.
- **How it works:** the user message is complete the moment it arrives, so there is nothing to buffer — the dual-write problem exists only for the streamed answer. The first message also seeds the conversation title, which is what the transcript list shows.

#### Block 4: The idempotent assistant upsert

```typescript
public upsertAssistantMessage(input: AssistantMessageInput): ConversationMessage {
  const conversation = this.getOrCreate(input.conversationId, 'unknown');
  const existingIndex = conversation.messages.findIndex((message) => message.id === input.messageId);
  const record: ConversationMessage = {
    id: input.messageId,
    ordinal: existingIndex >= 0 ? conversation.messages[existingIndex]!.ordinal : conversation.messages.length,
    role: 'assistant', content: input.content, status: input.status,
    finishReason: input.finishReason, usage: input.usage,
    createdAt: existingIndex >= 0 ? conversation.messages[existingIndex]!.createdAt : (input.firstTokenAt ?? Date.now()),
    firstTokenAt: input.firstTokenAt, completedAt: input.completedAt,
  };
  if (existingIndex >= 0) conversation.messages[existingIndex] = record;
  else conversation.messages.push(record);
  conversation.updatedAt = Date.now();
  return record;
}
```

- **What it does:** writes the reconstructed answer exactly once, and is safe to call twice.
- **How it works:** because `messageId` is generated *before* streaming starts, a retry or a duplicate completion overwrites the same record instead of appending a second turn (§8.7 "stable messageId"). `ordinal` and `createdAt` are **preserved** on update — ordering is part of history, and a rewritten turn must not jump to the end of the transcript. This one method is what guarantees "chunks never become messages".

---

### Part B: The per-conversation lock

#### Block 5: Fail-fast exclusive access

```typescript
public async runExclusive<T>(conversationId: string, task: () => Promise<T>, waitMs = 0): Promise<LockResult<T>> {
  const previous = this.locks.get(conversationId) ?? Promise.resolve();
  if (this.locks.has(conversationId) && waitMs === 0) return { acquired: false, waitedMs: 0 };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => gate);
  this.locks.set(conversationId, chained);

  if (this.locks.size > 1 && waitMs > 0) { /* race previous-completion against a timer */ }

  try {
    return { acquired: true, value: await task() };
  } finally {
    release();
    if (this.locks.get(conversationId) === chained) this.locks.delete(conversationId);
  }
}
```

- **What it does:** serialises turns within one conversation, and reports failure instead of silently queueing.
- **How it works:** the mutex is a promise chain: `previous.then(() => gate)` means the next acquisition cannot resolve until the current one calls `release()`. `waitMs = 0` makes it **fail fast**, which is what a chat UI wants — the route turns it into `409 conversation_busy` (two tabs streaming into one transcript would interleave writes and permanently corrupt the history). The `finally` block is the reason a cancelled or crashed stream cannot leave a conversation permanently locked (§8.8 pitfall #10), and the identity check (`=== chained`) prevents deleting a newer holder's lock.

---

### ✅ Chapter 09 verification

```bash
npm run test:cancel        # asserts exactly ONE assistant message, lock released, follow-up works
curl -s localhost:8090/api/conversations/conv_cancel_test | python3 -m json.tool
```


---

**Previous:**  · **Next:** 
