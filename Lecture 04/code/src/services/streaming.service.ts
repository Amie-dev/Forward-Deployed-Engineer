import { Request, Response } from 'express';
import { openai, isLiveApiKeyConfigured } from '../lib/openai.js';
import { config } from '../config/env.js';
import { ContextManagerService } from './context-manager.service.js';
import { SessionStore } from './session.store.js';

export class StreamingService {
  private contextManager: ContextManagerService;
  private sessionStore: SessionStore;

  constructor() {
    this.contextManager = new ContextManagerService();
    this.sessionStore = SessionStore.getInstance();
  }

  /**
   * Orchestrates full Server-Sent Events (SSE) streaming lifecycle for chat completions.
   */
  public async handleStreamingChat(
    req: Request,
    res: Response,
    sessionId: string,
    userQuery: string
  ): Promise<void> {
    // 1. Record incoming user turn in the persistent session store
    this.sessionStore.appendUserMessage(sessionId, userQuery);

    // 2. Prepare hydrated, token-optimized context payload
    const { messages: hydratedMessages } = await this.contextManager.prepareHydratedPayload(sessionId);

    // 3. Negotiate mandatory HTTP Server-Sent Events (SSE) headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Critical: Disables reverse proxy (Nginx/Cloudflare) buffering
    });

    // Flush headers immediately so client receives initial 200 OK frame
    res.flushHeaders?.();

    // 4. Bind AbortController to client socket closure to prevent GPU token waste
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        console.log(`[StreamingService] Client disconnected session: ${sessionId}. Aborting generation.`);
        abortController.abort();
      }
    });

    let fullGeneratedText = '';

    try {
      if (isLiveApiKeyConfigured()) {
        // Live production path via OpenAI SDK stream
        const stream = await openai.chat.completions.create(
          {
            model: config.AI_MODEL,
            messages: hydratedMessages as any,
            temperature: config.AI_TEMPERATURE,
            stream: true,
          },
          { signal: abortController.signal }
        );

        for await (const chunk of stream) {
          const deltaContent = chunk.choices[0]?.delta?.content || '';
          const finishReason = chunk.choices[0]?.finish_reason;

          if (deltaContent) {
            fullGeneratedText += deltaContent;

            // Frame token as standard SSE data line
            const payload = JSON.stringify({ token: deltaContent });
            res.write(`data: ${payload}\n\n`);
          }

          if (finishReason) {
            const completionPayload = JSON.stringify({ finishReason });
            res.write(`data: ${completionPayload}\n\n`);
          }
        }
      } else {
        // Local developer mock stream when live key is not supplied
        fullGeneratedText = await this.simulateTokenStream(res, userQuery, sessionId, abortController);
      }

      // 5. Emit termination sentinel
      res.write('data: [DONE]\n\n');
      res.end();

      // 6. Persist completed assistant generation back to session store for future turns
      this.sessionStore.appendAssistantMessage(sessionId, fullGeneratedText);

    } catch (error: any) {
      if (abortController.signal.aborted) {
        return; // Normal cleanup on client abort
      }

      console.error(`[StreamingService] Generation error for session ${sessionId}:`, error);
      const errorPayload = JSON.stringify({
        error: error.message || 'Stream generation failed.',
        code: error.status || 500,
      });
      res.write(`data: ${errorPayload}\n\n`);
      res.end();
    }
  }

  /**
   * Progressive token emission simulator for offline local validation.
   */
  private async simulateTokenStream(
    res: Response,
    query: string,
    sessionId: string,
    abortController: AbortController
  ): Promise<string> {
    const mockReply = `Hello! I am your Tomato Support Executive for session ${sessionId}. Regarding your query ("${query}"), our standard delivery turnaround is 30-45 minutes. How else may I assist you with your order?`;
    const tokens = mockReply.split(' ');

    for (let i = 0; i < tokens.length; i++) {
      if (abortController.signal.aborted) break;

      const token = (i === 0 ? '' : ' ') + tokens[i];
      const payload = JSON.stringify({ token });
      res.write(`data: ${payload}\n\n`);

      // Simulate 35ms inter-token latency (ITL)
      await new Promise((resolve) => setTimeout(resolve, 35));
    }

    return mockReply;
  }
}
