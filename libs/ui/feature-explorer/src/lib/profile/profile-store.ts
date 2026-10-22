// The broker profile of the connection the explorer shows, read once per page (`profile.get`) and parsed
// with the strict `BrokerProfileSchema`. Anything the engine sends that does not parse, and any failure,
// is "unknown", never "available": the pages render gates and `allowedActions` as sent and fail closed
// (R8, R10). The UI never computes authorisation.
//
// A connection nobody has probed has no cached profile: `profile.get` answers NOT_FOUND and so does every
// inventory read, until `probe.run` has stored one. The store knows that case (`needsProbe`) so a page can
// say so in words and offer the one button that fixes it (`probe`), instead of every page failing in its own
// way on the first run. `probe.run` reads the broker's management API with the stored login and keeps the
// answer in the engine's cache; it changes nothing the broker keeps.
import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
  type Signal,
} from '@angular/core';
import { ConnectionIdSchema, probeRun, profileGet } from '@app/contracts';
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import { EngineApi, isEngineProblem } from '@app/ui-data';
import type { Subscription } from 'rxjs';

import { EXPLORER_CONNECTION } from '../connection';

export interface ProfileState {
  /** `unknown`: no connection, a failed call, or a profile that does not parse. */
  readonly status: 'loading' | 'ready' | 'unknown';
  readonly profile: BrokerProfile | null;
  /** The failure, as received, when the call failed. */
  readonly error: unknown;
  /** What the engine sent as the profile, before parsing: the capability card reads its gates one by one. */
  readonly raw: unknown;
}

/** Why a page offers the probe: no profile was ever stored, or the stored one is not one this version reads. */
export type ProbeNeed = 'never' | 'outdated';

/** The probe the page started: not running, running, or failed with the engine's Problem as received. */
export interface ProbeState {
  readonly status: 'idle' | 'running' | 'failed';
  readonly error: unknown;
}

const LOADING: ProfileState = {
  status: 'loading',
  profile: null,
  error: null,
  raw: null,
};
const NONE: ProfileState = {
  status: 'unknown',
  profile: null,
  error: null,
  raw: null,
};
const IDLE: ProbeState = { status: 'idle', error: null };

@Injectable()
export class ProfileStore {
  readonly #api = inject(EngineApi);
  readonly #cid = inject(EXPLORER_CONNECTION);
  readonly #state = signal<ProfileState>(NONE);
  readonly #probe = signal<ProbeState>(IDLE);
  #probing: Subscription | null = null;
  readonly state: Signal<ProfileState> = this.#state.asReadonly();
  readonly probeState: Signal<ProbeState> = this.#probe.asReadonly();

  /**
   * The engine has no usable profile of this connection, so reads of the inventory cannot be answered until the
   * probe has run: `never` when `profile.get` says NOT_FOUND, `outdated` when it sent a profile this version
   * cannot read (the inventory reads refuse that one the same way). `null` while loading, when the profile is
   * known and for any other failure (those are shown as sent).
   */
  readonly needsProbe: Signal<ProbeNeed | null> = computed(() => {
    const state = this.#state();
    if (state.status !== 'unknown') return null;
    if (isEngineProblem(state.error)) {
      return state.error.code === 'NOT_FOUND' ? 'never' : null;
    }
    return state.error === null && state.raw !== null && state.raw !== undefined
      ? 'outdated'
      : null;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#probing?.unsubscribe();
    });
    effect((onCleanup) => {
      const cid = this.#cid();
      this.#probing?.unsubscribe();
      this.#probing = null;
      this.#probe.set(IDLE);
      if (cid === null) {
        this.#state.set(NONE);
        return;
      }
      this.#state.set(LOADING);
      const subscription = this.#api
        .call(profileGet, { cid: ConnectionIdSchema.parse(cid) })
        .subscribe({
          next: (output) => {
            this.#state.set(this.#parsed(output.profile));
          },
          error: (error: unknown) => {
            this.#state.set({
              status: 'unknown',
              profile: null,
              error,
              raw: null,
            });
          },
        });
      onCleanup(() => {
        subscription.unsubscribe();
      });
    });
  }

  /**
   * Runs the probe once (a press while one runs is ignored). On success the profile it answered replaces the
   * state, so every page that waited for it goes on; on failure the Problem is kept as received and the state
   * is left as it was, so the button can be pressed again.
   */
  probe(): void {
    const cid = this.#cid();
    if (cid === null || this.#probe().status === 'running') return;
    this.#probe.set({ status: 'running', error: null });
    this.#probing?.unsubscribe();
    this.#probing = this.#api
      .call(probeRun, { cid: ConnectionIdSchema.parse(cid) })
      .subscribe({
        next: (output) => {
          this.#state.set(this.#parsed(output.profile));
          this.#probe.set(IDLE);
        },
        error: (error: unknown) => {
          this.#probe.set({ status: 'failed', error });
        },
      });
  }

  #parsed(raw: unknown): ProfileState {
    const parsed = BrokerProfileSchema.safeParse(raw);
    return parsed.success
      ? { status: 'ready', profile: parsed.data, error: null, raw }
      : { ...NONE, raw };
  }
}
