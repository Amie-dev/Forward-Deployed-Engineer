/**
 * ============================================================================
 * Lecture 06 — the BROWSER half of the streaming pipeline.
 * ============================================================================
 *
 * The five decisions this file makes, and why each one matters (§9):
 *
 *  1. `await fetch()` resolves on RESPONSE HEADERS, not body completion. We
 *     therefore treat "headers received" as a distinct timestamp from "first
 *     painted character" (client TTFT).
 *  2. `response.body` is a ReadableStream of BYTES. We never call
 *     `response.text()` on the streaming path — that one line would undo the
 *     entire backend (Anti-pattern #1).
 *  3. ONE `TextDecoder` is reused with `{ stream: true }` and flushed once at the
 *     end, because a network chunk can split a multi-byte character.
 *  4. Frame parsing is incremental: bytes are buffered and split on the frame
 *     delimiter, keeping the trailing partial frame for the next read.
 *  5. Exactly ONE assistant bubble is created lazily and appended to forever.
 */

// ============================================================================
// 1. DOM references & mutable state
// ============================================================================

const el = {
  messages: document.getElementById('messages'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  drop: document.getElementById('drop'),
  jump: document.getElementById('jump-latest'),
  wire: document.getElementById('wire'),
  transport: document.getElementById('transport'),
  granularity: document.getElementById('granularity'),
  chaosStall: document.getElementById('chaos-stall'),
  chaosError: document.getElementById('chaos-error'),
  chaosTtft: document.getElementById('chaos-ttft'),
  antipattern: document.getElementById('antipattern'),
  refreshServer: document.getElementById('refresh-server'),
  badgeModel: document.getElementById('badge-model'),
  badgeProvider: document.getElementById('badge-provider'),
  badgeTransport: document.getElementById('badge-transport'),
  metrics: {
    clientTtft: document.getElementById('m-client-ttft'),
    total: document.getElementById('m-total'),
    itlMean: document.getElementById('m-itl-mean'),
    itlMax: document.getElementById('m-itl-max'),
    chunks: document.getElementById('m-chunks'),
    reads: document.getElementById('m-reads'),
    bytes: document.getElementById('m-bytes'),
    chars: document.getElementById('m-chars'),
    charsPerChunk: document.getElementById('m-chars-per-chunk'),
    tps: document.getElementById('m-tps'),
    heartbeats: document.getElementById('m-heartbeats'),
    state: document.getElementById('m-state'),
    serverTtft: document.getElementById('m-server-ttft'),
    ttftGap: document.getElementById('m-ttft-gap'),
    error: document.getElementById('m-error'),
  },
};

const state = {
  /** AbortController for the in-flight request — the Stop button's whole job. */
  controller: null,
  running: false,
  /** Set by the `start` frame; required for server-side cancel and catch-up. */
  requestId: null,
  conversationId: null,
  /** The ONE assistant bubble (created on first text, never per chunk). */
  bubble: null,
  rawText: '',
  seq: 0,
  reads: 0,
  bytes: 0,
  chunks: 0,
  heartbeats: 0,
  itlSamples: [],
  lastChunkAt: 0,
  sendStartedAt: 0,
  firstAppendAt: 0,
  clientTtftMs: 0,
  paintOffsetMs: 0,
  serverTtftMs: null,
  serverBudget: null,
  usage: null,
  /** Carry buffers — the difference between correct and corrupted parsing. */
  carry: { line: '', sse: '' },
  decoder: null,
  serverModel: null,
  /** Set when a `done` frame arrived, so the fallback finisher does not overwrite it. */
  doneSeen: false,
  lastMessage: null,
};

// ============================================================================
// 2. Incremental frame parsing (the framing-buffer pattern)
// ============================================================================

/**
 * NDJSON: one JSON envelope per line. The trailing partial line MUST be kept.
 * Doing `text.split("\n")` per read instead corrupts any line the network
 * happens to bisect.
 */
function parseNdjson(text, onFrame) {
  const combined = state.carry.line + text;
  const lines = combined.split('\n');
  state.carry.line = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      onFrame(JSON.parse(line), line);
    } catch {
      recordWire('parse-error', line);
    }
  }
}

