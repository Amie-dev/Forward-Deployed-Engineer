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
