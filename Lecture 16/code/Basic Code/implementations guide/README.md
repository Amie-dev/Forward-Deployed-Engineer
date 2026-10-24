# Lecture 16 — Basic Code · Implementation Guide

> **A chapter-wise, order-wise walkthrough of the `Basic Code` project.**
> Every chapter covers **one source file**: what it is for, the commands you need,
> the **complete file** verbatim, and then a **block-by-block** explanation of what
> each block does and *how* it works. Read the chapters in order — each one builds
> on the previous file.

This guide explains the runnable code behind the lecture notes
([`../../../notes`](../../../notes/README.md)). The notes explain *why* an LLM can
understand an image; this guide explains *how the code is built*, one file at a time.

---

## What this project is

One small Express application that implements the whole pipeline from the notes —
**text → tokens → vectors**, **image → patches → visual embeddings**, **projection →
attention**, and a single `/chat` route whose contract is the board's:

```text
Client  ──/chat──>  LLM
        "Text / Image -----> Text"
```

```text
                    ┌──────────────── src/index.js ─────────────────┐
                    │  config → ChatService → Express app            │
                    │                                                │
   POST /chat ─────▶│  middleware/upload.js   (gate the image)       │
   text or image    │  controllers/chat…      (validate, delegate)   │
                    │  services/chatService   (package + call)       │
                    │        ├── visionPipeline.js   (measure it)    │
                    │        ├── costService.js      (price it)      │
                    │        └── history + compaction                │
                    └────────────────────────────────────────────────┘

   npm run demo ────▶ src/demo.js : Chapters 03 → 08, offline, no model call
```

**The one sentence that explains every design decision here:** the application
**packages** text and image; it never **interprets** the image. Everything in `src/`
exists to get the right bytes to the provider and to handle the answer responsibly.

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | `>= 20.0.0` | `package.json` sets `engines.node`; the code uses modern ESM, `node:` APIs and `fetch`/`FormData` in tests |
| **npm** | any recent | installs dependencies and runs the scripts |

No API key, no network, no database. Everything runs locally.

---

## Quickstart

```bash
cd "Lecture 16/code/Basic Code"

npm install      # express, multer, openai, dotenv
npm run demo     # the whole pipeline, offline, one screen   ← start here
npm test         # the pipeline + the /chat contract
npm start        # the HTTP server on http://127.0.0.1:8080
```

`npm run demo` prints six sections, one per chapter group:

```text
1. TEXT PIPELINE (Chapter 03) — the model never sees English
2. VISION PIPELINE (Chapter 04) — an image is already numbers
3. CONNECTING VISION TO LANGUAGE (Chapter 05)
4. HOW IT LEARNS IT (Chapter 06) — training data is images + description
5. THE REQUEST (Chapter 07) — the app packages, it does not interpret
6. COST GUARD (Chapter 08) — images are expensive tokens
```

---

## Chapter map

Read top to bottom. Each chapter is one file (or one tight pair); the **build order**
below is the order the code actually depends on itself
(config → pipelines → alignment → cost → gate → service → routes → entry).

| # | Guide chapter | File covered | Lecture chapter |
|---|---|---|---|
| 01 | [Project Structure & File Map](./01_Project_Structure_and_File_Map.md) | whole project, `package.json`, `.env` | 01 / 02 |
| 02 | [Config: Model, Limits & System Prompt](./02_Config_Model_Limits_and_System_Prompt.md) | `src/config/config.js` | 02 / 04 / 08 |
| 03 | [Text Pipeline: Text → Tokens → Vectors](./03_Text_Pipeline_Text_to_Vectors.md) | `src/services/textPipeline.js` | 03 |
| 04 | [Vision Pipeline: Pixels → Patches → Embeddings](./04_Vision_Pipeline_Pixels_Patches_Embeddings.md) | `src/services/visionPipeline.js` | 04 |
| 05 | [Alignment: Position, Projection & Attention](./05_Alignment_Position_Projection_and_Attention.md) | `src/services/alignmentService.js` | 05 / 06 |
| 06 | [Cost Guard: The Image Token Budget](./06_Cost_Guard_Image_Token_Budget.md) | `src/services/costService.js` | 08.2 |
| 07 | [Upload Middleware: An Untrusted Image](./07_Upload_Middleware_Validating_Untrusted_Images.md) | `src/middleware/upload.js` | 08.4 |
| 08 | [Chat Service: The Call & the History](./08_Chat_Service_The_Multimodal_Call_and_History.md) | `src/services/chatService.js` | 07 |
| 09 | [Controller & Routes: The `/chat` Contract](./09_Controller_and_Routes_The_chat_Contract.md) | `src/controllers/chatController.js`, `src/routes/index.js` | 07.5 |
| 10 | [Entry Point & Offline Demo](./10_Entry_Point_and_Offline_Demo.md) | `src/index.js`, `src/demo.js` | 07 |

