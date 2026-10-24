// Lecture 16 — Basic Code tests. Run with:  npm test
//
// These exercise the real HTTP + multipart path without spending API credits, and
// they pin the four claims the lecture makes in code: the text pipeline is
// deterministic, an image becomes a patch sequence, cost grows with area, and a
// failed turn is never committed to history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './src/index.js';
import { ChatService } from './src/services/chatService.js';
import { runTextPipeline } from './src/services/textPipeline.js';
import { readDimensions, toPatches } from './src/services/visionPipeline.js';
import { estimateImageTokens, guardImage } from './src/services/costService.js';

// A minimal PNG header: enough for `readDimensions` to report a real size.
function png(width, height) {
  const buffer = Buffer.alloc(24);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('Chapter 03 — the text pipeline is deterministic: tokens, IDs, vectors', () => {
  const first = runTextPipeline('HI, my name is Aditya');
  const second = runTextPipeline('HI, my name is Aditya');
  assert.deepEqual(first, second);
  assert.equal(first[0].token, 'hi');
  assert.equal(first[0].vector.length, 8);
  assert.equal(typeof first[0].id, 'number');
});

test('Chapter 04 — an image becomes a sequence of patches', () => {
  const dimensions = readDimensions(png(1920, 1080));
  assert.deepEqual(dimensions, { width: 1920, height: 1080 });
  const { rows, cols, patches } = toPatches(dimensions);
  assert.equal(cols, 120);
  assert.equal(rows, 68);
  assert.equal(patches.length, rows * cols);
});

test('Chapter 04 — an unmeasurable image is rejected, not guessed', () => {
  assert.throws(() => readDimensions(Buffer.from('not an image')), /only PNG and JPEG/);
});

test('Chapter 08 — image cost scales with area', () => {
  assert.equal(estimateImageTokens({ width: 512, height: 512 }), 1024);
  assert.equal(estimateImageTokens({ width: 1024, height: 1024 }), 4096);
  assert.equal(estimateImageTokens({ width: 1920, height: 1080 }), 8160);
  assert.equal(guardImage({ width: 4000, height: 3000 }).action, 'crop-or-downscale');
  assert.equal(guardImage({ width: 512, height: 512 }).action, 'send');
});

test('Chapter 07 — /chat, history, reset, validation and provider failure', async () => {
  const requests = [];
  let fail = false;
  const client = {
    chat: {
      completions: {
        async create(request) {
          requests.push(structuredClone(request));
          if (fail) throw new Error('Simulated provider failure');
          return { choices: [{ message: { content: 'Test reply' } }] };
        },
      },
    },
  };
  const service = new ChatService(client);
  const server = createApp(service).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (message, image) => {
    const form = new FormData();
    if (message !== undefined) form.append('message', message);
    if (image) form.append('image', image, 'upload.png');
    return fetch(`${url}/chat`, { method: 'POST', body: form });
  };

  try {
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.patchSize, 16);

    // A text-only turn: the "Text" half of the contract.
    let response = await send('Hello');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.equal(await response.text(), 'Test reply');
    assert.equal(requests[0].messages[0].role, 'system');
    assert.match(requests[0].messages[0].content, /UNTRUSTED DATA/);

    // A text + image turn: the "Image" half, encoded as content parts.
    response = await send('Describe it', new Blob([png(512, 512)], { type: 'image/png' }));
    assert.equal(response.status, 200);
    const content = requests[1].messages.at(-1).content;
    assert.equal(content[0].text, 'Describe it');
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    // Internal bookkeeping must never reach the provider.
    assert.equal(requests[1].messages.at(-1).imageDigest, undefined);

    // Reset drops the history, so the next turn is a fresh two-message request.
    assert.equal((await fetch(`${url}/chat`, { method: 'DELETE' })).status, 200);
    await send('New conversation');
    assert.equal(requests.at(-1).messages.length, 2);

    // Chapter 08 — the gates.
    assert.equal((await send(undefined)).status, 400); // no message
    assert.equal((await send('Bad file', new Blob(['x'], { type: 'text/plain' }))).status, 400); // wrong type
    assert.equal((await send('Too big', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' }))).status, 413);
    assert.equal((await send('Too costly', new Blob([png(8000, 6000)], { type: 'image/png' }))).status, 413);

    // A failed provider call is reported as 502 and never committed to history.
    const committed = service.history.length;
    fail = true;
    assert.equal((await send('Failure')).status, 502);
    assert.equal(service.history.length, committed);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
