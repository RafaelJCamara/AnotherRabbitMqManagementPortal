import { BoundedCore } from './core.ts';

/**
 * A bounded buffer that keeps the newest items (I-6): when an item arrives and either limit would
 * be exceeded, the oldest items are evicted until it fits. Every eviction is counted in `dropped`
 * and reported to `onDrop`, so a consumer can tell the user that items were lost (I-13).
 *
 * The add method is `add`, not `push`, on purpose: `@app/bounded-buffers-only` rejects `.push`
 * on anything named like a buffer.
 */
export class BoundedRing<T> extends BoundedCore<T> {
  /**
   * Adds an item and returns how many items this call dropped. An item larger than `maxBytes`
   * cannot fit even in an empty ring: it is dropped itself (reason `oversized`) and the contents
   * stay as they were.
   */
  add(item: T): number {
    const size = this.sizeOfItem(item);
    if (size > this.maxBytes) {
      this.recordDrop('oversized', 1, size);
      return 1;
    }
    let evicted = 0;
    let evictedBytes = 0;
    while (!this.fits(size)) {
      evictedBytes += this.evictOldest();
      evicted += 1;
    }
    this.store(item, size);
    if (evicted > 0) this.recordDrop('overflow', evicted, evictedBytes);
    return evicted;
  }
}
