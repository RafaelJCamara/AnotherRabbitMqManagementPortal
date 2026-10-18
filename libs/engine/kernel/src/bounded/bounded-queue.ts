import { BoundedCore } from './core.ts';

/**
 * A bounded FIFO that keeps the oldest items and pushes back on the producer (I-6): when an item
 * does not fit, `offer` returns false and the item is not stored. A refusal counts in `dropped`
 * and is reported to `onDrop`, because the item is lost unless the caller keeps it (I-13).
 *
 * The add method is `offer`, not `push`, on purpose: `@app/bounded-buffers-only` rejects `.push`
 * on anything named like a buffer.
 */
export class BoundedQueue<T> extends BoundedCore<T> {
  /** Adds an item at the tail. Returns false, and counts a drop, when it does not fit. */
  offer(item: T): boolean {
    const size = this.sizeOfItem(item);
    if (size > this.maxBytes) {
      this.recordDrop('oversized', 1, size);
      return false;
    }
    if (!this.fits(size)) {
      this.recordDrop('full', 1, size);
      return false;
    }
    this.store(item, size);
    return true;
  }
}
