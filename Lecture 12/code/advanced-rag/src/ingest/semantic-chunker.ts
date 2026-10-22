import type { EmbeddingProvider } from '../embeddings.js';
import { cosine } from '../lib/vectors.js';
import { countTokens, sha256 } from '../lib/text.js';
import type { Chunk, SourceDocument } from '../types.js';

/**
 * Semantic chunking — cut where the topic changes, not where the counter says.
 *
 * The algorithm is three lines of arithmetic wrapped in a lot of judgement:
 *
 *  1. split the document into sentences;
 *  2. embed them all in one batch;
 *  3. start a new chunk wherever consecutive sentences are *dissimilar* enough
 *     (cosine below `threshold`), or the chunk would exceed `maxTokens`.
 *
 * Why it is not the default here: the breakpoints depend on a similarity
 * threshold that is specific to the embedding model and the corpus, so a value
 * tuned on legal contracts silently produces 40-token chunks on policy text.
 * Headings are free, stable and explainable; embeddings are none of those. Use
 * semantic chunking where structure is missing (transcripts, scraped HTML), and
 * keep the size cap so a single long sentence cannot create a 2,000-token chunk.
 */

export interface SemanticChunkOptions {
  maxTokens: number;
  /** Cosine below this between neighbouring sentences opens a new chunk. */
  threshold: number;
  /** Never emit a chunk smaller than this many tokens; merge it forward instead. */
  minTokens: number;
}

export async function chunkSemantic(
  doc: SourceDocument,
  embeddings: EmbeddingProvider,
  options: SemanticChunkOptions,
): Promise<Chunk[]> {
  const sentences = (doc.text.match(/[^.!?\n]+[.!?]?/g) ?? [doc.text])
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) return [];

  const vectors = await embeddings.embed(sentences);
  const groups: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    const tokens = countTokens(sentence);

    const boundary =
      current.length > 0 &&
      (currentTokens + tokens > options.maxTokens ||
        (index > 0 && cosine(vectors[index - 1], vectors[index]) < options.threshold));

    if (boundary && currentTokens >= options.minTokens) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(sentence);
    currentTokens += tokens;
  }

  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const text = group.join(' ').trim();
    return {
      id: sha256(doc.source, 'semantic', index, text),
      text,
      source: doc.source,
      title: doc.title,
      // Semantic breaks are not headings: we can label the chunk, not name it.
      heading: `segment ${index + 1}`,
      breadcrumb: doc.title,
      chunkIndex: index,
      tokens: countTokens(text),
      parentId: null,
      meta: doc.meta,
    };
  });
}
