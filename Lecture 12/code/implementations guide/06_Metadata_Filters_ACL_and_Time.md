# Chapter 06: Metadata Filters, ACL and Time

> **Chapter Goal:** Decide which documents are *eligible* before any scoring happens — and
> separate the filter a caller asks for from the rules the system enforces. This is the
> chapter where a retrieval bug becomes a security incident if you get it wrong.

> **Lecture mapping:** Notes Chapter 05 — schema design, pre- versus post-filtering, the
> restrictiveness trap, tenant isolation, group ACLs, and time as a filter.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/store/filters.ts` | 155 | the filter DSL, the fail-closed access rules, the parser, the describe |
| `src/store/vector-store.ts` | 88 | the pre/post switch the filters are demonstrated through |
| `src/ingest/loader.ts` | 111 | where the metadata is validated, so the filters have something to trust |

---

## 1. Commands

```bash
cd "Lecture 12/code/advanced-rag"
npm run cli -- filters
```

---

## 2. Measured Output

```text

> lecture-12-advanced-rag@1.0.0 cli
> tsx src/cli.ts filters

Index: 27 chunks · tenant northwind-eu · acl [support, customer] · asOf 2026-06-01

filter                              chunks  why
──────────────────────────────────  ──────  ──────────────────────────────────────
no filter                           27      every chunk is visible to this caller
category in [electronics, general]  14      narrower caller filter, same access
tenant = other-tenant               0       fail closed: no tenant match
acl = [anonymous]                   0       fail closed: no group overlap
asOf = 2026-06-01                   24      current policies only
asOf = 2025-06-01                   3       superseded 2025 policy becomes visible

Filter "category == shipping", top-5:
  pre-filter   3 hits  (27 scanned, 3 eligible)
  post-filter  0 hits  (3 eligible, but K slots were spent first)
Post-filtering is how a system returns "no results" while the answer sits in the index.
```

Four results, and each one is a rule rather than a feature:

1. **`category in [electronics, general]` narrows 27 chunks to 14.** A caller filter can only
   *narrow*; it can never widen what the access rules allow.
2. **A different tenant gets 0 chunks.** Not "fewer" — zero, because a record whose `tenantId`
   does not match is invisible. The same is true for a caller in no matching group: 0.
3. **`asOf` moves the corpus.** 24 chunks are valid on 2026-06-01 and 3 are valid on
   2025-06-01: the superseded 2025 electronics policy becomes visible and the current one
   disappears. Time is a filter, and a corpus is a *time series* of corpora.
4. **The same filter, two orders of operations.** With `category == shipping` and a warranty
   question: pre-filtering returns **3 hits** (3 eligible, scanned and scored), post-filtering
   returns **0 hits** — the three eligible documents exist, but the top-5 slots were spent
   before the predicate ran.

That last line is the most expensive bug in this chapter's territory, and it is invisible in
logs that only record the final result count.


---

## 3. The Filter Language — `src/store/filters.ts`

```ts
import type { AccessContext, DocMeta } from '../types.js';

/**
 * The filter language, and the access rules that are not optional.
 *
 * Two things are being separated here, and the separation is the security lesson:
 *
 *  - `Filter` is what the *caller* asked for: `category in [electronics, general]`.
 *     It is a relevance control. Getting it wrong costs accuracy.
 *  - `AccessContext` is what the *system* enforces: tenant, group membership, and
 *     the effective date. It is applied to every query, whether the caller mentions
 *     it or not, and it fails closed: a document with no `tenantId`, no matching
 *     group, or a validity window that excludes `asOf` is invisible.
 *
 * A filter is a predicate evaluated *before* scoring (pre-filtering). That is the
 * only way to keep top-K honest: filtering after retrieval means K results were
 * spent on documents the caller may not see, and the answer is "no results" even
 * though eligible documents exist.
 */

export type Filter =
  | { op: 'eq'; field: string; value: string }
  | { op: 'in'; field: string; values: string[] }
  | { op: 'contains'; field: string; value: string }
  | { op: 'and'; clauses: Filter[] }
  | { op: 'or'; clauses: Filter[] };

export type MetaPredicate = (meta: DocMeta) => boolean;

/** Fields a caller is allowed to filter on. Anything else is a typo, not a feature. */
const FILTERABLE = new Set(['category', 'docType', 'productIds', 'version']);

