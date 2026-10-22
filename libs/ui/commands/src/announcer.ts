// What the command system says aloud (M1-41, R9). The registry, the keymap store and the host report a
// closed command, a failed command, a conflict or a keymap that could not be loaded or saved here; the host
// turns the latest message into words in one polite live region. Nothing in the system is silent.
import { Injectable, signal, type Signal } from '@angular/core';

import type { DisabledReason } from './availability';

export type AnnounceParams = Readonly<
  Record<string, string | number | DisabledReason>
>;

export interface Announcement {
  /** Changes with every message, so the same message said twice is read twice. */
  readonly seq: number;
  /** A key of the `palette` scope under `announce.`. */
  readonly key: string;
  readonly params: AnnounceParams;
}

@Injectable({ providedIn: 'root' })
export class Announcer {
  readonly #latest = signal<Announcement | null>(null);
  #seq = 0;

  readonly latest: Signal<Announcement | null> = this.#latest.asReadonly();

  say(key: string, params: AnnounceParams = {}): void {
    this.#seq += 1;
    this.#latest.set({ seq: this.#seq, key, params });
  }
}
