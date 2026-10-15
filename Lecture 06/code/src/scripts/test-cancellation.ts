/**
 * CANCELLATION PROPAGATION & PARTIAL PERSISTENCE (§6.6 + §8.5).
 *
 * Pressing Stop is a *first-class* streaming feature, and it is where most
 * systems quietly lose money and data. This suite asserts the whole chain:
 *
 *   client abort → socket close → server notices → provider call cancelled
 *     → partial answer persisted ONCE with `status: "interrupted"` + a finish
 *       reason → lock released → the next turn in the same conversation works.
 *
 * Run: npm run test:cancel
 */

process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
process.env.STREAM_FLUSH_MS = '25';

interface TranscriptResponse {
  conversation: {
    locked: boolean;
    messages: Array<{
      role: string;
      content: string;
      status: string;
      finishReason: string | null;
      firstTokenAt: string | null;
      completedAt: string | null;
    }>;
  };
}

interface BudgetResponse {
  metrics: { interruptedTurnsIncluded: number; estimatedPromptTokens: number; includedMessages: number };
  preview: Array<{ role: string; characters: number; head: string }>;
}

async function main(): Promise<void> {
  const { assert, consumeStream, exitWithSummary, paint, section, startTestServer, waitUntil } = await import(
    './harness.js'
  );

  const server = await startTestServer();
  const conversationId = 'conv_cancel_test';
  console.log(paint.dim(`In-process test server: ${server.baseUrl}`));

  try {
    // ======================================================================
    section('1. A full stream, for comparison');
    // ======================================================================
    const full = await consumeStream(server.baseUrl, {
      transport: 'ndjson',
      conversationId: 'conv_full_reference',
      granularity: 'token',
    });
    assert(full.chunkCount > 5, 'Reference run produced a long answer', `${full.text.length} chars`);

    // ======================================================================
    section('2. Abort mid-stream: the client keeps what it already saw');
    // ======================================================================
    const aborted = await consumeStream(server.baseUrl, {
      transport: 'ndjson',
      conversationId,
      granularity: 'token',
      abortAfterChunks: 3,
    });

    assert(aborted.aborted === true, 'The client aborted the request (AbortError handled as an outcome)');
    assert(aborted.chunkCount >= 3, 'Text was received before the abort', `chunks=${aborted.chunkCount}`);
    assert(aborted.text.length > 0, 'Partial text is non-empty and preserved', `${aborted.text.length} chars`);
    assert(
      aborted.text.length < full.text.length,
      'The provider stopped early — no zombie generation behind the abort',
      `${aborted.text.length} < ${full.text.length} chars`
    );

    // ======================================================================
    section('3. Dual-write persistence: ONE message, with an explicit status');
    // ======================================================================
    const checkTranscript = async (): Promise<boolean> => {
      const response = await fetch(`${server.baseUrl}/api/conversations/${conversationId}`);
      if (response.status !== 200) return false;
      const body = (await response.json()) as TranscriptResponse;
      return body.conversation.messages.length >= 2;
    };
    const transcriptReady = await waitUntil(checkTranscript);
    assert(transcriptReady, 'The turn was persisted after the abort');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const transcript = (await (
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}`)
    ).json()) as TranscriptResponse;

    const userMessages = transcript.conversation.messages.filter((message) => message.role === 'user');
    const assistantMessages = transcript.conversation.messages.filter((message) => message.role === 'assistant');

    assert(userMessages.length === 1, 'Exactly ONE user message is stored');
    assert(
      assistantMessages.length === 1,
      'Exactly ONE assistant message is stored — chunks are NOT stored as messages',
      `${assistantMessages.length} of ${aborted.chunkCount} chunks became messages`
    );

    const assistant = assistantMessages[0]!;
    assert(assistant.status === 'interrupted', 'The partial answer is flagged as interrupted', assistant.status);
    assert(
      assistant.finishReason === 'client_abort',
      'The finish reason records WHY it stopped',
      assistant.finishReason ?? 'null'
    );
    assert(
      assistant.content === aborted.text,
      'The stored content is byte-for-byte what the user read',
      `stored=${assistant.content.length} chars, delivered=${aborted.text.length} chars`
    );
    assert(assistant.firstTokenAt !== null, 'The first-token timestamp was captured');
    assert(assistant.completedAt !== null, 'The interrupted turn still recorded a completion timestamp');

    // ======================================================================
    section('4. The interrupted turn is visible to the NEXT prompt');
    // ======================================================================
    const budget = (await (
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}/budget`)
    ).json()) as BudgetResponse;

    assert(budget.metrics.interruptedTurnsIncluded === 1, 'The budget builder counts the interrupted turn');
    assert(
      budget.preview.some((message) => message.head.includes('[Note: this previous answer was interrupted')),
      'The partial answer is annotated so the model does not read it as complete'
    );

    // ======================================================================
    section('5. Telemetry: aborts are counted, not swallowed');
    // ======================================================================
    const metricsText = await (await fetch(`${server.baseUrl}/metrics`)).text();
    const abortLine = metricsText.split('\n').find((line) => line.startsWith('stream_aborts_total'));
    assert(Boolean(abortLine), 'Abort counter exists in the registry', abortLine ?? 'missing');
    assert(
      Boolean(abortLine) && !(abortLine as string).trim().endsWith(' 0'),
      'The abort was counted',
      abortLine ?? 'no sample'
    );

    // ======================================================================
    section('6. Locks released: the conversation is usable again');
    // ======================================================================
    const inflight = (await (await fetch(`${server.baseUrl}/api/chat/streams`)).json()) as { inflight: number };
    assert(inflight.inflight === 0, 'No stream remains in flight', `inflight=${inflight.inflight}`);

    const followUp = await consumeStream(server.baseUrl, {
      transport: 'ndjson',
      conversationId,
      granularity: 'sentence',
      prompt: 'Continue from where you stopped.',
    });
    assert(
      followUp.doneFrame?.status === 'completed',
      'A follow-up turn in the SAME conversation succeeds (no leaked lock)',
      `${followUp.text.length} chars`
    );

    const finalTranscript = (await (
      await fetch(`${server.baseUrl}/api/conversations/${conversationId}`)
    ).json()) as TranscriptResponse;
    assert(
      finalTranscript.conversation.messages.filter((message) => message.role === 'assistant').length === 2,
      'Two assistant turns are stored: one interrupted, one completed',
      `${finalTranscript.conversation.messages.length} messages in total`
    );

    exitWithSummary('test-cancellation');
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
