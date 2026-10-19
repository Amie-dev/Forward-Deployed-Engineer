import { BinaryHeap } from './heap.js';

export interface Ranked {
  id: string;
  score: number;
}

/**
 * Bounded top-K collector: O(N log K) time, O(K) memory.
 *
 * Keeping the *worst* score at the root lets us reject almost every candidate
 * with one comparison. Sorting all N scores would be O(N log N) and allocate an
 * array proportional to the collection — unacceptable at 100M vectors.
 */
export class TopK {
  private readonly heap: BinaryHeap<Ranked>;

  constructor(private readonly k: number) {
    // Min-heap by score: the weakest result sits at the root.
    this.heap = new BinaryHeap<Ranked>((a, b) => a.score - b.score);
  }

  /** Score of the current K-th best, or -Infinity while the heap is filling. */
  get threshold(): number {
    if (this.heap.size < this.k) return -Infinity;
    return this.heap.peek()!.score;
  }

  push(id: string, score: number): void {
    if (this.k <= 0 || !Number.isFinite(score)) return;

    if (this.heap.size < this.k) {
      this.heap.push({ id, score });
      return;
    }
    if (score > this.heap.peek()!.score) {
      this.heap.replaceTop({ id, score });
    }
  }

  /** Deterministic order: score descending, then id ascending. */
  results(): Ranked[] {
    return this.heap
      .toArray()
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
}
