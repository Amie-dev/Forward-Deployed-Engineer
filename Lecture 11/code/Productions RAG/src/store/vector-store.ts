import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cosineSimilarity } from '../lib/vectors.js';
import type { IndexRecord, Match } from '../types/rag.types.js';

/**
 * The only surface the rest of the code needs from "the vector database".
 *
 * Chapter 05 in one interface: upsert, query with a top-K, delete by source so
 * removed documents stop being retrievable, and a count so `/health` can prove
 * the index is not empty.
 */
export interface VectorFilter {
  source?: string;
}

export interface VectorQuery {
  vector: readonly number[];
  topK: number;
  filter?: VectorFilter;
}

export interface VectorStore {
  readonly name: string;
  upsert(records: readonly IndexRecord[]): Promise<number>;
  query(request: VectorQuery): Promise<Match[]>;
  deleteBySource(source: string): Promise<number>;
  count(): Promise<number>;
  /** Optional: only stores that can enumerate sources support orphan cleanup. */
  listSources?(): Promise<string[]>;
}

interface Snapshot {
  version: 1;
  model: string;
  dimensions: number;
  records: IndexRecord[];
}

/**
 * Exact cosine search over an in-memory map, persisted to one JSON file.
 *
 * At a few thousand chunks this is faster than a network round trip, which is
 * exactly why it is the default here. The interface is the same one the Pinecone
 * adapter implements, so switching is a config change.
 */
export class MemoryVectorStore implements VectorStore {
  readonly name = 'memory';

  private readonly records = new Map<string, IndexRecord>();
  private readonly indexPath: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(config: { indexPath: string; model: string; dimensions: number }) {
    this.indexPath = config.indexPath;
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  /** Reload the persisted index. A model or dimension change invalidates it. */
  async load(): Promise<number> {
    let snapshot: Snapshot;

    try {
      snapshot = JSON.parse(await readFile(this.indexPath, 'utf8')) as Snapshot;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 0;
      console.warn(`[store] ignoring unreadable index at ${this.indexPath}: ${String(error)}`);
      return 0;
    }

    if (snapshot.model !== this.model || snapshot.dimensions !== this.dimensions) {
      console.warn(
        `[store] index was built with ${snapshot.model}/${snapshot.dimensions} dims, ` +
          `config says ${this.model}/${this.dimensions} — re-ingesting.`,
      );
      return 0;
    }

    for (const record of snapshot.records) this.records.set(record.id, record);
    return this.records.size;
  }

  async upsert(records: readonly IndexRecord[]): Promise<number> {
    for (const record of records) {
      if (record.vector.length !== this.dimensions) {
        throw new Error(
          `Record ${record.id} has ${record.vector.length} dimensions, index expects ${this.dimensions}.`,
        );
      }
      this.records.set(record.id, record);
    }

    await this.persist();
    return records.length;
  }

  async query({ vector, topK, filter }: VectorQuery): Promise<Match[]> {
    const scored: Match[] = [];

    for (const record of this.records.values()) {
      if (filter?.source && record.source !== filter.source) continue;
      const { vector: stored, ...chunk } = record;
      scored.push({ ...chunk, score: cosineSimilarity(vector, stored) });
    }

    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, topK);
  }

  async deleteBySource(source: string): Promise<number> {
    let removed = 0;

    for (const [id, record] of this.records) {
      if (record.source === source) {
        this.records.delete(id);
        removed++;
      }
    }

    if (removed > 0) await this.persist();
    return removed;
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async listSources(): Promise<string[]> {
    return [...new Set([...this.records.values()].map((record) => record.source))].sort();
  }

  async clear(): Promise<void> {
    this.records.clear();
    await this.persist();
  }

  /** Write to a temp file, then rename: a crash never leaves a truncated index. */
  private async persist(): Promise<void> {
    const snapshot: Snapshot = {
      version: 1,
      model: this.model,
      dimensions: this.dimensions,
      records: [...this.records.values()],
    };

    await mkdir(path.dirname(this.indexPath), { recursive: true });
    const temporaryPath = `${this.indexPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
    await rename(temporaryPath, this.indexPath);
  }
}
