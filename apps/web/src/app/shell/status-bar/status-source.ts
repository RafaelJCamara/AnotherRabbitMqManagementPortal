// What the status bar knows about the active connection, as one model. It reads two queries
// (`connections.get` for the name and the environment class, `profile.get` for the cached
// BrokerProfile) and the live client's state, and it never makes anything look safer than the
// strictest reading: a missing or failed answer is an unknown version and era, an unknown build,
// the `prod` environment, locked writes and (when the live session is down) a down engine (AC-12).
import {
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { connectionsGet, profileGet, type EnvClass } from '@app/contracts';
import { BrokerProfileSchema, type Verification } from '@app/domain-model';
import { LiveClient, engineResource, type LiveClientState } from '@app/ui-data';

import { ActiveConnection } from '../active-connection';

export type EngineHealth = 'ok' | 'reconnecting' | 'down' | 'unknown';
export type LockState = 'locked' | 'armed' | 'unknown';
export type StatsMode = 'on' | 'totals-only' | 'off';

export interface StatusModel {
  readonly profileName: string | null;
  /** Undefined when unknown; `<app-env-chrome>` shows that as `prod`. */
  readonly environment: EnvClass | undefined;
  readonly brokerVersion: string | null;
  readonly era: {
    readonly value: string;
    readonly conservative: boolean;
  } | null;
  readonly stats: StatsMode | null;
  /** Undefined when unknown; `<app-verification-banner>` shows that as an unknown build. */
  readonly verification: Verification | undefined;
  readonly lock: LockState;
  readonly health: EngineHealth;
}

/**
 * Whether writes are locked, as the engine said. No action returns the arming state yet (OQ-530),
 * so the default is `locked`: the fail-closed reading. The unlock flow (M0-52) provides the real
 * source.
 */
export const LOCK_STATE = new InjectionToken<Signal<LockState>>('LOCK_STATE', {
  factory: () => signal<LockState>('locked').asReadonly(),
});

const HEALTH: Readonly<Record<LiveClientState, EngineHealth>> = {
  idle: 'unknown',
  connecting: 'unknown',
  ready: 'ok',
  reconnecting: 'reconnecting',
  down: 'down',
};

function statsMode(stats: {
  disabled: boolean;
  queueTotals: boolean;
}): StatsMode {
  if (!stats.disabled) return 'on';
  return stats.queueTotals ? 'totals-only' : 'off';
}

@Injectable({ providedIn: 'root' })
export class StatusSource {
  readonly #connection = inject(ActiveConnection);
  readonly #live = inject(LiveClient);
  readonly #lock = inject(LOCK_STATE);
  readonly #input = computed(() => {
    const cid = this.#connection.cid();
    return cid === null ? undefined : { cid };
  });
  readonly #profileName = engineResource(connectionsGet, () => this.#input());
  readonly #brokerProfile = engineResource(profileGet, () => this.#input());

  /** True while the answers for the connection are on their way (no banner, no values). */
  readonly loading = computed(
    () =>
      this.#connection.cid() !== null &&
      (this.#profileName.status() === 'loading' ||
        this.#brokerProfile.status() === 'loading'),
  );

  readonly model: Signal<StatusModel> = computed(() => {
    const connection = this.#profileName.hasValue()
      ? this.#profileName.value().profile
      : undefined;
    const raw = this.#brokerProfile.hasValue()
      ? this.#brokerProfile.value().profile
      : undefined;
    const parsed = BrokerProfileSchema.safeParse(raw);
    const profile = parsed.success ? parsed.data : undefined;
    return {
      profileName: connection?.name ?? null,
      environment: connection?.envClass,
      brokerVersion: profile?.versions.min?.raw ?? null,
      era:
        profile === undefined
          ? null
          : {
              value: profile.era.value,
              conservative: profile.era.conservative,
            },
      stats: profile === undefined ? null : statsMode(profile.stats),
      verification: profile?.verification,
      lock: this.#lock(),
      health: HEALTH[this.#live.state()],
    };
  });
}