function readField(meta: DocMeta, field: string): string | string[] | undefined {
  switch (field) {
    case 'category':
      return meta.category;
    case 'docType':
      return meta.docType;
    case 'productIds':
      return meta.productIds;
    case 'version':
      return meta.version;
    default:
      return undefined;
  }
}

function matchesOne(meta: DocMeta, filter: Filter): boolean {
  if (filter.op === 'and') return filter.clauses.every((clause) => matchesOne(meta, clause));
  if (filter.op === 'or') return filter.clauses.some((clause) => matchesOne(meta, clause));

  if (!FILTERABLE.has(filter.field)) {
    throw new Error(`Cannot filter on "${filter.field}". Allowed: ${[...FILTERABLE].join(', ')}.`);
  }

  const value = readField(meta, filter.field);
  if (value === undefined) return false;

  if (filter.op === 'contains') {
    return Array.isArray(value) ? value.includes(filter.value) : value === filter.value;
  }

  const values = Array.isArray(value) ? value : [value];
  if (filter.op === 'eq') return values.includes(filter.value);
  return filter.values.some((candidate) => values.includes(candidate));
}

/** Is this document valid on `asOf`? Missing dates fail open, missing tenant fails closed. */
export function isVisible(meta: DocMeta, access: AccessContext): boolean {
  if (!meta.tenantId || meta.tenantId !== access.tenantId) return false;
  if (meta.acl.length === 0 || !meta.acl.some((group) => access.acl.includes(group))) return false;
  if (meta.effectiveFrom && meta.effectiveFrom > access.asOf) return false;
  if (meta.effectiveTo && meta.effectiveTo < access.asOf) return false;
  return true;
}

/**
 * Combine access control with the caller's filter into one predicate.
 *
 * Note the order: access first. A caller filter can never widen visibility, only
 * narrow it — which is why `compileFilter(undefined, access)` is still a real
 * filter and not the identity function.
 */
export function compileFilter(filter: Filter | undefined, access: AccessContext): MetaPredicate {
  return (meta) => {
    if (!isVisible(meta, access)) return false;
    return filter ? matchesOne(meta, filter) : true;
  };
}

/**
 * A deliberately small filter language for the CLI and the API.
 *
 *   category == electronics
 *   category in [electronics, general]
 *   productIds contains AX-204
 *   category == electronics AND productIds contains BX-900
 *
 * It is a parser, not a DSL with a grammar file, because the point is to show
 * where filter expressions become code — and that unknown fields must throw
 * rather than silently match everything.
 */
export function parseFilter(expression: string): Filter {
  const clauses = expression.split(/\s+AND\s+/i).map((part) => part.trim()).filter(Boolean);
  if (clauses.length === 0) throw new Error('Empty filter expression.');

  const parsed = clauses.map(parseClause);
  return parsed.length === 1 ? parsed[0] : { op: 'and', clauses: parsed };
}

