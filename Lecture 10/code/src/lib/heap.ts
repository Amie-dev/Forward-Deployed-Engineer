/**
 * A tiny generic binary heap.
 *
 * Comparator contract: negative means `a` has higher priority than `b`.
 * That one rule lets the same class act as a min-heap or a max-heap, which is
 * exactly what HNSW needs (closest-first candidates, farthest-first results).
 */
export type Comparator<T> = (a: T, b: T) => number;

export class BinaryHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: Comparator<T>) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Replace the root in O(log n). Used by bounded top-K. */
  replaceTop(item: T): void {
    if (this.items.length === 0) return;
    this.items[0] = item;
    this.siftDown(0);
  }

  /** Snapshot sorted by the heap's own priority order. */
  toArray(): T[] {
    return [...this.items].sort(this.compare);
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.items[i], this.items[parent]) >= 0) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;

      if (left < this.items.length && this.compare(this.items[left], this.items[best]) < 0) {
        best = left;
      }
      if (right < this.items.length && this.compare(this.items[right], this.items[best]) < 0) {
        best = right;
      }
      if (best === i) break;

      [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
      i = best;
    }
  }
}
