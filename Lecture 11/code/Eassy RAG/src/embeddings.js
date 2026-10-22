import OpenAI from "openai";
import { config } from "./config.js";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

export async function embedTexts(
  texts,
  batchSize = config.embeddingBatchSize
) {
  if (!Array.isArray(texts)) {
    throw new TypeError("texts must be an array");
  }

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  if (texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("Every input text must be a non-empty string");
  }

  // Keep the output position aligned with the input position.
  const vectors = new Array(texts.length);

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await openai.embeddings.create({
      model: config.openai.embeddingModel,
      dimensions: config.openai.embeddingDimensions,
      input: batch,
      encoding_format: "float",
    });

    for (const item of response.data) {
      const originalIndex = i + item.index;

      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= batch.length
      ) {
        throw new Error("Invalid embedding index returned by OpenAI");
      }

      if (vectors[originalIndex] !== undefined) {
        throw new Error(`Duplicate embedding index: ${originalIndex}`);
      }

      if (
        !Array.isArray(item.embedding) ||
        item.embedding.length !== config.openai.embeddingDimensions ||
        !item.embedding.every(Number.isFinite)
      ) {
        throw new Error(
          `Invalid vector at input index ${originalIndex}`
        );
      }

      vectors[originalIndex] = item.embedding;
    }

    console.log(
      `Embedded ${Math.min(i + batch.length, texts.length)}/${texts.length} chunks`
    );
  }

  if (vectors.includes(undefined)) {
    throw new Error("Some input chunks did not receive embeddings");
  }

  return vectors;
}