/**
 * SSE: `field: value` lines terminated by a BLANK line that dispatches the event.
 * Splitting naively on every read corrupts frames exactly the same way.
 */
function parseSse(text, onFrame) {
  const combined = state.carry.sse + text;
  const frames = combined.split('\n\n');
  state.carry.sse = frames.pop() ?? '';

  for (const frame of frames) {
    if (!frame.trim()) continue;

    let event = 'message';
    let id = null;
    const dataLines = [];

    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat comment
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');

      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (event === 'message' && dataLines.length === 0) {
      // A bare comment/heartbeat block.
      onFrame({ type: 'heartbeat' }, frame);
      continue;
    }

    try {
      const parsed = JSON.parse(dataLines.join('\n'));
      onFrame(parsed, frame, id);
    } catch {
      recordWire('parse-error', frame);
    }
  }
}

// ============================================================================
// 3. Rendering — one bubble, sanitised markdown, one repaint per frame
// ============================================================================

const pending = { dirty: false, paintPending: false };

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Deliberately tiny markdown subset, applied to ALREADY-ESCAPED text.
 *
 * Two production rules from §9.11 are encoded here:
 *  - streamed content is untrusted input, so it is escaped first and no raw HTML
 *    is ever inserted (`innerHTML` of unescaped model output is an XSS hole);
 *  - partial markdown is invalid markdown, so the renderer must tolerate
 *    half-written fences without throwing or losing text.
 */
function renderMarkdown(source) {
  let html = escapeHtml(source);

  // Fenced code blocks (open or not-yet-closed — partial fences must render).
  html = html.replace(/```([a-zA-Z0-9+-]*)\n?([\s\S]*?)(```|$)/g, (_match, _lang, body, closing) => {
    const suffix = closing === '```' ? '' : '\n▌'; // show that the fence is still open
    return `<pre class="code"><code>${body}${suffix}</code></pre>`;
  });

  html = html
    .replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br />');

  return html;
}

/** Create the assistant bubble LAZILY, so a failure cannot leave a ghost bubble. */
function ensureBubble() {
  if (state.bubble) return state.bubble;

  const article = document.createElement('article');
  article.className = 'turn assistant streaming';
  article.setAttribute('aria-busy', 'true');

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'assistant · streaming…';

  const body = document.createElement('div');
  body.className = 'body';

  article.append(meta, body);
  el.messages.append(article);

  state.bubble = { article, meta, body };
  return state.bubble;
}

/** Append-only: the contract is "whenever more text arrives, append it". */
function appendText(text) {
  if (!text) return;

  if (state.firstAppendAt === 0) {
    state.firstAppendAt = performance.now();
    state.clientTtftMs = Math.round(state.firstAppendAt - state.sendStartedAt);
  }
  ensureBubble();
  state.rawText += text;
  scheduleRender();
}

/**
 * One repaint per animation frame. Parsing markdown per network chunk is the
 * "janky renderer" anti-pattern: dozens of full re-parses per second.
 */
function scheduleRender() {
  if (pending.dirty) return;
  pending.dirty = true;
  requestAnimationFrame(() => {
    pending.dirty = false;
    flushRender();
  });
}

function flushRender() {
  if (!state.bubble) return;

  const wasSticky = isNearBottom();
  state.bubble.body.innerHTML = renderMarkdown(state.rawText);

  // First PAINT is the number the user actually feels — record the offset
  // between "text appended" and "pixels on screen" once, per turn.
  if (state.paintOffsetMs === 0 && state.firstAppendAt > 0) {
    state.paintOffsetMs = Math.round(performance.now() - state.firstAppendAt);
  }

  if (wasSticky) scrollToBottom();
  else el.jump.hidden = false;

  updateMetrics();
}

function isNearBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
  el.jump.hidden = true;
}

// ============================================================================
// 4. Telemetry & status display
// ============================================================================

const wireLog = [];

function recordWire(kind, payload) {
  wireLog.unshift(`[${new Date().toLocaleTimeString()}] ${kind} ${payload}`);
  if (wireLog.length > 40) wireLog.pop();
  el.wire.textContent = wireLog.join('\n');
}

