# Chapter 10 — Entry Point & Offline Demo

> **Goal of this chapter:** wire the pieces together, and then *prove* the whole lecture runs on
> your machine. `src/index.js` assembles the app; `src/demo.js` executes the seven-step ladder
> from Chapter 07.7 with no model and no network.
>
> **Lecture chapters:** [07 — The End-to-End Multimodal Pipeline](../../../notes/07_The_End_To_End_Multimodal_Pipeline.md)
> and [08 — Production](../../../notes/08_Production_Multimodal_Systems_Cost_Security_And_Evaluation.md).

---

## 10.1 File details

| | |
|---|---|
| **Path A** | `src/index.js` |
| **Purpose A** | build the Express app and start the server |
| **Imports A** | `express`, `node:url` (`pathToFileURL`), `config`, `errorHandler`, `createRouter`, `ChatService` |
| **Exports A** | `createApp(chatService)`, `startServer()` |
| **Path B** | `src/demo.js` |
| **Purpose B** | print Chapters 03–08 in one screen, offline |
| **Imports B** | `config` + the four pipeline services + `buildUserMessage` |
| **Exports B** | none — it is a script, run for its side effect |
| **Who imports them** | `node` (`npm start`, `npm run demo`); `app.test.js` imports `createApp` |
| **Depends on** | everything else |

**Commands**

```bash
cd "Lecture 16/code/Basic Code"
npm run demo     # the offline walkthrough — no API key, no network
npm start        # the HTTP server
```

---

## 10.2 Full file — the entry point

**Path:** `src/index.js`

```js
// Lecture 16 · Chapter 07 — the application entry point.
//
// It wires three things and nothing else: config -> service -> HTTP. Everything the
// lecture calls "the plumbing" is assembled here; everything it calls "the vision"
// lives behind the provider's API.
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config } from './config/config.js';
import { errorHandler } from './middleware/upload.js';
import { createRouter } from './routes/index.js';
import { ChatService } from './services/chatService.js';

// Exported so tests can build the app without opening a port.
export function createApp(chatService) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(chatService));
  app.use(errorHandler); // Chapter 08.4 — last stop, so it can catch everything above
  return app;
}

export function startServer() {
  const chatService = new ChatService();
  const app = createApp(chatService);
  return app.listen(config.port, config.host, () => {
    console.log(`Vision Chat is running at http://${config.host}:${config.port}`);
    console.log(
      process.env.OPENAI_API_KEY
        ? `Model: ${config.model}`
        : 'No OPENAI_API_KEY — POST /chat answers offline. Run `npm run demo` for the pipeline.',
    );
  });
}

// Only listen when this file is the entry point, so `import { createApp }` in the
// tests never opens a socket.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
```

---

## 10.3 Full file — the offline demo

**Path:** `src/demo.js`

```js
// Lecture 16 · the whole pipeline, offline, in one command:  npm run demo
//
// Nothing here calls a model. Chapters 03-06 are arithmetic and hashing, so they are
// reproducible on any machine; Chapter 07 shows the request we WOULD send; Chapter 08
// prices it. This is the seven-step ladder from Chapter 07.7, executed.
import { config } from './config/config.js';
import { alignmentScore, attention, averageVector, positionOf, project, trainingPair } from './services/alignmentService.js';
import { buildUserMessage } from './services/chatService.js';
import { conversationCost, estimateImageTokens, guardImage } from './services/costService.js';
import { runTextPipeline } from './services/textPipeline.js';
import { runVisionPipeline } from './services/visionPipeline.js';

const QUESTION = 'Why is my payment failing?';
const DESCRIPTION = 'a screenshot of a failed payment';
const IMAGE = { mimetype: 'image/png', buffer: fakePng(1920, 1080) };

