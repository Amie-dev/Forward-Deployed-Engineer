import type { Chunk, SourceDocument } from '../types.js';

/**
 * Contextual retrieval — the fix for the chunk that forgot what it was about.
 *
 * A chunk that says "This does not apply to electronics." is unresolvable on its
 * own: it has a pronoun and no antecedent. Two ways to fix that:
 *
 *  - **template** (offline, deterministic): the breadcrumb plus the document's
 *    metadata is turned into one sentence of context. Free, reproducible, and
 *    enough for most policy corpora because the document already knows what it is.
 *  - **llm** (Anthropic's contextual retrieval): ask a model to write one or two
 *    sentences situating the chunk in the document. Better on messy prose, costs
 *    one call per chunk at ingest, and needs a cache or it becomes the most
 *    expensive thing in the pipeline.
 *
 * The prefix is prepended to the text that gets *embedded*, and it is also shown
 * to the reader at answer time. That is deliberate: the same words that make the
 * chunk findable make the citation understandable.
 */

export type ContextMode = 'none' | 'template' | 'llm';

export function templateContext(chunk: Chunk, doc?: SourceDocument): string {
  const subject = chunk.meta.productIds.length > 0
    ? `${chunk.meta.category} policy covering ${chunk.meta.productIds.join(', ')}`
    : `${chunk.meta.category} policy`;

  const validity = chunk.meta.effectiveTo
    ? `in force from ${chunk.meta.effectiveFrom ?? 'unrecorded'} until ${chunk.meta.effectiveTo}`
    : `in force from ${chunk.meta.effectiveFrom ?? 'unrecorded'}`;

  const section = chunk.breadcrumb || doc?.title || chunk.source;
  return `Context: this passage is from "${section}" in "${chunk.title}", a ${subject}, ${validity}.`;
}

/**
 * One model call per chunk, at ingest time, cached by chunk id.
 *
 * The prompt is short on purpose: the model's job is to *situate* the chunk, not
 * to summarise it. Summaries lose the exact numbers ("48 hours") that retrieval
 * is supposed to preserve.
 */
export async function llmContext(
  doc: SourceDocument,
  chunk: Chunk,
  options: { apiKey: string; model: string },
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content:
            'Write one short sentence that situates the passage inside the document. ' +
            'Name the document and the section, and state what the passage is about. ' +
            'Do not summarise the passage, do not add facts, do not use the word "excerpt".',
        },
        {
          role: 'user',
          content: `<document>\n${doc.text.slice(0, 6000)}\n</document>\n\n<passage>\n${chunk.text}\n</passage>`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Contextual retrieval failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return payload.choices[0]?.message.content.trim() ?? templateContext(chunk, doc);
}

/** Attach a context prefix to every chunk. The `none` mode returns the input untouched. */
export async function contextualize(
  chunks: readonly Chunk[],
  docs: ReadonlyMap<string, SourceDocument>,
  options: { mode: ContextMode; apiKey?: string; model: string },
): Promise<Chunk[]> {
  if (options.mode === 'none') return [...chunks];

  const cache = new Map<string, string>();
  const output: Chunk[] = [];

  for (const chunk of chunks) {
    const doc = docs.get(chunk.source);
    let prefix = cache.get(chunk.id);

    if (!prefix) {
      if (options.mode === 'llm' && doc && options.apiKey) {
        prefix = await llmContext(doc, chunk, { apiKey: options.apiKey, model: options.model });
      } else {
        prefix = templateContext(chunk, doc);
      }
      cache.set(chunk.id, prefix);
    }

    output.push({ ...chunk, contextPrefix: prefix });
  }

  return output;
}

/**
 * The exact string that is embedded.
 *
 * Order matters: context first, then the breadcrumb, then the text. Embedding
 * models weight the beginning of the input more heavily, and the beginning is
 * where the *subject* belongs — the specific words are already in the text.
 */
export function embedText(chunk: Chunk): string {
  return [chunk.contextPrefix, chunk.breadcrumb, chunk.text].filter(Boolean).join('\n').trim();
}