function setState(label, tone = '') {
  el.metrics.state.textContent = label;
  el.metrics.state.dataset.tone = tone;
}

function updateMetrics() {
  const chunks = state.chunks;
  el.metrics.chunks.textContent = String(chunks);
  el.metrics.reads.textContent = String(state.reads);
  el.metrics.bytes.textContent = String(state.bytes);
  el.metrics.chars.textContent = String(state.rawText.length);
  el.metrics.heartbeats.textContent = String(state.heartbeats);
  el.metrics.charsPerChunk.textContent = chunks ? (state.rawText.length / chunks).toFixed(1) : '–';

  if (state.itlSamples.length) {
    const mean = state.itlSamples.reduce((sum, value) => sum + value, 0) / state.itlSamples.length;
    el.metrics.itlMean.textContent = `${mean.toFixed(1)} ms`;
    el.metrics.itlMax.textContent = `${Math.max(...state.itlSamples).toFixed(0)} ms`;
  } else {
    el.metrics.itlMean.textContent = '–';
    el.metrics.itlMax.textContent = '–';
  }

  if (state.clientTtftMs) {
    el.metrics.clientTtft.textContent = `${state.clientTtftMs} ms (+${state.paintOffsetMs} paint)`;
  }

  const generationMs = state.firstAppendAt ? performance.now() - state.firstAppendAt : 0;
  if (generationMs > 200) {
    el.metrics.tps.textContent = (state.rawText.length / (generationMs / 1000)).toFixed(0);
  }
}

function finishTurn(finishReason, note) {
  if (state.bubble) {
    state.bubble.article.classList.remove('streaming');
    state.bubble.article.setAttribute('aria-busy', 'false');
    state.bubble.meta.textContent = `assistant · ${finishReason}${note ? ` · ${note}` : ''}`;
  }
  if (state.sendStartedAt) el.metrics.total.textContent = `${Math.round(performance.now() - state.sendStartedAt)} ms`;
  updateMetrics();
}

/** In-band error: the HTTP status was 200 and immutable, so the failure is a frame. */
function showInBandError(frame) {
  el.metrics.error.textContent = `${frame.code}${frame.partial ? ' (partial text kept)' : ''}`;
  if (!state.bubble) return;

  const chip = document.createElement('div');
  chip.className = 'inline-error';
  chip.textContent = `⚠ ${frame.code}: ${frame.message}${frame.recoverable ? ' — retry is safe.' : ''}`;
  state.bubble.article.append(chip);
}

// ============================================================================
// 5. Frame dispatch — ONE place decides what each frame means
// ============================================================================

function applyFrame(frame, raw) {
  switch (frame.type) {
    case 'start': {
      state.requestId = frame.requestId;
      state.conversationId = frame.conversationId;
      state.serverBudget = frame;
      recordWire('start', `requestId=${frame.requestId} granularity=${frame.granularity} heartbeat=${frame.heartbeatMs}ms`);
      break;
    }

    case 'delta': {
      const now = performance.now();
      state.chunks += 1;
      state.seq = Math.max(state.seq, frame.seq);
      state.bytes += frame.bytes;
      if (state.lastChunkAt > 0) state.itlSamples.push(now - state.lastChunkAt);
      state.lastChunkAt = now;

      recordWire(`delta#${frame.seq}`, `${frame.chars} chars / ${frame.bytes} bytes`);
      appendText(frame.text);
      break;
    }

    case 'usage': {
      state.usage = frame.usage;
      recordWire('usage', `prompt=${frame.usage.promptTokens} completion=${frame.usage.completionTokens}`);
      break;
    }

    case 'heartbeat':
      state.heartbeats += 1;
      updateMetrics();
      break;

    case 'error':
      recordWire('error', `${frame.code} partial=${frame.partial}`);
      showInBandError(frame);
      break;

    case 'done': {
      state.doneSeen = true;
      state.serverTtftMs = frame.timings.ttftMs;
      el.metrics.serverTtft.textContent = `${Math.round(frame.timings.ttftMs)} ms`;
      if (state.clientTtftMs) {
        el.metrics.ttftGap.textContent = `${Math.max(0, state.clientTtftMs - Math.round(frame.timings.ttftMs))} ms`;
      }
      finishTurn(
        `${frame.status}/${frame.finishReason}`,
        `${frame.chunks} chunks · ${frame.chars} chars · ${Math.round(frame.timings.avgItlMs)} ms ITL`
      );
      recordWire('done', `status=${frame.status} reason=${frame.finishReason} chunks=${frame.chunks}`);
      break;
    }

    default:
      recordWire('frame', raw ?? '');
  }
}