// A minimal PNG header is enough: `readDimensions` only needs the IHDR chunk, so the
// demo needs no binary asset checked into the repo.
function fakePng(width, height) {
  const buffer = Buffer.alloc(24);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
  buffer.writeUInt32BE(13, 8); // IHDR length
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

const section = (title) => console.log(`\n${title}`);
const vector = (values) => `[${values.join(', ')}]`;

console.log('Lecture 16 — how an LLM understands an image (offline walkthrough)');
console.log(`text: "${QUESTION}"   image: ${IMAGE.mimetype} 1920 x 1080`);

// ---- Chapter 03 — Text → Tokens → Token IDs → Vectors -----------------------------
section('1. TEXT PIPELINE (Chapter 03) — the model never sees English');
const text = runTextPipeline(QUESTION);
console.log(`   tokens     : ${text.map((token) => token.token).join(', ')}`);
console.log(`   token IDs  : ${text.map((token) => token.id).join(', ')}`);
console.log(`   vector     : ${vector(text[0].vector)}  (v1, v2, v3 ...)`);

// ---- Chapter 04 — Pixels → Patches → Visual Embeddings ---------------------------
section('2. VISION PIPELINE (Chapter 04) — an image is already numbers');
const vision = runVisionPipeline(IMAGE.buffer);
console.log(`   pixels     : ${vision.dimensions.width * vision.dimensions.height} (~${vision.rawNumbers} raw numbers)`);
console.log(`   patch grid : ${vision.rows} x ${vision.cols} patches of ${vision.patchSize} x ${vision.patchSize}`);
console.log(`   patch count: ${vision.patches.length} visual units (a grid became a sequence)`);
console.log(`   p1 vector  : ${vector(vision.patches[0].vector)}`);

// ---- Chapter 05 — Position, Projection, Attention --------------------------------
section('3. CONNECTING VISION TO LANGUAGE (Chapter 05)');
const firstPatch = vision.patches[0];
const lastPatch = vision.patches.at(-1);
console.log(`   p1 position: ${positionOf(firstPatch, vision)}   last patch: ${positionOf(lastPatch, vision)}`);
console.log(`   projected  : ${vector(project(firstPatch.vector))}  (into the language model space)`);
console.log('   attention  : which patch does each word lean on?');
// Shown over the first 8 patches only. Attention over all 8,160 would just report the
// argmax of 8,160 random similarities, which is always ≈ 1 and teaches nothing. In a
// real model these weights come from a softmax inside every layer, and they are LEARNED.
for (const row of attention(text, vision.patches.slice(0, 8))) {
  console.log(`      "${row.token}" -> patch ${row.patch} (score ${row.score})`);
}

// ---- Chapter 06 — Alignment -------------------------------------------------------
section('4. HOW IT LEARNS IT (Chapter 06) — training data is images + description');
// Pooled over a SAMPLE of patches: a real model learns its pooling step, and the mean
// of thousands of unrelated vectors would collapse to zero and say nothing.
const pair = trainingPair(DESCRIPTION, vision.patches.slice(0, 32));
const descriptionVector = averageVector(runTextPipeline(DESCRIPTION).map((token) => token.vector));
console.log(`   training pair : image + "${pair.description}"`);
console.log(`   image vector  : ${vector(pair.imageVector)}`);
console.log(`   text vector   : ${vector(descriptionVector)}`);
console.log(`   alignment     : ${alignmentScore(descriptionVector, pair.imageVector)}  (cosine, -1..1; training pushes it up)`);

// ---- Chapter 07 — the request we would send ---------------------------------------
section('5. THE REQUEST (Chapter 07) — the app packages, it does not interpret');
const message = buildUserMessage(QUESTION, IMAGE);
console.log(`   role     : ${message.role}`);
console.log(`   parts    : ${message.content.map((part) => part.type).join(' + ')}`);
console.log(`   transport: data:${IMAGE.mimetype};base64,... (inline, so no user URL is fetched)`);
console.log('   contract : Client --/chat--> LLM, "Text / Image -> Text"');

// ---- Chapter 08 — cost ------------------------------------------------------------
section('6. COST GUARD (Chapter 08) — images are expensive tokens');
const tokens = estimateImageTokens(vision.dimensions);
const decision = guardImage(vision.dimensions);
console.log(`   image tokens : ${tokens} = (${vision.dimensions.width}/${vision.patchSize}) x (${vision.dimensions.height}/${vision.patchSize})`);
console.log(`   budget       : ${config.maxImageTokens}`);
console.log(`   decision     : ${decision.action}`);
console.log(`   12 MP image  : ${guardImage({ width: 4000, height: 3000 }).action} (${estimateImageTokens({ width: 4000, height: 3000 })} tokens)`);
console.log(`   conversation : ${conversationCost(tokens, 10)} tokens for ONE image over 10 turns`);

console.log('\nRun `npm start` and POST to /chat to use the real multimodal model.');
```


---

## 10.4 Block-by-block explanation — `src/index.js`

**Block 1 — `createApp(chatService)`: assembly only**

```js
export function createApp(chatService) {
  const app = express();
  app.use(express.json());
  app.use(createRouter(chatService));
  app.use(errorHandler);
  return app;
}
```

- **Three `use` calls, and the order is the design.**
  1. `express.json()` parses a JSON body, so an `application/json` client works as well as a
     multipart one. (For `multipart/form-data` it is a no-op — multer handles that.)
  2. `createRouter(chatService)` mounts the three routes.
  3. `errorHandler` is registered **last**, so it sits at the bottom of the stack and catches
     everything raised by the two above it. Registering it first would mean errors from the
     routes never reached it.
- `createApp` takes the service as a parameter rather than constructing it. That one decision is
  what lets `app.test.js` inject a **fake client** and exercise the whole HTTP path — multipart
  parsing, validation, the 413 guard, history — with no API call.
- It returns the app and does **not** call `listen`. Separating "build" from "start" is the same
  discipline as `createRouter`: construction should be free of side effects.

**Block 2 — `startServer()`: the only side effect**

```js
export function startServer() {
  const chatService = new ChatService();
  const app = createApp(chatService);
  return app.listen(config.port, config.host, () => { ... });
}
```

- Constructs the service with its **default** client. `ChatService`'s constructor calls
  `createClient()`, which returns `null` when there is no API key — so the offline behaviour is
  decided in one place (`chatService.js`), not here.
- `app.listen(config.port, config.host, callback)` — passing `config.host` binds to
  `127.0.0.1` only (Chapter 02), so the endpoint is not reachable from the network.
- The startup log **tells you which mode you are in**:

  ```text
  Vision Chat is running at http://127.0.0.1:8080
  No OPENAI_API_KEY — POST /chat answers offline. Run `npm run demo` for the pipeline.
  ```

  A server that silently behaves differently with and without a credential is a debugging trap;
  saying it out loud at boot is the fix.
- Returning the server object is a small courtesy: tests and tooling can call `.close()` on it.

**Block 3 — the "am I the entry point?" guard**

```js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
```

- **What it does:** starts the server only when this file was *run*, not when it was *imported*.
- `process.argv[1]` is the script Node was asked to execute. `pathToFileURL` converts that path
  into the same `file://…` form that `import.meta.url` uses, so the two can be compared
  correctly. Comparing a raw path against a URL string would always be `false` — and would
  silently never start the server.
- `process.argv[1] &&` guards the case where Node was started with no script argument.
- **Why this matters concretely:** `app.test.js` does
  `import { createApp } from './src/index.js'`. Without the guard, importing the module would
  also call `listen(8080)` — the tests would collide with a running dev server, and every test
  run would leak a listening socket.
- This is the ESM equivalent of CommonJS's `require.main === module`.


---

## 10.5 Block-by-block explanation — `src/demo.js`

**Block 1 — the header and the imports**

```js
import { config } from './config/config.js';
import { alignmentScore, attention, averageVector, positionOf, project, trainingPair } from './services/alignmentService.js';
import { buildUserMessage } from './services/chatService.js';
import { conversationCost, estimateImageTokens, guardImage } from './services/costService.js';
import { runTextPipeline } from './services/textPipeline.js';
import { runVisionPipeline } from './services/visionPipeline.js';
```

- Six imports, one per service — the dependency graph of the whole project, written out. Read
  only this block and you can see what the lecture's pipeline is made of.
- Note it imports `buildUserMessage` but **not** `ChatService`. The demo shows the *message we
  would send* (Chapter 07), not a model call — which is why it needs no API key.

**Block 2 — the fixed inputs**

```js
const QUESTION = 'Why is my payment failing?';
const DESCRIPTION = 'a screenshot of a failed payment';
const IMAGE = { mimetype: 'image/png', buffer: fakePng(1920, 1080) };
```

- `QUESTION` is the notes' own example (Chapter 07.1). `DESCRIPTION` is the Chapter 06
  *description* half of a training pair. Both are constants so the demo is reproducible.
- `IMAGE` is shaped like a multer file (`mimetype` + `buffer`) so it can be passed to
  `buildUserMessage` and `runVisionPipeline` exactly as a real upload would be. Faking the
  *shape* rather than the *source* means every downstream function is the real one.

**Block 3 — `fakePng`: a 24-byte image**

```js
function fakePng(width, height) {
  const buffer = Buffer.alloc(24);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
  buffer.writeUInt32BE(13, 8); // IHDR length
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
```

- **What it does:** builds the smallest buffer that `readDimensions` (Chapter 04) will accept —
  the 8-byte PNG signature, the `IHDR` chunk header, and the width/height fields at bytes 16
  and 20.
- **Why not ship a real image?** Because the demo only ever needs two integers. A 24-byte
  synthetic header means the repository has **no binary asset**, and the demo runs identically
  on every machine. It also makes Chapter 04's byte offsets concrete: you can see exactly which
  bytes the reader cares about.
- `Buffer.alloc(24)` zero-fills; `write(..., 0, 'latin1')` writes the signature byte-for-byte
  (the `\x89` would be mangled by `utf8`, which is why `latin1` is specified).

**Block 4 — the two print helpers**

```js
const section = (title) => console.log(`\n${title}`);
const vector = (values) => `[${values.join(', ')}]`;
```

- `section` prints a blank line then the heading — enough structure for six sections without a
  logging library.
- `vector` formats an array as `[0.18, 0.34, ...]`, the notation the board uses.
- Both are one-liners. A demo that needs a formatting library has stopped being a demo.

**Block 5 — sections 1–6, one chapter each**

Every section follows the same three-step shape: print a heading naming the chapter, call the
service, print the interesting fields. Read them in order and you have the lecture:

| Section | Calls | Shows |
|---|---|---|
| 1 | `runTextPipeline` | tokens, token IDs, one vector |
| 2 | `runVisionPipeline` | pixels, raw numbers, patch grid, patch count, `p1` vector |
| 3 | `positionOf`, `project`, `attention` | `top-left` / `bottom-right`, the projected vector, per-word patch |
| 4 | `trainingPair`, `averageVector`, `alignmentScore` | the pair, both vectors, the cosine |
| 5 | `buildUserMessage` | role, content parts, transport, the contract |
| 6 | `estimateImageTokens`, `guardImage`, `conversationCost` | tokens, budget, decision, the 12 MP case, the 10-turn cost |

- **`.at(-1)`** in section 3 is the modern way to write "the last element" — clearer than
  `vision.patches[vision.patches.length - 1]`.
- **`vision.patches.slice(0, 8)`** and **`.slice(0, 32)`** are the two deliberate sample sizes
  discussed in Chapter 05: a small candidate set for attention (or the argmax saturates at 1),
  and a small sample for pooling (or the mean collapses to zero). Both are commented in place,
  because they look like arbitrary constants otherwise.
- Section 5 prints `message.content.map((part) => part.type)` → `text + image_url`. That single
  line is the board's *"Text / Image → Text"* contract made visible.
- Section 6 calls `guardImage({ width: 4000, height: 3000 })` a second time on purpose, so the
  `crop-or-downscale` branch is demonstrated rather than merely described.

**Block 6 — the closing hint**

```js
console.log('\nRun `npm start` and POST to /chat to use the real multimodal model.');
```

- The demo proves the pipeline; the last line points at the next step. Same pattern as
  Lecture 15's offline `askModel` echo: show what would happen, then tell the reader how to make
  it real.


---

## 10.6 Run / verify

```bash
cd "Lecture 16/code/Basic Code"
npm run demo
```

Expected: the six sections shown in [`../README.md`](../README.md), ending with:

```text
6. COST GUARD (Chapter 08) — images are expensive tokens
   image tokens : 8160 = (1920/16) x (1080/16)
   budget       : 8160
   decision     : send
   12 MP image  : crop-or-downscale (47000 tokens)
   conversation : 81600 tokens for ONE image over 10 turns

Run `npm start` and POST to /chat to use the real multimodal model.
```

Then:

```bash
npm start
```

Expected:

```text
Vision Chat is running at http://127.0.0.1:8080
No OPENAI_API_KEY — POST /chat answers offline. Run `npm run demo` for the pipeline.
```

Put a key in `.env` and restart: the boot line changes to `Model: gpt-4o-mini`, and `POST /chat`
answers with real model output. **Nothing else changes** — which is the final proof of
Chapter 07's claim.

---

## 10.7 Checkpoint

1. **Why is `errorHandler` registered last in `createApp`?** → so it sits at the bottom of the
   stack and catches errors raised by everything above it.
2. **What breaks if you delete the `import.meta.url` guard?** → importing `createApp` in the
   tests would also start a server on port 8080.
3. **Why does `demo.js` not need an API key?** → Chapters 03–06 are arithmetic and hashing, and
   section 5 only *builds* the request; nothing is sent.

---

## 10.8 Where to go next

You have now read every file in the project. Three good next steps:

1. **Turn the model on.** Put a key in `.env`, restart, and `POST /chat` a real screenshot.
   Compare the answer against the offline reply — same request, different answer.
2. **Change the budget.** Set `MAX_IMAGE_TOKENS=2000` and watch the guard start rejecting the
   board's own `cat.jpg`. That is Chapter 08.2 in one edit.
3. **Harden it.** The same chapters, taken further with validated config, structured logging,
   metrics and a real error taxonomy, are the natural next step from this baseline.

**Back to:** [Guide index](./README.md) · [Lecture 16 notes](../../../notes/README.md) · [Basic Code README](../README.md)

