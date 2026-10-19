import { BadRequestError } from '../lib/errors.js';
import type { FieldCondition, FieldOperators, Filter, Scalar } from '../types/vector.types.js';

/**
 * Compile a filter once per query, then evaluate the predicate per record.
 *
 * This is intentionally the same shape as Qdrant/pgvector filters: equality,
 * `$in`, range, existence and string containment, combined with `$and`/`$or`.
 * Compiling first avoids re-validating the JSON on every one of N records.
 */
export function compileFilter<T extends Record<string, unknown>>(
  filter: Filter | undefined,
): (payload: T) => boolean {
  if (!filter) return () => true;
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new BadRequestError('Filter must be a JSON object.');
  }
  return compileNode<T>(filter);
}

function compileNode<T extends Record<string, unknown>>(filter: Filter): (payload: T) => boolean {
  if (isAnd(filter)) {
    const children = filter.$and.map((child) => compileNode<T>(child));
    return (payload) => children.every((child) => child(payload));
  }
  if (isOr(filter)) {
    const children = filter.$or.map((child) => compileNode<T>(child));
    return (payload) => children.some((child) => child(payload));
  }
  if (isNot(filter)) {
    const child = compileNode<T>(filter.$not);
    return (payload) => !child(payload);
  }

  const conditions = Object.entries(filter).map(([field, condition]) =>
    compileField<T>(field, condition as FieldCondition),
  );
  return (payload) => conditions.every((condition) => condition(payload));
}

function compileField<T extends Record<string, unknown>>(
  field: string,
  condition: FieldCondition,
): (payload: T) => boolean {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    if (Array.isArray(condition)) {
      const allowed = new Set<Scalar>(condition);
      return (payload) => allowed.has(getPath(payload, field) as Scalar);
    }
    return (payload) => getPath(payload, field) === condition;
  }

  const operators = condition as FieldOperators;
  const known = new Set([
    '$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists', '$contains',
  ]);
  for (const key of Object.keys(operators)) {
    if (!known.has(key)) throw new BadRequestError(`Unsupported filter operator: ${key}`);
  }

  return (payload) => {
    const value = getPath(payload, field);
    if (operators.$exists !== undefined && (value !== undefined) !== operators.$exists) return false;
    if (operators.$eq !== undefined && value !== operators.$eq) return false;
    if (operators.$ne !== undefined && value === operators.$ne) return false;
    if (operators.$in !== undefined && !operators.$in.includes(value as Scalar)) return false;
    if (operators.$nin !== undefined && operators.$nin.includes(value as Scalar)) return false;
    if (operators.$gt !== undefined && !(typeof value === 'number' && value > operators.$gt)) {
      return false;
    }
    if (operators.$gte !== undefined && !(typeof value === 'number' && value >= operators.$gte)) {
      return false;
    }
    if (operators.$lt !== undefined && !(typeof value === 'number' && value < operators.$lt)) {
      return false;
    }
    if (operators.$lte !== undefined && !(typeof value === 'number' && value <= operators.$lte)) {
      return false;
    }
    if (operators.$contains !== undefined) {
      if (typeof value === 'string') {
        if (!value.toLowerCase().includes(operators.$contains.toLowerCase())) return false;
      } else if (Array.isArray(value)) {
        if (!value.includes(operators.$contains)) return false;
      } else {
        return false;
      }
    }
    return true;
  };
}

function getPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isAnd(filter: Filter): filter is { $and: Filter[] } {
  return '$and' in filter && Array.isArray((filter as { $and?: unknown }).$and);
}

function isOr(filter: Filter): filter is { $or: Filter[] } {
  return '$or' in filter && Array.isArray((filter as { $or?: unknown }).$or);
}

function isNot(filter: Filter): filter is { $not: Filter } {
  return '$not' in filter;
}
