# Chapter 01 — Project Structure & File Map

> **Goal of this chapter:** before reading a single line of JavaScript, understand *the map*:
> every folder, every file, what it is for, and the order in which the files depend on each
> other. This is the "explain the overall file structure" chapter you start from.
>
> **Lecture chapters:** [01 — Why Text-Only AI Is Not Enough](../../../notes/01_Why_Text_Only_AI_Is_Not_Enough.md)
> and [02 — What Multimodal Models Understand, and OCR vs MLLM](../../../notes/02_What_Multimodal_Models_Understand_And_OCR_vs_MLLM.md).

---

## 1.1 What the project is (in one paragraph)

It is **one Express application** that implements the whole multimodal pipeline from the
notes, plus a `/chat` route whose contract is the lecture board's: **text or image in, text
out**. It runs **offline with no API key**: `npm run demo` walks Chapters 03–08 with no
network call at all, and `POST /chat` answers from the pipeline instead of a model. Add a key
and the *same request* goes to a real multimodal model — which is Chapter 07's entire point:
**the application packages the request; it never understands the image.**

That single design choice — *no vision logic in the request path* — is why `src/` contains a
lot of measuring and almost no "understanding".

---

## 1.2 Prerequisites

| Requirement | Version | Why it is needed |
|---|---|---|
| **Node.js** | `>= 20.0.0` | declared in `package.json` `engines.node`; the code uses ESM, `node:url`, and the tests use `fetch` + `FormData` |
| **npm** | recent | installs the dependencies and runs the scripts in `package.json` |

Verify before you start:

```bash
node --version    # must print v20.x or newer (this guide was verified on v24.22.0)
npm --version
```

---

## 1.3 The complete file structure

```text
Basic Code/
├── .env                        # local runtime values (port, model, patch size, budget); gitignored
├── .env.example                # committed template that `.env` is copied from
├── package.json                # project metadata, dependencies, npm scripts
├── package-lock.json           # the exact dependency tree npm install resolved
├── README.md                   # the project's own overview (short)
├── app.test.js                 # `npm test` — the pipeline and the HTTP contract
├── implementations guide/      # this guide
└── src/
    ├── index.js                # Chapter 10 — the entry point: config → service → HTTP
    ├── demo.js                 # Chapter 10 — the whole pipeline offline, one screen
    ├── config/
    │   └── config.js           # Chapter 02 — every constant the pipeline needs
    ├── middleware/
    │   └── upload.js           # Chapter 07 — the untrusted-image gate + safe errors
    ├── routes/
    │   └── index.js            # Chapter 09 — the /chat contract (three routes)
    ├── controllers/
    │   └── chatController.js   # Chapter 09 — validate, delegate, render
    └── services/
        ├── textPipeline.js     # Chapter 03 — Text → Tokens → IDs → Vectors
        ├── visionPipeline.js   # Chapter 04 — Pixels → Patches → Embeddings
        ├── alignmentService.js # Chapter 05 — position, projection, attention
        ├── costService.js      # Chapter 06 — the image token budget
        └── chatService.js      # Chapter 08 — the multimodal call + history
```

`node_modules/` is intentionally **not** listed: it is created by `npm install` and is
gitignored. There is no `dist/` because this project runs from source — there is no build step.

### File-by-file role

| File | Layer | Owns | Who reads it |
|---|---|---|---|
| `package.json` | project | dependencies + the `npm run …` scripts | npm / you |
| `.env` | project | runtime values that must not be hard-coded | `src/config/config.js` |
| `src/config/config.js` | config | every constant: model, patch size, limits, system prompt | every other module |
| `src/services/textPipeline.js` | service | text → tokens → IDs → vectors | `demo.js`, `chatController` |
| `src/services/visionPipeline.js` | service | measuring and patchifying an image | `chatService`, `demo.js` |
| `src/services/alignmentService.js` | service | position, projection, cosine, attention | `demo.js` |
| `src/services/costService.js` | service | image token arithmetic + the budget decision | `chatService`, `demo.js` |
| `src/services/chatService.js` | service | the provider call, history, compaction | `controllers/` |
| `src/middleware/upload.js` | middleware | multipart parsing, type/size gates, error translation | `routes/` |
| `src/controllers/chatController.js` | controller | HTTP in / HTTP out | `routes/` |
| `src/routes/index.js` | routes | the URL surface | `src/index.js` |
| `src/index.js` | entry | assembling app + starting the server | `node`, `app.test.js` |
| `src/demo.js` | script | the offline walkthrough | `node`, you |