// ============================================================================
// 6. The streaming client — reader loop, decoder discipline, cancellation
// ============================================================================

function buildChaos() {
  const chaos = {};
  if (el.chaosStall.checked) {
    chaos.stallAfterDeltas = 3;
    chaos.stallMs = 35000; // longer than the server's idle timeout ⇒ watchdog fires
  }
  if (el.chaosError.checked) {
    chaos.failAfterDeltas = 4;
    chaos.failCode = 'provider_error';
  }
  if (el.chaosTtft.checked) chaos.exceedTtftBudget = true;
  return Object.keys(chaos).length ? chaos : undefined;
}

function setRunning(running) {
  state.running = running;
  el.send.disabled = running;
  el.stop.disabled = !running;
  el.drop.disabled = !running;
  setState(running ? 'streaming' : 'idle', running ? 'busy' : '');
}

function appendUserBubble(message) {
  const article = document.createElement('article');
  article.className = 'turn user';
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = message; // textContent: user input is never interpolated as HTML
  article.append(body);
  el.messages.append(article);
  scrollToBottom();
}

/** A small inline notice inside the current bubble (errors, cancellations, notes). */
function appendNotice(text, tone = 'info') {
  ensureBubble();
  const notice = document.createElement('div');
  notice.className = `notice ${tone}`;
  notice.textContent = text;
  state.bubble.article.append(notice);
  scrollToBottom();
}

