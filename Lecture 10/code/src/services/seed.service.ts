import type { CorpusDocument } from '../data/corpus.js';
import { CORPUS } from '../data/corpus.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import type { VectorStore } from '../store/vector-store.js';

export interface SeedResult {
  inserted: number;
  updated: number;
  documents: number;
}

/** Embed the corpus once, then upsert. Used by boot, the admin route and scripts. */
export async function seedStore(
  store: VectorStore<Record<string, unknown>>,
  embeddings: EmbeddingService,
  documents: readonly CorpusDocument[] = CORPUS,
): Promise<SeedResult> {
  const vectors = await embeddings.embedDocuments(documents.map((document) => document.text));
  const result = store.upsert(
    documents.map((document, index) => ({
      id: document.id,
      vector: vectors[index],
      payload: document.payload,
      text: document.text,
    })),
  );
  return { ...result, documents: documents.length };
}