> **Why so many layers for three routes?** Because the lecture's content is not the routes —
> it is the pipeline behind them. Splitting the pipeline into one file per chapter is what
> makes this code readable *as the notes*. A single 200-line `server.js` would work and teach
> nothing.


---

## 1.4 `package.json` (full file)

**Path:** `Basic Code/package.json`

```json
{
  "name": "lecture-16-multimodal-basics",
  "version": "1.0.0",
  "private": true,
  "description": "Lecture 16 — Multimodal AI: How LLMs Understand Images. The minimal, runnable code behind the notes: the text pipeline, the vision pipeline, alignment, the /chat contract and the image cost guard.",
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "demo": "node src/demo.js",
    "test": "node --test"
  },
  "keywords": [
    "fde",
    "multimodal",
    "vision",
    "patches",
    "embeddings",
    "llm"
  ],
  "license": "MIT",
  "dependencies": {
    "dotenv": "^17.0.0",
    "express": "^5.0.0",
    "multer": "^2.0.0",
    "openai": "^6.0.0"
  }
}
```

### Block-by-block explanation

**Block 1 — identity**

```json
"name": "lecture-16-multimodal-basics",
"version": "1.0.0",
"private": true,
```

- `name` / `version` identify the package. `private: true` prevents an accidental
  `npm publish` — this is teaching code, not a library.

**Block 2 — the single most important line**

```json
"type": "module",
```

- This makes every `.js` file an **ES module**, so `import` / `export` work and top-level
  `await` is allowed. Without it, Node would treat these files as CommonJS and every
  `import` statement in the project would fail.
- It is also why imports inside the code end in `.js` (`from './config/config.js'`): in ESM
  you import the **file name**, and the file name really is `.js`.

**Block 3 — the engine floor**

```json
"engines": { "node": ">=20.0.0" },
```

- Node 20 is the floor because the project uses `node --watch`, the built-in test runner
  (`node --test`), and `fetch` + `FormData` in `app.test.js` — all stable from Node 20.

**Block 4 — the four scripts**

```json
"scripts": {
  "start": "node src/index.js",
  "dev":   "node --watch src/index.js",
  "demo":  "node src/demo.js",
  "test":  "node --test"
}
```

- `start` — run the HTTP server once.
- `dev` — the same, but `--watch` restarts the process when a file changes.
- `demo` — the offline walkthrough (Chapters 03–08). **Start here.** No key needed.
- `test` — Node's built-in runner discovers `*.test.js`. No test framework to install.

**Block 5 — the four dependencies**

```json
"dependencies": {
  "dotenv": "^17.0.0",
  "express": "^5.0.0",
  "multer": "^2.0.0",
  "openai": "^6.0.0"
}
```

| Dependency | Why it is here | Where it is used |
|---|---|---|
| `dotenv` | loads `.env` so limits are configuration, not code | `src/config/config.js` |
| `express` | the HTTP surface | `src/index.js`, `src/routes/index.js` |
| `multer` | parses `multipart/form-data` — the only way a file arrives | `src/middleware/upload.js` |
| `openai` | the multimodal model client | `src/services/chatService.js` |

> **Notice what is *not* there.** No `sharp`/`jimp` (we measure dimensions from the header
> instead of decoding), no `tiktoken` (the cost formula is arithmetic, Chapter 08.2), no test
> framework, no `tsx`/`typescript`. Every dependency you do not add is a concept the reader
> does not have to learn before reaching the lecture's point.

---

## 1.5 `.env` and `.env.example` (full files)

**Path:** `Basic Code/.env.example` (committed template)