async function sendStreaming(message) {
  const transport = el.transport.value;
  state.controller = new AbortController();
  state.sendStartedAt = performance.now();
  el.metrics.error.textContent = 'none';
  setRunning(true);

  let response;
  try {
    response = await fetch(`/api/chat/stream?transport=${transport}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        conversationId: state.conversationId ?? undefined,
        transport,
        granularity: el.granularity.value,
        chaos: buildChaos(),
      }),
      signal: state.controller.signal,
    });
  } catch (error) {
    handleTransportError(error);
    setRunning(false);
    return;
  }

  // ✅ `fetch()` resolved HERE — on the response headers, NOT on body completion.
  recordWire('headers', `HTTP ${response.status} after ${Math.round(performance.now() - state.sendStartedAt)} ms`);

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: { message: 'Request failed.' } }));
    appendNotice(`✖ ${response.status} ${payload.error?.code ?? 'error'}: ${payload.error?.message ?? ''}`, 'error');
    finishTurn(`http ${response.status}`, '');
    setState('failed', 'bad');
    setRunning(false);
    return;
  }

  // ❌ THE ANTI-PATTERN TOGGLE — one line erases every backend guarantee.
  if (el.antipattern.checked) {
    await consumeWithText(response);
    setRunning(false);
    return;
  }

  await consumeWithReader(response, transport);
  setRunning(false);
}

/**
 * The correct consumer: read bytes, decode incrementally, parse frames by carry.
 */
async function consumeWithReader(response, transport) {
  // ONE decoder for the entire stream. `{ stream: true }` holds back an
  // incomplete multi-byte sequence instead of emitting U+FFFD replacements.
  state.decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      state.reads += 1;
      const text = state.decoder.decode(value, { stream: true });

      if (transport === 'text') {
        recordWire('read', `${value.byteLength} bytes (raw text/plain)`);
        appendText(text);
      } else if (transport === 'sse') {
        parseSse(text, applyFrame);
      } else {
        parseNdjson(text, applyFrame);
      }
    }

    // Flush: without this final call the last character(s) can be silently lost.
    const tail = state.decoder.decode();
    if (tail) {
      if (transport === 'text') appendText(tail);
      else if (transport === 'sse') parseSse(tail, applyFrame);
      else parseNdjson(tail, applyFrame);
    }

    if (!state.doneSeen) {
      finishTurn('stream ended', `${state.chunks} chunks`);
      if (!state.chunks) appendNotice('The stream closed without any text.', 'warn');
    }
  } catch (error) {
    handleTransportError(error);
  } finally {
    // Release the lock so a later turn (or a retry) can acquire a reader again.
    reader.releaseLock?.();
    scheduleRender();
    reportClientTtft();
  }
}

/**
 * ❌ The anti-pattern, kept executable on purpose.
 *
 * `await response.text()` means: "read the entire body, concatenate it, decode
 * it, and give it to me only when it has finished." Every server-side guarantee
 * survives the network and dies right here — client TTFT becomes the total
 * duration.
 */
async function consumeWithText(response) {
  const startedAt = state.sendStartedAt;
  const collapsed = await response.text();
  const elapsed = Math.round(performance.now() - startedAt);

  state.reads = 1;
  state.chunks = 1;
  state.bytes = new TextEncoder().encode(collapsed).length;
  state.firstAppendAt = performance.now();
  state.clientTtftMs = elapsed; // ← the whole point: nothing was painted earlier

  recordWire('response.text()', `${state.bytes} bytes delivered in ONE piece after ${elapsed} ms`);
  ensureBubble();
  state.rawText = collapsed;
  scheduleRender();

  appendNotice(
    `❌ Anti-pattern mode: await response.text() buffered the ENTIRE body. Client TTFT = ${elapsed} ms = total time. ` +
      'The backend streamed perfectly; this single line removed the experience (§9.2).',
    'error'
  );
  finishTurn(`buffered (ttft ${elapsed} ms)`, 'text() collapse');
  setState('buffered', 'warn');
}

function handleTransportError(error) {
  if (error?.name === 'AbortError') {
    // Cancellation is a first-class outcome, NOT an error: no toast, no red
    // state, and the partial text stays on screen (§9.8).
    appendNotice('⏹ Stopped by user. Partial answer preserved; AbortError is not a failure.', 'warn');
    finishTurn('aborted', 'partial text kept');
    setState('aborted', 'warn');
    return;
  }
  appendNotice(`⚠ Transport error: ${error?.message ?? error}`, 'error');
  finishTurn('transport error', '');
  setState('error', 'bad');
}

// ============================================================================
// 7. Stop, drop-and-recover, and the server panel
// ============================================================================

/** Stop = "close the socket". The server observes the close and cancels the provider. */
function stopStream() {
  if (!state.controller) return;
  state.controller.abort();

  // Belt and braces: also ask the server to cancel by requestId. The socket close
  // is normally sufficient, but an explicit cancel covers proxies that keep the
  // connection open after the client has gone away.
  if (state.requestId) {
    fetch(`/api/chat/streams/${state.requestId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'User pressed Stop' }),
      keepalive: true,
    }).catch(() => undefined);
  }
}

/**
 * Simulate a flaky network, then prove the recovery path: the client keeps the
 * highest `seq` it applied and re-reads anything it missed by cursor.
 */
async function dropAndRecover() {
  const requestId = state.requestId;
  const fromSeq = state.seq;

  if (!requestId) {
    appendNotice('No active stream to recover yet.', 'warn');
    return;
  }

  stopStream(); // the socket dies exactly as it would on a train entering a tunnel
  appendNotice('🔌 Socket dropped on purpose. Recovering missed frames by cursor…', 'warn');
  await new Promise((resolve) => setTimeout(resolve, 400));

  try {
    const response = await fetch(`/api/chat/streams/${requestId}/catch-up?fromSeq=${fromSeq}`);
    const payload = await response.json();

    for (const item of payload.frames) {
      // Frames are replayed verbatim, so the SAME dispatch path consumes them.
      if (item.payload.trim().startsWith('{')) {
        applyFrame(JSON.parse(item.payload), item.payload);
      } else if (item.payload.includes('event:')) {
        parseSse(item.payload, applyFrame);
      } else {
        applyFrame({
          type: 'delta',
          seq: item.seq,
          text: item.payload,
          chars: item.payload.length,
          bytes: new TextEncoder().encode(item.payload).length,
        });
      }
    }

    recordWire(
      'catch-up',
      `${payload.frames.length} frame(s) replayed · lastSeq=${payload.lastSeq} · inflight=${payload.inflight}`
    );
    appendNotice(
      payload.frames.length
        ? `Recovered ${payload.frames.length} frame(s) the dropped socket never delivered.`
        : 'Nothing was missed before the drop (the ring buffer had no newer frames).',
      'info'
    );
  } catch (error) {
    appendNotice(`Recovery failed: ${error.message}`, 'error');
  }

  await refreshServer();
}

