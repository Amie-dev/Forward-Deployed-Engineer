import OpenAI from 'openai';
import { env, isLiveOpenAIEnabled } from '../config/env.js';

/**
 * EmbeddingService — wraps the OpenAI Embeddings API.
 *
 * Concepts from the notes implemented here:
 *   - Embedding Model: text → fixed-size vector
 *   - The model is NOT a chatbot — it only returns numerical representations
 *   - Uses text-embedding-3-small by default: fast, cheap, 1536 dimensions
 */
export class EmbeddingService {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    this.model = env.EMBEDDING_MODEL;
  }

  /**
   * Convert a single piece of text into an embedding vector.
   *
   * This is the REPRESENT step of: REPRESENT → STORE → COMPARE → RANK
   *
   * @param text  Any natural language string (movie description, user query)
   * @returns     A fixed-size array of numbers encoding the semantic meaning
   */
  async embed(text: string): Promise<number[]> {
    if (!isLiveOpenAIEnabled()) {
      // Mock mode — return deterministic fake vector for development without API key
      console.warn('[EmbeddingService] MOCK MODE — returning stub vector (set OPENAI_API_KEY for real embeddings)');
      return this.mockVector(text);
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      encoding_format: 'float',
    });

    return response.data[0].embedding;
  }

  /**
   * Batch-embed multiple texts in a single API call.
   *
   * The OpenAI Embeddings API natively supports batch input — much more
   * efficient than calling embed() in a loop.
   *
   * Used during Phase 1 (catalog precomputation) to process all movies at once.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!isLiveOpenAIEnabled()) {
      console.warn('[EmbeddingService] MOCK MODE — returning stub vectors for batch');
      return texts.map(t => this.mockVector(t));
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      encoding_format: 'float',
    });

    // The API returns embeddings in the same order as input texts
    return response.data
      .sort((a, b) => a.index - b.index)
      .map(item => item.embedding);
  }

  /**
   * Deterministic mock vector for development without an API key.
   * Generates a normalized pseudo-random vector seeded by the input text.
   * NOT semantically meaningful — only for testing the pipeline without costs.
   */
  private mockVector(text: string): number[] {
    const dim = 128; // Smaller for mock — real is 1536
    let seed = text.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);

    const raw = Array.from({ length: dim }, () => {
      // Simple LCG pseudo-random seeded by text content
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return ((seed >>> 0) / 0xffffffff) * 2 - 1; // Range: -1 to 1
    });

    // L2-normalize so cosine similarity works correctly
    const magnitude = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
    return raw.map(v => v / magnitude);
  }
}

// Singleton — one client shared across the app
export const embeddingService = new EmbeddingService();
