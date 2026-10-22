import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { normaliseText } from '../lib/text.js';
import type { DocMeta, SourceDocument } from '../types.js';

/**
 * Document loading, with metadata as a hard requirement.
 *
 * Every file carries a front-matter block that becomes the filterable metadata
 * from Chapter 05. Parsing it is boring; *validating* it is the interesting part.
 * A document with no `tenantId` or no `acl` cannot be filtered safely, so it is
 * rejected at ingestion rather than leaking into an answer later. That is the
 * fail-closed rule applied at the earliest possible point.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');

const metaSchema = z.object({
  docType: z.string().min(1).default('policy'),
  category: z.string().min(1).default('general'),
  productIds: z.array(z.string()).default([]),
  tenantId: z.string().min(1, 'tenantId is required — an unfiltered document cannot be isolated.'),
  acl: z.array(z.string()).min(1, 'acl must list at least one group.'),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional(),
  version: z.string().min(1).default('1.0'),
});

export { metaSchema };

/** Split `---` front matter from the body. Deliberately not a full YAML parser. */
export function parseFrontMatter(raw: string, source: string): { data: Record<string, string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error(`${source}: missing front matter. Every document needs tenantId and acl.`);
  }

  const data: Record<string, string[]> = {};

  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) throw new Error(`${source}: malformed front-matter line "${trimmed}".`);

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value ? [value.replace(/^["']|["']$/g, '')] : [];
    }
  }

  return { data, body: match[2] };
}

/** Front matter → validated `DocMeta`. Throws with the file name, not a stack trace. */
export function toMeta(data: Record<string, string[]>, source: string): DocMeta {
  const parsed = metaSchema.safeParse({
    docType: data.docType?.[0],
    category: data.category?.[0],
    productIds: data.productIds ?? [],
    tenantId: data.tenantId?.[0],
    acl: data.acl ?? [],
    effectiveFrom: data.effectiveFrom?.[0],
    effectiveTo: data.effectiveTo?.[0],
    version: data.version?.[0],
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`${source}: invalid metadata — ${issues.join('; ')}`);
  }

  return parsed.data;
}

/** The document title is the first H1, falling back to the file name. */
export function titleOf(body: string, source: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : source.replace(/\.md$/, '');
}

export async function loadDocument(filePath: string): Promise<SourceDocument> {
  const source = path.basename(filePath);
  const raw = await readFile(filePath, 'utf8');
  const { data, body } = parseFrontMatter(raw, source);

  return {
    source,
    title: titleOf(body, source),
    text: normaliseText(body),
    meta: toMeta(data, source),
  };
}

/** Every `.md` file in the policy directory, sorted so ingestion is reproducible. */
export async function loadDocuments(directory: string): Promise<SourceDocument[]> {
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.md')).sort();
  return Promise.all(entries.map((entry) => loadDocument(path.join(directory, entry))));
}
