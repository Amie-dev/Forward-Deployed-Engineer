# Lecture 16 — Multimodal AI: How LLMs Understand Images (Basic Code)

> **The code behind the notes.** One small Express application that implements every
> load-bearing idea in [`../../notes`](../../notes/README.md): text becomes **tokens**, an
> image becomes **patches**, patches become **visual embeddings**, a **projection** makes
> them comparable, and a single `/chat` route accepts **text or image** and returns **text**.

**Runs offline.** With no API key, `POST /chat` still answers (from the pipeline, not a
model) and `npm run demo` walks Chapters 03–08 without a single network call. Add a key and
the *same request* goes to a real multimodal model — the request shape does not change, which
is Chapter 07's whole point.

```bash
cd "Lecture 16/code/Basic Code"
npm install

npm run demo     # the whole pipeline, offline, on one screen   ← start here
npm test         # the pipeline + the /chat contract
npm start        # the HTTP server on http://127.0.0.1:8080
```

`npm run demo` prints:

```text
Lecture 16 — how an LLM understands an image (offline walkthrough)
text: "Why is my payment failing?"   image: image/png 1920 x 1080

1. TEXT PIPELINE (Chapter 03) — the model never sees English
   tokens     : why, is, my, payment, failing
   token IDs  : 2657, 1905, 2035, 3103, 3613
   vector     : [0.86, 0.46, 0.25, 0.33, 0.31, -0.25, -0.65, 0.84]  (v1, v2, v3 ...)

2. VISION PIPELINE (Chapter 04) — an image is already numbers
   pixels     : 2073600 (~6220800 raw numbers)
   patch grid : 68 x 120 patches of 16 x 16
   patch count: 8160 visual units (a grid became a sequence)
   p1 vector  : [0.18, 0.34, 0.34, 0.14, 0.61, -0.8, 0.73, 0.86]

3. CONNECTING VISION TO LANGUAGE (Chapter 05)
   p1 position: top-left   last patch: bottom-right
   projected  : [0.09, 0.18, 0.19, 0.1, 0.34, -0.35, 0.42, 0.5]  (into the language model space)
   attention  : which patch does each word lean on?
      "why" -> patch 3 (score 0.626)
      "is" -> patch 2 (score 0.736)
      "my" -> patch 6 (score 0.7)
      "payment" -> patch 2 (score 0.909)
      "failing" -> patch 5 (score 0.826)

4. HOW IT LEARNS IT (Chapter 06) — training data is images + description
   training pair : image + "a screenshot of a failed payment"
   image vector  : [0, -0.01, -0.02, 0.02, 0.05, -0.02, -0.12, 0.01]
   text vector   : [0.48, 0.24, 0.22, -0.07, -0.15, 0.11, 0.42, 0.12]
   alignment     : -0.659  (cosine, -1..1; training pushes it up)

5. THE REQUEST (Chapter 07) — the app packages, it does not interpret
   role     : user
   parts    : text + image_url
   transport: data:image/png;base64,... (inline, so no user URL is fetched)
   contract : Client --/chat--> LLM, "Text / Image -> Text"

6. COST GUARD (Chapter 08) — images are expensive tokens
   image tokens : 8160 = (1920/16) x (1080/16)
   budget       : 8160
   decision     : send
   12 MP image  : crop-or-downscale (47000 tokens)
   conversation : 81600 tokens for ONE image over 10 turns

Run `npm start` and POST to /chat to use the real multimodal model.
```


---

## Structure

```text
Basic Code/
├── .env                      # ports, model name, patch size, token budget (gitignored)
├── .env.example              # committed template that `.env` is copied from
├── package.json              # metadata, dependencies, npm scripts
├── package-lock.json         # the exact dependency tree npm install resolved
├── README.md
├── app.test.js               # `npm test` — pipeline + HTTP, no API credits spent
├── implementations guide/    # ← chapter-wise walkthrough of every file below
└── src/
    ├── index.js                          # the entry point: config → service → HTTP
    ├── demo.js                           # the whole pipeline, offline, one screen
    ├── config/config.js                  # every constant the pipeline needs
    ├── middleware/upload.js              # the untrusted-image gate + safe errors
    ├── routes/index.js                   # the /chat contract (three routes)
    ├── controllers/chatController.js     # validate, delegate, render
    └── services/
        ├── textPipeline.js               # Text → Tokens → IDs → Vectors      (Ch 03)
        ├── visionPipeline.js             # Pixels → Patches → Embeddings      (Ch 04)
        ├── alignmentService.js           # position, projection, attention    (Ch 05/06)
        ├── costService.js                # the image token budget             (Ch 08.2)
        └── chatService.js                # the multimodal call + history      (Ch 07)
```

### Chapter map