/** Report the TTFT the user actually felt, so the server can alert on the gap. */
async function reportClientTtft() {
  if (!state.clientTtftMs) return;
  try {
    const response = await fetch('/api/observability/client-ttft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: state.requestId ?? undefined,
        serverTtftMs: state.serverTtftMs ?? undefined,
        clientTtftMs: state.clientTtftMs,
      }),
    });
    const data = await response.json();
    if (typeof data.gapMs === 'number') el.metrics.ttftGap.textContent = `${data.gapMs} ms`;
    recordWire(
      'client-ttft',
      `client=${state.clientTtftMs} ms gap=${data.gapMs ?? 'n/a'} ms (alert > ${data.threshold} ms)`
    );
  } catch {
    /* client telemetry must never break the chat */
  }
}

async function refreshServer() {
  try {
    const response = await fetch('/api/observability');
    const data = await response.json();

    el.badgeModel.textContent = `model: ${data.provider.model}`;
    el.badgeProvider.textContent = `provider: ${data.provider.name}`;
    el.badgeTransport.textContent = `transport: ${el.transport.value} · conv: ${state.conversationId ?? 'new'}`;

    const p50 = data.latency.serverTtftMs.p50;
    const p95 = data.latency.serverTtftMs.p95;
    el.metrics.serverTtft.textContent = p50 ? `p50 ${p50} / p95 ${p95} ms` : '–';

    recordWire(
      'observability',
      `server TTFT p50=${p50}ms p95=${p95}ms · gap p95=${data.latency.ttftGapMs.p95}ms · inflight=${data.inflight.length} · alerts=${data.alerts.length}`
    );
  } catch (error) {
    recordWire('observability', `unavailable: ${error.message}`);
  }
}

// ============================================================================
// 8. Wiring
// ============================================================================

function resetTurnState() {
  state.bubble = null;
  state.rawText = '';
  state.seq = 0;
  state.reads = 0;
  state.bytes = 0;
  state.chunks = 0;
  state.heartbeats = 0;
  state.itlSamples = [];
  state.lastChunkAt = 0;
  state.firstAppendAt = 0;
  state.clientTtftMs = 0;
  state.paintOffsetMs = 0;
  state.serverTtftMs = null;
  state.usage = null;
  state.doneSeen = false;
  state.carry.line = '';
  state.carry.sse = '';
  // NOTE: `conversationId` is deliberately NOT reset — that is what makes this a
  // multi-turn conversation and exercises the server's dual-write history.

  el.metrics.clientTtft.textContent = '–';
  el.metrics.total.textContent = '–';
  el.metrics.error.textContent = 'none';
  updateMetrics();
}

async function onSubmit(event) {
  event?.preventDefault();
  const message = el.prompt.value.trim();
  if (!message || state.running) return;

  el.prompt.value = '';
  appendUserBubble(message);
  resetTurnState();
  await sendStreaming(message);
  await refreshServer();
}

document.getElementById('composer').addEventListener('submit', onSubmit);
el.stop.addEventListener('click', stopStream);
el.drop.addEventListener('click', dropAndRecover);
el.refreshServer.addEventListener('click', refreshServer);
el.jump.addEventListener('click', scrollToBottom);
el.transport.addEventListener('change', refreshServer);
el.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) onSubmit(event);
});
el.messages.addEventListener('scroll', () => {
  if (isNearBottom()) el.jump.hidden = true;
});

resetTurnState();
refreshServer();

// A tiny surface for live console experiments during the lecture.
window.streamingClient = { state, send: sendStreaming, stop: stopStream, recover: dropAndRecover };
