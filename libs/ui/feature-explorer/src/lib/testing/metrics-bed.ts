// The metrics views' specs: a queue entity page opened on its Charts or Forecast tab over the model's fake
// `MetricsData` (history, forecast and the live topic a spec controls), a manual clock for the forecast cadence and
// small readers for what the charts show. Never part of the library build.
import type { Provider } from '@angular/core';
import { EngineProblemError } from '@app/ui-data';
import { jsonResponse } from '@app/ui-platform/testing';
import {
  createFakeMetricsData,
  liveItem,
  quietStatus,
  seriesResult,
  type FakeMetricsData,
} from '@app/metrics-model/testing';
import type {
  MetricsForecastOutput,
  MetricsQueryInput,
  MetricsQueryOutput,
  SeriesRef,
} from '@app/metrics-model';

import { METRICS_DATA } from '../metrics/metrics-data';
import { EXPLORER_TIMER } from '../timer';
import { mountEntity, queueRow, type EntityBed } from './entity-bed';
import type { PageRoutes } from './page-testbed';
import { ManualTimer } from './manual-timer';

export const T0 = 1_760_000_000_000;
export const MINUTE = 60_000;
export const ORDERS = queueRow('orders', {
  type: 'quorum',
  state: 'running',
  node: 'rabbit@a',
});

/** The history of the queue's series: `count` points a minute apart, ready counting up and the rest steady. */
export function queueHistory(
  count = 20,
  step = MINUTE,
): (input: MetricsQueryInput) => MetricsQueryOutput {
  const times = Array.from({ length: count }, (_, i) => T0 + i * step);
  return (input) => ({
    series: input.series.map((ref) => {
      const value = (i: number): number => {
        switch (ref.metric) {
          case 'queue_messages_ready':
            return i * 5;
          case 'queue_messages_unacked':
            return i % 4;
          case 'queue_messages':
            return i * 5 + (i % 4);
          default:
            return 2;
        }
      };
      return seriesResult(
        ref,
        times.map((t, i) => [t, value(i)] as const),
      );
    }),
    status: quietStatus({ asOf: times[times.length - 1] ?? T0 }),
  });
}

/** A history answer in which the engine holds none of the series. */
export const NOTHING_REPORTED = (
  input: MetricsQueryInput,
): MetricsQueryOutput => ({
  series: input.series.map((ref) => seriesResult(ref, null)),
  status: quietStatus({
    state: 'unavailable',
    source: 'none',
    asOf: undefined,
    intervalMs: undefined,
  }),
});

export const forecastAnswer =
  (
    forecast: MetricsForecastOutput['forecast'],
  ): ((input: {
    target: MetricsForecastOutput['target'];
  }) => MetricsForecastOutput) =>
  (input) => ({
    target: input.target,
    metric: 'queue_messages',
    forecast,
    points: 20,
    status: quietStatus(),
  });

const METRICS_PATH =
  /^\/api\/v1\/connections\/([^/]+)\/metrics\/(queries|forecasts)$/;

/**
 * The REST half of the metrics contracts over the fake `MetricsData`, as the engine would answer them: a spec that
 * runs the real `EngineApi` and live client passes this as `routes` (and `metricsLiveTopic` as a topic).
 */
export function metricsRoutes(fake: FakeMetricsData): PageRoutes {
  return async (request) => {
    const match = METRICS_PATH.exec(request.url);
    if (request.method !== 'POST' || match?.[1] === undefined) return undefined;
    const body = JSON.parse(
      typeof request.body === 'string' ? request.body : '{}',
    ) as Record<string, unknown>;
    const input = { ...body, cid: decodeURIComponent(match[1]) };
    const signal = new AbortController().signal;
    return match[2] === 'queries'
      ? jsonResponse(200, await fake.query(input as never, signal))
      : jsonResponse(200, await fake.forecast(input as never, signal));
  };
}

export interface MetricsBed extends EntityBed {
  readonly metrics: FakeMetricsData;
  readonly timer: ManualTimer;
}

export interface MetricsBedOptions {
  readonly tab?: 'charts' | 'forecast';
  /** Prepares the fake before the page opens. */
  readonly configure?: (metrics: FakeMetricsData) => void;
  readonly providers?: readonly Provider[];
}

export async function mountQueueMetrics(
  options: MetricsBedOptions = {},
): Promise<MetricsBed> {
  const metrics = createFakeMetricsData();
  metrics.answer = queueHistory();
  options.configure?.(metrics);
  const timer = new ManualTimer();
  const bed = await mountEntity({
    rows: [ORDERS],
    tab: options.tab ?? 'charts',
    providers: [
      { provide: METRICS_DATA, useValue: metrics },
      { provide: EXPLORER_TIMER, useValue: timer },
      ...(options.providers ?? []),
    ],
  });
  return { ...bed, metrics, timer };
}

export const ORDERS_QUEUE = { vhost: '/', name: 'orders' };
export const ref = (metric: SeriesRef['metric']): SeriesRef => ({
  metric,
  queue: ORDERS_QUEUE,
});
export const live = (
  metric: SeriesRef['metric'],
  t: number,
  value: number,
): ReturnType<typeof liveItem> => liveItem(ref(metric), t, value);

/** An engine Problem as the page receives it. */
export function engineProblem(
  code: 'BROKER_UNREACHABLE' | 'FORBIDDEN_BROKER' | 'INTERNAL' = 'INTERNAL',
  title = 'The engine could not do that',
  detail = 'Some detail of the failure.',
): EngineProblemError {
  return new EngineProblemError({
    type: 'about:blank',
    title,
    status: 503,
    code,
    detail,
    correlationId: 'fake-engine',
    retryable: false,
  });
}

/** The cards of the page, each with the paths of its chart. */
export function cards(el: Element): {
  card: HTMLElement;
  title: string;
  paths: string[];
  plot: HTMLElement | null;
  legend: string[];
}[] {
  return [...el.querySelectorAll<HTMLElement>('app-chart-card')].map(
    (card) => ({
      card,
      title: card.querySelector('h3')?.textContent.trim() ?? '',
      paths: [...card.querySelectorAll('path.line')].map(
        (p) => p.getAttribute('d') ?? '',
      ),
      plot: card.querySelector<HTMLElement>('.plot'),
      legend: [...card.querySelectorAll('.legend-item')].map((n) =>
        n.textContent.replace(/\s+/g, ' ').trim(),
      ),
    }),
  );
}

export const textOf = (el: Element, selector: string): string =>
  el.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() ?? '';

export const allText = (el: Element, selector: string): string[] =>
  [...el.querySelectorAll(selector)].map((n) =>
    n.textContent.replace(/\s+/g, ' ').trim(),
  );
