import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pdf from "pdf-parse";

import { config } from "./config.js";
import { chunkText } from "./chunking.js";
import { embedTexts } from "./embeddings.js";
import { qdrant, ensureCollection } from "./qdrant.js";

async function readPdfText(filePath) {
  const buffer = await fs.readFile(filePath);
  const data = await pdf(buffer);

  return data.text ?? "";
}

// Convert a SHA-256 hash into a UUID-shaped deterministic point ID.
// Qdrant supports UUID strings for point IDs.
function createPointId(documentId, chunkIndex) {
  const hash = crypto
    .createHash("sha256")
    .update(`${documentId}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export async function indexPdf({ filePath, documentId }) {
  if (!documentId?.trim()) {
    throw new Error("documentId is required");
  }

  const collection = await ensureCollection();

  console.log(`Reading PDF: ${filePath}`);

  const text = await readPdfText(filePath);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    return {
      chunks: 0,
      message: "No extractable text found in PDF",
    };
  }

  console.log(`Extracted ${text.length} characters`);
  console.log(`Created ${chunks.length} chunks`);

  const vectors = await embedTexts(chunks);

  // Validate the total number of vectors.
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: ${vectors.length} vectors ` +
      `for ${chunks.length} chunks`
    );
  }

  // Build one point per chunk.
  const points = chunks.map((chunk, index) => ({
    id: createPointId(documentId, index),
    vector: vectors[index],
    payload: {
      text: chunk,
      source: path.basename(filePath),
      documentId,
      chunkIndex: index,
    },
  }));

  // Upload in batches rather than sending an unlimited number of points
  // in one Qdrant request.
  const uploadBatchSize = 100;

  for (let i = 0; i < points.length; i += uploadBatchSize) {
    const batch = points.slice(i, i + uploadBatchSize);

    await qdrant.upsert(collection, {
      wait: true,
      points: batch,
    });

    console.log(
      `Stored ${Math.min(i + batch.length, points.length)}/${points.length} points`
    );
  }

  return {
    chunks: chunks.length,
    vectors: vectors.length,
    dimensions: config.openai.embeddingDimensions,
    collection,
    documentId,
  };
}