---

## How each chapter is structured

Every chapter follows the same six-part shape so you can follow along mechanically:

1. **File details** — path, purpose, imports/exports, and the lecture section it implements.
2. **Commands** — the exact command(s) to run this piece in isolation (when it makes sense).
3. **Full file** — the complete, verbatim source (never a snippet).
4. **Block-by-block explanation** — the file is split into numbered blocks; for each block you
   get *what it does* and *how it works*.
5. **Run / verify** — the command and the output you should see.
6. **Checkpoint** — the two or three things you must understand before moving on.

---

## The order, and why

```text
01 structure      → know the map before walking the streets
02 config.js      → the constants everything else imports
03 textPipeline   → the pipeline images must COPY (Chapter 03 is the bridge)
04 visionPipeline → pixels → patches → embeddings, plus measuring the real size
05 alignment…     → position, projection, attention, and what a "match" means
06 costService    → Chapter 04's arithmetic turned into an invoice
07 upload.js      → the gate every byte passes before it can reach a model
08 chatService    → the actual multimodal call, plus history and compaction
09 controller+routes → the /chat contract: text or image in, text out
10 index + demo   → wiring it up, and walking the whole ladder offline
```

> **Note on chapter numbering.** This guide numbers chapters by *file/build order*
> (Chapter 01 is the file-structure overview). The "Lecture chapter" column maps each
> guide chapter back to the corresponding chapter in
> [`../../../notes`](../../../notes/README.md).



---

## Where the lecture's own example lives in the code

| Lecture idea | Code |
|---|---|
| `HI, my name is Aditya` → tokens → **token IDs 23 41 56** → `v1 v2 v3` | `src/services/textPipeline.js` |
| `cat.jpg` · `R:255 G:120 B:30` · `1920 * 1080` | `src/services/visionPipeline.js` (`rawNumbers`) |
| the `p1 p2 … 16 * 16` patch grid | `src/services/visionPipeline.js` (`toPatches`) |
| Vision Encoder → `[0.12, -0.55, …]` | `src/services/visionPipeline.js` (`encodePatches`) |
| **"two paths, one word: vectors"** | `encodePatches` reuses the *same* `embed` as text |
| patch content **+ patch position** (`top-left` / `bottom-right`) | `src/services/alignmentService.js` (`positionOf`) |
| projection / adapter | `src/services/alignmentService.js` (`project`) |
| attention across both modalities | `src/services/alignmentService.js` (`attention`) |
| training data = **images + description** | `src/services/alignmentService.js` (`trainingPair`) |
| `Raw Image → compress → compressed image → LLM` | `src/services/costService.js` (`guardImage`) |
| `Client —/chat→ LLM`, "Text / Image → Text" | `src/routes/index.js` + `src/controllers/chatController.js` |
| images persist in **conversation history** and are re-sent | `src/services/chatService.js` (`compactHistory`) |
| image token cost, budget, per-turn accumulation | `src/services/costService.js` |
| the image is untrusted input (type, size, injection) | `src/middleware/upload.js` + `config.systemPrompt` |
| the seven-step mental model (Chapter 07.7) | `src/demo.js` |

**Back to:** [Lecture 16 notes](../../../notes/README.md) · [Basic Code README](../README.md)
