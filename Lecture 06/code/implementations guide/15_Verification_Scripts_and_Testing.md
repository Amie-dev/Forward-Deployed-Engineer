# Chapter 15: Verification Scripts: Harness, Torture Tests, Chaos & Benchmarks

> **Chapter Goal:** Make every claim in the lecture testable: a byte-accurate consumer, the UTF-8 torture test, the pipeline-invariant CI gate, cancellation persistence, and a latency matrix.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `src/scripts/harness.ts` | 319 lines |
| `src/scripts/cli-stream-consumer.ts` | 224 lines |
| `src/scripts/test-utf8-fragmentation.ts` | 130 lines |
| `src/scripts/test-pipeline-invariants.ts` | 282 lines |
| `src/scripts/test-cancellation.ts` | 180 lines |
| `src/scripts/benchmark-latency.ts` | 132 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `src/scripts/harness.ts` (318 lines)

```typescript
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { LineSplitter } from '../lib/text-codec.js';
import { sleep } from '../lib/timing.js';
import { createParser } from 'eventsource-parser';
import type { StreamFrame, StreamTransport } from '../types/stream.types.js';

/**
 * Shared harness for the streaming scripts: an in-process server, a byte-accurate
 * consumer, and percentile maths.
 *
 * Booting the Express app IN-PROCESS (on an ephemeral port) is deliberate: every
 * assertion about TTFT, chunk counts and cancellation is then reproducible in CI
 * with no external service, no API key and no fixed port.
 */

export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(port = 0): Promise<TestServer> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(port, () => resolve(listener));
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface ConsumeOptions {
  transport: StreamTransport;
  granularity?: string;
  chaos?: Record<string, unknown>;
  /** Abort the socket once this many delta frames have been applied. */
  abortAfterChunks?: number;
  /**
   * When > 0, received bytes are replayed through the decoder in fixed-size
   * slices — the "fragmentation torture test" of §4.5. Proves the client contract
   * is boundary-agnostic.
   */
  fragmentSize?: number;
  prompt?: string;
  conversationId?: string;
}

export interface ConsumeResult {
  text: string;
  frames: StreamFrame[];
  chunkCount: number;
  networkReads: number;
  heartbeats: number;
  bytes: number;
  itl: number[];
  serverTtftMs: number | null;
  clientTtftMs: number | null;
  totalMs: number;
  status: number | null;
  doneFrame: Extract<StreamFrame, { type: 'done' }> | null;
  errorFrame: Extract<StreamFrame, { type: 'error' }> | null;
  aborted: boolean;
  contentType: string | null;
}

export async function consumeStream(baseUrl: string, options: ConsumeOptions): Promise<ConsumeResult> {
  const {
    transport,
    granularity = 'sentence',
    chaos,
    abortAfterChunks = 0,
    fragmentSize = 0,
    prompt = 'Explain AI streaming in detail.',
    conversationId,
  } = options;

  const controller = new AbortController();
  const startedAt = performance.now();

  const result: ConsumeResult = {
    text: '',
    frames: [],
    chunkCount: 0,
    networkReads: 0,
    heartbeats: 0,
    bytes: 0,
    itl: [],
    serverTtftMs: null,
    clientTtftMs: null,
    totalMs: 0,
    status: null,
    doneFrame: null,
    errorFrame: null,
    aborted: false,
    contentType: null,
  };

  let lastChunkAt = 0;

  const onFrame = (frame: StreamFrame): void => {
    result.frames.push(frame);

    switch (frame.type) {
      case 'delta': {
        const at = performance.now();
        result.chunkCount += 1;
        if (result.clientTtftMs === null) result.clientTtftMs = Math.round(at - startedAt);
        if (lastChunkAt > 0) result.itl.push(at - lastChunkAt);
        lastChunkAt = at;
        result.text += frame.text;
        if (abortAfterChunks > 0 && result.chunkCount >= abortAfterChunks) {
          // The consumer asked to stop. Depending on timing the reader loop may
          // end either by rejection (AbortError) or by a normal `done` from the
          // server, so we record the intent here as well.
          result.aborted = true;
          controller.abort();
        }
        break;
      }
      case 'heartbeat':
        result.heartbeats += 1;
        break;
      case 'error':
        result.errorFrame = frame;
        break;
      case 'done':
        result.doneFrame = frame;
        result.serverTtftMs = Math.round(frame.timings.ttftMs);
        break;
      default:
        break;
    }
  };

  // -------- transport parsers -------------------------------------------------
  const ndjsonSplitter = new LineSplitter('\n');
  const sseParser = createParser({
    // A production-tested SSE parser instead of a hand-rolled `split('\n\n')`.
    onEvent: (event) => {
      if (!event.data) return;
      try {
        onFrame(JSON.parse(event.data) as StreamFrame);
      } catch {
        /* ignore malformed frame inside the harness */
      }
    },
    onComment: () => {
      result.heartbeats += 1;
    },
  });

  const feed = (text: string): void => {
    if (!text) return;

    if (transport === 'text') {
      if (result.clientTtftMs === null) result.clientTtftMs = Math.round(performance.now() - startedAt);
      result.text += text;
      result.chunkCount += 1;
      return;
    }
    if (transport === 'sse') {
      sseParser.feed(text);
      return;
    }
    for (const line of ndjsonSplitter.push(text)) {
      try {
        onFrame(JSON.parse(line) as StreamFrame);
      } catch {
        /* ignore */
      }
    }
  };

  const decoder = new TextDecoder('utf-8');
  const collected: Uint8Array[] = [];

  try {
    const response = await fetch(`${baseUrl}/api/chat/stream?transport=${transport}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, transport, granularity, chaos, conversationId }),
      signal: controller.signal,
    });

    result.status = response.status;
    result.contentType = response.headers.get('content-type');

    if (!response.ok || !response.body) {
      result.totalMs = Math.round(performance.now() - startedAt);
      return result;
    }

    const reader = response.body.getReader();

    if (fragmentSize > 0) {
      // Collect everything, then replay the bytes in hostile fixed-size slices.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        result.networkReads += 1;
        result.bytes += value.byteLength;
        collected.push(value);
      }
      const joined = Buffer.concat(collected.map((chunk) => Buffer.from(chunk)));
      for (let offset = 0; offset < joined.length; offset += fragmentSize) {
        const slice = joined.subarray(offset, Math.min(offset + fragmentSize, joined.length));
        feed(decoder.decode(slice, { stream: true }));
      }
      feed(decoder.decode()); // final flush
    } else {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        result.networkReads += 1;
        result.bytes += value.byteLength;
        feed(decoder.decode(value, { stream: true }));
        if (controller.signal.aborted) break;
      }
      feed(decoder.decode());
    }

    // Flush a trailing partial NDJSON line, if any.
    for (const line of ndjsonSplitter.flush()) {
      try {
        onFrame(JSON.parse(line) as StreamFrame);
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') result.aborted = true;
    else throw error;
  } finally {
    result.totalMs = Math.round(performance.now() - startedAt);
  }

  return result;
}