function parseClause(clause: string): Filter {
  const inMatch = /^(\w+)\s+in\s+\[(.*)\]$/i.exec(clause);
  if (inMatch) {
    const values = inMatch[2]
      .split(',')
      .map((value) => unquote(value.trim()))
      .filter(Boolean);
    if (values.length === 0) throw new Error(`Empty list in filter clause "${clause}".`);
    return { op: 'in', field: inMatch[1], values };
  }

  const containsMatch = /^(\w+)\s+contains\s+(.+)$/i.exec(clause);
  if (containsMatch) {
    return { op: 'contains', field: containsMatch[1], value: unquote(containsMatch[2].trim()) };
  }

  const eqMatch = /^(\w+)\s*==\s*(.+)$/.exec(clause);
  if (eqMatch) {
    return { op: 'eq', field: eqMatch[1], value: unquote(eqMatch[2].trim()) };
  }

  throw new Error(
    `Cannot parse filter clause "${clause}". Supported: field == value, field in [a, b], field contains value.`,
  );
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

/** Human-readable form, used in traces so a reviewer sees the filter that ran. */
export function describeFilter(filter: Filter): string {
  switch (filter.op) {
    case 'eq':
      return `${filter.field} == ${filter.value}`;
    case 'in':
      return `${filter.field} in [${filter.values.join(', ')}]`;
    case 'contains':
      return `${filter.field} contains ${filter.value}`;
    case 'and':
      return filter.clauses.map(describeFilter).join(' AND ');
    case 'or':
      return `(${filter.clauses.map(describeFilter).join(' OR ')})`;
  }
}
```

**Block by block:**

- **Two concepts, deliberately separated.** `Filter` is what the *caller* asked for
  (`category in [electronics, general]`) — a relevance control, where getting it wrong costs
  accuracy. `AccessContext` is what the *system* enforces (tenant, groups, date) — a security
  control, where getting it wrong costs the company.
- **`FILTERABLE` is an allow-list.** Filtering on a field that is not in it throws rather than
  silently matching everything, because a typo'd field name in a filter is otherwise a
  silent full-table scan that returns unfiltered results.
- **`isVisible` is the fail-closed function**, and every clause is a rule you can defend:
  - a missing or different `tenantId` is invisible;
  - a record with an empty `acl`, or no overlap with the caller's groups, is invisible;
  - `effectiveFrom > asOf` (not yet valid) or `effectiveTo < asOf` (superseded) is invisible.
  Note the direction of the comparisons: string comparison works here *because* the dates are
  ISO-8601, which is the only reason to insist on that format.
- **`compileFilter` puts access first and the caller's filter second.** The order is not
  cosmetic: the access check short-circuits, and no caller filter can widen the result set —
  only narrow it. `compileFilter(undefined, access)` is therefore still a real filter, not the
  identity function.
- **`parseFilter` is a parser, not a DSL engine.** Three clause forms (`==`, `in [...]`,
  `contains`), joined by `AND`. It exists because the CLI and the API need a text form, and
  because writing the parser is how you notice that unknown fields must throw.
- **`describeFilter`** produces the human-readable form used in traces, so a reviewer sees
  the filter that actually ran rather than the filter they think they configured.

---

## 4. Where the Metadata Comes From

The filters are only as good as the metadata, and the metadata is validated at ingestion —
before any of this code can run. That is the fail-closed principle applied at the earliest
possible point:

```ts
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
```

**Block by block:**

- **`tenantId: z.string().min(1)` with no default** — a document with no tenant cannot be
  isolated, so it never reaches the index. The alternative (defaulting to a tenant) is how one
  customer's contract ends up in another customer's answer.
- **`acl: z.array(z.string()).min(1)`** — an empty group list is not "public", it is
  "undefined". The rule is explicit: no groups means no access.
- **`effectiveFrom`/`effectiveTo` are validated as ISO dates** at ingestion, which is what
  makes the string comparison in `isVisible` correct.
- **The error names the file** (`returns-x.md: invalid metadata — tenantId: ...`), so a
  missing field is a one-line fix rather than a hunt through an index.

---

## 5. Pre-Filter or Post-Filter

| | pre-filter | post-filter |
| :--- | :--- | :--- |
| when the predicate runs | during the scan | after top-K |
| top-K means | best K **eligible** | best K overall, then filtered |
| narrow filter | K eligible results | often **zero** results |
| cost | scans eligible records only | scans everything, then throws work away |
| where it happens | index-level filtering (Qdrant `filter`, pgvector `WHERE`) | application-level `.filter()` after search |

The demo in this chapter is the third row. With `category == shipping` and a warranty
question, post-filtering returns nothing while three eligible documents sit in the index —
and the trace looks like "no results found", which is indistinguishable from "the corpus does
not cover this". That ambiguity is what makes the bug expensive: the first fix people try is
adding documents, and the corpus was never the problem.

**One more consequence, for multi-tenant systems:** if the predicate runs post-filter, the K
slots are shared across tenants. A tenant with a large share of the corpus can starve a small
tenant out of the results entirely. Pre-filtering makes the isolation a property of the query
rather than a property of the result set.

---

## 6. What to Take Away

- **A filter is a relevance control; access is a rule.** Keep them in separate concepts, and
  apply the rule whether the caller mentions it or not.
- **Fail closed on missing metadata.** No tenant, no groups, or no validity window means
  invisible — and it should fail at ingestion, not at query time.
- **ISO dates make string comparison correct.** That is a design decision with teeth.
- **Filter before scoring.** Post-filtering turns a filter problem into an apparent corpus
  problem, and it lets one tenant starve another out of the top-K.
- **Report `eligible` next to `hits`.** It is the difference between "filtered out" and
  "nothing scored well enough".
- **Let the caller narrow, never widen.** `compileFilter` enforces that by construction.

> **Where This Goes Next:** [Chapter 07](./07_Hybrid_Search_and_RRF.md) adds the second
> retrieval arm, which is what makes exact strings like `AX-204` findable at all.

