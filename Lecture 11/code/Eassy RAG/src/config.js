import "dotenv/config";

function getNumber(name, fallback) {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return fallback;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return number;
}

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    embeddingModel:
      process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    embeddingDimensions: getNumber(
      "EMBEDDING_DIMENSIONS",
      1024
    ),
    chatModel: process.env.CHAT_MODEL ?? "gpt-4o-mini",
  },

  chunking: {
    chunkSize: getNumber("CHUNK_SIZE", 1000),
    chunkOverlap: getNumber("CHUNK_OVERLAP", 150),
  },

  embeddingBatchSize: getNumber("EMBEDDING_BATCH_SIZE", 100),

  qdrant: {
    url: process.env.QDRANT_URL ?? "http://localhost:6333",
    apiKey: process.env.QDRANT_API_KEY || undefined,
    collection: process.env.QDRANT_COLLECTION ?? "pdf_knowledge",
  },

  topK: getNumber("TOP_K", 5),
};

if (!config.openai.apiKey) {
  throw new Error("OPENAI_API_KEY is missing from .env");
}

if (config.chunking.chunkOverlap >= config.chunking.chunkSize) {
  throw new Error("Chunk overlap must be smaller than chunk size");
}

if (
  config.openai.embeddingDimensions > 1536 &&
  config.openai.embeddingModel === "text-embedding-3-small"
) {
  throw new Error(
    "text-embedding-3-small supports at most 1536 output dimensions"
  );
}