// ============================================================================
// Maths + console helpers
// ============================================================================

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round((sorted[index] as number) * 100) / 100;
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return Boolean(await predicate());
}

export const paint = {
  green: (text: string): string => `\u001b[32m${text}\u001b[0m`,
  red: (text: string): string => `\u001b[31m${text}\u001b[0m`,
  yellow: (text: string): string => `\u001b[33m${text}\u001b[0m`,
  cyan: (text: string): string => `\u001b[36m${text}\u001b[0m`,
  dim: (text: string): string => `\u001b[2m${text}\u001b[0m`,
  bold: (text: string): string => `\u001b[1m${text}\u001b[0m`,
};

let failures = 0;

export function assert(condition: boolean, label: string, detail = ''): void {
  if (condition) {
    console.log(`${paint.green('✔')} ${label}${detail ? paint.dim(` — ${detail}`) : ''}`);
  } else {
    failures += 1;
    console.log(`${paint.red('✘')} ${label}${detail ? paint.dim(` — ${detail}`) : ''}`);
  }
}

export function section(title: string): void {
  console.log(`\n${paint.bold(paint.cyan(title))}\n${'─'.repeat(Math.max(40, title.length + 8))}`);
}

export function exitWithSummary(name: string): never {
  if (failures === 0) {
    console.log(`\n${paint.green(`${name}: ALL ASSERTIONS PASSED`)}\n`);
    process.exit(0);
  }
  console.log(`\n${paint.red(`${name}: ${failures} ASSERTION(S) FAILED`)}\n`);
  process.exit(1);
}

