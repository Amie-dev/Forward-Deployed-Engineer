# Chapter 14: The Browser Client: fetch, ReadableStream, TextDecoder & Rendering

> **Chapter Goal:** Build the half of the pipeline that can undo everything: one decoder, carry buffers, one lazily created bubble, rAF rendering, sticky scroll, sanitised markdown, cancellation — and an executable anti-pattern demo.

> **Prerequisites:** the previous chapters of this guide, in order. Each chapter lists the files it creates and the commands it needs.

---

## 1. Files Covered in This Chapter

| File | Purpose |
| :--- | :--- |
| `public/index.html` | 139 lines |
| `public/app.js` | 784 lines |
| `public/styles.css` | 363 lines |

---

## 2. Complete Source Code

> Generated directly from the shipped files, so this guide and the repository can never drift apart.


### 📄 `public/index.html` (138 lines)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lecture 06 · AI Streaming Client — fetch · ReadableStream · TextDecoder</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="topbar">
      <div>
        <h1>AI Streaming Client</h1>
        <p class="subtitle">
          The browser half of the pipeline: <code>fetch()</code> → <code>response.body</code> →
          <code>ReadableStream</code> → <code>TextDecoder({stream:true})</code> → ONE growing bubble.
        </p>
      </div>
      <div class="badges">
        <span class="badge" id="badge-model">model: …</span>
        <span class="badge" id="badge-provider">provider: …</span>
        <span class="badge" id="badge-transport">transport: ndjson</span>
      </div>
    </header>

    <main class="layout">
      <!-- ================= LEFT: conversation ================= -->
      <section class="panel chat-panel">
        <div class="controls">
          <label>
            Transport
            <select id="transport">
              <option value="ndjson" selected>NDJSON (application/x-ndjson)</option>
              <option value="sse">SSE (text/event-stream)</option>
              <option value="text">Raw text/plain (PDF/Tomato pattern)</option>
            </select>
          </label>

          <label>
            Granularity (coalescing)
            <select id="granularity">
              <option value="sentence" selected>sentence — natural bubbles</option>
              <option value="word">word — 3 tokens per delta</option>
              <option value="token">token — provider cadence</option>
              <option value="random">random — hostile 1–3 chars</option>
            </select>
          </label>

          <label class="checkbox">
            <input type="checkbox" id="chaos-stall" />
            Inject a mid-stream stall (idle watchdog)
          </label>
          <label class="checkbox">
            <input type="checkbox" id="chaos-error" />
            Inject a mid-stream provider error (in-band <code>error</code>)
          </label>
          <label class="checkbox">
            <input type="checkbox" id="chaos-ttft" />
            Breach the TTFT budget
          </label>
          <label class="checkbox danger">
            <input type="checkbox" id="antipattern" />
            ❌ Anti-pattern mode: <code>await response.text()</code>
          </label>
        </div>

        <div
          id="messages"
          class="messages"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Conversation transcript"
        ></div>

        <button id="jump-latest" class="jump-latest" hidden>↓ Jump to latest</button>

        <form id="composer" class="composer">
          <textarea
            id="prompt"
            rows="2"
            placeholder="Ask something… (Enter to send, Shift+Enter for a newline)"
            aria-label="Message"
          ></textarea>
          <div class="composer-actions">
            <button type="submit" id="send">Send</button>
            <button type="button" id="stop" disabled aria-label="Stop generating">Stop</button>
            <button
              type="button"
              id="drop"
              disabled
              title="Abort the socket, then recover the missed frames by cursor"
            >
              Drop &amp; recover
            </button>
          </div>
        </form>
      </section>

      <!-- ================= RIGHT: telemetry ================= -->
      <aside class="panel hud">
        <h2>Streaming telemetry</h2>
        <p class="hint">
          Measured in the client. <strong>TTFT</strong> is what the user feels;
          <strong>ITL</strong> decides whether the model can keep up with the reader.
        </p>

        <div class="grid">
          <div class="metric"><span class="k">Client TTFT</span><span class="v" id="m-client-ttft">–</span></div>
          <div class="metric"><span class="k">Total</span><span class="v" id="m-total">–</span></div>
          <div class="metric"><span class="k">ITL mean</span><span class="v" id="m-itl-mean">–</span></div>
          <div class="metric"><span class="k">ITL max</span><span class="v" id="m-itl-max">–</span></div>
          <div class="metric"><span class="k">Chunks</span><span class="v" id="m-chunks">0</span></div>
          <div class="metric"><span class="k">Network reads</span><span class="v" id="m-reads">0</span></div>
          <div class="metric"><span class="k">Bytes</span><span class="v" id="m-bytes">0</span></div>
          <div class="metric"><span class="k">Chars</span><span class="v" id="m-chars">0</span></div>
          <div class="metric"><span class="k">Chars / chunk</span><span class="v" id="m-chars-per-chunk">–</span></div>
          <div class="metric"><span class="k">Chars / sec</span><span class="v" id="m-tps">–</span></div>
          <div class="metric"><span class="k">Heartbeats</span><span class="v" id="m-heartbeats">0</span></div>
          <div class="metric"><span class="k">State</span><span class="v" id="m-state">idle</span></div>
        </div>

        <div class="server-panel">
          <h3>Server side</h3>
          <div class="metric wide"><span class="k">Server TTFT</span><span class="v" id="m-server-ttft">–</span></div>
          <div class="metric wide"><span class="k">TTFT gap (client − server)</span><span class="v" id="m-ttft-gap">–</span></div>
          <div class="metric wide"><span class="k">In-band error / status</span><span class="v" id="m-error">none</span></div>
          <button type="button" id="refresh-server" class="ghost">Refresh /api/observability</button>
        </div>

        <h3>Wire inspector</h3>
        <p class="hint">Raw frames exactly as they arrived (most recent first).</p>
        <pre id="wire" class="wire"></pre>
      </aside>
    </main>

    <script type="module" src="./app.js"></script>
  </body>
