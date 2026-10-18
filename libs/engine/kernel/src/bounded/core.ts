// Shared accounting of BoundedRing and BoundedQueue: the two limits, the counters and the drop
// callback. The public classes add only their overflow policy.
import { assertLimit, binarySizeOf, checkedSize, type SizeOf } from './size.ts';
import { Slots } from './slots.ts';
import type {
  BoundedOptions,
  BoundedStats,
  DropEvent,
  DropReason,
} from './types.ts';

export abstract class BoundedCore<T> {
  protected readonly slots: Slots<T>;
  protected readonly maxItems: number;
  protected readonly maxBytes: number;
  private readonly measure: SizeOf<T>;
  private readonly onDrop: ((event: DropEvent) => void) | undefined;
  private heldBytes = 0;
  private droppedItems = 0;
  private droppedByteTotal = 0;

  constructor(options: BoundedOptions<T>) {
    assertLimit('maxItems', options.maxItems);
    assertLimit('maxBytes', options.maxBytes);
    this.maxItems = options.maxItems;
    this.maxBytes = options.maxBytes;
    this.measure = options.sizeOf ?? binarySizeOf;
    this.onDrop = options.onDrop;
    this.slots = new Slots<T>(options.maxItems);
  }

  /** Items held. */
  get size(): number {
    return this.slots.length;
  }

  /** Bytes held. */
  get bytes(): number {
    return this.heldBytes;
  }

  /** Items dropped since creation. */
  get dropped(): number {
    return this.droppedItems;
  }

  stats(): BoundedStats {
    return {
      items: this.slots.length,
      bytes: this.heldBytes,
      dropped: this.droppedItems,
      droppedBytes: this.droppedByteTotal,
      maxItems: this.maxItems,
      maxBytes: this.maxBytes,
    };
  }

  /** The oldest item, without removing it. */
  peek(): T | undefined {
    return this.slots.peekFront();
  }

  /** Removes and returns the oldest item. */
  shift(): T | undefined {
    if (this.slots.length === 0) return undefined;
    const { item, size } = this.slots.takeFront();
    this.heldBytes -= size;
    return item;
  }

  /** A copy of the contents, oldest first. */
  toArray(): T[] {
    return this.slots.toArray();
  }

  /** Removes and returns up to `max` of the oldest items (all of them by default). */
  drain(max = Infinity): T[] {
    const out: T[] = [];
    while (out.length < max && this.slots.length > 0) {
      out.push(this.shift() as T);
    }
    return out;
  }

  /** Discards the contents. The discarded items count as dropped (reason `cleared`). */
  clear(): void {
    let items = 0;
    let bytes = 0;
    while (this.slots.length > 0) {
      bytes += this.slots.takeFront().size;
      items += 1;
    }
    this.heldBytes = 0;
    if (items > 0) this.recordDrop('cleared', items, bytes);
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.slots.toArray()[Symbol.iterator]();
  }

  protected sizeOfItem(item: T): number {
    return checkedSize(this.measure, item);
  }

  protected store(item: T, size: number): void {
    this.slots.addBack(item, size);
    this.heldBytes += size;
  }

  protected evictOldest(): number {
    const { size } = this.slots.takeFront();
    this.heldBytes -= size;
    return size;
  }

  protected fits(size: number): boolean {
    return (
      this.slots.length < this.maxItems &&
      this.heldBytes + size <= this.maxBytes
    );
  }

  protected recordDrop(reason: DropReason, items: number, bytes: number): void {
    this.droppedItems += items;
    this.droppedByteTotal += bytes;
    this.onDrop?.({ reason, items, bytes });
  }
}
