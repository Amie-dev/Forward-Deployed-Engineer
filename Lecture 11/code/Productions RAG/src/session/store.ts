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
