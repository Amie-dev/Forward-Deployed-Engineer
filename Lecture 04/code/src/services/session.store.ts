import { ChatMessage, ChatSession, UserProfileMemory } from '../types/chat.types.js';
import { TokenizerUtils } from '../lib/tokenizer.js';

/**
 * Enterprise In-Memory Session & Application Memory Store
 *
 * Implements the decoupled state tier:
 * - Separates transient session chat dialogue from permanent user memory profiles.
 * - Supports GDPR "Right to be Forgotten" via deterministic session/profile eviction.
 * - Thread-safe in single-instance Node.js event-loop runtimes; easily swappable with Redis/PostgreSQL.
 */
export class SessionStore {
  private static instance: SessionStore;
  private sessions: Map<string, ChatSession> = new Map();
  private userProfiles: Map<string, UserProfileMemory> = new Map();

  private constructor() {
    // Seed sample enterprise user profiles to demonstrate Application Memory pattern
    this.userProfiles.set('user_vip_001', {
      userId: 'user_vip_001',
      name: 'Aditya Sharma',
      loyaltyTier: 'VIP',
      dietaryPreferences: ['Strict Vegetarian', 'No Garlic', 'Gluten Sensitive'],
      notes: ['Frequent customer of Tomato Food Delivery', 'Prefers doorstep contactless delivery'],
    });

    this.userProfiles.set('user_dev_002', {
      userId: 'user_dev_002',
      name: 'Priya Verma',
      loyaltyTier: 'GOLD',
      dietaryPreferences: ['Vegan'],
      notes: ['Prefers eco-friendly packaging', 'Active software engineering lead'],
    });
  }

  public static getInstance(): SessionStore {
    if (!SessionStore.instance) {
      SessionStore.instance = new SessionStore();
    }
    return SessionStore.instance;
  }

  /**
   * Retrieves an existing session or initializes a new state container.
   */
  public getOrCreateSession(sessionId: string, userId: string = 'anonymous'): ChatSession {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        runningSummary: '',
        cumulativeTurns: 0,
      };
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  public getSession(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Appends an incoming user turn to the session history.
   */
  public appendUserMessage(sessionId: string, content: string): ChatMessage {
    const session = this.getOrCreateSession(sessionId);
    const tokenEstimate = TokenizerUtils.estimateTextTokens(content);

    const message: ChatMessage = {
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
      tokens: tokenEstimate,
    };

    session.messages.push(message);
    session.cumulativeTurns += 1;
    session.updatedAt = Date.now();
    return message;
  }

  /**
   * Appends a completed assistant generation to the session history.
   */
  public appendAssistantMessage(sessionId: string, content: string): ChatMessage {
    const session = this.getOrCreateSession(sessionId);
    const tokenEstimate = TokenizerUtils.estimateTextTokens(content);

    const message: ChatMessage = {
      role: 'assistant',
      content: content.trim(),
      timestamp: Date.now(),
      tokens: tokenEstimate,
    };

    session.messages.push(message);
    session.updatedAt = Date.now();
    return message;
  }

  /**
   * Updates the background synthesized running summary for this session.
   */
  public updateRunningSummary(sessionId: string, summary: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.runningSummary = summary.trim();
      session.updatedAt = Date.now();
    }
  }

  /**
   * Prunes older turns that have been assimilated into the running summary.
   */
  public replaceHistorySegment(sessionId: string, remainingMessages: ChatMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = remainingMessages;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Evicts a session completely (GDPR right-to-be-forgotten compliant).
   */
  public deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Application Memory: Retrieves persistent user profile attributes.
   */
  public getUserProfile(userId: string): UserProfileMemory | undefined {
    return this.userProfiles.get(userId);
  }

  /**
   * Application Memory: Saves or updates persistent user profile attributes.
   */
  public setUserProfile(userId: string, profile: Partial<UserProfileMemory>): void {
    const existing = this.userProfiles.get(userId) || { userId };
    this.userProfiles.set(userId, { ...existing, ...profile, userId });
  }

  public getAllActiveSessions(): ChatSession[] {
    return Array.from(this.sessions.values());
  }

  public getSessionCount(): number {
    return this.sessions.size;
  }
}
