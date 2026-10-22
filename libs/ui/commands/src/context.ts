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
  readonly #stacks = new Map<
    string,
    { readonly token: symbol; readonly value: ContextValue }[]
  >();

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
   * Sets a key for as long as the caller wants it and returns the function that ends it. Providers of one
   * key stack: the latest one is in force, and when it ends the one below comes back, so two pages that
   * share a key (a split editor with two grids) do not clear each other's.
   */
  provide(key: string, value: ContextValue): () => void {
    const token = Symbol(key);
    const stack = this.#stacks.get(key) ?? [];
    stack.push({ token, value });
    this.#stacks.set(key, stack);
    this.set(key, value);
    return () => {
      const list = this.#stacks.get(key);
      if (list === undefined) return;
      const at = list.findIndex((entry) => entry.token === token);
      if (at < 0) return;
      const wasTop = at === list.length - 1;
      list.splice(at, 1);
      if (!wasTop) return;
      const below = list[list.length - 1];
      if (below === undefined) {
        this.#stacks.delete(key);
        this.delete(key);
      } else {
        this.set(key, below.value);
      }
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
