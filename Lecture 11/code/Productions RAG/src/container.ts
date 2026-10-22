import { env } from './config/env.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embeddings/provider.js';
import { createGenerationProvider, type GenerationProvider } from './generation/provider.js';
import { RagService } from './rag.service.js';
import { Retriever } from './retrieval/retriever.js';
import { createQueryRewriter } from './session/rewrite.js';
import { SessionStore } from './session/store.js';
import { createVectorStore } from './store/factory.js';
import type { VectorStore } from './store/vector-store.js';

export interface Container {
  env: typeof env;
  store: VectorStore;
  embeddings: EmbeddingProvider;
  generator: GenerationProvider;
  retriever: Retriever;
  sessions: SessionStore;
  service: RagService;
}

/**
 * Composition root: the only place that knows which concrete provider is in use.
 *
 * Everything below this file depends on interfaces, which is what lets `demo` and
 * `eval` run offline with the same pipeline the server uses in production.
 */
export async function createContainer(): Promise<Container> {
  const embeddings = createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    apiKey: env.OPENAI_API_KEY,
  });

  const generator = createGenerationProvider({
    provider: env.LLM_PROVIDER,
    model: env.CHAT_MODEL,
    apiKey: env.OPENAI_API_KEY,
  });

  const store = await createVectorStore({
    kind: env.VECTOR_STORE,
    indexPath: env.INDEX_PATH,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    pinecone: {
      apiKey: env.PINECONE_API_KEY,
      indexName: env.PINECONE_INDEX_NAME,
      namespace: env.PINECONE_NAMESPACE,
    },
  });

  const retriever = new Retriever({
    store,
    embeddings,
    options: {
      topK: env.TOP_K,
      candidateMultiplier: env.CANDIDATE_MULTIPLIER,
      minScore: env.MIN_SCORE,
      lexicalWeight: env.HYBRID_LEXICAL_WEIGHT,
    },
  });

  const sessions = new SessionStore(env.SESSION_TTL_MINUTES * 60_000, env.HISTORY_TURNS);

  // Only a real model can rewrite a query; the extractive stub cannot paraphrase.
  const rewriter = createQueryRewriter(env.LLM_PROVIDER === 'openai' ? generator : undefined);

  const service = new RagService({
    store,
    embeddings,
    generator,
    retriever,
    sessions,
    rewriter,
    config: {
      knowledgeDir: env.KNOWLEDGE_DIR,
      chunkSize: env.CHUNK_SIZE,
      chunkOverlap: env.CHUNK_OVERLAP,
      topK: env.TOP_K,
      maxContextTokens: env.MAX_CONTEXT_TOKENS,
      historyTurns: env.HISTORY_TURNS,
    },
  });

  return { env, store, embeddings, generator, retriever, sessions, service };
}
