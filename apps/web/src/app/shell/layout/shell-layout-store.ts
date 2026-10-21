// Loads and saves the layout of the connection profile that is open, and owns the signals the shell
// renders. A change applies at once and is saved after an idle delay, so a splitter drag is one
// `layouts.put`, not hundreds (OQ-529, OQ-383); a flush on `visibilitychange` sends what is
// pending, best effort. A failed save keeps the layout in memory, shows the engine's own Problem
// and is retried by the next change or by `retrySave`: nothing is discarded (AC-7, I-13).
import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { layoutsGet, layoutsPut, type ConnectionId } from '@app/contracts';
import { EngineApi, EngineProblemError, syntheticProblem } from '@app/ui-data';
import { firstValueFrom } from 'rxjs';

import { fitLayout, type Viewport } from './fit-layout';
import type { LayoutRefusal, LayoutResult } from './layout-ops';
import {
  defaultLayout,
  parseLayout,
  withinContractSize,
  type LayoutNotice,
  type ShellLayout,
} from './shell-layout';

/** Idle time after the last change before the layout is saved (OQ-529). */
export const LAYOUT_SAVE_DELAY_MS = 1500;

/** Runs `callback` after `ms`; returns a function that cancels it. A spec drives its own clock. */
export type LayoutTimer = (callback: () => void, ms: number) => () => void;

export const LAYOUT_TIMER = new InjectionToken<LayoutTimer>('LAYOUT_TIMER', {
  factory: () => (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
});

/** The size of the window the shell fits itself to. */
export const VIEWPORT = new InjectionToken<() => Viewport>('VIEWPORT', {
  factory: () => () => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }),
});

export type LayoutSaveState = 'loading' | 'ready' | 'saving' | 'save-failed';

/** An error as a Problem; the carrier failures have none, so the UI makes one up (flagged). */
function asProblem(error: unknown): EngineProblemError {
  return error instanceof EngineProblemError
    ? error
    : new EngineProblemError(syntheticProblem(503, 'ui'), { synthetic: true });
}

@Injectable({ providedIn: 'root' })
export class ShellLayoutStore {
  readonly #api = inject(EngineApi);
  readonly #timer = inject(LAYOUT_TIMER);
  readonly #viewport = inject(VIEWPORT);

  readonly #layout = signal<ShellLayout>(defaultLayout());
  readonly #notice = signal<LayoutNotice | null>(null);
  readonly #saveState = signal<LayoutSaveState>('loading');
  readonly #saveProblem = signal<EngineProblemError | null>(null);
  readonly #refusal = signal<LayoutRefusal | null>(null);
  readonly #refusals = signal(0);

  readonly layout = this.#layout.asReadonly();
  readonly notice = this.#notice.asReadonly();
  readonly saveState = this.#saveState.asReadonly();
  /** The engine's Problem for the last failed load or save, as sent. */
  readonly saveProblem = this.#saveProblem.asReadonly();
  /** The reason the last change was refused for a cap, until it is dismissed. */
  readonly refusal = this.#refusal.asReadonly();
  /** How many changes were refused since the shell started (I-6, I-13: a refusal is counted). */
  readonly refusals = this.#refusals.asReadonly();

  #cid: ConnectionId | null = null;
  #generation = 0;
  #dirty = false;
  #cancelTimer: (() => void) | null = null;
  #saving: Promise<void> | null = null;

  /** `layouts.get`, parse, fit. Anything unusable becomes the default with a notice (AC-5, AC-6). */
  async open(cid: ConnectionId): Promise<void> {
    await this.flush();
    const generation = ++this.#generation;
    this.#cid = cid;
    this.#dirty = false;
    this.#layout.set(defaultLayout());
    this.#notice.set(null);
    this.#saveProblem.set(null);
    this.#refusal.set(null);
    this.#saveState.set('loading');
    let layout: ShellLayout;
    let notice: LayoutNotice | null;
    let problem: EngineProblemError | null = null;
    try {
      const answer = await firstValueFrom(this.#api.call(layoutsGet, { cid }));
      ({ layout, notice } = parseLayout(answer.layout, cid));
    } catch (error) {
      problem = asProblem(error);
      layout = defaultLayout();
      notice = 'load-failed';
    }
    // The person went to another profile while this one loaded: this answer is stale.
    if (generation !== this.#generation) return;
    this.#layout.set(fitLayout(layout, this.#viewport()));
    this.#notice.set(notice);
    this.#saveProblem.set(problem);
    this.#saveState.set('ready');
  }

  /** Fits the layout to a changed window. Not a change of the person's: nothing is saved for it. */
  fit(): void {
    if (this.#saveState() === 'loading') return;
    const fitted = fitLayout(this.#layout(), this.#viewport());
    if (JSON.stringify(fitted) !== JSON.stringify(this.#layout())) {
      this.#layout.set(fitted);
    }
  }

  /** Applies a change at once and saves it after the idle delay. Ignored while loading. */
  update(change: (layout: ShellLayout) => ShellLayout): void {
    if (this.#saveState() === 'loading' || this.#cid === null) return;
    const current = this.#layout();
    const next = change(current);
    if (next === current) return;
    if (!withinContractSize(next)) {
      this.#refuse('document-too-large');
      return;
    }
    this.#layout.set(next);
    this.#dirty = true;
    this.#arm();
  }

  /** Applies an operation that can be refused for a cap; a refusal is shown and counted. */
  apply(
    operation: (layout: ShellLayout) => LayoutResult,
  ): LayoutRefusal | null {
    const result = operation(this.#layout());
    if (!result.ok) {
      this.#refuse(result.refusal);
      return result.refusal;
    }
    this.update(() => result.layout);
    return null;
  }

  dismissRefusal(): void {
    this.#refusal.set(null);
  }

  dismissNotice(): void {
    this.#notice.set(null);
  }

  /** Sends the latest layout now, whatever the timer says (also after a failed save). */
  async retrySave(): Promise<void> {
    this.#cancelPending();
    if (this.#cid === null || this.#saveState() === 'loading') return;
    this.#dirty = true;
    await this.#save();
  }

  /** Sends what is pending; used when the page becomes hidden. Best effort. */
  async flush(): Promise<void> {
    this.#cancelPending();
    await (this.#dirty ? this.#save() : (this.#saving ?? Promise.resolve()));
  }

  #refuse(refusal: LayoutRefusal): void {
    this.#refusal.set(refusal);
    this.#refusals.update((count) => count + 1);
  }

  #cancelPending(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #arm(): void {
    this.#cancelPending();
    this.#cancelTimer = this.#timer(() => {
      this.#cancelTimer = null;
      void this.#save();
    }, LAYOUT_SAVE_DELAY_MS);
  }

  #save(): Promise<void> {
    this.#saving ??= this.#run().finally(() => {
      this.#saving = null;
    });
    return this.#saving;
  }

  async #run(): Promise<void> {
    // A change that arrives during a save arms the timer, which sends it after the idle delay.
    while (this.#dirty && this.#cid !== null && this.#cancelTimer === null) {
      const cid = this.#cid;
      const layout = this.#layout();
      this.#dirty = false;
      this.#saveState.set('saving');
      try {
        await firstValueFrom(
          this.#api.call(layoutsPut, { cid, layout: { ...layout } }),
        );
      } catch (error) {
        this.#dirty = true;
        this.#saveProblem.set(asProblem(error));
        this.#saveState.set('save-failed');
        return;
      }
      this.#saveProblem.set(null);
      this.#saveState.set('ready');
    }
  }
}
