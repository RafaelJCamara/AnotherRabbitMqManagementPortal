// The entity watch of the model as a signal (M1-42, R3). One watch lives while the connection, the entity and
// the permission to read (the profile is known) hold; it is destroyed with them. Nothing here polls: `refresh`
// reads the freshness again when the person asks, and `retry` starts the whole read again after a failure.
import { effect, inject, signal, untracked, type Signal } from '@angular/core';
import {
  createEntityWatch,
  type EntityRef,
  type EntityState,
  type EntityWatch,
} from '@app/explorer-model';

import { EXPLORER_CONNECTION } from '../connection';
import { EXPLORER_DATA } from '../data/explorer-data';

export interface EntityRead {
  /** `null` while nothing is being read (no connection, no entity, or not allowed yet). */
  readonly state: Signal<EntityState | null>;
  /** Reads the index's freshness (and a binding's row) again. */
  refresh(): void;
  /** Starts the read over, after a failure. */
  retry(): void;
}

/** Must run in an injection context. `enabled` is false while the page waits for the profile or the probe. */
export function injectEntityRead(
  ref: Signal<EntityRef | null>,
  enabled: Signal<boolean>,
): EntityRead {
  const data = inject(EXPLORER_DATA);
  const connection = inject(EXPLORER_CONNECTION);
  const state = signal<EntityState | null>(null);
  const attempt = signal(0);
  let current: EntityWatch | null = null;

  effect((onCleanup) => {
    const cid = connection();
    const target = ref();
    attempt();
    if (cid === null || target === null || !enabled()) {
      state.set(null);
      return;
    }
    untracked(() => {
      const watch = createEntityWatch(data, {
        cid,
        kind: target.kind,
        key: target.key,
      });
      current = watch;
      state.set(watch.state());
      const stop = watch.onState((next) => {
        state.set(next);
      });
      onCleanup(() => {
        stop();
        watch.destroy();
        if (current === watch) current = null;
      });
    });
  });

  return {
    state: state.asReadonly(),
    refresh: () => {
      current?.refresh();
    },
    retry: () => {
      attempt.update((n) => n + 1);
    },
  };
}
