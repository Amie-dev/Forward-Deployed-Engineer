import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { normaliseText } from '../lib/text.js';
import type { SourceDocument } from '../types/rag.types.js';

const SUPPORTED = new Set(['.md', '.markdown', '.txt', '.pdf']);

/**
 * Read every supported file in the knowledge folder, in a stable order.
 *
 * Order matters: it makes chunk indices, and therefore chunk ids, reproducible
 * across machines. That is what allows "re-ingest changed files only" later.
 */
export async function loadDocuments(directory: string): Promise<SourceDocument[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error(`Knowledge directory not found: ${directory}. Set KNOWLEDGE_DIR in .env.`);
    }
    throw error;
  });

  const files = entries
    .filter((entry) => entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(
      `No ${[...SUPPORTED].join(' / ')} files in ${directory}. Refusing to build an empty index.`,
    );
  }

  const documents = await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(directory, file);
      const raw = path.extname(file).toLowerCase() === '.pdf'
        ? await extractPdfText(filePath)
        : await readFile(filePath, 'utf8');
      const text = normaliseText(raw);

      return { source: file, title: detectTitle(text, file), text } satisfies SourceDocument;
    }),
  );

  return documents;
}

/**
 * PDFs have no structure left after extraction — only text. Scanned PDFs return
 * nothing at all, which is why the caller reports empty documents instead of
 * silently indexing them.
 */
async function extractPdfText(filePath: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const buffer = await readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });

  return Array.isArray(text) ? text.join('\n\n') : text;
}

/** First markdown H1 wins; otherwise the file name becomes the title. */
function detectTitle(text: string, file: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(text);
  if (heading) return heading[1];

  return path
    .basename(file, path.extname(file))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\p{Ll}/gu, (character) => character.toUpperCase());
}
