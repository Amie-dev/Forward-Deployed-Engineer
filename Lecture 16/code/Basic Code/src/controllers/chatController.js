// Lecture 16 · Chapter 07.5 — the HTTP layer.
//
// It validates, it delegates, it renders. It contains NO image logic and NO model
// logic, because the application's job is to get the right bytes to the provider and
// to handle the answer responsibly — not to understand the picture.
import { config } from '../config/config.js';

// Chapter 08 — a cheap liveness probe that also reports the limits actually in force.
export function health(request, response) {
  response.json({
    ok: true,
    model: config.model,
    patchSize: config.patchSize,
    maxImageTokens: config.maxImageTokens,
    modelConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
}

// Chapter 07.5 — the board's contract: Client --/chat--> LLM, "Text / Image -> Text".
export function chat(chatService) {
  return async (request, response, next) => {
    const message = request.body?.message;
    if (typeof message !== 'string' || message.trim() === '') {
      return response.status(400).type('text').send('The message field is required.');
    }
    try {
      // `request.file` is undefined for a text-only turn, which is exactly the
      // "Text / Image" half of the contract: one route, two shapes.
      response.type('text').send(await chatService.chat(message, request.file));
    } catch (error) {
      next(error);
    }
  };
}

// Chapter 07.6 — drop the conversation, and every image in it.
export function clear(chatService) {
  return async (request, response, next) => {
    try {
      await chatService.clearHistory();
      response.status(200).end();
    } catch (error) {
      next(error);
    }
  };
}
