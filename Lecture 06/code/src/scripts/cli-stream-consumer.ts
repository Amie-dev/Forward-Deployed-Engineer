/**
 * CLI STREAMING CONSUMER (§9 — the browser mechanics, in Node).
 *
 * This script is the reference *consumer*: it uses the same three primitives the
 * browser uses — `fetch()`, `response.body.getReader()` and
 * `TextDecoder({ stream: true })` — so the exact discipline that keeps the UI
 * smooth can be inspected from a terminal.
 *
 * It prints the answer as it arrives, then a timing summary:
 *   TTFT · ITL mean/max · chunks · network reads · bytes · chars · chars/sec
 *
 * Usage
 * -----
 *   npm run stream:cli
 *   npm run stream:cli -- --transport=sse --granularity=token
 *   npm run stream:cli -- --transport=text --prompt="Explain TPOT"
 *   npm run stream:cli -- --url=http://localhost:8090 --transport=ndjson
 *
 * Without `--url` the app is booted in-process on an ephemeral port, so the demo
 * needs no terminal juggling and no API key.
 */

import { createParser } from 'eventsource-parser';
import { LineSplitter } from '../lib/text-codec.js';
import type { StreamFrame, StreamTransport } from '../types/stream.types.js';

interface CliOptions {
  transport: StreamTransport;
  granularity: string;
  prompt: string;
  url?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    transport: 'ndjson',
    granularity: 'sentence',
    prompt: 'Explain AI streaming from LLM tokens to the live UI, in detail.',
    quiet: false,
  };

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'transport' && value) options.transport = value as StreamTransport;
    else if (key === 'granularity' && value) options.granularity = value;
    else if (key === 'prompt' && value) options.prompt = value;
    else if (key === 'url' && value) options.url = value;
    else if (key === 'quiet') options.quiet = true;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let baseUrl = options.url;
  let close: (() => Promise<void>) | undefined;

  if (!baseUrl) {
    // Quiet the in-process server so its structured telemetry does not interleave
    // with the streamed answer in the terminal. Override with LOG_LEVEL=info.
    process.env.LOG_LEVEL ??= 'warn';
    const { startTestServer } = await import('./harness.js');
    const server = await startTestServer();
    baseUrl = server.baseUrl;
    close = server.close;
    process.stdout.write(`\u001b[2mIn-process server on ${baseUrl}\u001b[0m\n`);
  }

  const startedAt = performance.now();
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const response = await fetch(`${baseUrl}/api/chat/stream?transport=${options.transport}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: options.prompt,
      transport: options.transport,
      granularity: options.granularity,
    }),
    signal: controller.signal,
  });

  process.stdout.write(
    `\u001b[2mHTTP ${response.status} ${response.headers.get('content-type')} — headers at ` +
      `${Math.round(performance.now() - startedAt)} ms (fetch() resolves HERE)\u001b[0m\n\n`
  );

  if (!response.ok || !response.body) {
    console.error('Request failed:', response.status, await response.text());
    await close?.();
    process.exit(1);
  }

  let text = '';
  let chunks = 0;
  let reads = 0;
  let bytes = 0;
  let heartbeats = 0;
  let ttftMs = 0;
  let lastChunkAt = 0;
  const itl: number[] = [];
  const frames: StreamFrame[] = [];

  const onFrame = (frame: StreamFrame): void => {
    frames.push(frame);
    switch (frame.type) {
      case 'delta': {
        const at = performance.now();
        if (ttftMs === 0) ttftMs = Math.round(at - startedAt);
        if (lastChunkAt > 0) itl.push(at - lastChunkAt);
        lastChunkAt = at;
        chunks += 1;
        text += frame.text;
        if (!options.quiet) process.stdout.write(frame.text);
        break;
      }
      case 'heartbeat':
        heartbeats += 1;
        break;
      case 'error':
        process.stdout.write(`\n\u001b[31m✘ in-band error: ${frame.code} — ${frame.message}\u001b[0m\n`);
        break;
      default:
        break;
    }
  };

  const splitter = new LineSplitter('\n');
  const sseParser = createParser({
    onEvent: (event) => {
      if (!event.data) return;
      try {
        onFrame(JSON.parse(event.data) as StreamFrame);
      } catch {
        /* skip malformed frame */
      }
    },
    onComment: () => {
      heartbeats += 1;
    },
  });

  const feed = (piece: string): void => {
    if (!piece) return;

    if (options.transport === 'text') {
      if (ttftMs === 0) ttftMs = Math.round(performance.now() - startedAt);
      text += piece;
      chunks += 1;
      if (!options.quiet) process.stdout.write(piece);
      return;
    }
    if (options.transport === 'sse') {
      sseParser.feed(piece);
      return;
    }
    for (const line of splitter.push(piece)) {
      try {
        onFrame(JSON.parse(line) as StreamFrame);
      } catch {
        /* skip malformed frame */
      }
    }
  };

  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      reads += 1;
      bytes += value.byteLength;
      // The single most important line in any streaming client:
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode()); // flush the decoder
  } catch (error) {
    if ((error as Error).name !== 'AbortError') throw error;
  } finally {
    reader.releaseLock?.();
  }

  const totalMs = Math.round(performance.now() - startedAt);
  const generationMs = lastChunkAt > 0 ? lastChunkAt - (startedAt + ttftMs) : 0;
  const meanItl = itl.length ? (itl.reduce((sum, value) => sum + value, 0) / itl.length).toFixed(1) : '0';
  const doneFrame = frames.find((frame) => frame.type === 'done') as { status?: string } | undefined;

  process.stdout.write('\n\n');
  process.stdout.write('\u001b[36m── stream summary ─────────────────────────────────────────────\u001b[0m\n');
  const summary: Array<[string, string]> = [
    ['transport / granularity', `${options.transport} / ${options.granularity}`],
    ['TTFT (client)', `${ttftMs} ms`],
    ['total', `${totalMs} ms`],
    ['ITL mean / max', `${meanItl} ms / ${itl.length ? Math.max(...itl).toFixed(0) : 0} ms`],
    ['chunks', String(chunks)],
    ['network reads', String(reads)],
    ['bytes / chars', `${bytes} / ${text.length}`],
    ['chars per chunk', chunks ? (text.length / chunks).toFixed(1) : '0'],
    ['chars per second', generationMs > 0 ? (text.length / (generationMs / 1000)).toFixed(0) : '0'],
    ['heartbeats', String(heartbeats)],
    ['terminal status', doneFrame?.status ?? 'no done frame'],
  ];

  for (const [label, value] of summary) process.stdout.write(`  ${label.padEnd(24)} ${value}\n`);

  await close?.();

  if (chunks <= 1) {
    process.stdout.write('\n\u001b[31m⚠ Only one chunk arrived — something is buffering.\u001b[0m\n');
    process.exit(1);
  }
  process.stdout.write('\n\u001b[32m✔ The response arrived progressively.\u001b[0m\n');
}

main().catch((error) => {
  console.error('CLI consumer failed:', error);
  process.exit(1);
});
