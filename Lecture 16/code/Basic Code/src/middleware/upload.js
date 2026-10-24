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
