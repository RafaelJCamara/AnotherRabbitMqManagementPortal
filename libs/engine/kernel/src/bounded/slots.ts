// The storage behind BoundedRing and BoundedQueue: a growable circular list of items with their
// sizes. It has no limits of its own; the two public classes enforce them. Capacity grows by
// doubling up to `maxItems`, so a ring with a huge limit does not allocate it up front.

export class Slots<T> {
  private items: (T | undefined)[];
  private sizes: number[];
  private head = 0;
  private count = 0;

  constructor(private readonly maxItems: number) {
    const initial = Math.min(maxItems, 16);
    this.items = new Array<T | undefined>(initial);
    this.sizes = new Array<number>(initial).fill(0);
  }

  get length(): number {
    return this.count;
  }

  addBack(item: T, size: number): void {
    if (this.count === this.items.length) this.grow();
    const index = (this.head + this.count) % this.items.length;
    this.items[index] = item;
    this.sizes[index] = size;
    this.count += 1;
  }

  /** Removes the oldest item; the caller checked `length` first. */
  takeFront(): { item: T; size: number } {
    const item = this.items[this.head] as T;
    const size = this.sizes[this.head] ?? 0;
    this.items[this.head] = undefined;
    this.sizes[this.head] = 0;
    this.head = (this.head + 1) % this.items.length;
    this.count -= 1;
    return { item, size };
  }

  peekFront(): T | undefined {
    return this.count === 0 ? undefined : this.items[this.head];
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      out.push(this.items[(this.head + i) % this.items.length] as T);
    }
    return out;
  }

  private grow(): void {
    const capacity = Math.min(this.maxItems, this.items.length * 2);
    const items = new Array<T | undefined>(capacity);
    const sizes = new Array<number>(capacity).fill(0);
    for (let i = 0; i < this.count; i += 1) {
      const from = (this.head + i) % this.items.length;
      items[i] = this.items[from];
      sizes[i] = this.sizes[from] ?? 0;
    }
    this.items = items;
    this.sizes = sizes;
    this.head = 0;
  }
}
