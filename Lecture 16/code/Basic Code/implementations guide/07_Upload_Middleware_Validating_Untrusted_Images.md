# Chapter 07 — Upload Middleware: An Untrusted Image

> **Goal of this chapter:** build the gate every byte passes before it can reach a model. An
> image is untrusted input — and *worse* than a user message, because nobody read it first.
>
> **Lecture chapter:** [08 — Production: Cost, Security and Evaluation](../../../notes/08_Production_Multimodal_Systems_Cost_Security_And_Evaluation.md), §8.4.

---

## 7.1 File details

| | |
|---|---|
| **Path** | `src/middleware/upload.js` |
| **Purpose** | parse multipart uploads, enforce type/count/size limits, translate every failure into a safe HTTP response |
| **Imports** | `multer`, `config` |
| **Exports** | `UploadError` (class), `upload` (multer instance), `rejectOversizedRequest`, `errorHandler` |
| **Who imports it** | `routes/index.js` (`upload`, `rejectOversizedRequest`), `src/index.js` (`errorHandler`) |
| **Depends on** | `src/config/config.js` |

**Commands**

```bash
cd "Lecture 16/code/Basic Code"
npm start
# in another terminal:
curl -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8080/chat -F 'message=hi' -F 'image=@/etc/hostname;type=text/plain'
```

---

## 7.2 Full file

**Path:** `src/middleware/upload.js`

```js
// Lecture 16 · Chapter 08.4 — an image is UNTRUSTED INPUT.
//
// "Nobody read the pixels before uploading them." This file is the gate every byte
// passes before it can reach a model: type, count and size are all decided here.
import multer from 'multer';
import { config } from '../config/config.js';

// Only the formats `readDimensions` (Chapter 04) can measure.
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// Errors that carry an HTTP status, so the error handler below stays generic.
export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const upload = multer({
  // Memory, not disk: we only ever forward the bytes, so there is nothing to clean up
  // and no temp file to leak. The limits are Chapter 08's resource-exhaustion defence.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxImagesPerTurn,
    fields: 2,
  },
  fileFilter(request, file, callback) {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return callback(new UploadError(
        `Unsupported image type "${file.mimetype}". Send PNG, JPEG or WEBP.`,
      ));
    }
    callback(null, true);
  },
});

// Chapter 08.2 — reject an oversized request before multer buffers the whole body.
export function rejectOversizedRequest(request, response, next) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
    const megabytes = config.maxUploadBytes / 1024 / 1024;
    return response.status(413).type('text').send(`Maximum image size is ${megabytes} MB.`);
  }
  next();
}

// Chapter 08.4 — the single error translator for the whole app.
// Note what it does NOT do: leak the provider's message, the API key, or a stack trace.
export function errorHandler(error, request, response, next) {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return response
      .status(status)
      .type('text')
      .send(status === 413 ? 'Maximum image size exceeded.' : 'Invalid multipart upload.');
  }
  if (error.status) {
    return response.status(error.status).type('text').send(error.message);
  }
  response
    .status(502)
    .type('text')
    .send('Unable to get an AI response. Check your API key and try again.');
}
```

---

## 7.3 Block-by-block explanation

**Block 1 — the allow-list**

```js
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
```

- **What it does:** defines the three formats the app will accept, as **MIME types**.
- The list is an **allow-list**, not a deny-list. Chapter 08.4's defence table works by
  narrowing what is possible; a deny-list can only ever be incomplete.
- The three entries are not arbitrary: they are exactly the formats `readDimensions`
  (Chapter 04) can measure. **The gate and the measurer must agree**, or a valid upload would
  pass the middleware and then fail in the service.
- `image/jpeg` (not `image/jpg`) is the registered MIME type. `image/jpg` is a common client-side
  typo and is *not* the same string.

**Block 2 — `UploadError`: an error that carries a status**

```js
export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
```

- **What it does:** a tiny `Error` subclass with a default `status` of `400`.
- `super(message)` runs `Error`'s constructor so `instanceof Error`, `error.message` and the
  stack trace all work normally — a subclass that forgets `super()` is broken in JavaScript.
- **Why carry a status at all?** So `errorHandler` does not need a chain of
  `if (error instanceof X) … else if (error instanceof Y) …`. Any layer can attach a status and
  the handler will honour it. `visionPipeline.readDimensions` uses the same convention by
  setting `error.status = 400` on a plain `Error` — the contract is *"has a `status`"*, not
  *"is an `UploadError`"*.
- **Why default to `400`** (client error) and not `500`? An unsupported file type is the
  *client's* problem, and saying so is Chapter 08's "validate before sending" made visible in
  the status code.

**Block 3 — the multer instance**

```js
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxImagesPerTurn,
    fields: 2,
  },
  fileFilter(request, file, callback) {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return callback(new UploadError(
        `Unsupported image type "${file.mimetype}". Send PNG, JPEG or WEBP.`,
      ));
    }
    callback(null, true);
  },
});
```

- `multer` parses `multipart/form-data` — the only encoding a browser uses when it posts a file.
  Without it, `req.file` would not exist.
