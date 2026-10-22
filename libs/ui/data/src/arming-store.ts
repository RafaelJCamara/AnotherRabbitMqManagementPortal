// ArmingStore (M0-52, R5): what this page knows about the prod lock. No action returns the arming state (OQ-530),
// so it remembers only what its own `ops.arm` and `ops.disarm` calls were answered, and it counts a window from
// the answer's length (`expiresAt - armedAt`, both on the engine's clock) against the page's clock, so a clock
// that differs from the engine's cannot make a window longer. After a reload it knows nothing and reads "locked"
// (fail closed). It is a display of an engine decision: the engine still refuses a locked call.
import {
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import {
  actionId,
  opsArm,
  opsDisarm,
  type ConnectionId,
  type GateDecision,
} from '@app/contracts';
import { firstValueFrom } from 'rxjs';

import { EngineApi } from './engine-api';

/** The page's clock and one-shot timer. A spec provides a manual one. */
export interface ArmingClock {
  now(): number;
  /** Runs `callback` after `ms`; returns a function that cancels it. */
  after(ms: number, callback: () => void): () => void;
}

/** A timer cannot wait longer than this (2^31 - 1 ms); an arming window is 15 minutes. */
const TIMER_MAX_MS = 2_147_483_647;
/** Windows kept at once: far above the 200 profiles a person can have (I-6). */
const ARMED_MAX = 256;

export const ARMING_CLOCK = new InjectionToken<ArmingClock>('ARMING_CLOCK', {
  providedIn: 'root',
  factory: () => ({
    now: () => Date.now(),
    after: (ms, callback) => {
      const handle = setTimeout(callback, Math.min(ms, TIMER_MAX_MS));
      return () => {
        clearTimeout(handle);
      };
    },
  }),
});

export type ArmOutcome =
  | { readonly ok: true; readonly validForMs: number }
  | { readonly ok: false; readonly error: unknown };

export type DisarmOutcome =
  | { readonly ok: true; readonly wasArmed: boolean }
  | { readonly ok: false; readonly error: unknown };

/** The `source` of the gate the engine sends for a locked call, and of the gate this store builds. */
export const PROD_LOCK_SOURCE = 'prod-lock';

/** The classes the engine's lock does not apply to; anything else, an unknown one included, reads as prod. */
const OPEN_CLASSES: readonly string[] = ['staging', 'test', 'dev', 'local'];

/**
 * The gate of a mutating control, from two engine facts: the profile's class (unset or unknown reads `prod`) and
 * whether this page has an open arming window for it. Closed gates carry the engine's own fix (`ops.arm`).
 * `reason` is the already translated text.
 */
export function lockGate(options: {
  readonly cid: string;
  readonly envClass: unknown;
  readonly armed: boolean;
  readonly reason: string;
}): GateDecision {
  const locked = !OPEN_CLASSES.includes(String(options.envClass));
  if (!locked || options.armed) return { enabled: true };
  return {
    enabled: false,
    reason: options.reason,
    source: PROD_LOCK_SOURCE,
    fix: {
      actionId: actionId('ops.arm'),
      input: { connectionId: options.cid },
    },
  };
}

@Injectable({ providedIn: 'root' })
export class ArmingStore {
  readonly #api = inject(EngineApi);
  readonly #clock = inject(ARMING_CLOCK);
  /** Per connection: when this page's clock says the window ends. */
  readonly #until = signal<ReadonlyMap<string, number>>(new Map());
  readonly #now = signal(this.#clock.now());
  readonly #cancels = new Map<string, () => void>();
  readonly #views = new Map<string, Signal<boolean>>();
  readonly #busy = signal(false);

  /** True while an arm or disarm call is on its way. */
  readonly busy: Signal<boolean> = this.#busy.asReadonly();

  /** Whether the person armed this connection from this page and the window has not run out. */
  armed(cid: string): Signal<boolean> {
    let view = this.#views.get(cid);
    if (view === undefined) {
      view = computed(
        (): boolean => (this.#until().get(cid) ?? 0) > this.#now(),
      );
      this.#views.set(cid, view);
    }
    return view;
  }

  /** When the window ends, on this page's clock (epoch ms), or `null`. */
  until(cid: string): number | null {
    const end = this.#until().get(cid);
    return end !== undefined && end > this.#now() ? end : null;
  }

  async arm(cid: string): Promise<ArmOutcome> {
    this.#busy.set(true);
    try {
      const answer = await firstValueFrom(
        this.#api.call(opsArm, { connectionId: cid as ConnectionId }),
      );
      const validForMs = Math.max(0, answer.expiresAt - answer.armedAt);
      this.#open(cid, validForMs);
      return { ok: true, validForMs };
    } catch (error) {
      return { ok: false, error };
    } finally {
      this.#busy.set(false);
    }
  }

  async disarm(cid: string): Promise<DisarmOutcome> {
    this.#busy.set(true);
    try {
      const answer = await firstValueFrom(
        this.#api.call(opsDisarm, { connectionId: cid as ConnectionId }),
      );
      this.#close(cid);
      return { ok: true, wasArmed: answer.wasArmed };
    } catch (error) {
      return { ok: false, error };
    } finally {
      this.#busy.set(false);
    }
  }

  /** The engine refused a call with the lock: whatever this page thought, the connection is locked. */
  noteLocked(cid: string): void {
    this.#close(cid);
  }

  #open(cid: string, validForMs: number): void {
    const now = this.#clock.now();
    this.#cancels.get(cid)?.();
    this.#now.set(now);
    this.#until.update((map) => {
      const next = new Map(map);
      for (const [key, end] of next) if (end <= now) next.delete(key);
      if (!next.has(cid) && next.size >= ARMED_MAX) return next;
      next.set(cid, now + validForMs);
      return next;
    });
    this.#cancels.set(
      cid,
      this.#clock.after(validForMs, () => {
        this.#cancels.delete(cid);
        this.#now.set(this.#clock.now());
        this.#close(cid);
      }),
    );
  }

  #close(cid: string): void {
    this.#cancels.get(cid)?.();
    this.#cancels.delete(cid);
    this.#until.update((map) => {
      if (!map.has(cid)) return map;
      const next = new Map(map);
      next.delete(cid);
      return next;
    });
  }
}
