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
