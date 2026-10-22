// The metrics session of the model as a signal (M1-54, R3). One session lives while the connection and the series
// to chart hold; it is destroyed with them. Redraws are coalesced to the animation frame: however many events
// arrive, the signal changes once per frame (the first state is set at once). Nothing here polls.
import { effect, inject, signal, untracked, type Signal } from '@angular/core';
import {
  createMetricsSession,
  type MetricsSession,
  type SessionConfig,
  type SessionState,
} from '@app/metrics-model';

import { METRICS_DATA } from './metrics-data';
import { METRICS_FRAME } from './frame';

export interface MetricsRead {
  /** `null` while nothing is being read (no connection, or nothing to chart). */
  readonly state: Signal<SessionState | null>;
  pause(): void;
  resume(): void;
  /** Reads the history again (after a failure, or when the person asks). */
  reload(): void;
}

/** Must run in an injection context. `config` is `null` while there is no connection or nothing to chart. */
export function injectMetricsRead(
  config: Signal<SessionConfig | null>,
): MetricsRead {
  const data = inject(METRICS_DATA);
  const frame = inject(METRICS_FRAME);
  const state = signal<SessionState | null>(null);
  let current: MetricsSession | null = null;

  effect((onCleanup) => {
    const wanted = config();
    if (wanted === null) {
      state.set(null);
      return;
    }
    untracked(() => {
      const session = createMetricsSession(data, wanted);
      current = session;
      state.set(session.state());
      let latest: SessionState | null = null;
      let scheduled = false;
      let cancel: (() => void) | null = null;
      const stop = session.onState((next) => {
        latest = next;
        if (scheduled) return;
        scheduled = true;
        cancel = frame.request(() => {
          scheduled = false;
          cancel = null;
          if (latest !== null) state.set(latest);
        });
      });
      onCleanup(() => {
        stop();
        cancel?.();
        session.destroy();
        if (current === session) current = null;
      });
    });
  });

  return {
    state: state.asReadonly(),
    pause: () => {
      current?.pause();
    },
    resume: () => {
      current?.resume();
    },
    reload: () => {
      current?.reload();
    },
  };
}
