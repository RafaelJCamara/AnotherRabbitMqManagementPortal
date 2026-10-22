// The keymap over the engine (M1-41, R7): the person's overrides are loaded with `keybindings.get` and
// saved, as the whole document, with `keybindings.put` (a local-scope action: it changes only the engine's
// own state, OQ-783). A failed load leaves the defaults; a failed save keeps the override for the session.
// Both are kept as received and said aloud, never swallowed.
import { inject, Injectable, signal, type Signal } from '@angular/core';
import { keybindingsGet, keybindingsPut } from '@app/contracts';
import { EngineApi } from '@app/ui-data';
import { firstValueFrom } from 'rxjs';

import { Announcer } from './announcer';
import {
  planAssign,
  withUnbound,
  withoutOverride,
  type AssignResult,
  type KeybindingOverrides,
} from './keymap';
import { CommandRegistry, Keymap } from './registry';
import { COMMAND_TIMER } from './timer';

/** How long the store waits after a change before it sends the document. */
export const KEYMAP_SAVE_DELAY_MS = 400;

export type KeymapLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';
export type KeymapSaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

@Injectable({ providedIn: 'root' })
export class KeymapStore {
  readonly #api = inject(EngineApi);
  readonly #keymap = inject(Keymap);
  readonly #registry = inject(CommandRegistry);
  readonly #announcer = inject(Announcer);
  readonly #timer = inject(COMMAND_TIMER);
  readonly #loadStatus = signal<KeymapLoadStatus>('idle');
  readonly #loadError = signal<unknown>(null);
  readonly #saveStatus = signal<KeymapSaveStatus>('idle');
  readonly #saveError = signal<unknown>(null);
  #cancelSave: (() => void) | null = null;
  #version = 0;
  #savedVersion = 0;
  #saving: Promise<void> | null = null;
  #loading: Promise<void> | null = null;

  readonly overrides: Signal<KeybindingOverrides> = this.#keymap.overrides;
  readonly loadStatus: Signal<KeymapLoadStatus> = this.#loadStatus.asReadonly();
  /** The Problem (or failure) of the last load, as received. */
  readonly loadError: Signal<unknown> = this.#loadError.asReadonly();
  readonly saveStatus: Signal<KeymapSaveStatus> = this.#saveStatus.asReadonly();
  readonly saveError: Signal<unknown> = this.#saveError.asReadonly();

  /** Loads the overrides once; a failed load can be tried again by calling it again. */
  load(): Promise<void> {
    if (this.#loading !== null && this.#loadStatus() !== 'failed')
      return this.#loading;
    this.#loadStatus.set('loading');
    this.#loading = firstValueFrom(this.#api.call(keybindingsGet, {})).then(
      (out) => {
        // A change made before the answer came wins over the stored document for the commands it names.
        this.#keymap.set(
          this.#version === 0
            ? out.bindings
            : { ...out.bindings, ...this.#keymap.overrides() },
        );
        this.#loadError.set(null);
        this.#loadStatus.set('ready');
      },
      (error: unknown) => {
        this.#loadError.set(error);
        this.#loadStatus.set('failed');
        this.#announcer.say('keymapLoadFailed');
      },
    );
    return this.#loading;
  }

  /** Assigns a chord to a command; the result says why when it is refused. Nothing changes on a refusal. */
  assign(
    id: string,
    chord: string,
    options: { readonly replace?: boolean } = {},
  ): AssignResult {
    const owners = this.#registry
      .commands()
      .map((c) => ({ id: c.id, chords: c.chords }));
    const result = planAssign(
      owners,
      this.#keymap.overrides(),
      id,
      chord,
      options,
    );
    if (result.ok) this.#change(result.overrides);
    return result;
  }

  /** The person unbinds the command: it keeps no chord, not even its default. */
  unbind(id: string): void {
    this.#change(withUnbound(this.#keymap.overrides(), id));
  }

  /** The command goes back to its default chords. */
  useDefault(id: string): void {
    this.#change(withoutOverride(this.#keymap.overrides(), id));
  }

  /** Every command goes back to its default chords. */
  resetAll(): void {
    this.#change({});
  }

  /** Sends a pending change now. */
  async flush(): Promise<void> {
    this.#cancelSave?.();
    this.#cancelSave = null;
    await this.#save();
  }

  /** Sends the document again after a failed save. */
  async retry(): Promise<void> {
    await this.flush();
  }

  #change(next: KeybindingOverrides): void {
    this.#keymap.set(next);
    this.#version += 1;
    this.#cancelSave?.();
    this.#cancelSave = this.#timer.set(() => {
      this.#cancelSave = null;
      void this.#save();
    }, KEYMAP_SAVE_DELAY_MS);
  }

  /** Sends the document in force when it differs from the last one the engine accepted; one request at a time. */
  async #save(): Promise<void> {
    if (this.#saving !== null) await this.#saving;
    if (this.#savedVersion === this.#version) return;
    const version = this.#version;
    this.#saveStatus.set('saving');
    const request = firstValueFrom(
      this.#api.call(keybindingsPut, {
        bindings: { ...this.#keymap.overrides() },
      }),
    ).then(
      () => {
        this.#savedVersion = version;
        this.#saveError.set(null);
        this.#saveStatus.set(this.#version === version ? 'saved' : 'saving');
      },
      (error: unknown) => {
        // The document in force is not the one the engine keeps: it stays unsaved until a retry.
        this.#saveError.set(error);
        this.#saveStatus.set('failed');
        this.#announcer.say('keymapSaveFailed');
      },
    );
    this.#saving = request;
    await request;
    this.#saving = null;
    // A change made while the request ran is sent next, unless this request failed (a retry sends it).
    if (
      this.#saveStatus() !== 'failed' &&
      this.#savedVersion !== this.#version
    ) {
      await this.#save();
    }
  }
}