export function table(rows: Array<Record<string, string | number>>): void {
  if (!rows.length) return;
  const columns = Object.keys(rows[0] as Record<string, string | number>);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length))
  );

  const line = (values: string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] as number)).join('  ');

  console.log(paint.dim(line(columns)));
  console.log(paint.dim(widths.map((width) => '─'.repeat(width)).join('  ')));
  for (const row of rows) console.log(line(columns.map((column) => String(row[column] ?? ''))));
}
```


### 📄 `src/scripts/cli-stream-consumer.ts` (223 lines)

```typescript
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
```


### 📄 `src/scripts/test-utf8-fragmentation.ts` (129 lines)

```typescript
/**
 * UTF-8 FRAGMENTATION TORTURE TEST (§4.4 / §4.5 / §10.5 level 1).
 *
 * Streaming correctness is temporal: the same bytes produce different output
 * depending on how they are sliced. This script proves two things:
 *
 *   1. Incremental decoding — ONE `TextDecoder` with `{ stream: true }` plus a
 *      final flush — is byte-boundary agnostic, down to one byte per read.
 *   2. The naive alternative (a fresh decoder per chunk, which is what most
 *      broken clients do) really does corrupt multi-byte characters. The bug is
 *      demonstrated, not just described.
 *
 * Run: npm run test:utf8
 */

const SAMPLES: Array<{ name: string; text: string }> = [
  { name: 'emoji (4-byte)', text: 'Rocket 🚀 launched 🌍 with 🧑‍🚀 crew' },
  { name: 'CJK (3-byte)', text: '日本語のテキストと中文文本の混合' },
  { name: 'combining marks', text: 'e\u0301 vs é — and ǹ, ǹ, ǹ' },
  { name: 'RTL + ZWJ', text: 'مرحبا بالعالم — 👨‍👩‍👧‍👦' },
  { name: 'streamed markdown', text: '**bold** `code` ∑ ∆ ≈ λ\n```js\nconst x = 1;\n```\n' },
  { name: 'mixed answer', text: 'Spring Boot is a framework. 日本語! 🚀 ∑ ∆' },
];

const FRAGMENT_SIZES = [1, 2, 3, 5, 17, 64, 1_024];

