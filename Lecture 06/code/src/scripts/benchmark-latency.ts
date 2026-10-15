/**
 * LATENCY BENCHMARK (§3 — TTFT, ITL, TPS and perceived performance).
 *
 * Answers the engineering questions with numbers instead of adjectives:
 *
 *   - How does the transport (raw text vs NDJSON vs SSE) affect TTFT?
 *   - How does coalescing granularity trade chunk count against per-chunk delay?
 *   - How much perceived latency does streaming actually remove?
 *
 * Run: npm run bench:latency
 */

process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

const RUNS = Number.parseInt(process.env.BENCH_RUNS ?? '3', 10);

async function main(): Promise<void> {
  const { consumeStream, mean, paint, percentile, section, startTestServer, table } = await import('./harness.js');

  const server = await startTestServer();
  console.log(paint.dim(`In-process server: ${server.baseUrl} · ${RUNS} runs per configuration`));

  try {
    // ======================================================================
    section('1. Transport × granularity matrix (streaming)');
    // ======================================================================
    const matrixRows: Array<Record<string, string | number>> = [];

    for (const transport of ['text', 'ndjson', 'sse'] as const) {
      for (const granularity of ['token', 'word', 'sentence', 'random']) {
        const ttfts: number[] = [];
        const totals: number[] = [];
        const chunkCounts: number[] = [];
        const itlMeans: number[] = [];
        const tpsValues: number[] = [];

        for (let run = 0; run < RUNS; run += 1) {
          const result = await consumeStream(server.baseUrl, {
            transport,
            granularity,
            conversationId: `bench_${transport}_${granularity}_${run}`,
          });

          ttfts.push(result.clientTtftMs ?? 0);
          totals.push(result.totalMs);
          chunkCounts.push(result.chunkCount);
          itlMeans.push(mean(result.itl));

          const generationMs = (result.clientTtftMs ?? 0) > 0 ? result.totalMs - (result.clientTtftMs ?? 0) : 0;
          tpsValues.push(generationMs > 0 ? Math.round((result.text.length / generationMs) * 1_000) : 0);
        }

        matrixRows.push({
          transport,
          granularity,
          'ttft p50': `${percentile(ttfts, 50)} ms`,
          'ttft p95': `${percentile(ttfts, 95)} ms`,
          'total p50': `${percentile(totals, 50)} ms`,
          'chunks p50': percentile(chunkCounts, 50),
          'itl p50': `${percentile(itlMeans, 50)} ms`,
          'chars/s p50': percentile(tpsValues, 50),
        });
      }
    }

    table(matrixRows);

    // ======================================================================
    section('2. Buffered vs streaming: the perceived-latency difference');
    // ======================================================================
    const bufferedTotals: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const startedAt = performance.now();
      const response = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Explain streaming.', granularity: 'sentence' }),
      });
      await response.json();
      bufferedTotals.push(Math.round(performance.now() - startedAt));
    }

    const streaming = await consumeStream(server.baseUrl, {
      transport: 'ndjson',
      granularity: 'sentence',
      conversationId: 'bench_stream_reference',
    });

    const bufferedP50 = percentile(bufferedTotals, 50);
    const bufferedP95 = percentile(bufferedTotals, 95);

    table([
      {
        mode: 'buffered (POST /api/chat)',
        'first visible text': `${bufferedP50} ms (p50)`,
        'p95': `${bufferedP95} ms`,
        'user waits for': 'the ENTIRE answer',
      },
      {
        mode: 'streaming (POST /api/chat/stream)',
        'first visible text': `${streaming.clientTtftMs} ms`,
        'p95': 'n/a (single run)',
        'user waits for': 'the FIRST token',
      },
    ]);

    console.log(
      `\n${paint.bold('Reading-speed check (perceived performance):')} ${paint.cyan(
        `${percentile([Math.round((streaming.text.length / Math.max(1, streaming.totalMs - (streaming.clientTtftMs ?? 0))) * 1_000)], 50)} chars/s`
      )}`
    );
    console.log(
      paint.dim(
        'Below roughly 15–20 tokens (~60–80 chars) per second the reader out-runs the model and perceived streaming collapses.'
      )
    );
    console.log(
      paint.dim(
        'Note that the TOTAL time is nearly identical for both modes: streaming changes what the user FEELS, not how fast the model finishes.'
      )
    );
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
