import { Router, type Request, type Response } from 'express';
import { conversationStore } from '../services/conversation.store.js';
import { historyService } from '../services/history.service.js';

/**
 * Conversation router — the *reader* of the dual-written history.
 *
 * These endpoints make the central correctness claim of Chapter 08 inspectable:
 * one user turn + ONE assistant message per generation, with an explicit status
 * (`completed` | `interrupted`) and finish reason, even when the stream died.
 */

export const conversationRouter = Router();

/** GET /api/conversations — recent conversations (id, title, counters). */
conversationRouter.get('/', (_req: Request, res: Response): void => {
  const conversations = conversationStore.list().map((conversation) => ({
    id: conversation.id,
    userId: conversation.userId,
    title: conversation.title,
    messages: conversation.messages.length,
    interrupted: conversation.messages.filter((message) => message.status === 'interrupted').length,
    updatedAt: new Date(conversation.updatedAt).toISOString(),
    locked: conversationStore.isLocked(conversation.id),
  }));

  res.status(200).json({ ok: true, count: conversations.length, conversations });
});

/**
 * GET /api/conversations/:conversationId
 *
 * The transcript, including provenance per message: status, finish reason, token
 * usage and the two streaming timestamps (`createdAt`, `firstTokenAt`).
 */
conversationRouter.get('/:conversationId', (req: Request, res: Response): void => {
  const conversationId = req.params.conversationId as string;
  const conversation = conversationStore.get(conversationId);

  if (!conversation) {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: `Unknown conversation "${conversationId}".` } });
    return;
  }

  res.status(200).json({
    ok: true,
    conversation: {
      id: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      createdAt: new Date(conversation.createdAt).toISOString(),
      updatedAt: new Date(conversation.updatedAt).toISOString(),
      locked: conversationStore.isLocked(conversation.id),
      messages: conversation.messages.map((message) => ({
        id: message.id,
        ordinal: message.ordinal,
        role: message.role,
        content: message.content,
        status: message.status,
        finishReason: message.finishReason,
        usage: message.usage,
        createdAt: new Date(message.createdAt).toISOString(),
        firstTokenAt: message.firstTokenAt === null ? null : new Date(message.firstTokenAt).toISOString(),
        completedAt: message.completedAt === null ? null : new Date(message.completedAt).toISOString(),
      })),
    },
  });
});

/**
 * GET /api/conversations/:conversationId/budget
 *
 * Exactly what the next provider call would send, and why anything was dropped.
 * Prompt length drives TTFT, so this endpoint is a latency tool, not just a cost
 * tool (§3.4 / §8.6).
 */
conversationRouter.get('/:conversationId/budget', (req: Request, res: Response): void => {
  const conversation = conversationStore.get(req.params.conversationId as string);
  const { messages, metrics } = historyService.build(conversation);

  res.status(200).json({
    ok: true,
    metrics,
    messageCount: messages.length,
    // The system prompt is echoed for auditability; history is summarised by size.
    preview: messages.map((message) => ({
      role: message.role,
      characters: message.content.length,
      // Long enough to include the interruption annotation appended to partial
      // answers, so operators can see exactly what the model will be told.
      head: message.content.slice(0, 240),
    })),
  });
});

/** DELETE /api/conversations/:conversationId — right to be forgotten. */
conversationRouter.delete('/:conversationId', (req: Request, res: Response): void => {
  const conversationId = req.params.conversationId as string;
  const removed = conversationStore.delete(conversationId);

  if (!removed) {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: `Unknown conversation "${conversationId}".` } });
    return;
  }
  res.status(200).json({ ok: true, conversationId, purged: true });
});