```dotenv
# Lecture 16 — Multimodal AI: How LLMs Understand Images
# Copy this file to `.env` and fill in what you need. `.env` is gitignored.

# Chapter 07 — the HTTP server the browser/app talks to.
PORT=8080
HOST=127.0.0.1

# Chapter 07 — the multimodal model that does the reasoning.
# Leave OPENAI_API_KEY empty and the app still runs: POST /chat answers offline,
# and `npm run demo` walks the whole pipeline without any model call.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# Chapter 04 / 08 — the patch grid. Fixed at training time, so we never tune it
# per request; we tune the RESOLUTION instead. It is also what sets the token cost.
PATCH_SIZE=16

# Chapter 08.2 — the per-image token budget. 8160 ≈ 1920 x 1080 at 16 x 16 patches,
# which is exactly the board's `cat.jpg`.
MAX_IMAGE_TOKENS=8160
```

**Path:** `Basic Code/.env` (your local copy — gitignored, same keys)

```dotenv
# Lecture 16 — Multimodal AI: How LLMs Understand Images
# Local runtime values. Gitignored — see `.env.example` for the template.

PORT=8080
HOST=127.0.0.1

# Leave empty to run offline (POST /chat answers offline, `npm run demo` needs no key).
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

PATCH_SIZE=16
MAX_IMAGE_TOKENS=8160
```

### Block-by-block explanation

**Block 1 — the server**

```dotenv
PORT=8080
HOST=127.0.0.1
```

- `HOST=127.0.0.1` binds to **loopback only**. The server is deliberately not exposed on
  `0.0.0.0`, because an endpoint that accepts arbitrary images and forwards them to a paid
  model is not something to leave open by accident.

**Block 2 — the model**

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

- `OPENAI_API_KEY` is **empty by default**. That is a feature: the whole project runs, and
  the whole test suite passes, without a credential. Chapter 07's point is that the request
  shape is identical whether a model answers or not — so leaving the key out proves it.
- `OPENAI_MODEL` is configuration because Chapter 08.8's decision framework is exactly this:
  which model, at which price, for which vision task.

**Block 3 — the patch grid**

```dotenv
PATCH_SIZE=16
```

- The board's "16 * 16 regions". Chapter 04.8 warns that **you cannot tune patch size per
  request** — it is fixed at training time. It is in `.env` anyway so the *arithmetic* is
  visible and adjustable while you learn; in a real system you would leave it alone and tune
  the **resolution** instead.

**Block 4 — the budget**

```dotenv
MAX_IMAGE_TOKENS=8160
```

- Chapter 08.2's budget rule made configurable. `8160 = (1920/16) × (1080/16)`, i.e. exactly
  the board's `cat.jpg` — so the default budget accepts the lecture's own example and rejects
  the 12 MP photo, which is the lesson.

> **Why a `.env` at all?** So the numbers that cost money are *configuration*. Changing the
> budget is a deploy, not a code review — and Chapter 08's "compute the budget before you
> build the demo" becomes a one-line edit instead of a refactor.

---

## 1.6 What is intentionally missing

| Not present | Why |
|---|---|
| `dist/` | the project runs from source; there is no build step |
| a database | the conversation lives in memory (`chatService.history`) |
| a real tokenizer or vision encoder | both are the provider's job — Chapters 03–04 are *shown*, not reimplemented |
| a frontend | three routes do not need one, and `curl` shows the contract more honestly |
| TypeScript / `tsconfig.json` | the existing Lecture 16 code is plain ESM JavaScript; keeping it that way means nothing to compile before you can read it |
| an image-processing library | `readDimensions` reads the header directly — 20 lines instead of a dependency |

---

## 1.7 Run / verify

```bash
cd "Lecture 16/code/Basic Code"
npm install          # if you have not already
npm run demo         # the offline walkthrough — six sections, no network
npm test             # 5 tests, no API credits spent
```

Expected: `demo` prints the six numbered sections, and `test` reports `pass 5 / fail 0`.

---

## 1.8 Checkpoint

Before moving on, you should be able to answer:

1. **Which file would you edit to change the per-image token budget** without touching any
   JavaScript? → `.env` (`MAX_IMAGE_TOKENS`).
2. **Which layer would you delete if you only cared about the HTTP contract** and not the
   lecture's internals? → `src/services/` minus `chatService.js` — the pipelines exist to
   *demonstrate* Chapters 03–08, not to serve the route.
3. **Why does `import … from './config/config.js'` end in `.js`** when there is no build step?
   → `"type": "module"` means the import specifier is a real file path, and the file is `.js`.

**Next:** [Chapter 02 — Config: Model, Limits & System Prompt](./02_Config_Model_Limits_and_System_Prompt.md)