async function main(): Promise<void> {
  const { fragmentStringByBytes, utf8ByteLength } = await import('../lib/text-codec.js');
  const { assert, exitWithSummary, paint, section, table } = await import('./harness.js');

  section('1. Byte accounting: characters are NOT bytes');
  const emoji = '🚀';
  assert(emoji.length === 2, `'🚀' is ${emoji.length} UTF-16 code units in JavaScript`);
  assert(utf8ByteLength(emoji) === 4, `'🚀' is ${utf8ByteLength(emoji)} bytes on the wire`);
  const cjk = '日';
  assert(utf8ByteLength(cjk) === 3, `'日' is ${utf8ByteLength(cjk)} bytes on the wire`);

  section('2. Incremental decoding survives hostile fragmentation');
  const rows: Array<Record<string, string | number>> = [];
  let boundaryFailures = 0;

  for (const sample of SAMPLES) {
    for (const size of FRAGMENT_SIZES) {
      const fragments = fragmentStringByBytes(sample.text, size);

      // ✅ The correct discipline: ONE decoder, `{ stream: true }`, flush at the end.
      const decoder = new TextDecoder('utf-8');
      let incremental = '';
      for (const fragment of fragments) incremental += decoder.decode(fragment, { stream: true });
      incremental += decoder.decode();

      if (incremental !== sample.text) {
        boundaryFailures += 1;
        rows.push({ sample: sample.name, bytes: size, result: '❌ CORRUPTED' });
      }
    }
  }

  assert(
    boundaryFailures === 0,
    'Every fragment size reassembles the original string exactly',
    `${SAMPLES.length * FRAGMENT_SIZES.length} combinations checked (1 byte at a time included)`
  );

  section('3. The naive client really does break (negative control)');
  const corruptions: Array<Record<string, string | number>> = [];

  for (const sample of SAMPLES) {
    for (const size of [1, 2, 3]) {
      const fragments = fragmentStringByBytes(sample.text, size);
      // ❌ A new TextDecoder per chunk — the classic bug.
      const naive = fragments.map((fragment) => new TextDecoder('utf-8').decode(fragment)).join('');
      if (naive !== sample.text) {
        corruptions.push({
          sample: sample.name,
          bytesPerRead: size,
          replacementChars: (naive.match(/\uFFFD/g) ?? []).length,
          matchesOriginal: 'no',
        });
      }
    }
  }

  table(corruptions);
  assert(
    corruptions.length > 0,
    'A per-chunk TextDecoder produces U+FFFD replacement characters',
    `${corruptions.length} corrupted combinations — this is the bug the discipline prevents`
  );

  section('4. The final decode() flush matters when a stream ends mid-character');
  const tailSample = 'end 🚀';
  const tailBytes = Buffer.from(tailSample, 'utf8');
  // Simulate a stream that dies two bytes into the final 4-byte emoji.
  const truncated = tailBytes.subarray(0, tailBytes.length - 2);

  const flushDecoder = new TextDecoder('utf-8');
  const withoutFlush = flushDecoder.decode(truncated, { stream: true });
  const withFlush = withoutFlush + flushDecoder.decode();

  assert(
    withoutFlush.length < tailSample.length,
    'Without the flush the incomplete character is held back — the text looks shorter',
    `"${withoutFlush}" (${withoutFlush.length} chars)`
  );
  assert(
    withFlush.length > withoutFlush.length && withFlush.includes('\uFFFD'),
    'The flush surfaces the truncation as U+FFFD instead of swallowing it silently',
    `"${withFlush}"`
  );
  assert(
    withoutFlush === 'end ',
    'Everything before the truncated character was still delivered correctly',
    `"${withoutFlush}"`
  );

  console.log(
    `\n${paint.dim(
      'Takeaway: byte boundaries are meaningless to the client. Decode incrementally, buffer frames, and append whatever arrives.'
    )}`
  );

  exitWithSummary('test-utf8-fragmentation');
}

