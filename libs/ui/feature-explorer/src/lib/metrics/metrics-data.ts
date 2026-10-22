// The charts' data port over the engine (M1-54): `metrics.query` and `metrics.forecast` through `EngineApi` (the answer
// is parsed against the contract in dev and test builds) and `metrics.live` through the live client. Every call here
// reads; nothing changes the broker.
import { inject, InjectionToken } from '@angular/core';
import {
  metricsForecast,
  metricsLiveTopic,
  metricsQuery,
} from '@app/contracts';
import type {
  LiveFeedEvent,
  MetricsData,
  MetricsForecastOutput,
  MetricsQueryOutput,
} from '@app/metrics-model';
import { EngineApi, LiveClient, type LiveEvent } from '@app/ui-data';
import type { ItemOf } from '@app/contracts';
import type { Observable } from 'rxjs';

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The request was aborted.', 'AbortError');
}

/** One call as a promise that ends when the signal aborts. */
function once<T>(source: Observable<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      subscription.unsubscribe();
      reject(abortReason(signal));
    };
    const subscription = source.subscribe({
      next: (value) => {
        resolve(value);
      },
      error: (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    });
    signal.addEventListener('abort', onAbort, { once: true });
    subscription.add(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** What the topic sends, as the model's port knows it; `data` frames are not part of this topic. */
function mapEvent(
  event: LiveEvent<ItemOf<typeof metricsLiveTopic>>,
): LiveFeedEvent | undefined {
  switch (event.kind) {
    case 'snapshot':
      return { kind: 'snapshot', items: event.items };
    case 'delta':
      return { kind: 'delta', upserts: event.upserts, removes: event.removes };
    case 'gap':
      return { kind: 'gap' };
    case 'status':
      return { kind: 'status', state: event.state };
    case 'reset':
      return { kind: 'reset' };
    case 'data':
      return undefined;
  }
}

export function createEngineMetricsData(
  api: Pick<EngineApi, 'call'>,
  live: Pick<LiveClient, 'subscribe'>,
): MetricsData {
  return {
    query: (input, signal): Promise<MetricsQueryOutput> =>
      once(api.call(metricsQuery, input), signal),
    forecast: (input, signal): Promise<MetricsForecastOutput> =>
      once(api.call(metricsForecast, input), signal),
    follow(params, listener) {
      const subscription = live.subscribe(metricsLiveTopic, params).subscribe({
        next: (event) => {
          const mapped = mapEvent(event);
          if (mapped) listener(mapped);
        },
        error: (error: unknown) => {
          listener({ kind: 'error', error });
        },
        complete: () => {
          listener({ kind: 'end' });
        },
      });
      return () => {
        subscription.unsubscribe();
      };
    },
  };
}

/** How the charts read metrics: the engine-backed port by default; a spec provides the model's fake. */
export const METRICS_DATA = new InjectionToken<MetricsData>('METRICS_DATA', {
  providedIn: 'root',
  factory: () => createEngineMetricsData(inject(EngineApi), inject(LiveClient)),
});