</html>
```


### 📄 `public/app.js` (783 lines)

```javascript
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
```


### 📄 `public/styles.css` (362 lines)

```css
:root {
  color-scheme: dark;
  --bg: #0b1020;
  --panel: #141a2e;
  --panel-2: #1b2340;
  --border: #26304f;
  --text: #e8ecf8;
  --muted: #9aa5c4;
  --accent: #6ea8fe;
  --warn: #fbbf24;
  --bad: #f87171;
  --user: #1f2a4a;
  --radius: 12px;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: radial-gradient(1200px 600px at 20% -10%, #16204a 0%, var(--bg) 60%);
  color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: rgba(110, 168, 254, 0.12);
  padding: 0.1em 0.35em;
  border-radius: 5px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border);
  background: rgba(11, 16, 32, 0.75);
  backdrop-filter: blur(6px);
  position: sticky;
  top: 0;
  z-index: 5;
}

h1 {
  margin: 0;
  font-size: 20px;
}

.subtitle {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
  max-width: 78ch;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.badge {
  font-size: 12px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  white-space: nowrap;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(340px, 0.75fr);
  gap: 16px;
  padding: 16px 22px 28px;
  align-items: start;
}

@media (max-width: 1000px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.panel {
  background: linear-gradient(180deg, var(--panel) 0%, #111730 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
}

.chat-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 72vh;
  position: relative;
}

.controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--border);
}

.controls label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

.controls .checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text);
}

.controls .checkbox.danger {
  color: var(--warn);
}

select,
textarea,
button {
  font: inherit;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
}

select:focus-visible,
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

