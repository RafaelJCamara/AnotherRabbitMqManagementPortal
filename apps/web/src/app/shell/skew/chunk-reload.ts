// A lazy chunk that fails to load usually means the UI in this tab is older than the files the
// engine serves now (a release replaced them). The remedy is one controlled reload at the address
// the person was going to, with the route and the query kept. A layout change that is waiting for its
// idle delay is sent first, for as long as a second. The reload happens once per window: a second failure inside it shows an error
// view with a manual reload instead of looping (AC-13, OQ-533).
import { Location } from '@angular/common';
import {
  Injectable,
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  signal,
  type EnvironmentProviders,
} from '@angular/core';
import { NavigationEnd, NavigationError, Router } from '@angular/router';

import { ShellLayoutStore } from '../layout/shell-layout-store';

/** One reload per this long (OQ-533). */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;
/** The longest a pending layout save may hold the reload back. */
const FLUSH_LIMIT_MS = 1000;
const STATE_KEY = 'chunk-reload-at';

/**
 * True for the errors a failed dynamic `import()` gives. The esbuild-based builder has no
 * `ChunkLoadError` (that is the bundler-specific name); the browser throws a TypeError whose text
 * differs (OQ-533). The router wraps nothing, but a cause may carry the error, so it is followed.
 */
export function isChunkLoadFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.name === 'ChunkLoadError') return true;
    if (
      /dynamically imported module|importing a module script failed|error loading dynamic|loading chunk .* failed|loading css chunk|unable to preload css/i.test(
        current.message,
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Where the reload window is kept: `sessionStorage` by default, injectable for specs. Null when
 * the browser blocks it; without a place to remember the reload, a failure shows the error view
 * and never reloads, because a reload that cannot be remembered could loop.
 */
export const CHUNK_RELOAD_STATE = new InjectionToken<Storage | null>(
  'CHUNK_RELOAD_STATE',
  {
    factory: () => {
      try {
        const storage = globalThis.sessionStorage;
        storage.setItem(`${STATE_KEY}-probe`, '1');
        storage.removeItem(`${STATE_KEY}-probe`);
        return storage;
      } catch {
        return null;
      }
    },
  },
);
/** The clock of the reload window. */
export const CHUNK_CLOCK = new InjectionToken<() => number>('CHUNK_CLOCK', {
  factory: () => () => Date.now(),
});

/** Opens an address as a new page load (a real navigation, not the router's). */
export const PAGE_ASSIGN = new InjectionToken<(url: string) => void>(
  'PAGE_ASSIGN',
  {
    factory: () => (url) => {
      globalThis.location.assign(url);
    },
  },
);

@Injectable({ providedIn: 'root' })
export class ChunkReload {
  readonly #router = inject(Router);
  readonly #location = inject(Location);
  readonly #state = inject(CHUNK_RELOAD_STATE);
  readonly #now = inject(CHUNK_CLOCK);
  readonly #assign = inject(PAGE_ASSIGN);
  readonly #layout = inject(ShellLayoutStore);
  readonly #failed = signal<string | null>(null);

  /** The address that could not be loaded again after a reload; null when all is well. */
  readonly failure = this.#failed.asReadonly();

  /** Starts watching navigations. */
  start(): void {
    this.#router.events.subscribe((event) => {
      if (event instanceof NavigationError) {
        this.#onError(event.error, event.url);
      } else if (event instanceof NavigationEnd) {
        this.#failed.set(null);
        this.#write(null);
      }
    });
  }

  #onError(error: unknown, url: string): void {
    if (!isChunkLoadFailure(error)) return;
    const last = this.#read();
    const now = this.#now();
    const recent =
      last !== null && now - last >= 0 && now - last < CHUNK_RELOAD_WINDOW_MS;
    // Reloaded a moment ago and it failed again, or the reload cannot be remembered: the files
    // are not coming, or a reload could loop. Say so instead.
    if (recent || !this.#write(now)) {
      this.#failed.set(url);
      return;
    }
    // The router's own address (path, query, fragment), only ever a path of this origin.
    const target = url.startsWith('/') && !url.startsWith('//') ? url : '/';
    void this.#saveThenAssign(this.#location.prepareExternalUrl(target));
  }

  async #saveThenAssign(url: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FLUSH_LIMIT_MS);
    });
    try {
      await Promise.race([this.#layout.flush(), limit]);
    } finally {
      clearTimeout(timer);
    }
    this.#assign(url);
  }

  #read(): number | null {
    try {
      const value = Number(this.#state?.getItem(STATE_KEY));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** Keeps (or clears) the time of the last reload; false when it cannot be kept. */
  #write(at: number | null): boolean {
    if (this.#state === null) return false;
    try {
      if (at === null) {
        this.#state.removeItem(STATE_KEY);
        return true;
      }
      this.#state.setItem(STATE_KEY, String(at));
      return this.#state.getItem(STATE_KEY) === String(at);
    } catch {
      return false;
    }
  }
}

/** Reloads once when a lazy chunk fails to load; see the file comment. */
export function provideChunkReload(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      inject(ChunkReload).start();
    }),
  ]);
}
