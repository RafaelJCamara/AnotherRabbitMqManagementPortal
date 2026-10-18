// A bounded queue that one consumer reads as an async iterable. Both carriers use it to hand server
// frames to the LiveClient. Credits bound how many frames the engine may send, so a full queue
// means the engine broke the protocol: the queue fails with an 'overflow' TransportError instead of
// growing or dropping frames silently (I-6, I-13).
import { TransportError } from './engine-transport';

export class FrameQueue<T> implements AsyncIterable<T> {
  readonly #capacity: number;
  readonly #onReturn: (() => void) | undefined;
  readonly #items: T[] = [];
  #waiter: {
    resolve(result: IteratorResult<T>): void;
    reject(error: unknown): void;
  } | null = null;
  #done = false;
  #error: unknown = undefined;
  #failed = false;

  constructor(capacity: number, onReturn?: () => void) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('capacity must be a positive integer');
    }
    this.#capacity = capacity;
    this.#onReturn = onReturn;
  }

  get size(): number {
    return this.#items.length;
  }

  get done(): boolean {
    return this.#done;
  }

  /** False when the queue is finished or this push overflowed it (which finishes it). */
  push(value: T): boolean {
    if (this.#done) return false;
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter.resolve({ value, done: false });
      return true;
    }
    if (this.#items.length >= this.#capacity) {
      this.end(
        new TransportError(
          'overflow',
          `more than ${String(this.#capacity)} frames are waiting for the reader`,
        ),
      );
      return false;
    }
    this.#items.push(value);
    return true;
  }

  /** Finishes the queue. The reader first gets what is queued, then the error or the end. */
  end(error?: unknown): void {
    if (this.#done) return;
    this.#done = true;
    if (error !== undefined) {
      this.#failed = true;
      this.#error = error;
    }
    const waiter = this.#waiter;
    if (waiter !== null && this.#items.length === 0) {
      this.#waiter = null;
      this.#settleDone(waiter);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.#next(),
      return: () => {
        this.#items.length = 0;
        this.end();
        this.#onReturn?.();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      return Promise.resolve({ value: this.#items.shift() as T, done: false });
    }
    if (this.#done) {
      return new Promise((resolve, reject) => {
        this.#settleDone({ resolve, reject });
      });
    }
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  #settleDone(waiter: {
    resolve(result: IteratorResult<T>): void;
    reject(error: unknown): void;
  }): void {
    if (this.#failed) {
      const error = this.#error;
      this.#failed = false;
      waiter.reject(error);
    } else {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}