button {
  cursor: pointer;
  background: linear-gradient(180deg, #2b375f, #222c4c);
}

button:hover:not(:disabled) {
  border-color: var(--accent);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button.ghost {
  background: transparent;
  font-size: 12.5px;
}

/* ------------------------------ conversation ------------------------------- */

.messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 6px;
  scroll-behavior: smooth;
}

@media (prefers-reduced-motion: reduce) {
  .messages {
    scroll-behavior: auto;
  }
}

.turn {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  max-width: 92%;
  word-break: break-word;
}

.turn.user {
  align-self: flex-end;
  background: var(--user);
  border-color: #2f3d68;
}

.turn.assistant {
  align-self: flex-start;
  background: #101731;
}

.turn.assistant.streaming {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(110, 168, 254, 0.15), 0 8px 24px -18px var(--accent);
}

.turn .meta {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 6px;
  letter-spacing: 0.02em;
}

pre.code {
  background: #0a0f22;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  overflow-x: auto;
  font-size: 12.5px;
}

.notice,
.inline-error {
  margin-top: 8px;
  font-size: 12.5px;
  padding: 6px 9px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  color: var(--muted);
}

.notice.warn {
  border-color: var(--warn);
  color: var(--warn);
}

.notice.error,
.inline-error {
  border-color: var(--bad);
  color: var(--bad);
}

.jump-latest {
  position: absolute;
  right: 22px;
  bottom: 92px;
  font-size: 12.5px;
  border-color: var(--accent);
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.composer-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

#send {
  background: linear-gradient(180deg, #3b6ef5, #2b53c4);
  border-color: #3b6ef5;
}

/* ------------------------------ telemetry HUD ------------------------------ */

.hud h2 {
  font-size: 15px;
  margin: 0 0 4px;
}

.hud h3 {
  font-size: 13px;
  margin: 16px 0 6px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--muted);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
}

.metric.wide {
  grid-column: 1 / -1;
}

.metric .k {
  font-size: 11px;
  color: var(--muted);
}

.metric .v {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.metric .v[data-tone='busy'] {
  color: var(--accent);
}

.metric .v[data-tone='warn'] {
  color: var(--warn);
}

.metric .v[data-tone='bad'] {
  color: var(--bad);
}

.server-panel {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(27, 35, 64, 0.5);
  display: grid;
  gap: 6px;
}

.wire {
  max-height: 240px;
  overflow: auto;
  background: #0a0f22;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  font-size: 11.5px;
  line-height: 1.45;
  color: #9fe8b0;
  white-space: pre-wrap;
}
```


---

## 3. Block-by-Block Explanation

### Part A: `index.html` — the UI surface

#### Block 1: Transport and granularity selectors

```html
<select id="transport">
  <option value="ndjson" selected>NDJSON (application/x-ndjson)</option>
  <option value="sse">SSE (text/event-stream)</option>
  <option value="text">Raw text/plain (PDF/Tomato pattern)</option>
</select>

<select id="granularity">
  <option value="sentence" selected>sentence — natural bubbles</option>
  <option value="word">word — 3 tokens per delta</option>
  <option value="token">token — provider cadence</option>
  <option value="random">random — hostile 1–3 chars</option>
</select>
```

- **What it does:** makes transport and coalescing granularity switchable at runtime.
- **How it works:** the claim "streaming ≠ SSE" is only convincing when you can flip the transport and watch the numbers change. `random` is the hostile mode that fragments bytes mid-character — the UI stays correct, which is the point.

#### Block 2: Chaos toggles and the anti-pattern toggle

```html
<label class="checkbox"><input type="checkbox" id="chaos-stall" /> Inject a mid-stream stall (idle watchdog)</label>
<label class="checkbox"><input type="checkbox" id="chaos-error" /> Inject a mid-stream provider error (in-band <code>error</code>)</label>
<label class="checkbox"><input type="checkbox" id="chaos-ttft" /> Breach the TTFT budget</label>
<label class="checkbox danger"><input type="checkbox" id="antipattern" /> ❌ Anti-pattern mode: <code>await response.text()</code></label>
```

- **What it does:** puts every failure mode from Chapter 10 one click away, in the same UI.
- **How it works:** the three chaos boxes map directly onto `SimulationOptions` in the request body, so the browser can trigger the idle watchdog, an in-band error and a TTFT breach with no server-side tooling. The anti-pattern toggle is the most valuable one: it switches the client to `await response.text()` so the collapse is *demonstrated*, not described.

#### Block 3: Accessibility and the telemetry HUD

```html
<div id="messages" class="messages" role="log" aria-live="polite" aria-relevant="additions text"></div>
<div class="metric"><span class="k">Client TTFT</span><span class="v" id="m-client-ttft">–</span></div>
<div class="metric"><span class="k">Network reads</span><span class="v" id="m-reads">0</span></div>
<pre id="wire" class="wire"></pre>
```

- **What it does:** declares the transcript as a polite live region and exposes every measured number, including raw wire frames.
- **How it works:** `aria-live="polite"` (never `assertive`) plus sentence-granular rendering keeps a screen reader usable while text streams dozens of times per second. "Network reads" and the wire inspector exist so you can *see* that 14 chunks arrived as 15 reads — the difference between frames and reads is one of the lecture's granularity distinctions, made visible.

---

### Part B: `app.js` — the client half of the pipeline

#### Block 4: State that must not be reset between turns

```javascript
const state = {
  controller: null,       // AbortController for the in-flight request — the Stop button's whole job
  requestId: null,        // set by the `start` frame; required for cancel and catch-up
  conversationId: null,
  bubble: null,           // THE one assistant bubble (created lazily)
  rawText: '', seq: 0, reads: 0, bytes: 0, chunks: 0, heartbeats: 0,
  itlSamples: [], lastChunkAt: 0,
  sendStartedAt: 0, firstAppendAt: 0, clientTtftMs: 0, paintOffsetMs: 0,
  serverTtftMs: null, usage: null, doneSeen: false,
  carry: { line: '', sse: '' },    // ← the framing buffers
  decoder: null,
};
```

- **What it does:** holds one turn's measurements plus the two carry buffers.
- **How it works:** `carry.line` and `carry.sse` are the difference between correct and corrupted parsing — they hold the trailing partial frame between network reads. `doneSeen` stops the fallback finisher from overwriting the richer information that arrived in the `done` frame.

#### Block 5: NDJSON parsing with a carry buffer

```javascript
function parseNdjson(text, onFrame) {
  const combined = state.carry.line + text;
  const lines = combined.split('\n');
  state.carry.line = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try { onFrame(JSON.parse(line), line); } catch { recordWire('parse-error', line); }
  }
}
```

- **What it does:** is the correct way to read a line-delimited stream.
- **How it works:** `lines.pop()` keeps the last (possibly incomplete) line for the next read. Doing `text.split("\n")` per read instead — the naive approach the notes warn about — corrupts any line a network chunk happens to bisect, and the failure is intermittent, which is the worst kind.

#### Block 6: SSE parsing with the exact grammar

```javascript
function parseSse(text, onFrame) {
  const combined = state.carry.sse + text;
  const frames = combined.split('\n\n');
  state.carry.sse = frames.pop() ?? '';

  for (const frame of frames) {
    let event = 'message'; let id = null; const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;                 // heartbeat comment
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (event === 'message' && dataLines.length === 0) { onFrame({ type: 'heartbeat' }, frame); continue; }
    try { onFrame(JSON.parse(dataLines.join('\n')), frame, id); } catch { recordWire('parse-error', frame); }
  }
}
```

- **What it does:** implements the SSE wire grammar from §5.3.1 precisely.
- **How it works:** the **blank line is the delimiter** (hence `split('\n\n')` with a carry), a leading `:` means a comment/heartbeat, a line without a colon is a field name with an empty value, and multiple `data:` lines are joined with `\n`. The `id:` field is captured even though this demo resumes from the delta `seq` instead — which is a more precise cursor for this protocol.

#### Block 7: Rendering — escaping first, then a tiny markdown subset

```javascript
function renderMarkdown(source) {
  let html = escapeHtml(source);
  html = html.replace(/```([a-zA-Z0-9+-]*)\n?([\s\S]*?)(```|$)/g, (_m, _lang, body, closing) => {
    const suffix = closing === '```' ? '' : '\n▌';      // fence still open
    return `<pre class="code"><code>${body}${suffix}</code></pre>`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>')
             .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
             .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>')
             .replace(/\n/g, '<br />');
  return html;
}
```

- **What it does:** renders streamed markdown safely, and tolerates invalid partial markdown.
- **How it works:** streamed content is untrusted input, so it is **escaped first** and no raw HTML is ever inserted (unsanitised `innerHTML` of model output is an XSS hole). The fence regex accepts a missing closing fence and appends a `▌` marker, because a half-written code block is the normal state of a streaming answer — the renderer must not throw, drop text, or flicker.

#### Block 8: One repaint per animation frame

```javascript
function scheduleRender() {
  if (pending.dirty) return;
  pending.dirty = true;
  requestAnimationFrame(() => { pending.dirty = false; flushRender(); });
}

function flushRender() {
  if (!state.bubble) return;
  const wasSticky = isNearBottom();
  state.bubble.body.innerHTML = renderMarkdown(state.rawText);
  if (state.paintOffsetMs === 0 && state.firstAppendAt > 0) state.paintOffsetMs = Math.round(performance.now() - state.firstAppendAt);
  if (wasSticky) scrollToBottom(); else el.jump.hidden = false;
  updateMetrics();
}
```

- **What it does:** coalesces DOM work to one update per frame, and records the append→paint offset.
- **How it works:** parsing markdown per network chunk is the "janky renderer" anti-pattern (dozens of full re-parses per second). The dirty flag plus `requestAnimationFrame` caps it at ~60 renders/second maximum. `wasSticky` implements the respectful auto-scroll policy: only follow the text if the user was already at the bottom, otherwise show a "jump to latest" affordance instead of yanking the viewport.

---

### Part C: The reader loop, cancellation and recovery

#### Block 9: The reader loop — the four lines that matter

```javascript
async function consumeWithReader(response, transport) {
  state.decoder = new TextDecoder('utf-8');       // ONE decoder for the whole stream
  const reader = response.body.getReader();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    state.reads += 1;
    const text = state.decoder.decode(value, { stream: true });   // ← { stream: true } is the fix
    if (transport === 'text') appendText(text);
    else if (transport === 'sse') parseSse(text, applyFrame);
    else parseNdjson(text, applyFrame);
  }
  const tail = state.decoder.decode();            // ← the final flush
  /* … dispatch the tail, then finish … */
  reader.releaseLock?.();
}
```

- **What it does:** is the entire browser half of the pipeline in one function.
- **How it works:** `response.body.getReader()` gives a byte cursor; `decode(value, { stream: true })` holds back an incomplete multi-byte sequence for the next read instead of emitting `U+FFFD`; the final `decode()` flushes pending bytes. `releaseLock()` matters in framework code (React StrictMode double-invocation causes `TypeError: ReadableStream is locked`) and in any UI where a retry re-acquires a reader.

#### Block 10: The anti-pattern, kept executable

```javascript
async function consumeWithText(response) {
  const collapsed = await response.text();        // ❌ the entire backend, erased
  const elapsed = Math.round(performance.now() - startedAt);

  state.reads = 1; state.chunks = 1;
  state.bytes = new TextEncoder().encode(collapsed).length;
  state.clientTtftMs = elapsed;                   // ← client TTFT == total time
  appendNotice(`❌ Anti-pattern mode: await response.text() buffered the ENTIRE body. Client TTFT = ${elapsed} ms = total time. …`);
}
```

- **What it does:** proves §9.2 by making the client deliberately naive.
- **How it works:** `response.text()` means "read the whole body, concatenate, decode, and give it to me when it is done". The backend still streamed perfectly; one line on the client removed the experience, and every server-side dashboard stayed green. The HUD then shows client TTFT equal to total — the exact signature the `ttft_gap` metric is designed to catch.

#### Block 11: Cancellation is not an error

```javascript
function handleTransportError(error) {
  if (error?.name === 'AbortError') {
    appendNotice('⏹ Stopped by user. Partial answer preserved; AbortError is not a failure.', 'warn');
    finishTurn('aborted', 'partial text kept');
    setState('aborted', 'warn');
    return;
  }
  appendNotice(`⚠ Transport error: ${error?.message ?? error}`, 'error');
  finishTurn('transport error', '');
  setState('error', 'bad');
}

function stopStream() {
  state.controller.abort();
  if (state.requestId) {
    fetch(`/api/chat/streams/${state.requestId}/cancel`, { method: 'POST', …, keepalive: true }).catch(() => undefined);
  }
}
```

- **What it does:** treats a user-initiated stop as a first-class outcome, and cancels both sides.
- **How it works:** `AbortError` is checked *first*, because treating it as a failure is the "error toast on every Stop press" bug. The partial text stays on screen — nothing the user already read is discarded. The explicit cancel call is belt-and-braces: the socket close is normally enough, but a proxy that holds the connection open after the client leaves would otherwise keep the generation (and the bill) alive.

#### Block 12: Drop and recover

```javascript
async function dropAndRecover() {
  const requestId = state.requestId; const fromSeq = state.seq;
  stopStream();                                   // the socket dies, as on a flaky network
  await new Promise((resolve) => setTimeout(resolve, 400));

  const payload = await (await fetch(`/api/chat/streams/${requestId}/catch-up?fromSeq=${fromSeq}`)).json();
  for (const item of payload.frames) {
    if (item.payload.trim().startsWith('{')) applyFrame(JSON.parse(item.payload), item.payload);
    else if (item.payload.includes('event:')) parseSse(item.payload, applyFrame);
    else applyFrame({ type: 'delta', seq: item.seq, text: item.payload, chars: item.payload.length, bytes: … });
  }
  recordWire('catch-up', `${payload.frames.length} frame(s) replayed · lastSeq=${payload.lastSeq} · inflight=${payload.inflight}`);
}
```

- **What it does:** demonstrates the recovery path a real client needs after a network drop.
- **How it works:** the client remembers the highest `seq` it applied and asks for everything after it. Frames come back **verbatim**, so the same dispatch function consumes them — no second parsing path. Even when nothing was missed, the replayed terminal frames tell the client *why* the stream ended, which is information a dead socket can never deliver.

#### Block 13: Reporting the TTFT the user felt

```javascript
const data = await (await fetch('/api/observability/client-ttft', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: state.requestId ?? undefined, serverTtftMs: state.serverTtftMs ?? undefined, clientTtftMs: state.clientTtftMs }),
})).json();
if (typeof data.gapMs === 'number') el.metrics.ttftGap.textContent = `${data.gapMs} ms`;
```

- **What it does:** closes the observability loop between the two halves of the pipeline.
- **How it works:** the server measured its own TTFT and sent it in the `done` frame; the client measured the TTFT the user actually felt. Posting both produces `ttft_gap_ms` server-side — the metric that detects proxy buffering, a buffering middleware, or a frontend regression. Nothing else in a typical dashboard catches that class of failure. Telemetry failures are swallowed: measurement must never break the chat.

#### Block 14: Wiring, and the turn state that is deliberately not reset

```javascript
function resetTurnState() {
  state.bubble = null; state.rawText = ''; state.seq = 0; state.chunks = 0;
  state.carry.line = ''; state.carry.sse = ''; state.doneSeen = false;
  // NOTE: `conversationId` is deliberately NOT reset — that is what makes this a
  // multi-turn conversation and exercises the server's dual-write history.
  updateMetrics();
}

