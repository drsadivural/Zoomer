/**
 * Bounded priority queue for the analysis scheduler.
 *
 * A binary heap rather than a sorted array: with 200 participants re-prioritised
 * on every observation, repeated insertion into a sorted list is the one part of
 * the scheduler that would actually show up in a profile.
 *
 * Ties break on insertion order, so two equally urgent participants are analysed
 * round-robin instead of one of them starving behind the other.
 */

export interface Prioritised<T> {
  item: T;
  /** Higher runs first. */
  priority: number;
}

interface Node<T> {
  item: T;
  priority: number;
  seq: number;
}

export class PriorityQueue<T> {
  private heap: Node<T>[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(item: T, priority: number): void {
    this.heap.push({ item, priority, seq: this.seq++ });
    this.bubbleUp(this.heap.length - 1);
  }

  peek(): T | undefined {
    return this.heap[0]?.item;
  }

  pop(): T | undefined {
    const top = this.heap[0];
    if (!top) return undefined;
    const last = this.heap.pop()!;
    if (this.heap.length) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top.item;
  }

  /** Drains up to `limit` items in priority order. */
  take(limit: number): T[] {
    const out: T[] = [];
    while (out.length < limit) {
      const next = this.pop();
      if (next === undefined) break;
      out.push(next);
    }
    return out;
  }

  toSortedArray(): T[] {
    return this.take(this.heap.length);
  }

  private higher(a: Node<T>, b: Node<T>): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority;
    return a.seq < b.seq;
  }

  private bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.higher(this.heap[i], this.heap[parent])) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private sinkDown(index: number): void {
    const n = this.heap.length;
    let i = index;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < n && this.higher(this.heap[left], this.heap[best])) best = left;
      if (right < n && this.higher(this.heap[right], this.heap[best])) best = right;
      if (best === i) break;
      [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]];
      i = best;
    }
  }
}

/** Convenience: sort a batch by priority without holding the queue. */
export function rank<T>(entries: Prioritised<T>[]): T[] {
  const queue = new PriorityQueue<T>();
  for (const e of entries) queue.push(e.item, e.priority);
  return queue.toSortedArray();
}
