/**
 * PIPELINE INVARIANT TEST SUITE (§6.3 + §10.5 levels 3 and 5).
 *
 * This is the CI gate for streaming. It asserts the things that silently break in
 * production:
 *
 *   1. Every transport actually STREAMS (chunk count > 2, TTFT ≪ total).
 *      ⇔ detects "the collector service" anti-pattern.
 *   2. The buffered endpoint is measurably different (TTFT ≈ total), so the suite
 *      can distinguish the two modes instead of passing everything.
 *   3. Output is fragmentation-invariant: different byte slicing ⇒ same text.
 *   4. A mid-stream provider failure arrives IN-BAND and preserves partial text.
 *   5. The idle watchdog fires on a stalled provider (`upstream_stall`).
 *   6. The TTFT budget is enforced (`provider_timeout`).
 *   7. Heartbeats keep the connection alive — and never corrupt raw text.
 *   8. A second concurrent turn in the same conversation is refused with 409.
 *   9. Streaming metrics are actually recorded on the server.
 *  10. No state leaks: the in-flight registry drains fully.
 *
 * Environment overrides are applied BEFORE the app is imported, because
 * `config/env.ts` reads `process.env` at module load — hence the dynamic imports.
 *
 * Run: npm run test:invariants
 */

process.env.STREAM_IDLE_TIMEOUT_MS = '1200';
process.env.STREAM_TTFT_BUDGET_MS = '1200';
process.env.STREAM_HEARTBEAT_MS = '400';
process.env.STREAM_FLUSH_MS = '25';
process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