| Guide | File | Lecture chapter |
|---|---|---|
| [01 — Structure & File Map](./implementations%20guide/01_Project_Structure_and_File_Map.md) | whole project, `package.json`, `.env` | 01 / 02 |
| [02 — Config: Model, Limits, System Prompt](./implementations%20guide/02_Config_Model_Limits_and_System_Prompt.md) | `src/config/config.js` | 02 / 04 / 08 |
| [03 — Text Pipeline](./implementations%20guide/03_Text_Pipeline_Text_to_Vectors.md) | `src/services/textPipeline.js` | 03 |
| [04 — Vision Pipeline](./implementations%20guide/04_Vision_Pipeline_Pixels_Patches_Embeddings.md) | `src/services/visionPipeline.js` | 04 |
| [05 — Alignment: Position, Projection, Attention](./implementations%20guide/05_Alignment_Position_Projection_and_Attention.md) | `src/services/alignmentService.js` | 05 / 06 |
| [06 — Cost Guard: The Image Token Budget](./implementations%20guide/06_Cost_Guard_Image_Token_Budget.md) | `src/services/costService.js` | 08.2 |
| [07 — Upload Middleware: An Untrusted Image](./implementations%20guide/07_Upload_Middleware_Validating_Untrusted_Images.md) | `src/middleware/upload.js` | 08.4 |
| [08 — Chat Service: The Call and the History](./implementations%20guide/08_Chat_Service_The_Multimodal_Call_and_History.md) | `src/services/chatService.js` | 07 |
| [09 — Controller & Routes: The `/chat` Contract](./implementations%20guide/09_Controller_and_Routes_The_chat_Contract.md) | `src/controllers/chatController.js`, `src/routes/index.js` | 07.5 |
| [10 — Entry Point & Offline Demo](./implementations%20guide/10_Entry_Point_and_Offline_Demo.md) | `src/index.js`, `src/demo.js` | 07 |

> Full walkthrough with every file verbatim and block-by-block explanations:
> **[`implementations guide/README.md`](./implementations%20guide/README.md)**.

---

## Calling it by hand

`npm start`, then in another terminal:

```bash
curl 'http://127.0.0.1:8080/health'                       # limits in force
curl -X POST 'http://127.0.0.1:8080/chat' \
     -F 'message=Why is my payment failing?'              # text only  → the "Text" half
curl -X POST 'http://127.0.0.1:8080/chat' \
     -F 'message=What is in this image?' \
     -F 'image=@payment.png;type=image/png'               # text + image → the "Image" half
curl -X DELETE 'http://127.0.0.1:8080/chat'               # drop the conversation
```

Observed responses (no API key set):

```text
{"ok":true,"model":"gpt-4o-mini","patchSize":16,"maxImageTokens":8160,"modelConfigured":false}

[offline] image received (image/png, 24 bytes). You asked: "What is in this image?". Set OPENAI_API_KEY in .env for a real answer.

Image is too expensive: estimated 187500 image tokens exceeds the 8160-token budget. Crop to the region of interest and retry.   [413]
Unsupported image type "text/plain". Send PNG, JPEG or WEBP.                                                                   [400]
The message field is required.                                                                                                 [400]
```

---

## Three design decisions worth reading the code for

**1 · The application never understands the image** (`src/services/chatService.js`)

`buildUserMessage` turns `(text, image)` into `content` *parts* and stops there. There is no
image logic in the request path at all — because Chapter 07's claim is that your job is to get
the right bytes to the provider, not to interpret them. Everything else here exists to
*measure* the image, never to read it.

**2 · The cost guard runs before the spend** (`src/services/costService.js` → `chatService.assertAffordable`)

`estimateImageTokens` is Chapter 04's arithmetic and Chapter 08's invoice. It runs **before**
the API call, so an unaffordable image is a `413` instead of a bill. Chapter 08's budget rule —
*compute `tokens × turns × users × days` before you build the demo* — is enforced by code here,
not by discipline.

**3 · An image is untrusted input** (`src/middleware/upload.js` + `config.systemPrompt`)

Type, count and size are gated in middleware; the system prompt states plainly that text
*inside* an image is data, never instructions. That is Chapter 08.4's defence stack reduced to
the two things a basic implementation can actually afford.

---

## What this project deliberately does *not* have

| Not present | Why |
|---|---|
| a real tokenizer / vision encoder | both are the provider's job; Chapters 03–04 are *shown*, not reimplemented |
| image resizing or cropping | `guardImage` *reports* `crop-or-downscale`; the crop itself is a product decision |
| a database or auth | the lecture is about the modality, not persistence |
| streaming | vision encoding finishes before the first token, so streaming changes nothing (Ch 07.8) |
| a frontend | three routes do not need one; `curl` shows the contract more honestly |

**Back to:** [Lecture 16 notes](../../notes/README.md) · [Implementation guide](./implementations%20guide/README.md)

