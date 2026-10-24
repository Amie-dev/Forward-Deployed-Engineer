// Lecture 16 · Chapter 07.5 — the whole HTTP surface. Three routes, one contract.
import { Router } from 'express';
import * as chatController from '../controllers/chatController.js';
import { rejectOversizedRequest, upload } from '../middleware/upload.js';

export function createRouter(chatService) {
  const router = Router();

  // Chapter 08 — what limits are in force right now?
  router.get('/health', chatController.health);

  // The board's contract: Client --/chat--> LLM, "Text / Image -> Text".
  // Order matters: reject an oversized request first, then parse the multipart body,
  // then hand a validated message + image to the controller.
  router.post(
    '/chat',
    rejectOversizedRequest,
    upload.single('image'),
    chatController.chat(chatService),
  );

  // Chapter 07.6 — reset the conversation (and drop the images with it).
  router.delete('/chat', chatController.clear(chatService));

  return router;
}