document.getElementById('composer').addEventListener('submit', onSubmit);
el.stop.addEventListener('click', stopStream);
el.drop.addEventListener('click', dropAndRecover);
el.prompt.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) onSubmit(event); });
el.messages.addEventListener('scroll', () => { if (isNearBottom()) el.jump.hidden = true; });
```

- **What it does:** resets per-turn measurements while preserving the conversation.
- **How it works:** keeping `conversationId` across turns is what turns the demo into a *conversation*: every subsequent turn exercises the dual-write history, the context budget and the per-conversation lock on the server. The `scroll` listener re-hides the "jump to latest" button once the user returns to the bottom, so the affordance never becomes clutter.

---

### ✅ Chapter 14 verification

1. Open **http://localhost:8090/** and send a message with each transport.
2. Tick **❌ Anti-pattern mode** → client TTFT equals total time and nothing paints early.
3. Tick **Inject a mid-stream provider error** → an in-band error chip appears, partial text kept.
4. Press **Stop** mid-answer → no error state, partial text preserved, server logs `stream.aborted`.
5. Press **Drop & recover** → the catch-up line reports the replayed frames.
6. Scroll up while streaming → the viewport does not jump; a "jump to latest" button appears.
7. Ask a follow-up question → the server log line shows a larger `promptTokens` (history was sent).





---

**Previous:**  · **Next:** 
