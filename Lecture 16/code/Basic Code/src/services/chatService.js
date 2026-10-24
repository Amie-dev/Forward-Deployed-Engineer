// Lecture 16 · Chapter 07 — the end-to-end request: text + image in, text out.
//
// "The application does not itself understand the image. It simply packages the
// request and sends it to a multimodal model." This file is that packaging, plus
// the two things a real app must also do: budget the image (Ch 08) and keep the
// conversation honest across turns (Ch 07.6).
import OpenAI from 'openai';
import { config } from '../config/config.js';
import { readDimensions } from './visionPipeline.js';
import { guardImage } from './costService.js';

// Chapter 07.5 — build the multipart message: text and image as content PARTS.
// Base64 inline (Chapter 07.8) keeps the payload self-contained and sidesteps SSRF,
// because we never ask the provider to fetch a URL that a user supplied.
export function buildUserMessage(message, image) {
  if (!image) return { role: 'user', content: message };
  return {
    role: 'user',
    content: [
      { type: 'text', text: message },
      {
        type: 'image_url',
        image_url: { url: `data:${image.mimetype};base64,${image.buffer.toString('base64')}` },
      },
    ],
    // Chapter 07.6 — remember a text digest so this image can be replaced later.
    imageDigest: message,
  };
}

export class ChatService {
  constructor(client = createClient(), model = config.model) {
    this.client = client; // null when no API key is set -> the app answers offline
    this.model = model;
    this.history = [];
    // Chapter 07.6 — serialize turns so two concurrent requests cannot interleave
    // history and produce a conversation the model never actually had.
    this.queue = Promise.resolve();
  }

  runInOrder(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  // Chapter 08.2 — measure BEFORE spending. The dimensions decide the token cost,
  // and the cost decides whether this image is affordable at all.
  assertAffordable(image) {
    const dimensions = readDimensions(image.buffer);
    const decision = guardImage(dimensions);
    if (decision.action !== 'send') {
      const error = new Error(
        `Image is too expensive: ${decision.reason}. Crop to the region of interest and retry.`,
      );
      error.status = 413;
      throw error;
    }
  }

  // Chapter 07.6 — history is expensive: every turn re-sends every image.
  // Keep the newest N images, replace the rest with their text digest.
  compactHistory(maxImages = config.maxImagesInHistory) {
    const withImages = this.history.filter((turn) => turn.imageDigest);
    const keep = new Set(withImages.slice(-maxImages));
    for (const turn of withImages) {
      if (!keep.has(turn)) {
        turn.content = `[image removed from history to control cost: ${turn.imageDigest}]`;
        delete turn.imageDigest;
      }
    }
  }

  chat(message, image) {
    return this.runInOrder(async () => {
      if (image) this.assertAffordable(image);
      const userMessage = buildUserMessage(message, image);
      const reply = this.client ? await this.askModel(userMessage) : offlineReply(message, image);
      // Chapter 07.5 — only commit a COMPLETE turn, after the call has succeeded.
      // A failed call must not leave a half-turn in the conversation.
      this.history.push(userMessage, { role: 'assistant', content: reply });
      this.compactHistory();
      return reply;
    });
  }

  async askModel(userMessage) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: config.temperature,
      messages: [
        { role: 'system', content: config.systemPrompt },
        // Strip our internal bookkeeping (`imageDigest`) before sending.
        ...this.history.map(({ role, content }) => ({ role, content })),
        { role: userMessage.role, content: userMessage.content },
      ],
    });
    const reply = response.choices[0]?.message?.content;
    if (typeof reply !== 'string') {
      throw new Error('The model returned no text response.');
    }
    return reply;
  }

  clearHistory() {
    return this.runInOrder(() => {
      this.history.length = 0;
    });
  }
}

// Chapter 07.5 — with no key the app still runs. The request shape is identical;
// only the answer changes, which is the clearest proof that the app never had to
// understand the image itself.
function offlineReply(message, image) {
  const attachment = image
    ? `image received (${image.mimetype}, ${image.buffer.length} bytes)`
    : 'no image attached';
  return `[offline] ${attachment}. You asked: "${message}". Set OPENAI_API_KEY in .env for a real answer.`;
}

function createClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
  });
}
