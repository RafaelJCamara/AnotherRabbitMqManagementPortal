// ConnectionDirectory (M0-52, R2): the connection profiles the person can see, read from `connections.list` in
// windows and shared by everything that lists connections (the connections page, the shell's switcher). It holds
// profiles as the engine sent them, which carry no secret (a secret reads back as set or not set), and it is
// bounded: windows of `CONNECTIONS_PAGE_MAX`, at most `CONNECTIONS_PER_PRINCIPAL_MAX` kept (I-6, I-7). Whoever
// changes a profile calls `refresh()` afterwards, so a created, updated or deleted connection shows everywhere.
import { Injectable, inject, signal, type Signal } from '@angular/core';
import {
  CONNECTIONS_PAGE_MAX,
  CONNECTIONS_PER_PRINCIPAL_MAX,
  connectionsList,
  type ConnectionProfile,
} from '@app/contracts';
import { firstValueFrom } from 'rxjs';

import { EngineApi } from './engine-api';

export type DirectoryStatus = 'idle' | 'loading' | 'ready' | 'error';

@Injectable({ providedIn: 'root' })
export class ConnectionDirectory {
  readonly #api = inject(EngineApi);
  readonly #items = signal<readonly ConnectionProfile[]>([]);
  readonly #status = signal<DirectoryStatus>('idle');
  readonly #error = signal<unknown>(null);
  readonly #hasMore = signal(false);
  #cursor: string | undefined;
  /** A refresh that starts while another is on its way wins; the older answer is dropped. */
  #generation = 0;

  /** The profiles read so far, in the engine's order. */
  readonly items: Signal<readonly ConnectionProfile[]> =
    this.#items.asReadonly();
  readonly status: Signal<DirectoryStatus> = this.#status.asReadonly();
  /** The last failure, as received, or `null`. A failed read keeps the profiles that were already read. */
  readonly error: Signal<unknown> = this.#error.asReadonly();
  /** There are profiles the list has not read (more windows exist and the bound is not reached). */
  readonly hasMore: Signal<boolean> = this.#hasMore.asReadonly();

  /** Reads the first window if nothing has been read yet; the shell calls this when it opens. */
  ensureLoaded(): void {
    if (this.#status() === 'idle') void this.refresh();
  }

  /** Reads the first window again and replaces what was read. */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    this.#status.set('loading');
    try {
      const page = await firstValueFrom(
        this.#api.call(connectionsList, { limit: CONNECTIONS_PAGE_MAX }),
      );
      if (generation !== this.#generation) return;
      this.#items.set(page.items.slice(0, CONNECTIONS_PER_PRINCIPAL_MAX));
      this.#cursor = page.nextCursor;
      this.#hasMore.set(this.#more(page.items.length));
      this.#error.set(null);
      this.#status.set('ready');
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error.set(error);
      this.#status.set('error');
    }
  }

  /** Reads the next window and appends it, up to the bound. */
  async more(): Promise<void> {
    const cursor = this.#cursor;
    if (cursor === undefined || this.#status() === 'loading') return;
    const generation = ++this.#generation;
    this.#status.set('loading');
    try {
      const page = await firstValueFrom(
        this.#api.call(connectionsList, {
          limit: CONNECTIONS_PAGE_MAX,
          cursor,
        }),
      );
      if (generation !== this.#generation) return;
      const room = CONNECTIONS_PER_PRINCIPAL_MAX - this.#items().length;
      this.#items.update((items) => [...items, ...page.items.slice(0, room)]);
      this.#cursor = page.nextCursor;
      this.#hasMore.set(this.#more(Math.min(page.items.length, room)));
      this.#error.set(null);
      this.#status.set('ready');
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error.set(error);
      this.#status.set('error');
    }
  }

  /** The profile with this id among those read, or `undefined`. */
  find(cid: string): ConnectionProfile | undefined {
    return this.#items().find((profile) => profile.id === cid);
  }

  #more(added: number): boolean {
    return (
      this.#cursor !== undefined &&
      added > 0 &&
      this.#items().length < CONNECTIONS_PER_PRINCIPAL_MAX
    );
  }
}
