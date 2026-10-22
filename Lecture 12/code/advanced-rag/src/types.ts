/**
 * Data contracts for the Advanced RAG pipeline.
 *
 * One file, because the whole lecture is about *where* an assumption is made.
 * If you can read these shapes, you can see the two places a RAG system loses
 * information: `Chunk` (what could ever be retrieved) and `AssembledContext`
 * (what the model actually sees). Every control in the lecture edits one of them.
 */

/** Metadata that travels with every chunk and is used for filtering. */
export interface DocMeta {
  docType: string;
  /** Policy category: general | electronics | damage | warranty | shipping. */
  category: string;
  productIds: string[];
  /** Tenant that owns the document. Filtering fails closed when this is absent. */
  tenantId: string;
  /** Groups allowed to read the document. Filtering fails closed on no overlap. */
  acl: string[];
  /** ISO date the document became valid. */
  effectiveFrom?: string;
  /** ISO date the document stopped being valid. Empty means "still current". */
  effectiveTo?: string;
  version: string;
}

/** A file as it came off disk, after cleaning and metadata parsing. */
export interface SourceDocument {
  /** File name — the label a customer eventually sees in a citation. */
  source: string;
  title: string;
  text: string;
  meta: DocMeta;
}

/**
 * The unit of retrieval.
 *
 * `breadcrumb` and `parentId` are the two fields a naive chunker cannot fill in,
 * and they are the reason a 7-day rule can still be found by "headphones return
 * policy": the breadcrumb carries the document's subject, and the parent carries
 * the surrounding section.
 */
export interface Chunk {
  /** Deterministic: sha256(source:breadcrumb:index:text). Re-ingesting is a no-op. */
  id: string;
  text: string;
  source: string;
  title: string;
  /** Nearest markdown heading. Empty for fixed-size windows — that is the point. */
  heading: string;
  /** `title › heading › sub-heading`. Empty for fixed-size windows. */
  breadcrumb: string;
  chunkIndex: number;
  tokens: number;
  /** Id of the section this chunk belongs to, or null when chunking is blind. */
  parentId: string | null;
  /** Full section text, capped. Used for parent-expansion at answer time. */
  parentText?: string;
  /** One or two sentences situating this chunk in its document (Chapter 03). */
  contextPrefix?: string;
  meta: DocMeta;
}

/** A chunk plus the vector that gets indexed. */
export interface IndexRecord extends Chunk {
  /** The exact string that was embedded: contextPrefix + breadcrumb + text. */
  embedText: string;
  vector: number[];
}

/** A chunk plus a score, tagged with the stage that produced the score. */
export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  origin: 'dense' | 'lexical' | 'fused' | 'rerank';
}

/** A dense hit keeps its vector so MMR can compare candidates to each other. */
export interface DenseCandidate extends ScoredChunk {
  vector: number[];
}

/** `[n]` marker in an answer, resolved back to the block it claims to cite. */
export interface Citation {
  label: number;
  source: string;
  heading: string;
  /** False when the model cited a label that was never in the prompt. */
  valid: boolean;
}

/** One labelled evidence block, ready to be pasted into the prompt. */
export interface ContextBlock {
  label: number;
  chunkId: string;
  source: string;
  heading: string;
  text: string;
  tokens: number;
  score: number;
  /** Higher wins when two blocks disagree: product-specific beats general. */
  specificity: number;
  /** True when the block is the expanded parent section rather than the child. */
  expanded: boolean;
}

/** The output of context assembly — everything the model is allowed to see. */
export interface AssembledContext {
  text: string;
  blocks: ContextBlock[];
  tokens: number;
  /** Chunks that did not fit the budget or were duplicates. */
  dropped: number;
}

/** One timed stage. `detail` is the number a reviewer will ask about. */
export interface TraceStage {
  name: string;
  ms: number;
  detail: string;
}

/** Everything needed to explain one answer without opening a debugger. */
export interface RagTrace {
  question: string;
  asOf: string;
  tenantId: string;
  stages: TraceStage[];
  retrieved: Array<{
    id: string;
    source: string;
    heading: string;
    dense: number;
    bm25?: number;
    fused?: number;
    rerank?: number;
    /** Position in the final list that reached the prompt (1 = best). */
    rank?: number;
    used: boolean;
  }>;
  candidates: number;
  reranked: number;
  contextTokens: number;
  dropped: number;
  refused: boolean;
  invalidCitations: number;
  latencyMs: number;
  providers: { embeddings: string; rerank: string; generation: string };
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  refused: boolean;
  trace: RagTrace;
}

/** Who is asking, and as of when. Both are *inputs*, never defaults inside a query. */
export interface AccessContext {
  tenantId: string;
  acl: string[];
  /** ISO date. Drives the `effectiveFrom`/`effectiveTo` validity check. */
  asOf: string;
}