async function main(): Promise<void> {
  const { assert, consumeStream, exitWithSummary, paint, section, startTestServer, table } = await import(
    './harness.js'
  );
  const { metrics } = await import('../lib/metrics.js');
  const { streamRegistry } = await import('../services/stream-registry.js');

  const server = await startTestServer();
  console.log(paint.dim(`In-process test server: ${server.baseUrl}`));

  try {
    // ======================================================================
    section('1. Every streaming transport must actually stream');
    // ======================================================================
    const canonical = await consumeStream(server.baseUrl, { transport: 'ndjson' });
    const rows: Array<Record<string, string | number>> = [];

    for (const transport of ['text', 'ndjson', 'sse'] as const) {
      const result = await consumeStream(server.baseUrl, {
        transport,
        // `token` granularity keeps the generation phase long, so TTFT and total
        // time are clearly separable — the honest version of the CI assertion.
        granularity: 'token',
        conversationId: `conv_${transport}`,
      });
      const bufferingRatio = result.clientTtftMs === null ? 0 : result.clientTtftMs / Math.max(1, result.totalMs);

      rows.push({
        transport,
        contentType: result.contentType ?? 'n/a',
        chunks: result.chunkCount,
        ttftMs: result.clientTtftMs ?? -1,
        totalMs: result.totalMs,
        'ttft/total': bufferingRatio.toFixed(2),
        chars: result.text.length,
      });

      assert(result.chunkCount > 2, `[${transport}] arrived as multiple chunks`, `chunks=${result.chunkCount}`);
      assert(
        bufferingRatio < 0.5,
        `[${transport}] TTFT is far below total time`,
        `ttft=${result.clientTtftMs}ms total=${result.totalMs}ms`
      );
      assert(result.status === 200, `[${transport}] answered 200 OK`);
      assert(
        (result.contentType ?? '').includes(
          transport === 'sse' ? 'text/event-stream' : transport === 'ndjson' ? 'ndjson' : 'text/plain'
        ),
        `[${transport}] correct Content-Type`,
        result.contentType ?? ''
      );
      assert(
        transport === 'text' ? result.doneFrame === null : result.doneFrame?.status === 'completed',
        transport === 'text'
          ? '[text] raw text/plain has NO terminal frame — connection close is the only terminator (§5.5)'
          : `[${transport}] terminal frame says completed`
      );
    }
    table(rows);

    // ======================================================================
    section('2. The buffered endpoint is distinguishable (negative control)');
    // ======================================================================
    const bufferedStartedAt = performance.now();
    const bufferedResponse = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Explain streaming.', granularity: 'token' }),
    });
    const buffered = (await bufferedResponse.json()) as {
      timings: { ttftMs: number; totalMs: number; chunks: number };
      reply: string;
      history: { estimatedPromptTokens: number };
    };
    // What the user experienced: nothing was readable until the whole body existed.
    const clientWaitedMs = Math.round(performance.now() - bufferedStartedAt);

    assert(buffered.timings.chunks > 2, 'Buffered mode reported internal chunks', `${buffered.timings.chunks}`);
    assert(
      buffered.timings.ttftMs < buffered.timings.totalMs * 0.7,
      'Internally the model still streamed (server TTFT ≪ server total)',
      `ttft=${buffered.timings.ttftMs}ms total=${buffered.timings.totalMs}ms`
    );
    assert(
      clientWaitedMs >= buffered.timings.totalMs * 0.8,
      'But the CLIENT waited for the entire body — buffered delivery',
      `client waited ${clientWaitedMs}ms for the first (and only) piece`
    );

    // ======================================================================
    section('3. Fragmentation invariance: output must not depend on byte slicing');
    // ======================================================================
    for (const transport of ['ndjson', 'sse'] as const) {
      for (const fragmentSize of [1, 3, 17, 1_024]) {
        const result = await consumeStream(server.baseUrl, {
          transport,
          fragmentSize,
          conversationId: `conv_frag_${transport}_${fragmentSize}`,
        });
        assert(
          result.text === canonical.text,
          `[${transport}] ${fragmentSize}-byte slices reassemble the identical answer`,
          `${result.text.length} chars`
        );
      }
    }

    // ======================================================================
    section('4. Mid-stream provider failure must be signalled IN-BAND');
    // ======================================================================
    const failing = await consumeStream(server.baseUrl, {
      transport: 'sse',
      chaos: { failAfterDeltas: 3, failCode: 'provider_error' },
      conversationId: 'conv_inband_error',
    });

    assert(failing.status === 200, 'Status is still 200 — the stream had already started');
    assert(
      failing.errorFrame?.code === 'provider_error',
      'An `error` frame was delivered inside the stream',
      failing.errorFrame?.code ?? 'none'
    );
    assert(failing.errorFrame?.partial === true, 'The error frame flags that partial text exists');
    assert(failing.text.length > 0, 'Partial answer preserved', `${failing.text.length} chars delivered`);
    assert(failing.doneFrame?.status === 'interrupted', 'The `done` frame marks the turn interrupted');
    assert(
      failing.frames.some((frame) => frame.type === 'delta'),
      'Deltas arrived before the failure (it really was mid-stream)'
    );

    // ======================================================================
    section('5. Idle watchdog: a silent provider must not hang a connection');
    // ======================================================================
    const stalled = await consumeStream(server.baseUrl, {
      transport: 'ndjson',
      chaos: { stallAfterDeltas: 2, stallMs: 5_000 },
      conversationId: 'conv_stall',
    });

    assert(
      stalled.errorFrame?.code === 'upstream_stall',
      'The idle watchdog closed the stream with `upstream_stall`',
      `after ${stalled.totalMs} ms (idle budget 1200 ms)`
    );
    assert(stalled.totalMs < 4_000, 'The watchdog fired promptly instead of waiting for the provider');
    assert(stalled.heartbeats >= 1, 'Heartbeats were emitted during the silence', `${stalled.heartbeats} heartbeats`);

    // ======================================================================
    section('6. TTFT budget: a provider that never starts must fail fast');
    // ======================================================================
    const ttftBreach = await consumeStream(server.baseUrl, {
      transport: 'sse',
      chaos: { exceedTtftBudget: true },
      conversationId: 'conv_ttft',
    });

    assert(
      ttftBreach.errorFrame?.code === 'provider_timeout',
      'The TTFT budget produced a `provider_timeout` error frame',
      `after ${ttftBreach.totalMs} ms`
    );
    assert(ttftBreach.errorFrame?.recoverable === true, 'The error is marked recoverable (safe to retry)');

    // ======================================================================
    section('7. Heartbeats never corrupt a raw text/plain body');
    // ======================================================================
    const rawWithStall = await consumeStream(server.baseUrl, {
      transport: 'text',
      chaos: { stallAfterDeltas: 2, stallMs: 2_500 },
      conversationId: 'conv_text_heartbeat',
    });
    assert(
      rawWithStall.heartbeats === 0,
      'No heartbeat bytes were injected into the raw text body',
      `${rawWithStall.heartbeats} heartbeat comments`
    );
    assert(!rawWithStall.text.includes('keep-alive'), 'The delivered text contains no heartbeat artefacts');

    // ======================================================================
    section('8. Per-conversation concurrency is enforced');
    // ======================================================================
    const sharedConversation = 'conv_concurrency';
    const first = consumeStream(server.baseUrl, {
      transport: 'ndjson',
      granularity: 'token',
      conversationId: sharedConversation,
      prompt: 'A long answer please.',
    });
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the first turn start

    const secondResponse = await fetch(`${server.baseUrl}/api/chat/stream?transport=ndjson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Second parallel turn.', conversationId: sharedConversation }),
    });
    assert(secondResponse.status === 409, 'The concurrent turn was refused with 409 Conflict');
    const secondBody = (await secondResponse.json()) as { error: { code: string } };
    assert(secondBody.error.code === 'conversation_busy', 'The refusal names the reason', secondBody.error.code);

    const firstResult = await first;
    assert(firstResult.doneFrame?.status === 'completed', 'The original turn still completed normally');

    // ======================================================================
    section('9. Streaming telemetry is recorded server-side');
    // ======================================================================
    const metricsResponse = await fetch(`${server.baseUrl}/metrics`);
    const metricsText = await metricsResponse.text();

    assert(metricsText.includes('server_ttft_ms'), 'server_ttft_ms histogram is exposed');
    assert(metricsText.includes('stream_chunks_forwarded'), 'stream_chunks_forwarded histogram is exposed');
    assert(metricsText.includes('stream_requests_total'), 'stream_requests_total counter is exposed');
    assert(metricsText.includes('stream_bytes_total'), 'stream_bytes_total counter is exposed');
    assert(
      metricsText.includes('stream_inband_errors_total'),
      'in-band error counter is exposed (mid-stream failures are visible in telemetry)'
    );

    const abortLine = metricsText.split('\n').find((line) => line.startsWith('stream_aborts_total'));
    assert(
      abortLine === undefined || abortLine.trim().endsWith(' 0'),
      'No aborts were counted by THIS suite (abort coverage lives in `npm run test:cancel`)',
      abortLine ?? 'counter appears once the first abort happens'
    );

    const serverTtft = metrics.histogramSummary('server_ttft_ms');
    assert(
      serverTtft.count > 0,
      'Server TTFT samples were recorded',
      `count=${serverTtft.count} p50=${serverTtft.p50}ms p95=${serverTtft.p95}ms`
    );

    // ======================================================================
    section('10. No leaked state: the registry drains after every stream');
    // ======================================================================
    const inflightResponse = await fetch(`${server.baseUrl}/api/chat/streams`);
    const inflight = (await inflightResponse.json()) as { inflight: number };
    assert(inflight.inflight === 0, 'No streams remain registered', `inflight=${inflight.inflight}`);
    assert(streamRegistry.inflight() === 0, 'Registry gauge drained (locks released in `finally`)');

    exitWithSummary('test-pipeline-invariants');
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
