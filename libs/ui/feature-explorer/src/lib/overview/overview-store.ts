// The overview of the connection the explorer shows (M0-54, R9). One read when the page opens and one per press
// of Refresh; a floor of 10 s after each read keeps Refresh closed (every read costs the broker up to three
// requests, and there is no overview topic). A read that fails keeps the last good answer, marked as earlier,
// and keeps the engine's Problem as received.
import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { ConnectionIdSchema, overviewGet } from '@app/contracts';
import { EngineApi } from '@app/ui-data';
import type { Subscription } from 'rxjs';

import { EXPLORER_CONNECTION } from '../connection';
import { EXPLORER_TIMER } from '../timer';
import { OVERVIEW_MIN_REFRESH_MS, type OverviewAnswer } from './overview-model';

export type OverviewStatus = 'idle' | 'loading' | 'ready' | 'error';

@Injectable()
export class OverviewStore {
  readonly #api = inject(EngineApi);
  readonly #cid = inject(EXPLORER_CONNECTION);
  readonly #timer = inject(EXPLORER_TIMER);
  readonly #answer = signal<OverviewAnswer | null>(null);
  readonly #status = signal<OverviewStatus>('idle');
  readonly #error = signal<unknown>(null);
  readonly #floor = signal(false);
  #subscription: Subscription | null = null;
  #cancelFloor: (() => void) | null = null;

  /** The last good answer; kept when a later read fails. */
  readonly answer: Signal<OverviewAnswer | null> = this.#answer.asReadonly();
  readonly status: Signal<OverviewStatus> = this.#status.asReadonly();
  /** The engine's Problem (or the loss) of the last read, as received; `null` after a good read. */
  readonly error: Signal<unknown> = this.#error.asReadonly();
  /** The answer on screen is from an earlier read, because the last one failed. */
  readonly earlier = computed(
    () => this.#status() === 'error' && this.#answer() !== null,
  );
  /** Refresh is closed: a read was made less than the floor ago, or one is running. */
  readonly refreshClosed: Signal<boolean> = computed(
    () => this.#floor() || this.#status() === 'loading',
  );

  constructor() {
    // A page that goes away stops its read and its floor timer.
    inject(DestroyRef).onDestroy(() => {
      this.#subscription?.unsubscribe();
      this.#cancelFloor?.();
    });
    // Reads when the page opens and when the connection changes; never again until Refresh is pressed.
    effect(() => {
      const cid = this.#cid();
      untracked(() => {
        this.#reset();
        if (cid !== null) this.#read(cid);
      });
    });
  }

  /** One more read, unless one was made within the floor. */
  refresh(): void {
    const cid = this.#cid();
    if (cid === null || this.refreshClosed()) return;
    this.#read(cid);
  }

  #reset(): void {
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#cancelFloor?.();
    this.#cancelFloor = null;
    this.#floor.set(false);
    this.#answer.set(null);
    this.#error.set(null);
    this.#status.set('idle');
  }

  #read(cid: string): void {
    this.#subscription?.unsubscribe();
    this.#status.set('loading');
    this.#floor.set(true);
    this.#cancelFloor?.();
    this.#cancelFloor = this.#timer.set(() => {
      this.#cancelFloor = null;
      this.#floor.set(false);
    }, OVERVIEW_MIN_REFRESH_MS);
    this.#subscription = this.#api
      .call(overviewGet, { cid: ConnectionIdSchema.parse(cid) })
      .subscribe({
        next: (answer) => {
          this.#answer.set(answer);
          this.#error.set(null);
          this.#status.set('ready');
        },
        error: (error: unknown) => {
          this.#error.set(error);
          this.#status.set('error');
        },
      });
  }
}