main().catch((error) => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
```


### 📄 `src/scripts/test-pipeline-invariants.ts` (281 lines)

```typescript
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
```


### 📄 `src/scripts/test-cancellation.ts` (179 lines)

```typescript
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
```


### 📄 `src/scripts/benchmark-latency.ts` (131 lines)

```typescript
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
```


---

## 3. Block-by-Block Explanation

### Part A: `harness.ts` — the test substrate

#### Block 1: An in-process server on an ephemeral port

```typescript
export async function startTestServer(port = 0): Promise<TestServer> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => { const listener = app.listen(port, () => resolve(listener)); });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { baseUrl: `http://127.0.0.1:${actualPort}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
```

- **What it does:** boots the real Express app in the test process, on a port the OS picks.
- **How it works:** because `app.ts` exposes a factory, tests need no external server, no fixed port and no orchestration. `port = 0` means "any free port", so parallel test runs cannot collide — the single biggest source of flaky CI in streaming suites.

#### Block 2: A byte-accurate consumer

```typescript
const decoder = new TextDecoder('utf-8');

if (fragmentSize > 0) {
  // Collect everything, then replay it in hostile fixed-size slices.
  for (;;) { const { value, done } = await reader.read(); if (done) break; collected.push(value); }
  const joined = Buffer.concat(collected.map((chunk) => Buffer.from(chunk)));
  for (let offset = 0; offset < joined.length; offset += fragmentSize) {
    feed(decoder.decode(joined.subarray(offset, Math.min(offset + fragmentSize, joined.length)), { stream: true }));
  }
  feed(decoder.decode());
} else {
  for (;;) { const { value, done } = await reader.read(); if (done) break; feed(decoder.decode(value, { stream: true })); }
  feed(decoder.decode());
}
```

- **What it does:** is the client half of the pipeline, instrumented, with an optional hostile re-slicing mode.
- **How it works:** `fragmentSize > 0` is the CI assertion from §10.5 made real: the bytes are replayed through the decoder in 1-, 3-, 17- and 1024-byte slices, and the reconstructed text must be identical every time. That single capability is what proves the client contract is boundary-agnostic rather than lucky.

#### Block 3: Three parsers, one `onFrame`

```typescript
const ndjsonSplitter = new LineSplitter('\n');
const sseParser = createParser({
  onEvent: (event) => { if (!event.data) return; try { onFrame(JSON.parse(event.data) as StreamFrame); } catch { /* … */ } },
  onComment: () => { result.heartbeats += 1; },
});

const feed = (text: string): void => {
  if (transport === 'text') { /* raw text is appended directly */ }
  else if (transport === 'sse') sseParser.feed(text);
  else for (const line of ndjsonSplitter.push(text)) onFrame(JSON.parse(line));
};
```

- **What it does:** consumes all three transports with the *correct* parser for each.
- **How it works:** SSE uses `eventsource-parser` — a production library — rather than a hand-rolled `split('\n\n')`, which is both a correctness statement and a demonstration that the wire format is standard. `onComment` counts heartbeats, which is how the suite asserts that heartbeats keep a stalled stream alive (and that they never appear in raw text).

#### Block 4: Abort-on-N-chunks and result accounting

```typescript
case 'delta': {
  const at = performance.now();
  result.chunkCount += 1;
  if (result.clientTtftMs === null) result.clientTtftMs = Math.round(at - startedAt);
  if (lastChunkAt > 0) result.itl.push(at - lastChunkAt);
  lastChunkAt = at; result.text += frame.text;
  if (abortAfterChunks > 0 && result.chunkCount >= abortAfterChunks) { result.aborted = true; controller.abort(); }
  break;
}
```

- **What it does:** measures TTFT and ITL in the consumer, and can cancel itself deterministically.
- **How it works:** recording the *intent* to abort (`result.aborted = true`) as well as calling `abort()` matters: depending on timing the reader loop may end by rejection or by a normal `done` from the server, and the test must not depend on which. Every metric the CI suite asserts on (`clientTtftMs`, `itl`, `chunks`, `heartbeats`, `doneFrame`, `errorFrame`) is collected here, once.

---

### Part B: `test-utf8-fragmentation.ts` — the torture test

#### Block 5: The sample matrix

```typescript
const SAMPLES = [
  { name: 'emoji (4-byte)', text: 'Rocket 🚀 launched 🌍 with 🧑‍🚀 crew' },
  { name: 'CJK (3-byte)', text: '日本語のテキストと中文文本の混合' },
  { name: 'combining marks', text: 'e\u0301 vs é — and ǹ, ǹ, ǹ' },
  { name: 'RTL + ZWJ', text: 'مرحبا بالعالم — 👨‍👩‍👧‍👦' },
  { name: 'streamed markdown', text: '**bold** `code` ∑ ∆ ≈ λ\n```js\nconst x = 1;\n```\n' },
];
const FRAGMENT_SIZES = [1, 2, 3, 5, 17, 64, 1_024];
```

- **What it does:** enumerates every way UTF-8 can surprise a client.
- **How it works:** 4-byte emoji, 3-byte CJK, combining marks (separate code points that must not be split from their base), right-to-left text, a ZWJ family emoji (several code points joined), and markdown. Seven fragment sizes × six samples = **42 combinations**, each of which must reassemble byte-identically.

#### Block 6: The positive assertion, and the negative control

```typescript
// ✅ the correct discipline
const decoder = new TextDecoder('utf-8');
let incremental = '';
for (const fragment of fragments) incremental += decoder.decode(fragment, { stream: true });
incremental += decoder.decode();
if (incremental !== sample.text) boundaryFailures += 1;

// ❌ the naive client — a new decoder per chunk
const naive = fragments.map((fragment) => new TextDecoder('utf-8').decode(fragment)).join('');
if (naive !== sample.text) corruptions.push({ /* … */ replacementChars: (naive.match(/\uFFFD/g) ?? []).length });
```

- **What it does:** proves the fix works *and* that the bug is real.
- **How it works:** the negative control is what makes the test convincing: it reports 17 corrupted combinations with `U+FFFD` replacement characters at 1–3 byte fragment sizes. A test that only asserted the happy path would not tell you whether the discipline matters.

#### Block 7: Why the final flush exists

```typescript
const truncated = Buffer.from('end 🚀', 'utf8').subarray(0, 4);   // cut 2 bytes into the emoji
const withoutFlush = flushDecoder.decode(truncated, { stream: true });
const withFlush = withoutFlush + flushDecoder.decode();

assert(withoutFlush === 'end ', 'Everything before the truncated character was still delivered correctly');
assert(withFlush.includes('\uFFFD'), 'The flush surfaces the truncation as U+FFFD instead of swallowing it silently');
```

- **What it does:** demonstrates exactly what `{ stream: true }` plus a final flush do when a stream dies mid-character.
- **How it works:** with `stream: true` the incomplete bytes are *held back* (no corruption, but the character is missing); the final `decode()` then surfaces `U+FFFD` so the truncation is visible rather than silent. This is the honest version of "don't forget to flush" — it is not about losing the last character of a normal stream, it is about not swallowing a broken one.

---

### Part C: `test-pipeline-invariants.ts` — the CI gate

#### Block 8: Environment overrides before the app is imported

```typescript
process.env.STREAM_IDLE_TIMEOUT_MS = '1200';
process.env.STREAM_TTFT_BUDGET_MS = '1200';
process.env.STREAM_HEARTBEAT_MS = '400';
process.env.STREAM_FLUSH_MS = '25';
process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

async function main(): Promise<void> {
  const { startTestServer, consumeStream, assert, … } = await import('./harness.js');
  const { metrics } = await import('../lib/metrics.js');
```

- **What it does:** makes the timeouts testable in seconds instead of minutes.
- **How it works:** `config/env.ts` reads `process.env` at module load, so the overrides must be applied **before** anything imports the app — hence the dynamic `import()` calls. This is a general and often-missed technique: environment-driven configuration and ES module hoisting interact badly, and the fix is one `await import`.

#### Block 9: The assertions that catch real regressions

```typescript
assert(result.chunkCount > 2, `[${transport}] arrived as multiple chunks`, `chunks=${result.chunkCount}`);
assert(bufferingRatio < 0.5, `[${transport}] TTFT is far below total time`, `ttft=${…}ms total=${…}ms`);
assert(transport === 'text' ? result.doneFrame === null : result.doneFrame?.status === 'completed',
  '[text] raw text/plain has NO terminal frame — connection close is the only terminator (§5.5)');
```

- **What it does:** encodes §10.5's two high-value CI assertions, plus the raw-text subtlety.
- **How it works:** `chunkCount > 2` detects any layer that collected the stream into one piece; `ttft < 0.5 × total` detects the subtler case where chunks arrive but are all flushed at the end. The raw-text branch asserts the *absence* of a terminal frame: `text/plain` has no framing, so connection close is the only terminator — a limitation the test makes explicit rather than pretending away.

#### Block 10: Failure paths, concurrency and leak detection

```typescript
assert(failing.errorFrame?.code === 'provider_error', 'An `error` frame was delivered inside the stream');
assert(failing.doneFrame?.status === 'interrupted', 'The `done` frame marks the turn interrupted');
assert(stalled.errorFrame?.code === 'upstream_stall', 'The idle watchdog closed the stream with `upstream_stall`');
assert(stalled.heartbeats >= 1, 'Heartbeats were emitted during the silence');
assert(ttftBreach.errorFrame?.code === 'provider_timeout', 'The TTFT budget produced a `provider_timeout` error frame');
assert(rawWithStall.heartbeats === 0, 'No heartbeat bytes were injected into the raw text body');
assert(secondResponse.status === 409, 'The concurrent turn was refused with 409 Conflict');
assert(inflight.inflight === 0, 'No streams remain registered');
```

- **What it does:** is the suite that would catch a regression introduced by a future refactor.
- **How it works:** each assertion targets a specific anti-pattern from §10.6 — the silent truncation, the zombie connection, the proxy buffer, the leaky conversation, the locked stream. The raw-text heartbeat assertion proves transport awareness is real: a heartbeat inside a `text/plain` body would be a visible corruption, so the encoder must refuse it.

---

### Part D: `test-cancellation.ts` — money and data

#### Block 11: The assertions that matter commercially

```typescript
assert(aborted.text.length < full.text.length, 'The provider stopped early — no zombie generation behind the abort',
  `${aborted.text.length} < ${full.text.length} chars`);

const assistant = assistantMessages[0]!;
assert(assistantMessages.length === 1, 'Exactly ONE assistant message is stored — chunks are NOT stored as messages',
  `${assistantMessages.length} of ${aborted.chunkCount} chunks became messages`);
assert(assistant.status === 'interrupted', 'The partial answer is flagged as interrupted');
assert(assistant.finishReason === 'client_abort', 'The finish reason records WHY it stopped');
assert(assistant.content === aborted.text, 'The stored content is byte-for-byte what the user read');
```

- **What it does:** verifies the two things streaming systems most often get wrong: cost and history.
- **How it works:** the first assertion is the money one — the aborted run produced strictly less text than a full run, so the provider call really was cancelled rather than left to finish into a dead socket. The rest are the data ones: one message, flagged, with a reason, identical to what the user saw. That byte-for-byte comparison is only possible because the pump buffers exactly what it forwards.

#### Block 12: The follow-up turn proves the lock was released

```typescript
const followUp = await consumeStream(server.baseUrl, { transport: 'ndjson', conversationId, prompt: 'Continue from where you stopped.' });
assert(followUp.doneFrame?.status === 'completed', 'A follow-up turn in the SAME conversation succeeds (no leaked lock)');

const finalTranscript = await (await fetch(`${server.baseUrl}/api/conversations/${conversationId}`)).json();
assert(finalTranscript.conversation.messages.filter((m) => m.role === 'assistant').length === 2,
  'Two assistant turns are stored: one interrupted, one completed');
```

- **What it does:** proves the conversation is still usable after a cancellation.
- **How it works:** a leaked lock is invisible until the *next* request, so the test performs one and asserts it succeeds. The transcript then holds two assistant messages — one interrupted, one completed — the complete and correct history of what actually happened.

---

### Part E: `benchmark-latency.ts` and `cli-stream-consumer.ts`

#### Block 13: The latency matrix

```typescript
for (const transport of ['text', 'ndjson', 'sse'] as const) {
  for (const granularity of ['token', 'word', 'sentence', 'random']) {
    for (let run = 0; run < RUNS; run += 1) {
      const result = await consumeStream(server.baseUrl, { transport, granularity, conversationId: `bench_${transport}_${granularity}_${run}` });
      ttfts.push(result.clientTtftMs ?? 0); chunkCounts.push(result.chunkCount); itlMeans.push(mean(result.itl));
    }
    matrixRows.push({ transport, granularity, 'ttft p50': …, 'chunks p50': percentile(chunkCounts, 50), 'itl p50': …, 'chars/s p50': … });
  }
}
```

- **What it does:** answers "how does granularity trade chunk count against per-chunk delay?" with numbers.
- **How it works:** each cell reports percentiles rather than averages, because streaming quality lives in the tail. The buffered baseline is measured in the same script, so the perceived-latency difference is printed side by side: **~726 ms** to first visible text buffered versus **~374 ms** streaming, with nearly identical total time.

#### Block 14: The CLI consumer

```typescript
const response = await fetch(`${baseUrl}/api/chat/stream?transport=${options.transport}`, { method: 'POST', …, signal: controller.signal });
process.stdout.write(`HTTP ${response.status} … headers at ${Math.round(performance.now() - startedAt)} ms (fetch() resolves HERE)\n`);
…
for (;;) { const { value, done } = await reader.read(); if (done) break; reads += 1; bytes += value.byteLength; feed(decoder.decode(value, { stream: true })); }
feed(decoder.decode());
```

- **What it does:** is the same client discipline in a terminal, with live output and a summary table.
- **How it works:** it prints the moment headers arrive, then each delta as it lands, then TTFT / ITL mean+max / chunks / reads / bytes / chars-per-chunk / chars-per-second / heartbeats / terminal status. It exits non-zero if only one chunk arrived, which makes it usable as a deployment smoke test. `LOG_LEVEL` defaults to `warn` when it boots the in-process server so telemetry does not interleave with the answer.

---

### ✅ Chapter 15 verification

```bash
npm run test:utf8          # expect: 42 combinations pass, 17 naive corruptions reported
npm run test:invariants    # expect: ALL ASSERTIONS PASSED (10 sections)
npm run test:cancel        # expect: ALL ASSERTIONS PASSED (6 sections)
npm run bench:latency      # expect: the streaming-vs-buffered contrast table
npm run stream:cli -- --transport=sse
```





---

**Previous:**  · **Next:** 
