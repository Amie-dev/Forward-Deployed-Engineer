import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";

export const qdrant = new QdrantClient({
  url: config.qdrant.url,
  apiKey: config.qdrant.apiKey,
});

export async function ensureCollection() {
  const collectionName = config.qdrant.collection;

  const { collections } = await qdrant.getCollections();

  const exists = collections.some(
    (collection) => collection.name === collectionName
  );

  if (!exists) {
    await qdrant.createCollection(collectionName, {
      vectors: {
        size: config.openai.embeddingDimensions,
        distance: "Cosine",
      },
    });

    console.log(
      `Created collection "${collectionName}" with ` +
      `${config.openai.embeddingDimensions} dimensions`
    );

    return collectionName;
  }

  // Do not silently use an existing collection with incompatible dimensions.
  const info = await qdrant.getCollection(collectionName);
  const vectorConfig = info.config.params.vectors;

  if (
    typeof vectorConfig.size !== "number" ||
    vectorConfig.size !== config.openai.embeddingDimensions
  ) {
    throw new Error(
      `Collection dimension mismatch. Expected ` +
      `${config.openai.embeddingDimensions}, but collection uses ` +
      `${vectorConfig.size}. Create a compatible collection or migrate it.`
    );
  }

  return collectionName;
}
