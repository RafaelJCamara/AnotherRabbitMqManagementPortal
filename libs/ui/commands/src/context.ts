// Context keys (M1-41, R4): small facts that decide whether a command is listed, such as "a connection is
// shown" or "the queues page is open". The shell and the pages set them, `when` reads them inside a
// `computed`, so a command appears and disappears with the page.
import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  signal,
  type Signal,
} from '@angular/core';

export type ContextValue = string | boolean | null;
export type ContextGetter = (key: string) => ContextValue | undefined;

@Injectable({ providedIn: 'root' })
export class CommandContext {
  readonly #values = signal<ReadonlyMap<string, ContextValue>>(new Map());

  /** Reads a key; reactive when read inside a `computed` or an `effect`. */
  readonly get: ContextGetter = (key) => this.#values().get(key);

  set(key: string, value: ContextValue): void {
    this.#values.update((map) => new Map(map).set(key, value));
  }

  delete(key: string): void {
    this.#values.update((map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  }

  /**
   * Sets a key for as long as the caller wants it and returns the function that ends it. The key is
   * removed only if it still holds this value, so a page that opened later is not cleared by one that closed.
   */
  provide(key: string, value: ContextValue): () => void {
    this.set(key, value);
    return () => {
      if (this.get(key) === value) this.delete(key);
    };
  }

  /** Ties a key to a signal for the life of the calling injection context. */
  bind(key: string, source: Signal<ContextValue>): void {
    effect(() => {
      this.set(key, source());
    });
    inject(DestroyRef).onDestroy(() => {
      this.delete(key);
    });
  }
}