- **`memoryStorage()`.** The alternative is `diskStorage`, which writes the upload to a temp
  file. Memory is right here because we only ever forward the bytes: there is no temp file to
  clean up, and nothing left behind if the process crashes mid-request.
- **The three limits, all from config (Chapter 08.4's resource-exhaustion row):**

  | Limit | Stops |
  |---|---|
  | `fileSize: 10 MB` | one enormous file inflating memory and cost |
  | `files: 2` | a request carrying 500 images |
  | `fields: 2` | a body stuffed with thousands of text fields |

- **`fileFilter`** runs before the file is buffered. `file.mimetype` is the type the *client*
  declared in the multipart headers.
- **Honest limitation:** a MIME type is client-supplied and therefore **spoofable**. A real
  system would sniff the magic bytes. This project does better than nothing: bytes that *claim*
  to be a PNG but are not will be caught by `readDimensions` in the service, which throws a
  `400`. The two checks together — declared type here, real structure there — are enough for a
  basic implementation.
- `callback(null, true)` accepts; `callback(error)` rejects. Passing an `UploadError` rather
  than a string is what lets the status survive to the response.
- The rejection message **names the fix** (`Send PNG, JPEG or WEBP`) rather than just reporting
  failure — the same habit Lecture 14's `isError` messages use: an error message is an
  instruction channel.


**Block 4 — `rejectOversizedRequest`: refuse before you buffer**

```js
export function rejectOversizedRequest(request, response, next) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
    const megabytes = config.maxUploadBytes / 1024 / 1024;
    return response.status(413).type('text').send(`Maximum image size is ${megabytes} MB.`);
  }
  next();
}
```

- **What it does:** reads the `Content-Length` header and rejects an obviously-too-large request
  *before* multer allocates memory for it.
- **Why this is separate from multer's `fileSize` limit.** Multer's limit is enforced *while
  streaming*, which means the bytes are already arriving. Checking the declared length first
  means a client cannot make the server allocate 500 MB just to reject it afterwards. Two
  checks, two jobs: this one is cheap and early; multer's is exact and late.
- `Number.isFinite(declared)` guards the header's absence. `Number(undefined)` is `NaN`, and
  `NaN > x` is `false` — so a request with no `Content-Length` (a chunked upload) falls through
  to multer's limit instead of being rejected. Falling through is the right behaviour.
- `413` is *Payload Too Large* — the correct status here, not `400`.
- `.type('text')` sets `Content-Type: text/plain`, so the reply renders as text rather than
  being offered as a download.

**Block 5 — `errorHandler`: one place that decides what the client learns**

```js
export function errorHandler(error, request, response, next) {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return response.status(status).type('text')
      .send(status === 413 ? 'Maximum image size exceeded.' : 'Invalid multipart upload.');
  }
  if (error.status) {
    return response.status(error.status).type('text').send(error.message);
  }
  response.status(502).type('text')
    .send('Unable to get an AI response. Check your API key and try again.');
}
```

- **Express knows this is an error handler because it takes four arguments.** `(error, request,
  response, next)` — with three, Express would treat it as ordinary middleware and never call it
  for an error. `next` is unused here, but it must be *declared* for the arity check to pass.
  This is the one place in the project where an unused parameter is required.
- **Branch 1 — `MulterError`.** Multer's own errors (file too large, too many files) are
  translated: `LIMIT_FILE_SIZE` becomes `413`, everything else `400`. The raw `error.message` is
  *not* forwarded, because multer's messages describe internals.
- **Branch 2 — anything carrying a `status`.** This catches `UploadError` from `fileFilter` and
  the plain `Error` with `status = 400` from `readDimensions`. Because both set a status, one
  branch serves both — which is the whole reason `UploadError` exists.
- **Branch 3 — everything else, as `502`.** An unhandled error here means the provider call
  failed. The message is deliberately generic: **it must not leak the API key, the provider's
  raw error, or a stack trace.**
  - The status is `502` (Bad Gateway) rather than `500`. The failure is upstream — the provider —
    and saying so is both accurate and more useful for monitoring.

---

## 7.4 Run / verify

```bash
cd "Lecture 16/code/Basic Code" && npm start
```

```bash
curl -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8080/chat -F 'message=hi' -F 'image=@/etc/hostname;type=text/plain'
```

Expected (verified):

```text
Unsupported image type "text/plain". Send PNG, JPEG or WEBP. [400]
```

`npm test` covers the same paths without a running server: wrong type → `400`, 10 MB + 1 byte →
`413`, and an 8000×6000 image → `413` (from the cost guard, Chapter 06).

---

## 7.5 Checkpoint

1. **Why is the allow-list exactly those three MIME types?** → they are the formats
   `readDimensions` can measure. The gate and the measurer must agree.
2. **Why check `Content-Length` *and* set multer's `fileSize`?** → the header check is cheap and
   early (no allocation); multer's is exact but late.
3. **Why does `errorHandler` take four arguments when it uses only three?** → Express detects
   error handlers by arity; with three arguments it would never be called.

**Next:** [Chapter 08 — Chat Service: The Call & the History](./08_Chat_Service_The_Multimodal_Call_and_History.md)

