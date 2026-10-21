// The broker profile of the connection the explorer shows, read once per page (`profile.get`) and parsed
// with the strict `BrokerProfileSchema`. Anything the engine sends that does not parse, and any failure,
// is "unknown", never "available": the pages render gates and `allowedActions` as sent and fail closed
// (R8, R10). The UI never computes authorisation.
import { effect, inject, Injectable, signal, type Signal } from '@angular/core';
import { ConnectionIdSchema, profileGet } from '@app/contracts';
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import { EngineApi } from '@app/ui-data';

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

@Injectable()
export class ProfileStore {
  readonly #api = inject(EngineApi);
  readonly #cid = inject(EXPLORER_CONNECTION);
  readonly #state = signal<ProfileState>(NONE);
  readonly state: Signal<ProfileState> = this.#state.asReadonly();

  constructor() {
    effect((onCleanup) => {
      const cid = this.#cid();
      if (cid === null) {
        this.#state.set(NONE);
        return;
      }
      this.#state.set(LOADING);
      const subscription = this.#api
        .call(profileGet, { cid: ConnectionIdSchema.parse(cid) })
        .subscribe({
          next: (output) => {
            const parsed = BrokerProfileSchema.safeParse(output.profile);
            this.#state.set(
              parsed.success
                ? {
                    status: 'ready',
                    profile: parsed.data,
                    error: null,
                    raw: output.profile,
                  }
                : { ...NONE, raw: output.profile },
            );
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
}
