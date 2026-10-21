/**
 * Data contracts for the RAG pipeline.
 *
 * Every stage reads and writes exactly one of these shapes. Keeping them in one
 * file is what stops the pipeline from turning into string-passing: you can see
 * where a chunk becomes a vector, and where a match becomes a citation.
 */

/** A file as it came off disk, before any chunking. */
export interface SourceDocument {
  /** File name — this is the label the customer eventually sees in a citation. */
  source: string;
  title: string;
  text: string;
}

/** The unit of retrieval. If the answer is not inside one chunk, it cannot be found. */
export interface Chunk {
  /** Deterministic id: sha256(source:index:text). Re-ingesting the same bytes is a no-op. */
  id: string;
  text: string;
  source: string;
  section: string;
  chunkIndex: number;
  tokens: number;
}

/** A chunk plus its embedding — the shape a vector store actually persists. */
export interface IndexRecord extends Chunk {
  vector: number[];
}

/** A chunk plus a similarity score — what retrieval returns. */
export interface Match extends Chunk {
  score: number;
}

/** A `[n]` marker in the answer, resolved back to the chunk it claims to cite. */
export interface Citation {
  label: number;
  chunkId: string;
  source: string;
  section: string;
  score: number;
  /** False when the model invented a label that was never in the prompt. */
  valid: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One completed exchange, kept for continuity and query rewriting. */
export interface Turn {
  question: string;
  answer: string;
  /** The query that was actually sent to retrieval (after rewriting). */
  searchQuery: string;
  at: number;
}

/** Everything needed to explain one answer without a debugger. */
export interface RagTrace {
  question: string;
  searchQuery: string;
  topK: number;
  candidates: number;
  matches: Array<{ id: string; score: number; source: string; section: string }>;
  contextTokens: number;
  citations: number;
  invalidCitations: number;
  refused: boolean;
  providers: { embedding: string; generation: string };
  latencyMs: { embed: number; search: number; generate: number; total: number };
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  refused: boolean;
  sessionId: string;
  trace: RagTrace;
}

/** The result of one ingestion run — the numbers you alert on. */
export interface IngestReport {
  documents: number;
  chunks: number;
  tokens: number;
  /** Files that produced no usable text (scanned PDFs, empty files). */
  skipped: string[];
  /** Sources deleted because they no longer exist on disk. */
  staleSourcesRemoved: string[];
  durationMs: number;
  store: string;
}
