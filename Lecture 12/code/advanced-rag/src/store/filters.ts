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
