// The forecast of a queue or the cluster, read through `metrics.forecast` (M1-54, R10, MON-05). The UI never
// computes an ETA: it asks the engine when the page opens, when Refresh is pressed and every 30 s while the page
// is open and not paused. A read is never started while another runs; a failure keeps the last answer, marked as
// earlier, with the engine's Problem as received.
import { effect, inject, signal, untracked, type Signal } from '@angular/core';
import { forecastView, type ForecastView } from '@app/metrics-model';
import type {
  MetricsForecastInput,
  MetricsForecastOutput,
} from '@app/metrics-model';
import { ConnectionIdSchema } from '@app/contracts';

import { EXPLORER_TIMER } from '../timer';
import { METRICS_DATA } from './metrics-data';
import { EXPLORER_CONNECTION } from '../connection';

/** The forecast is read again this often while the page is open and not paused. */
export const FORECAST_EVERY_MS = 30_000;

export type ForecastTarget = MetricsForecastInput['target'];

export interface ForecastRead {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly answer: MetricsForecastOutput | null;
  readonly view: ForecastView | null;
  /** The failure of the last read, as received. */
  readonly problem: unknown;
  /** The answer on screen is from an earlier read, because the last one failed. */
  readonly earlier: boolean;
  /** Reads started. */
  readonly reads: number;
}

export interface ForecastWatch {
  /** `null` while nothing is read (no connection or no target). */
  readonly read: Signal<ForecastRead | null>;
  refresh(): void;
}

const LOADING: ForecastRead = {
  phase: 'loading',
  answer: null,
  view: null,
  problem: null,
  earlier: false,
  reads: 0,
};

/** Must run in an injection context. */
export function injectForecast(
  target: Signal<ForecastTarget | null>,
  paused: Signal<boolean>,
): ForecastWatch {
  const data = inject(METRICS_DATA);
  const connection = inject(EXPLORER_CONNECTION);
  const timer = inject(EXPLORER_TIMER);
  const read = signal<ForecastRead | null>(null);
  let refreshNow: (() => void) | null = null;

  effect((onCleanup) => {
    const cid = connection();
    const wanted = target();
    if (cid === null || wanted === null) {
      read.set(null);
      refreshNow = null;
      return;
    }
    untracked(() => {
      const id = ConnectionIdSchema.parse(cid);
      let inflight: AbortController | null = null;
      let cancelTimer: (() => void) | null = null;
      let destroyed = false;
      read.set(LOADING);

      const schedule = (): void => {
        cancelTimer?.();
        cancelTimer = timer.set(() => {
          cancelTimer = null;
          if (!paused()) start();
          schedule();
        }, FORECAST_EVERY_MS);
      };

      const start = (): void => {
        if (inflight !== null || destroyed) return;
        const controller = new AbortController();
        inflight = controller;
        const before = read();
        read.update((r) => ({ ...(r ?? LOADING), reads: (r?.reads ?? 0) + 1 }));
        data
          .forecast({ cid: id, target: wanted }, controller.signal)
          .then((answer) => {
            if (controller.signal.aborted) return;
            read.set({
              phase: 'ready',
              answer,
              view: forecastView(answer.forecast),
              problem: null,
              earlier: false,
              reads: read()?.reads ?? 1,
            });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            const last = before?.answer ?? null;
            read.set({
              phase: 'error',
              answer: last,
              view: before?.view ?? null,
              problem: error,
              earlier: last !== null,
              reads: read()?.reads ?? 1,
            });
          })
          .finally(() => {
            if (inflight === controller) inflight = null;
          });
      };

      refreshNow = start;
      start();
      schedule();
      onCleanup(() => {
        destroyed = true;
        cancelTimer?.();
        inflight?.abort();
        inflight = null;
        refreshNow = null;
      });
    });
  });

  return {
    read: read.asReadonly(),
    refresh: () => {
      refreshNow?.();
    },
  };
}
